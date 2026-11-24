/**
 * Team chat: channels (groups), direct messages and messages (database/migrations/010).
 * Same approach as api.ts: the browser Supabase client, with RLS + SECURITY DEFINER functions
 * deciding who may see and do what. New messages arrive live through Supabase Realtime, with a
 * slow refresh as a fallback. Files and voice notes (migration 011) live in the private
 * "taskapp-chat" bucket and are saved with their message.
 */
import { useEffect, useRef } from 'react'
import { ApiError, check, client, fetchByIds, me, refOf } from './api'
import { shared } from './cache'
import { notifications } from './notifications'
import type { ProfileRow } from './rows'
import { supabase } from './supabase'
import type { UserRef } from './types'

export interface Channel {
  id: string
  kind: 'channel' | 'dm'
  /** For DMs: the other person's name. */
  name: string
  description: string
  is_private: boolean
  archived: boolean
  created_by: string | null
  created_at: string
  is_member: boolean
  my_role: 'admin' | 'member' | null
  member_count: number
  unread_count: number
  last_message_at: string | null
  last_message: string | null
  last_message_by: string | null
  /** For DMs: the other person. */
  dm_user: UserRef | null
}

/** A file or voice note sent with a message. */
export interface ChatAttachment {
  /** "<channel id>/<message id>/<random>-<name>" in the taskapp-chat bucket. */
  path: string
  name: string
  type: string
  size: number
  /** Recorded in the app as a voice note. */
  voice?: boolean
  duration_ms?: number
  /** Short-lived signed link (null if it couldn't be made). */
  url: string | null
}

export interface ChatMessage {
  id: string
  channel_id: string
  user_id: string | null
  body: string
  created_at: string
  edited_at: string | null
  attachments: ChatAttachment[]
  /** People @mentioned in it (migration 012). */
  mentioned: UserRef[]
  /** @everyone was used. */
  mention_all: boolean
  author: UserRef | null
}

/** Who a message @mentions (ids from the @ picker). */
export interface MessageMentions {
  ids: string[]
  everyone: boolean
}

/** A voice note recorded in the browser, ready to send. */
export interface VoiceNote {
  blob: Blob
  durationMs: number
}

export interface ChannelMember extends UserRef {
  role: 'admin' | 'member'
  joined_at: string
}

interface ChannelRow extends Omit<Channel, 'dm_user'> {
  dm_user_id: string | null
}

interface MessageRow {
  id: string
  channel_id: string
  user_id: string | null
  body: string
  created_at: string
  edited_at: string | null
  /** Missing before migration 011. */
  attachments?: Omit<ChatAttachment, 'url'>[]
  /** Missing before migration 012. */
  mentions?: string[]
  mention_all?: boolean
}

/** Fired in this tab after a chat was marked as read (the sidebar badge listens). */
export const CHAT_READ_EVENT = 'tradmak:chat-read'

export const MESSAGE_PAGE = 50
const MAX_MESSAGE = 4000
export const CHAT_BUCKET = 'taskapp-chat'
export const MAX_CHAT_FILES = 5
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024
/** Voice notes stop recording automatically after this long. */
export const MAX_VOICE_MS = 5 * 60 * 1000
const LINK_SECONDS = 6 * 60 * 60
const NEEDS_MENTIONS_MIGRATION = '@mentions need a database update. Run database/migrations/012_notifications.sql in the Supabase SQL Editor.'
const NEEDS_FILES_MIGRATION = 'Sending files needs a database update. Run database/migrations/011_chat_attachments.sql in the Supabase SQL Editor.'

const NEEDS_MIGRATION = 'Team chat needs a database update. Run database/migrations/010_team_chat.sql in the Supabase SQL Editor.'

/** Turns "function / table not found" into the run-the-migration message. */
function chatCheck<T>(res: { data: unknown; error: { code?: string; message: string } | null }, what: string): T {
  if (res.error && ['PGRST202', 'PGRST205', '42P01', '42883'].includes(res.error.code ?? '')) throw new ApiError(500, NEEDS_MIGRATION)
  return check<T>(res as Parameters<typeof check>[0], what)
}

/** Adds the author and signed links for the files (one request each for the whole page). */
async function withAuthors(rows: MessageRow[]): Promise<ChatMessage[]> {
  const paths = rows.flatMap((r) => (r.attachments ?? []).map((a) => a.path))
  const [profiles, signed] = await Promise.all([
    fetchByIds<ProfileRow>('profiles', rows.flatMap((r) => [r.user_id, ...(r.mentions ?? [])])),
    paths.length ? client().storage.from(CHAT_BUCKET).createSignedUrls(paths, LINK_SECONDS) : Promise.resolve({ data: [] }),
  ])
  const urls = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]))
  return rows.map((r) => ({
    ...r,
    attachments: (r.attachments ?? []).map((a) => ({ ...a, url: urls.get(a.path) ?? null })),
    mentioned: (r.mentions ?? []).map((id) => refOf(profiles, id)).filter((u): u is UserRef => u !== null),
    mention_all: !!r.mention_all,
    author: refOf(profiles, r.user_id),
  }))
}

/** Keeps file names readable but safe as a storage path. */
function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-100)
  return cleaned.replace(/^[.-]+/, '') || 'file'
}

/** "audio/webm;codecs=opus" -> "audio/webm" (what the bucket's allowed types list). */
const baseType = (type: string) => type.split(';')[0].trim().toLowerCase()

const VOICE_EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }

function uploadError(name: string, message: string): ApiError {
  if (/bucket not found|related resource does not exist/i.test(message)) return new ApiError(500, NEEDS_FILES_MIGRATION)
  if (/mime|type.*not supported|invalid.*type/i.test(message)) return new ApiError(400, `${name}: this file type can't be sent.`)
  if (/size|too large|exceed/i.test(message)) return new ApiError(400, `${name} is larger than 10 MB.`)
  if (/row-level security|unauthorized|403/i.test(message)) return new ApiError(403, "You can't send files in this conversation.")
  return new ApiError(500, `${name}: ${message}`)
}

/** Best effort: a leftover file is harmless, so errors are ignored. */
async function removeChatFiles(paths: string[]) {
  if (paths.length) await client().storage.from(CHAT_BUCKET).remove(paths)
}

/** Checks files before anything is uploaded. Returns an error message, or null when fine. */
export function checkChatFiles(files: File[]): string | null {
  if (files.length > MAX_CHAT_FILES) return `Send at most ${MAX_CHAT_FILES} files at a time.`
  for (const f of files) {
    if (f.size === 0) return `${f.name} is empty.`
    if (f.size > MAX_CHAT_FILE_BYTES) return `${f.name} is larger than 10 MB.`
    if (baseType(f.type) === 'image/svg+xml') return `${f.name}: SVG images can't be sent.`
  }
  return null
}

/** The chat list: my channels, public channels I can join, my DMs, newest activity first. */
async function loadChannels(workspaceId: string): Promise<Channel[]> {
  const rows = chatCheck<ChannelRow[]>(await client().rpc('my_channels', { p_workspace_id: workspaceId }), 'load chats')
  const profiles = await fetchByIds<ProfileRow>('profiles', rows.map((r) => r.dm_user_id))
  return rows
    .map(({ dm_user_id, ...r }) => {
      const dmUser = refOf(profiles, dm_user_id)
      return { ...r, name: r.kind === 'dm' ? (dmUser?.name ?? 'Former member') : r.name, dm_user: dmUser }
    })
    .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at))
}

export const chat = {
  /** Channels I'm in, public channels I can join, and my DMs (with unread counts), newest activity first. */
  channels(workspaceId: string): Promise<Channel[]> {
    // The chat page and the sidebar badge ask at the same time: one request.
    return shared(`chat-channels:${workspaceId}`, () => loadChannels(workspaceId))
  },

  async createChannel(workspaceId: string, input: { name: string; description: string; is_private: boolean; member_ids: string[] }): Promise<string> {
    return chatCheck<string>(
      await client().rpc('create_channel', {
        p_workspace_id: workspaceId,
        p_name: input.name,
        p_description: input.description,
        p_is_private: input.is_private,
        p_member_ids: input.member_ids,
      }),
      'create the channel',
    )
  },

  /** Opens (or starts) a direct message with someone. Returns its channel id. */
  async openDirect(workspaceId: string, userId: string): Promise<string> {
    return chatCheck<string>(await client().rpc('open_direct_message', { p_workspace_id: workspaceId, p_other: userId }), 'open the chat')
  },

  async join(channelId: string): Promise<void> {
    chatCheck(await client().rpc('join_channel', { p_channel_id: channelId }), 'join the channel')
  },

  async leave(channelId: string): Promise<void> {
    const uid = await me()
    const rows = chatCheck<{ user_id: string }[]>(
      await client().from('channel_members').delete().eq('channel_id', channelId).eq('user_id', uid).select('user_id'),
      'leave the channel',
    )
    if (rows.length === 0) throw new ApiError(403, "You can't leave this conversation.")
  },

  async members(channelId: string): Promise<ChannelMember[]> {
    const rows = chatCheck<{ user_id: string; role: 'admin' | 'member'; joined_at: string }[]>(
      await client().from('channel_members').select('user_id, role, joined_at').eq('channel_id', channelId),
      'load members',
    )
    const profiles = await fetchByIds<ProfileRow>('profiles', rows.map((r) => r.user_id))
    return rows
      .map((r) => {
        const ref = refOf(profiles, r.user_id)
        return ref ? { ...ref, role: r.role, joined_at: r.joined_at } : null
      })
      .filter((m): m is ChannelMember => m !== null)
      .sort((a, b) => Number(b.role === 'admin') - Number(a.role === 'admin') || a.name.localeCompare(b.name))
  },

  async addMembers(channelId: string, userIds: string[]): Promise<number> {
    return chatCheck<number>(await client().rpc('add_channel_members', { p_channel_id: channelId, p_member_ids: userIds }), 'add people')
  },

  async removeMember(channelId: string, userId: string): Promise<void> {
    const rows = chatCheck<{ user_id: string }[]>(
      await client().from('channel_members').delete().eq('channel_id', channelId).eq('user_id', userId).select('user_id'),
      'remove people',
    )
    if (rows.length === 0) throw new ApiError(403, 'Only channel admins can remove people.')
  },

  /** Rename, change the description, or archive / unarchive (channel admins). */
  async updateChannel(channelId: string, patch: { name?: string; description?: string; archived?: boolean }): Promise<void> {
    const fields: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      const name = patch.name.trim().replace(/\s+/g, ' ')
      if (!name) throw new ApiError(400, 'Give the channel a name.')
      fields.name = name
    }
    if (patch.description !== undefined) fields.description = patch.description.trim()
    if (patch.archived !== undefined) fields.archived = patch.archived
    const res = await client().from('channels').update(fields).eq('id', channelId).select('id')
    if (res.error?.code === '23505') throw new ApiError(409, 'Another channel already has that name.')
    const rows = chatCheck<{ id: string }[]>(res, 'change the channel')
    if (rows.length === 0) throw new ApiError(403, 'Only channel admins can change this channel.')
  },

  /** Latest messages (oldest first), or the page before `before` (a created_at). */
  async messages(channelId: string, before?: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    let q = client().from('messages').select('*').eq('channel_id', channelId)
    if (before) q = q.lt('created_at', before)
    const rows = chatCheck<MessageRow[]>(await q.order('created_at', { ascending: false }).limit(MESSAGE_PAGE + 1), 'load messages')
    const page = rows.slice(0, MESSAGE_PAGE).reverse()
    return { messages: await withAuthors(page), hasMore: rows.length > MESSAGE_PAGE }
  },

  /**
   * Sends a message with optional files and / or a voice note. Files are uploaded first (into the
   * new message's own folder) and saved with the message in one insert, so other people receive
   * the message and its files together. If anything fails nothing is sent and uploads are removed.
   */
  async send(channelId: string, body: string, files: File[] = [], voice?: VoiceNote, mentions: MessageMentions = { ids: [], everyone: false }): Promise<ChatMessage> {
    const uid = await me()
    const text = body.trim()
    if (!text && files.length === 0 && !voice) throw new ApiError(400, 'Write a message first.')
    if (text.length > MAX_MESSAGE) throw new ApiError(400, `Messages can be at most ${MAX_MESSAGE} characters.`)
    const problem = checkChatFiles(files)
    if (problem) throw new ApiError(400, problem)
    if (voice && voice.blob.size > MAX_CHAT_FILE_BYTES) throw new ApiError(400, 'That voice note is too long.')

    const id = crypto.randomUUID()
    const uploads: { file: Blob; name: string; type: string; voice?: boolean; duration_ms?: number }[] = files.map((f) => ({
      file: f,
      name: f.name.slice(0, 255) || 'file',
      type: baseType(f.type) || 'application/octet-stream',
    }))
    if (voice) {
      const type = baseType(voice.blob.type) || 'audio/webm'
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
      uploads.push({ file: voice.blob, name: `Voice message ${stamp}.${VOICE_EXT[type] ?? 'webm'}`, type, voice: true, duration_ms: Math.round(voice.durationMs) })
    }

    const attachments: Omit<ChatAttachment, 'url'>[] = []
    try {
      for (const u of uploads) {
        const path = `${channelId}/${id}/${crypto.randomUUID().slice(0, 8)}-${safeFileName(u.name)}`
        const up = await client().storage.from(CHAT_BUCKET).upload(path, u.file, { contentType: u.type, upsert: false })
        if (up.error) throw uploadError(u.name, up.error.message)
        attachments.push({ path, name: u.name, type: u.type, size: u.file.size, ...(u.voice ? { voice: true, duration_ms: u.duration_ms } : {}) })
      }
      const res = await client()
        .from('messages')
        // Text-only messages leave "attachments" out, so they also work before migration 011.
        .insert({
          id,
          channel_id: channelId,
          user_id: uid,
          body: text,
          ...(attachments.length ? { attachments } : {}),
          // Also left out when empty, so plain messages work before migration 012.
          ...(mentions.ids.length ? { mentions: [...new Set(mentions.ids)] } : {}),
          ...(mentions.everyone ? { mention_all: true } : {}),
        })
        .select('*')
        .single()
      if (res.error && (res.error.code === 'PGRST204' || /column/.test(res.error.message))) {
        if (/mention/.test(res.error.message)) throw new ApiError(500, NEEDS_MENTIONS_MIGRATION)
        if (/attachments/.test(res.error.message)) throw new ApiError(500, NEEDS_FILES_MIGRATION)
      }
      const row = chatCheck<MessageRow>(res, 'send the message')
      return (await withAuthors([row]))[0]
    } catch (err) {
      await removeChatFiles(attachments.map((a) => a.path)).catch(() => {})
      throw err
    }
  },

  async edit(messageId: string, body: string, hasFiles = false): Promise<void> {
    const text = body.trim()
    if (!text && !hasFiles) throw new ApiError(400, 'A message can’t be empty. Delete it instead.')
    const rows = chatCheck<{ id: string }[]>(
      await client().from('messages').update({ body: text, edited_at: new Date().toISOString() }).eq('id', messageId).select('id'),
      'edit the message',
    )
    if (rows.length === 0) throw new ApiError(403, 'You can only edit your own messages.')
  },

  /** Deletes a message, then its files. */
  async remove(message: Pick<ChatMessage, 'id' | 'attachments'>): Promise<void> {
    const rows = chatCheck<{ id: string }[]>(await client().from('messages').delete().eq('id', message.id).select('id'), 'delete the message')
    if (rows.length === 0) throw new ApiError(403, 'You can only delete your own messages.')
    await removeChatFiles(message.attachments.map((a) => a.path)).catch(() => {})
  },

  /** Marks everything in the channel as read for me. */
  async markRead(channelId: string): Promise<void> {
    const uid = await me()
    await client().from('channel_members').update({ last_read_at: new Date().toISOString() }).eq('channel_id', channelId).eq('user_id', uid)
    // "Read" isn't sent through Realtime: tell the sidebar badge directly.
    window.dispatchEvent(new Event(CHAT_READ_EVENT))
    // Notifications about this conversation (DM, @mention) are read now too.
    void notifications.markReadFor({ channelId }).catch(() => {})
  },

  async fetchMessage(id: string): Promise<ChatMessage | null> {
    const res = await client().from('messages').select('*').eq('id', id).maybeSingle()
    if (res.error || !res.data) return null
    return (await withAuthors([res.data as MessageRow]))[0]
  },
}

/**
 * Calls `onChange` when messages change (anywhere, or only in `channelId`). Uses Supabase Realtime;
 * if that isn't available it falls back to polling every `pollMs`.
 */
export function useChatUpdates(
  onChange: (event: { type: 'INSERT' | 'UPDATE' | 'DELETE' | 'POLL'; id?: string; channelId?: string }) => void,
  channelId: string | null = null,
  pollMs = 8000,
) {
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  })

  useEffect(() => {
    if (!supabase) return
    let live = false
    let catchUp: number | undefined
    const topic = `chat-${channelId ?? 'all'}-${Math.random().toString(36).slice(2)}`
    let sub = supabase
      .channel(topic)
      .on(
        'postgres_changes',
        { event: '*', schema: 'taskapp', table: 'messages', ...(channelId ? { filter: `channel_id=eq.${channelId}` } : {}) },
        (payload) => {
          const row = (payload.new && Object.keys(payload.new).length ? payload.new : payload.old) as Partial<MessageRow>
          cb.current({ type: payload.eventType, id: row.id, channelId: row.channel_id })
        },
      )
    if (!channelId) {
      // The conversation list also changes when someone adds me to (or removes me from) a channel.
      // Only joins / leaves: "read up to" updates would refresh everyone's list constantly.
      const onMembers = () => cb.current({ type: 'POLL' })
      sub = sub
        .on('postgres_changes', { event: 'INSERT', schema: 'taskapp', table: 'channel_members' }, onMembers)
        .on('postgres_changes', { event: 'DELETE', schema: 'taskapp', table: 'channel_members' }, onMembers)
    }
    sub.subscribe((status) => {
      live = status === 'SUBSCRIBED'
      // Realtime needs a moment after SUBSCRIBED before events flow, and a reconnect may have
      // missed some: refresh once shortly after (re)connecting so nothing slips through the gap.
      if (live) {
        window.clearTimeout(catchUp)
        catchUp = window.setTimeout(() => cb.current({ type: 'POLL' }), 2500)
      }
    })
    // Fallback (and safety net for missed events): refresh now and then while Realtime isn't connected.
    const timer = window.setInterval(() => {
      if (!live && document.visibilityState === 'visible') cb.current({ type: 'POLL' })
    }, pollMs)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(catchUp)
      void supabase?.removeChannel(sub)
    }
  }, [channelId, pollMs])
}
