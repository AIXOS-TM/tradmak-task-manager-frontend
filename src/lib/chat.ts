/**
 * Team chat: channels (groups), direct messages and messages (database/migrations/010).
 * Same approach as api.ts: the browser Supabase client, with RLS + SECURITY DEFINER functions
 * deciding who may see and do what. New messages arrive live through Supabase Realtime, with a
 * slow refresh as a fallback.
 */
import { useEffect, useRef } from 'react'
import { ApiError, check, client, fetchByIds, me, refOf } from './api'
import { shared } from './cache'
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

export interface ChatMessage {
  id: string
  channel_id: string
  user_id: string | null
  body: string
  created_at: string
  edited_at: string | null
  author: UserRef | null
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
}

/** Fired in this tab after a chat was marked as read (the sidebar badge listens). */
export const CHAT_READ_EVENT = 'tradmak:chat-read'

export const MESSAGE_PAGE = 50
const MAX_MESSAGE = 4000

const NEEDS_MIGRATION = 'Team chat needs a database update. Run database/migrations/010_team_chat.sql in the Supabase SQL Editor.'

/** Turns "function / table not found" into the run-the-migration message. */
function chatCheck<T>(res: { data: unknown; error: { code?: string; message: string } | null }, what: string): T {
  if (res.error && ['PGRST202', 'PGRST205', '42P01', '42883'].includes(res.error.code ?? '')) throw new ApiError(500, NEEDS_MIGRATION)
  return check<T>(res as Parameters<typeof check>[0], what)
}

async function withAuthors(rows: MessageRow[]): Promise<ChatMessage[]> {
  const profiles = await fetchByIds<ProfileRow>('profiles', rows.map((r) => r.user_id))
  return rows.map((r) => ({ ...r, author: refOf(profiles, r.user_id) }))
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

  async send(channelId: string, body: string): Promise<ChatMessage> {
    const uid = await me()
    const text = body.trim()
    if (!text) throw new ApiError(400, 'Write a message first.')
    if (text.length > MAX_MESSAGE) throw new ApiError(400, `Messages can be at most ${MAX_MESSAGE} characters.`)
    const row = chatCheck<MessageRow>(
      await client().from('messages').insert({ channel_id: channelId, user_id: uid, body: text }).select('*').single(),
      'send the message',
    )
    return (await withAuthors([row]))[0]
  },

  async edit(messageId: string, body: string): Promise<void> {
    const text = body.trim()
    if (!text) throw new ApiError(400, 'A message can’t be empty. Delete it instead.')
    const rows = chatCheck<{ id: string }[]>(
      await client().from('messages').update({ body: text, edited_at: new Date().toISOString() }).eq('id', messageId).select('id'),
      'edit the message',
    )
    if (rows.length === 0) throw new ApiError(403, 'You can only edit your own messages.')
  },

  async remove(messageId: string): Promise<void> {
    const rows = chatCheck<{ id: string }[]>(await client().from('messages').delete().eq('id', messageId).select('id'), 'delete the message')
    if (rows.length === 0) throw new ApiError(403, 'You can only delete your own messages.')
  },

  /** Marks everything in the channel as read for me. */
  async markRead(channelId: string): Promise<void> {
    const uid = await me()
    await client().from('channel_members').update({ last_read_at: new Date().toISOString() }).eq('channel_id', channelId).eq('user_id', uid)
    // "Read" isn't sent through Realtime: tell the sidebar badge directly.
    window.dispatchEvent(new Event(CHAT_READ_EVENT))
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
