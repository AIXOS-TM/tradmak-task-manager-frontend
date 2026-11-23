import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { chat, CHAT_READ_EVENT, useChatUpdates } from '../lib/chat'
import { useTheme } from '../lib/theme'
import { useApi } from '../lib/useApi'
import { useApp, useAuth, useCurrentUser } from '../store/useApp'
import { daysUntil, timeAgo } from '../utils/format'
import Avatar from './Avatar'
import Icon, { type IconName } from './Icon'
import TaskPanel from './TaskPanel'

const NAV: { to: string; label: string; icon: IconName; adminOnly?: boolean }[] = [
  { to: '/dashboard', label: 'My tasks', icon: 'tasks' },
  { to: '/projects', label: 'Projects', icon: 'folder' },
  { to: '/meetings', label: 'Meetings', icon: 'mic' },
  { to: '/chat', label: 'Chat', icon: 'message' },
  { to: '/team', label: 'Team', icon: 'users' },
  { to: '/admin', label: 'Admin', icon: 'shield', adminOnly: true },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

export default function Layout() {
  const [navOpen, setNavOpen] = useState(false)
  const currentUser = useCurrentUser()
  const { signOut, workspaces, joined } = useAuth()
  const { showToast } = useApp()
  // Unread chat messages across my organizations (hidden until migration 010 is run).
  const chatUnread = useApi(
    () => Promise.all(workspaces.map((w) => chat.channels(w.id))).then((lists) => lists.flat().reduce((n, c) => n + (c.is_member ? c.unread_count : 0), 0)),
    [workspaces.map((w) => w.id).join(',')],
    workspaces.length > 0,
    { cache: 'chat-unread', persist: true },
  )
  const reloadUnread = chatUnread.reload
  useChatUpdates(() => reloadUnread(), null, 20000)
  useEffect(() => {
    window.addEventListener(CHAT_READ_EVENT, reloadUnread)
    return () => window.removeEventListener(CHAT_READ_EVENT, reloadUnread)
  }, [reloadUnread])
  const isAdminAnywhere = workspaces.some((w) => w.member_role === 'owner' || w.member_role === 'admin')

  // Existing users who just accepted an email invite: tell them where they are now.
  const announced = useRef(0)
  useEffect(() => {
    if (joined.length > announced.current) {
      const names = joined.slice(announced.current).map((j) => j.workspace_name)
      announced.current = joined.length
      showToast(`You joined ${names.join(', ')}`)
    }
  }, [joined, showToast])
  const summary = useApi(() => api.summary(), [], true, { cache: 'summary', persist: true })
  const projects = useApi(() => api.projects(), [], true, { cache: 'projects', persist: true })

  return (
    <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <Icon name="check" size={16} strokeWidth={3} />
          </span>
          <span className="brand-name">Tradmak Tasks</span>
          <button type="button" className="icon-btn sidebar-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <Icon name="x" />
          </button>
        </div>

        <nav className="sidebar-nav" onClick={() => setNavOpen(false)}>
          {NAV.filter((item) => !item.adminOnly || isAdminAnywhere).map((item) => (
            <NavLink key={item.to} to={item.to} className="nav-item">
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.to === '/dashboard' && !!summary.data?.open && <span className="nav-count">{summary.data.open}</span>}
              {item.to === '/chat' && !!chatUnread.data && (
                <span className="nav-count nav-count-chat" title="Unread messages">
                  {chatUnread.data > 99 ? '99+' : chatUnread.data}
                </span>
              )}
              {item.to === '/meetings' && !!summary.data?.needsReview && (
                <span className="nav-count nav-count-ai" title="Action items need review">
                  {summary.data.needsReview}
                </span>
              )}
            </NavLink>
          ))}

          <div className="sidebar-section-title">Projects</div>
          {projects.error && <div className="sidebar-note">Couldn't load projects</div>}
          {!projects.data && !projects.error && <div className="sidebar-note">Loading…</div>}
          {projects.data?.length === 0 && <div className="sidebar-note">No projects yet</div>}
          {projects.data?.map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`} className="nav-item nav-project">
              <span className="dot" style={{ background: p.color }} />
              <span className="truncate">{p.name}</span>
              {p.is_private && <Icon name="lock" size={12} className="nav-private" aria-label="Private project" />}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <Avatar user={currentUser} size={34} />
          <div className="sidebar-user">
            <div className="truncate strong">{currentUser.name}</div>
            <div className="truncate small">{currentUser.role}</div>
          </div>
          <button type="button" className="icon-btn" onClick={() => void signOut()} aria-label="Log out" title="Log out">
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />

      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <GlobalSearch />
          <div className="topbar-actions">
            <ThemeToggle />
            <Notifications />
            <NavLink to="/settings" className="topbar-user" aria-label="Profile settings">
              <Avatar user={currentUser} size={32} />
            </NavLink>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <TaskPanel />
      <ToastHost />
    </div>
  )
}

/** Quick light/dark switch in the top bar (Settings → Appearance also offers "System"). */
function ThemeToggle() {
  const { theme, setChoice } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button type="button" className="icon-btn" onClick={() => setChoice(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  )
}

/** Searches the current user's tasks (assigned + personal). */
function GlobalSearch() {
  const { openTask } = useApp()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const q = query.trim().toLowerCase()
  // Only fetch once the user starts searching.
  const tasks = useApi(() => api.myTasks('all'), [], focused || !!q, { cache: 'my-tasks:all', persist: true })
  const results = q && tasks.data ? tasks.data.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 6) : []

  return (
    <div className="search">
      <Icon name="search" size={16} className="search-icon" />
      <input
        type="search"
        placeholder="Search my tasks…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        aria-label="Search my tasks"
      />
      {focused && q && (
        <div className="dropdown search-results">
          {tasks.error ? (
            <div className="dropdown-empty">{tasks.error}</div>
          ) : !tasks.data ? (
            <div className="dropdown-empty">Searching…</div>
          ) : results.length === 0 ? (
            <div className="dropdown-empty">No tasks match “{query}”</div>
          ) : (
            results.map((t) => (
              <button
                key={t.id}
                type="button"
                className="dropdown-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  openTask(t.id)
                  setQuery('')
                  setFocused(false)
                }}
              >
                <span className="dot" style={{ background: t.project?.color ?? '#0f766e' }} />
                <span className="truncate">{t.title}</span>
                <span className="muted small truncate">{t.project?.name ?? 'Personal'}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** Built from real data: AI items that need an owner, plus my overdue / due-today tasks. */
function Notifications() {
  const { openTask } = useApp()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [seenAt, setSeenAt] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const review = useApi(() => api.reviewItems(), [], true, { cache: 'review', persist: true })
  const mine = useApi(() => api.myTasks('all'), [], true, { cache: 'my-tasks:all', persist: true })

  const items: { id: string; text: string; time: string; taskId?: string; href?: string }[] = []
  for (const r of review.data ?? []) {
    items.push({ id: r.id, text: `AI found "${r.suggested_title}" in ${r.meeting.title} with no clear owner`, time: r.meeting.started_at, href: `/meetings/${r.meeting_id}` })
  }
  for (const t of mine.data ?? []) {
    if (t.status === 'done' || !t.due_date) continue
    const n = daysUntil(t.due_date)
    if (n < 0) items.push({ id: t.id, text: `"${t.title}" is overdue`, time: t.updated_at, taskId: t.id })
    else if (n === 0) items.push({ id: t.id, text: `"${t.title}" is due today`, time: t.updated_at, taskId: t.id })
  }
  const unread = seenAt === 0 ? items.length : 0

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="notif" ref={ref}>
      <button type="button" className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="Notifications" aria-expanded={open}>
        <Icon name="bell" />
        {unread > 0 && <span className="notif-dot" />}
      </button>
      {open && (
        <div className="dropdown notif-menu">
          <div className="dropdown-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button type="button" className="link-btn small" onClick={() => setSeenAt(Date.now())}>
                Mark all as read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="dropdown-empty">{review.loading || mine.loading ? 'Loading…' : "You're all caught up."}</div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`notif-item ${unread ? 'unread' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (n.taskId) openTask(n.taskId)
                  else if (n.href) navigate(n.href)
                }}
              >
                <span className="notif-bullet" />
                <div>
                  <div>{n.text}</div>
                  <div className="muted small">{timeAgo(n.time)}</div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ToastHost() {
  const { toast, dismissToast } = useApp()

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismissToast, toast.tone === 'error' ? 5000 : 3000)
    return () => clearTimeout(timer)
  }, [toast, dismissToast])

  if (!toast) return null
  return (
    <div className={`toast toast-${toast.tone}`} role="status" key={toast.id}>
      <Icon name={toast.tone === 'error' ? 'alert' : 'checkCircle'} size={18} />
      <span>{toast.message}</span>
    </div>
  )
}
