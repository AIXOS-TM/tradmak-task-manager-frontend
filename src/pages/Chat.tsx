import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PendingFiles } from '../components/Attachments'
import Avatar from '../components/Avatar'
import { ChatAttachments, formatDuration, useVoiceRecorder } from '../components/ChatMedia'
import { MentionText, useMentions, type MentionPerson } from '../components/Mentions'
import Icon from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { chat, checkChatFiles, MAX_CHAT_FILES, useChatUpdates, type Channel, type ChannelMember, type ChatMessage, type MessageMentions, type VoiceNote } from '../lib/chat'
import type { Member } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useAuth, useCurrentUser } from '../store/useApp'
import '../styles/admin.css'
import '../styles/chat.css'

/** Team chat: channels (groups) and direct messages. /chat and /chat/:channelId */
export default function Chat() {
  const { workspaces } = useAuth()
  const { channelId } = useParams()
  const navigate = useNavigate()
  const [selectedWs, setSelectedWs] = useState<string | null>(null)
  const workspaceId = selectedWs ?? workspaces[0]?.id ?? ''
  const channels = useApi(() => chat.channels(workspaceId), [workspaceId], !!workspaceId, { cache: 'chat-channels', persist: true })
  const [modal, setModal] = useState<'channel' | 'dm' | 'browse' | null>(null)
  const [filter, setFilter] = useState('')

  // Any new / changed message refreshes the list (unread counts, latest message).
  const reloadList = channels.reload
  useChatUpdates(() => reloadList())
  // Renames, archiving and new public channels don't come through Realtime: refresh the list when
  // you come back to the tab, and every 30 seconds while the chat is open.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') reloadList()
    }
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reloadList])

  const all = channels.data ?? []
  const q = filter.trim().toLowerCase()
  const match = (c: Channel) => !q || c.name.toLowerCase().includes(q)
  const mine = all.filter((c) => c.kind === 'channel' && c.is_member && !c.archived && match(c))
  const dms = all.filter((c) => c.kind === 'dm' && match(c))
  const joinable = all.filter((c) => c.kind === 'channel' && !c.is_member && !c.archived)
  const archived = all.filter((c) => c.kind === 'channel' && c.is_member && c.archived && match(c))
  const active = all.find((c) => c.id === channelId) ?? null

  const open = (id: string) => {
    setModal(null)
    channels.reload()
    navigate(`/chat/${id}`)
  }

  return (
    <div className={`chat-page ${channelId ? 'has-active' : ''}`}>
      <aside className="chat-sidebar" aria-label="Conversations">
        <div className="chat-sidebar-head">
          <h1>Chat</h1>
          <div className="chat-sidebar-actions">
            <button type="button" className="icon-btn" onClick={() => setModal('dm')} title="New direct message" aria-label="New direct message">
              <Icon name="user" size={17} />
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal('channel')}>
              <Icon name="plus" size={15} /> Channel
            </button>
          </div>
        </div>
        {workspaces.length > 1 && (
          <select className="input chat-ws" value={workspaceId} onChange={(e) => { setSelectedWs(e.target.value); navigate('/chat') }} aria-label="Organization">
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <div className="search chat-search">
          <Icon name="search" size={15} className="search-icon" />
          <input type="search" placeholder="Find a conversation…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a conversation" />
        </div>

        <div className="chat-list">
          {channels.error && !channels.data ? (
            <ErrorState compact message={channels.error} onRetry={channels.reload} />
          ) : !channels.data ? (
            <LoadingState compact label="Loading chats…" />
          ) : (
            <>
              <ListSection title="Channels">
                {mine.length === 0 && <p className="chat-list-empty muted small">{q ? 'No match.' : 'You’re not in any channel yet.'}</p>}
                {mine.map((c) => (
                  <ChannelItem key={c.id} channel={c} active={c.id === channelId} onClick={() => navigate(`/chat/${c.id}`)} />
                ))}
                {joinable.length > 0 && (
                  <button type="button" className="chat-browse" onClick={() => setModal('browse')}>
                    <Icon name="search" size={14} /> Browse {joinable.length} more channel{joinable.length === 1 ? '' : 's'}
                  </button>
                )}
              </ListSection>
              <ListSection title="Direct messages">
                {dms.length === 0 && <p className="chat-list-empty muted small">{q ? 'No match.' : 'Start a conversation with a teammate.'}</p>}
                {dms.map((c) => (
                  <ChannelItem key={c.id} channel={c} active={c.id === channelId} onClick={() => navigate(`/chat/${c.id}`)} />
                ))}
              </ListSection>
              {archived.length > 0 && (
                <ListSection title="Archived">
                  {archived.map((c) => (
                    <ChannelItem key={c.id} channel={c} active={c.id === channelId} onClick={() => navigate(`/chat/${c.id}`)} />
                  ))}
                </ListSection>
              )}
            </>
          )}
        </div>
      </aside>

      <section className="chat-main">
        {active ? (
          <Conversation key={active.id} channel={active} workspaceId={workspaceId} onListChanged={channels.reload} onLeft={() => { channels.reload(); navigate('/chat') }} />
        ) : channelId && !channels.data ? (
          <LoadingState label="Opening chat…" />
        ) : channelId ? (
          <div className="chat-empty">
            <EmptyState icon="message" title="Chat not found" text="It may have been deleted, or you're no longer a member." />
          </div>
        ) : (
          <div className="chat-empty">
            <EmptyState
              icon="message"
              title="Team chat"
              text="Pick a conversation on the left, create a channel for a group, or message someone directly."
              action={
                <div className="chat-empty-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setModal('channel')}>
                    <Icon name="plus" size={15} /> New channel
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setModal('dm')}>
                    <Icon name="user" size={15} /> Direct message
                  </button>
                </div>
              }
            />
          </div>
        )}
      </section>

      {modal === 'channel' && <NewChannelModal workspaceId={workspaceId} onClose={() => setModal(null)} onCreated={open} />}
      {modal === 'dm' && <NewDirectModal workspaceId={workspaceId} onClose={() => setModal(null)} onOpened={open} />}
      {modal === 'browse' && <BrowseModal channels={joinable} onClose={() => setModal(null)} onJoined={open} />}
    </div>
  )
}

function ListSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="chat-section">
      <div className="chat-section-title">{title}</div>
      {children}
    </div>
  )
}

function ChannelItem({ channel: c, active, onClick }: { channel: Channel; active: boolean; onClick: () => void }) {
  const unread = c.unread_count > 0 && !active
  return (
    <button type="button" className={`chat-item ${active ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={onClick}>
      {c.kind === 'dm' ? (
        <Avatar user={c.dm_user ?? { name: c.name, avatar_color: '#8b92a3' }} size={28} />
      ) : (
        <span className="chat-hash">{c.is_private ? <Icon name="lock" size={13} /> : '#'}</span>
      )}
      <span className="chat-item-text">
        <span className="chat-item-name truncate">{c.name}</span>
        {c.last_message && <span className="chat-item-last truncate">{c.last_message}</span>}
      </span>
      {unread && <span className="chat-unread">{c.unread_count > 99 ? '99+' : c.unread_count}</span>}
    </button>
  )
}

// ---------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------

const GROUP_MS = 5 * 60 * 1000

function Conversation({ channel, workspaceId, onListChanged, onLeft }: { channel: Channel; workspaceId: string; onListChanged: () => void; onLeft: () => void }) {
  const currentUser = useCurrentUser()
  const { showToast } = useApp()
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  // Files dropped anywhere on the conversation go to the message box.
  const addFilesRef = useRef<AddFiles | null>(null)
  const [dragging, setDragging] = useState(false)
  const canPost = channel.is_member && !channel.archived
  const dragDepth = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const canModerate = channel.kind === 'channel' && channel.my_role === 'admin'

  const loadedOnce = useRef(false)
  const load = useCallback(async () => {
    try {
      const page = await chat.messages(channel.id)
      setMessages((current) => {
        // Refresh the latest page but keep older pages the user already loaded.
        if (!current) return page.messages
        const ids = new Set(page.messages.map((m) => m.id))
        const firstNew = page.messages[0]?.created_at ?? ''
        return [...current.filter((m) => !ids.has(m.id) && m.created_at < firstNew), ...page.messages]
      })
      if (!loadedOnce.current) setHasMore(page.hasMore)
      loadedOnce.current = true
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [channel.id])

  useEffect(() => {
    void load()
  }, [load])

  // Mark as read when opened and whenever new messages arrive while it's open.
  const markRead = useCallback(() => {
    if (channel.is_member && document.visibilityState === 'visible') void chat.markRead(channel.id).then(onListChanged)
  }, [channel.id, channel.is_member, onListChanged])
  useEffect(() => {
    markRead()
  }, [markRead, messages?.length])

  useChatUpdates(async (e) => {
    if (e.type === 'POLL') return void load()
    if (!e.id) return
    if (e.type === 'DELETE') return setMessages((m) => m?.filter((x) => x.id !== e.id) ?? m)
    const msg = await chat.fetchMessage(e.id)
    if (!msg) return
    setMessages((m) => {
      if (!m) return m
      const i = m.findIndex((x) => x.id === msg.id)
      if (i === -1) return [...m, msg]
      const next = [...m]
      next[i] = msg
      return next
    })
  }, channel.id)

  // Keep the view pinned to the newest message unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const loadOlder = async () => {
    if (!messages?.length) return
    const el = scroller.current
    const before = el ? el.scrollHeight - el.scrollTop : 0
    setLoadingOlder(true)
    try {
      const page = await chat.messages(channel.id, messages[0].created_at)
      stickToBottom.current = false
      setMessages((m) => [...page.messages, ...(m ?? [])])
      setHasMore(page.hasMore)
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before
      })
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setLoadingOlder(false)
    }
  }

  const onSent = (m: ChatMessage) => {
    stickToBottom.current = true
    setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list))
    onListChanged()
  }

  const join = async () => {
    try {
      await chat.join(channel.id)
      onListChanged()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    }
  }

  return (
    <div
      className={`chat-conversation ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(e) => {
        if (!canPost || !e.dataTransfer.types.includes('Files')) return
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (canPost && e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        if (!canPost) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        addFilesRef.current?.([...e.dataTransfer.files])
      }}
    >
      {dragging && <div className="chat-drop-overlay">Drop files to send them in {channel.kind === 'dm' ? `your chat with ${channel.name}` : `#${channel.name}`}</div>}
      <header className="chat-header">
        <button type="button" className="icon-btn chat-back" onClick={onLeft} aria-label="Back to conversations">
          <Icon name="arrowRight" size={18} className="flip" />
        </button>
        {channel.kind === 'dm' ? (
          <Avatar user={channel.dm_user ?? { name: channel.name, avatar_color: '#8b92a3' }} size={32} />
        ) : (
          <span className="chat-hash chat-hash-lg">{channel.is_private ? <Icon name="lock" size={15} /> : '#'}</span>
        )}
        <div className="chat-header-text">
          <h2 className="truncate">{channel.name}</h2>
          <p className="muted small truncate">
            {channel.kind === 'dm' ? 'Direct message' : channel.description || (channel.is_private ? 'Private channel' : 'Public channel')}
          </p>
        </div>
        {channel.kind === 'channel' && (
          <button type="button" className="btn btn-ghost btn-sm chat-members-btn" onClick={() => setInfoOpen(true)}>
            <Icon name="users" size={15} /> {channel.member_count}
          </button>
        )}
      </header>

      <div className="chat-messages" ref={scroller} onScroll={onScroll}>
        {error && !messages ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : !messages ? (
          <LoadingState label="Loading messages…" />
        ) : (
          <>
            {hasMore ? (
              <div className="chat-older">
                <button type="button" className="btn btn-ghost btn-sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            ) : (
              <div className="chat-start">
                <span className="chat-start-icon">{channel.kind === 'dm' ? <Icon name="message" size={20} /> : '#'}</span>
                <strong>{channel.kind === 'dm' ? `This is the start of your conversation with ${channel.name}.` : `Welcome to #${channel.name}`}</strong>
                {channel.kind === 'channel' && <span className="muted small">{channel.description || 'This is the very beginning of the channel.'}</span>}
              </div>
            )}
            <MessageList messages={messages} currentUserId={currentUser.id} canModerate={canModerate} onChanged={(id, body) => setMessages((m) => m?.map((x) => (x.id === id ? { ...x, body, edited_at: new Date().toISOString() } : x)) ?? m)} onDeleted={(id) => setMessages((m) => m?.filter((x) => x.id !== id) ?? m)} />
          </>
        )}
      </div>

      {channel.archived ? (
        <div className="chat-banner muted">This channel is archived. You can read it, but nobody can post.</div>
      ) : !channel.is_member ? (
        <div className="chat-banner">
          <span>You’re viewing <strong>#{channel.name}</strong>. Join to send messages.</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void join()}>
            Join channel
          </button>
        </div>
      ) : (
        <Composer channel={channel} workspaceId={workspaceId} onSent={onSent} addFilesRef={addFilesRef} />
      )}

      {infoOpen && (
        <ChannelInfoModal
          channel={channel}
          workspaceId={workspaceId}
          onClose={() => setInfoOpen(false)}
          onChanged={onListChanged}
          onLeft={() => {
            setInfoOpen(false)
            onLeft()
          }}
        />
      )}
    </div>
  )
}

function MessageList({
  messages,
  currentUserId,
  canModerate,
  onChanged,
  onDeleted,
}: {
  messages: ChatMessage[]
  currentUserId: string
  canModerate: boolean
  onChanged: (id: string, body: string) => void
  onDeleted: (id: string) => void
}) {
  return (
    <>
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString()
        const grouped = !newDay && prev && prev.user_id === m.user_id && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_MS
        return (
          <Fragment key={m.id}>
            {newDay && (
              <div className="chat-day">
                <span>{dayLabel(m.created_at)}</span>
              </div>
            )}
            <MessageItem message={m} grouped={!!grouped} mine={m.user_id === currentUserId} canModerate={canModerate} onChanged={onChanged} onDeleted={onDeleted} />
          </Fragment>
        )
      })}
    </>
  )
}

function MessageItem({
  message: m,
  grouped,
  mine,
  canModerate,
  onChanged,
  onDeleted,
}: {
  message: ChatMessage
  grouped: boolean
  mine: boolean
  canModerate: boolean
  onChanged: (id: string, body: string) => void
  onDeleted: (id: string) => void
}) {
  const { showToast } = useApp()
  const currentUser = useCurrentUser()
  const mentionsMe = m.mention_all || m.mentioned.some((u) => u.id === currentUser.id)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.body)
  const [busy, setBusy] = useState(false)
  const time = new Date(m.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  const save = async () => {
    if (draft.trim() === m.body) return setEditing(false)
    setBusy(true)
    try {
      await chat.edit(m.id, draft, m.attachments.length > 0)
      onChanged(m.id, draft.trim())
      setEditing(false)
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Delete this message? This can’t be undone.')) return
    setBusy(true)
    try {
      await chat.remove(m)
      onDeleted(m.id)
    } catch (err) {
      showToast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <div className={`chat-msg ${grouped ? 'grouped' : ''} ${editing ? 'editing' : ''} ${mentionsMe && !mine ? 'mentions-me' : ''}`}>
      <div className="chat-msg-gutter">{grouped ? <span className="chat-msg-time-hover">{time}</span> : <Avatar user={m.author ?? { name: 'Former member', avatar_color: '#8b92a3' }} size={34} />}</div>
      <div className="chat-msg-body">
        {!grouped && (
          <div className="chat-msg-head">
            <strong>{m.author?.name ?? 'Former member'}</strong>
            <span className="muted small">{time}</span>
          </div>
        )}
        {editing ? (
          <div className="chat-edit">
            <textarea
              className="input"
              value={draft}
              autoFocus
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void save()
                }
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <div className="chat-edit-actions small">
              <span className="muted">Enter to save · Esc to cancel</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy || (!draft.trim() && m.attachments.length === 0)}>
                Save
              </button>
            </div>
          </div>
        ) : (
          (m.body || m.edited_at) && (
            <div className="chat-msg-text">
              <MentionText text={m.body} names={m.mentioned.map((u) => u.name)} mine={currentUser.name} everyone={m.mention_all} />
              {m.edited_at && <span className="muted small chat-edited"> (edited)</span>}
            </div>
          )
        )}
        <ChatAttachments attachments={m.attachments} />
      </div>
      {!editing && (mine || canModerate) && (
        <div className="chat-msg-actions">
          {mine && (
            <button type="button" className="icon-btn" onClick={() => { setDraft(m.body); setEditing(true) }} aria-label="Edit message" title="Edit">
              <Icon name="edit" size={14} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => void remove()} disabled={busy} aria-label="Delete message" title="Delete">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

/** What the conversation hands to the message box (files dropped anywhere on the conversation). */
type AddFiles = (files: File[]) => void

function Composer({ channel, workspaceId, onSent, addFilesRef }: { channel: Channel; workspaceId: string; onSent: (m: ChatMessage) => void; addFilesRef: { current: AddFiles | null } }) {
  const { showToast } = useApp()
  const currentUser = useCurrentUser()
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  // Messages go out one after another (in order) while the box is already free for the next one.
  const queue = useRef<Promise<void>>(Promise.resolve())

  // @mentions: people who can read this conversation (members of a private channel / DM,
  // everyone in the organization for a public channel).
  const everyoneCanRead = channel.kind === 'channel' && !channel.is_private
  const people = useApi<MentionPerson[]>(
    () =>
      everyoneCanRead
        ? api.users(workspaceId).then((list) => list.map((u) => ({ id: u.id, name: u.name, avatar_color: u.avatar_color, hint: u.role })))
        : chat.members(channel.id).then((list) => list.map((u) => ({ id: u.id, name: u.name, avatar_color: u.avatar_color }))),
    [channel.id, everyoneCanRead, workspaceId],
    true,
    { cache: 'mention-people' },
  )
  const mentions = useMentions({
    value: draft,
    setValue: setDraft,
    inputRef: box,
    people: (people.data ?? []).filter((p) => p.id !== currentUser.id),
    allowEveryone: channel.kind === 'channel',
  })

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [draft])

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return
      setFiles((current) => {
        const next = [...current, ...incoming]
        const problem = checkChatFiles(next)
        if (problem) {
          showToast(problem, 'error')
          return current
        }
        return next
      })
      box.current?.focus()
    },
    [showToast],
  )
  useEffect(() => {
    addFilesRef.current = addFiles
    return () => {
      addFilesRef.current = null
    }
  }, [addFiles, addFilesRef])

  /** Queues one message. On failure its text and files come back so nothing is lost. */
  const enqueue = (text: string, attached: File[], voice?: VoiceNote, mentioned?: MessageMentions) => {
    setSending((n) => n + 1)
    queue.current = queue.current.then(async () => {
      try {
        onSent(await chat.send(channel.id, text, attached, voice, mentioned))
      } catch (err) {
        showToast(errorMessage(err), 'error')
        if (text) setDraft((current) => (current.trim() ? current : text))
        if (attached.length) setFiles((current) => (current.length ? current : attached))
      } finally {
        setSending((n) => n - 1)
      }
    })
  }

  const send = (e?: FormEvent) => {
    e?.preventDefault()
    const text = draft.trim()
    if (!text && files.length === 0) return
    // Clear at once so typing the next message never gets wiped by this one finishing.
    const mentioned = mentions.resolve(text)
    setDraft('')
    setFiles([])
    mentions.reset()
    box.current?.focus()
    enqueue(text, files, undefined, mentioned)
  }

  const recorder = useVoiceRecorder(
    (note) => enqueue('', [], note),
    (message) => showToast(message, 'error'),
  )

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const hasContent = draft.trim().length > 0 || files.length > 0
  const status = sending > 0 && <div className="chat-sending muted small">Sending…</div>

  if (recorder.state === 'recording') {
    return (
      <div className="chat-composer-wrap">
        {status}
        <div className="chat-composer chat-recording" role="group" aria-label="Recording a voice message">
          <button type="button" className="icon-btn" onClick={() => recorder.stop(false)} aria-label="Discard voice message" title="Discard">
            <Icon name="trash" size={17} />
          </button>
          <span className="chat-rec-dot" aria-hidden="true" />
          <span className="chat-rec-time">{formatDuration(recorder.elapsed)}</span>
          <span className="muted small chat-rec-hint">Recording… press send when you’re done</span>
          <button type="button" className="btn btn-primary chat-send" onClick={() => recorder.stop(true)} aria-label="Send voice message" title="Send">
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-composer-wrap">
      {mentions.popup}
      {status}
      <form className="chat-composer" onSubmit={send}>
        {files.length > 0 && (
          <div className="chat-pending">
            <PendingFiles files={files} onRemove={(i) => setFiles((f) => f.filter((_, j) => j !== i))} />
          </div>
        )}
        <button
          type="button"
          className="icon-btn chat-tool"
          onClick={() => picker.current?.click()}
          disabled={files.length >= MAX_CHAT_FILES}
          aria-label="Attach files"
          title={`Attach files (up to ${MAX_CHAT_FILES}, 10 MB each)`}
        >
          <Icon name="paperclip" size={18} />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <textarea
          ref={box}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            mentions.sync()
          }}
          onKeyDown={onKey}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') mentions.sync()
          }}
          onClick={mentions.sync}
          onBlur={() => window.setTimeout(mentions.sync, 150)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files]
            if (pasted.length) {
              e.preventDefault()
              addFiles(pasted.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Screenshot ${new Date().toLocaleString('en-GB').replace(/[/:,]/g, '-')}${i ? `-${i}` : ''}.png`, { type: f.type }))))
            }
          }}
          placeholder={channel.kind === 'dm' ? `Message ${channel.name}` : `Message #${channel.name}`}
          maxLength={4000}
          aria-label="Message"
          autoFocus
        />
        {!hasContent && (
          <button
            type="button"
            className="icon-btn chat-tool"
            onClick={() => void recorder.start()}
            disabled={recorder.state === 'starting'}
            aria-label="Record a voice message"
            title="Record a voice message"
          >
            <Icon name="mic" size={18} />
          </button>
        )}
        <button type="submit" className="btn btn-primary chat-send" disabled={!hasContent} aria-label="Send">
          <Icon name="send" size={16} />
        </button>
      </form>
    </div>
  )
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

// ---------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------

function Modal({ title, subtitle, onClose, busy, children, footer, onSubmit }: { title: string; subtitle?: ReactNode; onClose: () => void; busy?: boolean; children: ReactNode; footer?: ReactNode; onSubmit?: (e: FormEvent) => void }) {
  return (
    <>
      <div className="modal-backdrop" onClick={() => !busy && onClose()} />
      <form className="modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit ?? ((e) => e.preventDefault())}>
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </form>
    </>
  )
}

/** Active members of the organization other than me. */
function useTeammates(workspaceId: string) {
  const currentUser = useCurrentUser()
  const people = useApi(() => api.users(workspaceId), [workspaceId], !!workspaceId, { cache: 'team' })
  return { ...people, data: people.data?.filter((p) => p.id !== currentUser.id) }
}

function PeoplePicker({ people, selected, onToggle, disabled }: { people: Member[]; selected: Set<string>; onToggle: (id: string) => void; disabled?: (id: string) => string | null }) {
  const [q, setQ] = useState('')
  const shown = people.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="field">
      <input className="input" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      <ul className="people-checklist chat-picker">
        {shown.map((p) => {
          const note = disabled?.(p.id)
          return (
            <li key={p.id}>
              <label>
                <input type="checkbox" checked={!!note || selected.has(p.id)} disabled={!!note} onChange={() => onToggle(p.id)} />
                <span className="truncate">{p.name}</span>
                <span className="muted small">{note ?? p.role}</span>
              </label>
            </li>
          )
        })}
        {shown.length === 0 && <li className="muted small chat-picker-empty">Nobody found.</li>}
      </ul>
    </div>
  )
}

function NewChannelModal({ workspaceId, onClose, onCreated }: { workspaceId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const people = useTeammates(workspaceId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      onCreated(await chat.createChannel(workspaceId, { name, description, is_private: isPrivate, member_ids: [...selected] }))
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Create a channel"
      subtitle="A group conversation for a team, project or topic."
      onClose={onClose}
      busy={saving}
      onSubmit={onSubmit}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create channel'}
          </button>
        </>
      }
    >
      {error && <p className="form-error">{error}</p>}
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. design-team" maxLength={80} required autoFocus />
      </label>
      <label className="field">
        <span>Description (optional)</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this channel about?" maxLength={500} />
      </label>
      <div className="field">
        <span>Who can see it</span>
        <div className="segmented chat-visibility" role="radiogroup" aria-label="Visibility">
          <button type="button" role="radio" aria-checked={!isPrivate} className={!isPrivate ? 'active' : ''} onClick={() => setIsPrivate(false)}>
            # Public
          </button>
          <button type="button" role="radio" aria-checked={isPrivate} className={isPrivate ? 'active' : ''} onClick={() => setIsPrivate(true)}>
            <Icon name="lock" size={13} /> Private
          </button>
        </div>
        <span className="muted small">
          {isPrivate ? 'Only the people you add can find and read it.' : 'Everyone in the organization can find, read and join it.'}
        </span>
      </div>
      <div className="field">
        <span>Add people {selected.size > 0 && <span className="muted">({selected.size})</span>}</span>
        {people.data ? <PeoplePicker people={people.data} selected={selected} onToggle={toggle} /> : <LoadingState compact label="Loading people…" />}
      </div>
    </Modal>
  )
}

function NewDirectModal({ workspaceId, onClose, onOpened }: { workspaceId: string; onClose: () => void; onOpened: (id: string) => void }) {
  const people = useTeammates(workspaceId)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = (people.data ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.email.toLowerCase().includes(q.trim().toLowerCase()))

  const open = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      onOpened(await chat.openDirect(workspaceId, id))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  return (
    <Modal title="Direct message" subtitle="A private conversation with one teammate." onClose={onClose} busy={!!busy}>
      {error && <p className="form-error">{error}</p>}
      <input className="input" placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search people" />
      {!people.data ? (
        <LoadingState compact label="Loading people…" />
      ) : (
        <ul className="chat-people">
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" className="chat-person" onClick={() => void open(p.id)} disabled={!!busy}>
                <Avatar user={p} size={32} />
                <span className="chat-item-text">
                  <span className="strong truncate">{p.name}</span>
                  <span className="muted small truncate">{p.role}</span>
                </span>
                <span className="muted small">{busy === p.id ? 'Opening…' : 'Message'}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="muted small chat-picker-empty">Nobody found.</li>}
        </ul>
      )}
    </Modal>
  )
}

function BrowseModal({ channels, onClose, onJoined }: { channels: Channel[]; onClose: () => void; onJoined: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const join = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await chat.join(id)
      onJoined(id)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }
  return (
    <Modal title="Browse channels" subtitle="Public channels in your organization that you haven’t joined yet." onClose={onClose} busy={!!busy}>
      {error && <p className="form-error">{error}</p>}
      <ul className="chat-people">
        {channels.map((c) => (
          <li key={c.id} className="chat-browse-row">
            <span className="chat-hash">#</span>
            <span className="chat-item-text">
              <span className="strong truncate">{c.name}</span>
              <span className="muted small truncate">
                {c.member_count} member{c.member_count === 1 ? '' : 's'}
                {c.description && ` · ${c.description}`}
              </span>
            </span>
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void join(c.id)}>
              {busy === c.id ? 'Joining…' : 'Join'}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

function ChannelInfoModal({ channel, workspaceId, onClose, onChanged, onLeft }: { channel: Channel; workspaceId: string; onClose: () => void; onChanged: () => void; onLeft: () => void }) {
  const currentUser = useCurrentUser()
  const { showToast } = useApp()
  const isAdmin = channel.my_role === 'admin'
  const members = useApi(() => chat.members(channel.id), [channel.id])
  const people = useTeammates(workspaceId)
  const [name, setName] = useState(channel.name)
  const [description, setDescription] = useState(channel.description)
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const memberIds = new Set((members.data ?? []).map((m) => m.id))

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      showToast(done)
      onChanged()
      members.reload()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const aboutDirty = name.trim() !== channel.name || description.trim() !== channel.description

  return (
    <Modal title={`# ${channel.name}`} subtitle={channel.is_private ? 'Private channel' : 'Public channel'} onClose={onClose} busy={busy}>
      {error && <p className="form-error">{error}</p>}

      {isAdmin && (
        <div className="chat-info-block">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label className="field">
            <span>Description</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </label>
          <div className="chat-info-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !aboutDirty} onClick={() => void run(() => chat.updateChannel(channel.id, { name, description }), 'Channel updated')}>
              Save
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <span>Members {members.data && <span className="muted">({members.data.length})</span>}</span>
        {!members.data ? (
          <LoadingState compact label="Loading members…" />
        ) : (
          <ul className="chat-people chat-member-list">
            {members.data.map((m: ChannelMember) => (
              <li key={m.id} className="chat-browse-row">
                <Avatar user={m} size={28} />
                <span className="chat-item-text">
                  <span className="truncate">
                    {m.name}
                    {m.id === currentUser.id && <span className="you-tag">You</span>}
                  </span>
                  {m.role === 'admin' && <span className="muted small">Channel admin</span>}
                </span>
                {isAdmin && m.id !== currentUser.id && (
                  <button type="button" className="link-btn link-danger small" disabled={busy} onClick={() => void run(() => chat.removeMember(channel.id, m.id), `${m.name} was removed`)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin && !channel.archived && people.data && (
        <div className="field">
          <span>Add people</span>
          <PeoplePicker
            people={people.data}
            selected={adding}
            disabled={(id) => (memberIds.has(id) ? 'In channel' : null)}
            onToggle={(id) =>
              setAdding((s) => {
                const n = new Set(s)
                if (n.has(id)) n.delete(id)
                else n.add(id)
                return n
              })
            }
          />
          <div className="chat-info-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || adding.size === 0}
              onClick={() => void run(() => chat.addMembers(channel.id, [...adding]), `${adding.size} added`).then((ok) => ok && setAdding(new Set()))}
            >
              Add {adding.size || ''}
            </button>
          </div>
        </div>
      )}

      <div className="chat-info-danger">
        {isAdmin && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              if (!channel.archived && !window.confirm(`Archive #${channel.name}? People can still read it, but nobody can post.`)) return
              void run(() => chat.updateChannel(channel.id, { archived: !channel.archived }), channel.archived ? 'Channel restored' : 'Channel archived').then((ok) => ok && onClose())
            }}
          >
            {channel.archived ? 'Unarchive channel' : 'Archive channel'}
          </button>
        )}
        {channel.is_member && (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Leave #${channel.name}?${channel.is_private ? ' You’ll need to be added again to come back.' : ''}`)) return
              void run(() => chat.leave(channel.id), `You left #${channel.name}`).then((ok) => ok && onLeft())
            }}
          >
            Leave channel
          </button>
        )}
      </div>
    </Modal>
  )
}
