import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Avatar from '../components/Avatar'
import Icon, { type IconName } from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABELS } from '../lib/permissions'
import type { ActivityCategory, ActivityEntry, Priority, ProjectStatus, Workspace, WorkspaceRole } from '../lib/types'
import { useApi } from '../lib/useApi'
import { formatDue } from '../utils/format'
import { PRIORITY_LABELS, PROJECT_STATUS_LABELS } from '../utils/labels'

const CATEGORIES: { id: ActivityCategory; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'projects', label: 'Projects' },
  { id: 'people', label: 'People' },
  { id: 'organization', label: 'Organization' },
]

/** Admin → Activity: who did what, when. Filter by person and type; older entries load on demand. */
export default function ActivityTab({ workspace }: { workspace: Workspace }) {
  const people = useApi(() => api.users(workspace.id), [workspace.id])
  const [actorId, setActorId] = useState('')
  const [category, setCategory] = useState<ActivityCategory>('all')

  return (
    <section className="card admin-activity">
      <div className="members-toolbar">
        <select className="input activity-person" value={actorId} onChange={(e) => setActorId(e.target.value)} aria-label="Filter by person">
          <option value="">Everyone</option>
          {(people.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="segmented members-filter" role="tablist" aria-label="Filter by type">
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={category === c.id} className={category === c.id ? 'active' : ''} onClick={() => setCategory(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {/* key: a new filter starts a fresh list */}
      <ActivityFeed key={`${actorId}|${category}`} workspaceId={workspace.id} actorId={actorId || null} category={category} />
    </section>
  )
}

/** The latest few entries, for the Overview tab. */
export function RecentActivity({ workspaceId }: { workspaceId: string }) {
  return (
    <section className="card admin-card">
      <div className="admin-card-head admin-card-head-row">
        <div>
          <h2>
            <Icon name="clock" size={16} /> Recent activity
          </h2>
          <p className="muted small">The latest changes in this organization.</p>
        </div>
        <Link to="/admin?tab=activity" className="link-btn small">
          View all →
        </Link>
      </div>
      <ActivityFeed workspaceId={workspaceId} limit={8} compact />
    </section>
  )
}

interface FeedProps {
  workspaceId: string
  actorId?: string | null
  category?: ActivityCategory
  limit?: number
  /** Overview card: no day headers, no "load more". */
  compact?: boolean
}

function ActivityFeed({ workspaceId, actorId = null, category = 'all', limit = 40, compact = false }: FeedProps) {
  const first = useApi(() => api.activity(workspaceId, { actorId, category, limit }), [workspaceId, actorId, category, limit])
  const [older, setOlder] = useState<ActivityEntry[]>([])
  const [next, setNext] = useState<number | null | undefined>(undefined) // undefined = use the first page's cursor
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)

  if (first.error && !first.data) return <ErrorState compact message={first.error} onRetry={first.reload} />
  if (!first.data) return <LoadingState compact label="Loading activity…" />

  const entries = [...first.data.entries, ...older]
  const cursor = next === undefined ? first.data.next : next
  if (entries.length === 0) {
    return <EmptyState compact icon="clock" title="Nothing yet" text="Changes to tasks, projects and people will show up here." />
  }

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.activity(workspaceId, { actorId, category, limit, before: cursor })
      setOlder((o) => [...o, ...page.entries])
      setNext(page.next)
    } catch (err) {
      setMoreError(errorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  if (compact) {
    return (
      <ul className="activity-list">
        {entries.map((e) => (
          <ActivityItem key={e.id} entry={e} showDay />
        ))}
      </ul>
    )
  }

  // Group by day.
  const groups: { day: string; items: ActivityEntry[] }[] = []
  for (const e of entries) {
    const day = dayLabel(e.created_at)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.items.push(e)
    else groups.push({ day, items: [e] })
  }

  return (
    <div className="activity-feed">
      {groups.map((g) => (
        <div key={g.day} className="activity-day">
          <div className="activity-day-label">{g.day}</div>
          <ul className="activity-list">
            {g.items.map((e) => (
              <ActivityItem key={e.id} entry={e} />
            ))}
          </ul>
        </div>
      ))}
      {moreError && <p className="form-error">{moreError}</p>}
      {cursor && (
        <div className="activity-more">
          <button type="button" className="btn btn-ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load older activity'}
          </button>
        </div>
      )}
    </div>
  )
}

function ActivityItem({ entry: e, showDay = false }: { entry: ActivityEntry; showDay?: boolean }) {
  const time = new Date(e.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return (
    <li className="activity-item">
      {e.actor ? (
        <Avatar user={e.actor} size={30} />
      ) : (
        <span className="activity-system">
          <Icon name={ICONS[e.entity_type] ?? 'clock'} size={15} />
        </span>
      )}
      <div className="activity-body">
        <div className="activity-text">{describe(e)}</div>
        <div className="activity-meta small muted">
          {showDay ? `${dayLabel(e.created_at)} · ${time}` : time}
          {e.project && (
            <span className="activity-project">
              <span className="dot" style={{ background: e.project.color }} /> {e.project.name}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}

const ICONS: Record<ActivityEntry['entity_type'], IconName> = {
  task: 'tasks',
  project: 'folder',
  member: 'users',
  invite: 'mail',
  organization: 'settings',
  ai_item: 'sparkles',
}

// ---------------------------------------------------------------------
// Turning an entry into a sentence
// ---------------------------------------------------------------------

const TASK_STATUS: Record<string, string> = { pending: 'To do', todo: 'To do', in_progress: 'In progress', done: 'Done' }

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const roleLabel = (v: unknown) => ROLE_LABELS[str(v) as WorkspaceRole] ?? str(v)
const B = ({ children }: { children: ReactNode }) => <strong>{children}</strong>

function describe(e: ActivityEntry): ReactNode {
  const who = <B>{e.actor?.name ?? 'Someone'}</B>
  const thing = <B>{e.entity_name ?? 'an item'}</B>
  const person = <B>{e.target?.name ?? e.entity_name ?? 'someone'}</B>
  const d = e.details
  const from = str(d.from)
  const to = str(d.to)

  switch (e.action) {
    // tasks
    case 'task.created':
      return (
        <>
          {who} created {thing}
          {e.target && e.target.id !== e.actor?.id && <> for {person}</>}
          {d.from_meeting === true && ' from a meeting'}
        </>
      )
    case 'task.deleted':
      return <>{who} deleted the task {thing}</>
    case 'task.status_changed':
      return (
        <>
          {who} moved {thing} from {TASK_STATUS[from] ?? from} to <B>{TASK_STATUS[to] ?? to}</B>
        </>
      )
    case 'task.reassigned':
      return e.target ? (
        <>
          {who} assigned {thing} to {person}
          {e.from_user && <> (was {e.from_user.name})</>}
        </>
      ) : (
        <>{who} unassigned {thing}</>
      )
    case 'task.renamed':
      return (
        <>
          {who} renamed “{from}” to {thing}
        </>
      )
    case 'task.due_changed':
      return to ? (
        <>
          {who} set {thing} due <B>{formatDue(to)}</B>
        </>
      ) : (
        <>{who} removed the due date of {thing}</>
      )
    case 'task.priority_changed':
      return (
        <>
          {who} changed the priority of {thing} to <B>{PRIORITY_LABELS[to as Priority] ?? to}</B>
        </>
      )
    case 'comment.added':
      return (
        <>
          {who} commented on {thing}
          {str(d.excerpt) && <span className="activity-quote">“{str(d.excerpt)}”</span>}
        </>
      )

    // projects
    case 'project.created':
      return <>{who} created the project {thing}</>
    case 'project.deleted':
      return <>{who} deleted the project {thing}</>
    case 'project.renamed':
      return (
        <>
          {who} renamed the project “{from}” to {thing}
        </>
      )
    case 'project.status_changed':
      return (
        <>
          {who} marked {thing} as <B>{PROJECT_STATUS_LABELS[to as ProjectStatus] ?? to}</B>
        </>
      )
    case 'project.owner_changed':
      return (
        <>
          {who} made {person} the owner of {thing}
          {e.from_user && <> (was {e.from_user.name})</>}
        </>
      )
    case 'project.made_private':
      return <>{who} made {thing} private</>
    case 'project.made_public':
      return <>{who} made {thing} visible to everyone</>
    case 'project.member_added':
      return (
        <>
          {who} added {e.target ? <B>{e.target.name}</B> : 'someone'} to {thing}
        </>
      )
    case 'project.member_removed':
      return (
        <>
          {who} removed {e.target ? <B>{e.target.name}</B> : 'someone'} from {thing}
        </>
      )
    case 'project.archived':
      return <>{who} archived {thing}</>
    case 'project.restored':
      return <>{who} restored {thing}</>

    // people
    case 'member.added':
      return (
        <>
          {who} added {person} as <B>{roleLabel(d.role)}</B>
        </>
      )
    case 'member.joined':
      return (
        <>
          {person} joined as <B>{roleLabel(d.role)}</B>
        </>
      )
    case 'member.role_changed':
      return (
        <>
          {who} changed {person}’s role from {roleLabel(d.from)} to <B>{roleLabel(d.to)}</B>
        </>
      )
    case 'member.deactivated':
      return <>{who} deactivated {person}</>
    case 'member.reactivated':
      return <>{who} reactivated {person}</>
    case 'member.removed':
      return <>{who} removed {person} from the organization</>
    case 'member.left':
      return <>{person} left the organization</>
    case 'invite.sent':
      return (
        <>
          {who} invited {thing} as <B>{roleLabel(d.role)}</B>
        </>
      )
    case 'invite.resent':
      return <>{who} resent the invite to {thing}</>
    case 'invite.cancelled':
      return <>{who} cancelled the invite for {thing}</>

    // organization
    case 'organization.created':
      return <>{who} created the organization {thing}</>
    case 'organization.owner_changed':
      return (
        <>
          {who} made {e.target ? <B>{e.target.name}</B> : 'someone'} the owner of {thing}
          {e.from_user && <> (was {e.from_user.name})</>}
        </>
      )
    case 'organization.default_lists_changed':
      return (
        <>
          {who} set the default lists for new projects to <B>{Array.isArray(d.to) ? (d.to as string[]).join(', ') : ''}</B>
        </>
      )
    case 'organization.domains_changed':
      return Array.isArray(d.to) && d.to.length ? (
        <>
          {who} allowed invites only from <B>{(d.to as string[]).map((x) => '@' + x).join(', ')}</B>
        </>
      ) : (
        <>{who} allowed invites from any email address</>
      )
    case 'organization.renamed':
      return (
        <>
          {who} renamed the organization from “{from}” to {thing}
        </>
      )

    // AI meeting items
    case 'ai_item.assigned':
      return e.target && e.target.id === e.actor?.id ? (
        <>{who} took the meeting action item {thing}</>
      ) : (
        <>
          {who} assigned the meeting action item {thing}
          {e.target && <> to {person}</>}
        </>
      )
    case 'ai_item.ignored':
      return <>{who} dismissed the meeting action item {thing}</>

    default:
      return (
        <>
          {who} · {e.action} {thing}
        </>
      )
  }
}
