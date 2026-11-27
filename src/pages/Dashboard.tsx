import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AddPersonalTaskModal from '../components/AddPersonalTaskModal'
import Avatar, { AvatarStack } from '../components/Avatar'
import { DueDate, PriorityBadge, ProjectStatusBadge, StatusBadge } from '../components/Badges'
import Icon, { type IconName } from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import TaskCheck from '../components/TaskCheck'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { Priority, Project, Task, TaskSource, TaskStatus } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useCurrentUser } from '../store/useApp'
import { addDays, formatDateTime, formatDue, formatLongDate, formatMinutes, formatShortDate, greeting, todayISO } from '../utils/format'
import { PRIORITY_LABELS, PRIORITY_ORDER } from '../utils/labels'
import '../styles/dashboard.css'
import '../styles/planning.css'

type StatusFilter = 'all' | TaskStatus
type SourceTab = TaskSource | 'all'

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'todo', label: 'Pending' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
]

const SOURCE_TABS: { key: SourceTab; label: string; icon: IconName; hint: string }[] = [
  { key: 'assigned', label: 'Assigned to me', icon: 'users', hint: 'Tasks your lead and teammates gave you.' },
  { key: 'personal', label: 'Personal', icon: 'lock', hint: 'Your own to-dos. Only you can see these.' },
  { key: 'all', label: 'All', icon: 'layers', hint: 'Everything on your plate, assigned and personal.' },
]

type DueBucket = 'all' | 'late' | 'today' | 'upcoming' | 'none'
type SortKey = 'due' | 'priority' | 'project' | 'start' | 'created' | 'title'

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/** Which "when" group a task falls in (done tasks are kept out of late / today). */
function bucketOf(t: Task, today: string): Exclude<DueBucket, 'all'> | 'done' {
  if (t.status === 'done') return 'done'
  if (!t.due_date) return 'none'
  if (t.due_date < today) return 'late'
  if (t.due_date === today) return 'today'
  return 'upcoming'
}

const GROUPS: { key: Exclude<DueBucket, 'all'> | 'done'; label: string; tone: string }[] = [
  { key: 'late', label: 'Late', tone: 'red' },
  { key: 'today', label: 'Today', tone: 'blue' },
  { key: 'upcoming', label: 'Upcoming', tone: 'amber' },
  { key: 'none', label: 'No due date', tone: 'gray' },
  { key: 'done', label: 'Done', tone: 'green' },
]

function sortTasks(list: Task[], key: SortKey): Task[] {
  const by = {
    due: (a: Task, b: Task) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'),
    start: (a: Task, b: Task) => (a.start_date ?? a.due_date ?? '9999').localeCompare(b.start_date ?? b.due_date ?? '9999'),
    priority: (a: Task, b: Task) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    project: (a: Task, b: Task) => (a.project?.name ?? '~').localeCompare(b.project?.name ?? '~'),
    created: (a: Task, b: Task) => b.created_at.localeCompare(a.created_at),
    title: (a: Task, b: Task) => a.title.localeCompare(b.title),
  }[key]
  // Unfinished first, then the chosen order, then due date.
  return list.slice().sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || by(a, b) || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
}

export default function Dashboard() {
  const [page, setPage] = useState<'tasks' | 'projects'>('tasks')
  const currentUser = useCurrentUser()
  const { openTask, showToast, invalidate } = useApp()
  const [source, setSource] = useState<SourceTab>('assigned')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [justAddedId, setJustAddedId] = useState<string | null>(null)
  const [busyReviewId, setBusyReviewId] = useState<string | null>(null)
  const { canManageWork } = usePermissions()

  const summary = useApi(() => api.summary(), [], true, { cache: 'summary', persist: true })
  const tasks = useApi(() => api.myTasks(source), [source], true, { cache: 'my-tasks', persist: true })
  const review = useApi(() => api.reviewItems(), [], true, { cache: 'review', persist: true })
  const meetings = useApi(() => api.meetings(), [], true, { cache: 'meetings', persist: true })

  const [due, setDue] = useState<DueBucket>('all')
  const [query, setQuery] = useState('')
  const [priority, setPriority] = useState<'all' | Priority>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [sort, setSort] = useState<SortKey>('due')
  const [grouped, setGrouped] = useState(true)
  const today = todayISO()

  const s = summary.data
  const list = useMemo(() => tasks.data ?? [], [tasks.data])
  const statusCount = (f: StatusFilter) => (f === 'all' ? list.length : list.filter((t) => t.status === f).length)
  const dueCount = (b: DueBucket) => (b === 'all' ? list.filter((t) => t.status !== 'done').length : list.filter((t) => bucketOf(t, today) === b).length)
  const taskProjects = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>()
    for (const t of list) if (t.project) seen.set(t.project.id, t.project)
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [list])
  const q = query.trim().toLowerCase()
  const visible = sortTasks(
    list
      .filter((t) => filter === 'all' || t.status === filter)
      .filter((t) => due === 'all' || bucketOf(t, today) === due)
      .filter((t) => priority === 'all' || t.priority === priority)
      .filter((t) => projectFilter === 'all' || (projectFilter === 'none' ? !t.project_id : t.project_id === projectFilter))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || (t.project?.name.toLowerCase().includes(q) ?? false) || t.description.toLowerCase().includes(q)),
    sort,
  )
  const filtersOn = due !== 'all' || priority !== 'all' || projectFilter !== 'all' || !!q || filter !== 'all'
  const clearFilters = () => {
    setDue('all')
    setPriority('all')
    setProjectFilter('all')
    setQuery('')
    setFilter('all')
  }
  const showAssignInfo = source !== 'personal'
  const activeTab = SOURCE_TABS.find((t) => t.key === source)!
  const sourceCount = (key: SourceTab) => (!s ? null : key === 'all' ? s.assigned + s.personal : s[key])

  const total = s ? s.open + s.done : 0
  const stats: { label: string; value: number | string; sub: string; icon: IconName; tone: string }[] = [
    { label: 'Due today', value: s?.today ?? '–', sub: s ? (s.overdue ? `${s.overdue} overdue` : 'Nothing overdue') : ' ', icon: 'clock', tone: 'amber' },
    { label: 'Open tasks', value: s?.open ?? '–', sub: s ? `${s.in_progress} in progress` : ' ', icon: 'layers', tone: 'indigo' },
    { label: 'Completed', value: s?.done ?? '–', sub: s ? `${total ? Math.round((s.done / total) * 100) : 0}% of your tasks` : ' ', icon: 'checkCircle', tone: 'green' },
    { label: 'Needs review', value: s?.needsReview ?? '–', sub: 'From meeting notes', icon: 'sparkles', tone: 'violet' },
  ]

  const closeAdd = useCallback(() => setShowAdd(false), [])
  const onAdded = (id: string) => {
    setShowAdd(false)
    if (source === 'assigned') setSource('personal')
    setFilter('all')
    setJustAddedId(id)
    setTimeout(() => setJustAddedId((cur) => (cur === id ? null : cur)), 2500)
  }

  const resolveReview = async (id: string, action: 'assign' | 'ignore', title: string) => {
    setBusyReviewId(id)
    try {
      if (action === 'assign') {
        await api.assignActionItemToMe(id)
        showToast(`"${title}" was added to your tasks`)
      } else {
        await api.ignoreActionItem(id)
        showToast('Suggestion ignored')
      }
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusyReviewId(null)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">{formatLongDate(todayISO())}</p>
          <h1>
            {greeting()}, {currentUser.name.split(' ')[0]}
          </h1>
          <p className="muted">
            {s ? (
              <>
                You have <strong>{s.today} {s.today === 1 ? 'task' : 'tasks'} due today</strong>
                {s.overdue > 0 && (
                  <>
                    {' '}and <strong className="text-danger">{s.overdue} overdue</strong>
                  </>
                )}
                .
              </>
            ) : summary.error ? (
              <span className="text-danger">Couldn't load your summary: {summary.error}</span>
            ) : (
              'Loading your day…'
            )}
          </p>
        </div>
      </div>

      <div className="work-tabs" role="tablist" aria-label="My work">
        <button type="button" role="tab" aria-selected={page === 'tasks'} className={page === 'tasks' ? 'active' : ''} onClick={() => setPage('tasks')}>
          <Icon name="tasks" size={16} /> My tasks
        </button>
        <button type="button" role="tab" aria-selected={page === 'projects'} className={page === 'projects' ? 'active' : ''} onClick={() => setPage('projects')}>
          <Icon name="folder" size={16} /> My projects
        </button>
        <div className="due-counters" aria-label="When things are due">
          {(['late', 'today', 'upcoming'] as const).map((b) => (
            <button
              key={b}
              type="button"
              className={`due-counter due-${b} ${due === b && page === 'tasks' ? 'active' : ''}`}
              onClick={() => {
                setPage('tasks')
                setFilter('all')
                setDue(due === b ? 'all' : b)
              }}
              title={b === 'late' ? 'Past their due date and not done' : b === 'today' ? 'Due today' : 'Due later'}
            >
              <i />
              <strong>{tasks.data ? dueCount(b) : '–'}</strong> {b === 'late' ? 'Late' : b === 'today' ? 'Today' : 'Upcoming'}
            </button>
          ))}
        </div>
      </div>

      {page === 'projects' ? (
        <MyProjects userId={currentUser.id} />
      ) : (
      <>
      <div className="stat-grid">
        {stats.map((st) => (
          <div key={st.label} className={`card stat-card ${!s ? 'is-loading' : ''}`}>
            <span className={`stat-icon tone-${st.tone}`}>
              <Icon name={st.icon} size={20} />
            </span>
            <div>
              <div className="stat-label">{st.label}</div>
              <div className="stat-value">{st.value}</div>
              <div className="stat-sub">{st.sub}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="dashboard-grid">
        <section className="card my-tasks">
          <div className="card-header source-header">
            <div className="source-tabs" role="tablist" aria-label="Task source">
              {SOURCE_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={source === t.key}
                  className={`source-tab ${source === t.key ? 'active' : ''}`}
                  onClick={() => setSource(t.key)}
                >
                  <Icon name={t.icon} size={15} />
                  {t.label}
                  {sourceCount(t.key) !== null && <span className="seg-count">{sourceCount(t.key)}</span>}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)} data-tour="add-personal">
              <Icon name="plus" size={15} /> Add personal task
            </button>
          </div>

          <div className="task-toolbar">
            <div className="segmented" role="tablist" aria-label="Filter by status">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  className={filter === f.key ? 'active' : ''}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  {tasks.data && <span className="seg-count">{statusCount(f.key)}</span>}
                </button>
              ))}
            </div>
            <span className="muted small toolbar-hint">{activeTab.hint}</span>
          </div>

          <div className="task-filters">
            <label className="input-icon task-search">
              <Icon name="search" size={15} />
              <input className="input input-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search my tasks…" aria-label="Search my tasks" />
            </label>
            <select className="input input-sm" value={due} onChange={(e) => setDue(e.target.value as DueBucket)} aria-label="Due">
              <option value="all">Any due date</option>
              <option value="late">Late</option>
              <option value="today">Due today</option>
              <option value="upcoming">Upcoming</option>
              <option value="none">No due date</option>
            </select>
            <select className="input input-sm" value={priority} onChange={(e) => setPriority(e.target.value as 'all' | Priority)} aria-label="Priority">
              <option value="all">Any priority</option>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
            {source !== 'personal' && taskProjects.length > 0 && (
              <select className="input input-sm" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="Project">
                <option value="all">All projects</option>
                {source === 'all' && <option value="none">Personal (no project)</option>}
                {taskProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
              <option value="due">Sort: due date</option>
              <option value="priority">Sort: priority</option>
              <option value="start">Sort: start date</option>
              <option value="project">Sort: project</option>
              <option value="created">Sort: newest</option>
              <option value="title">Sort: A–Z</option>
            </select>
            <div className="segmented segmented-icons" role="tablist" aria-label="Layout">
              <button type="button" role="tab" aria-selected={grouped} className={grouped ? 'active' : ''} onClick={() => setGrouped(true)} title="Group by when it's due">
                <Icon name="layers" size={15} />
                <span className="sr-only">Grouped</span>
              </button>
              <button type="button" role="tab" aria-selected={!grouped} className={!grouped ? 'active' : ''} onClick={() => setGrouped(false)} title="One list">
                <Icon name="list" size={15} />
                <span className="sr-only">List</span>
              </button>
            </div>
            {filtersOn && (
              <button type="button" className="link-btn small" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>

          {tasks.error && !tasks.data ? (
            <ErrorState message={tasks.error} onRetry={tasks.reload} />
          ) : !tasks.data || (tasks.loading && tasks.data.length === 0) ? (
            <LoadingState label="Loading your tasks…" />
          ) : visible.length === 0 ? (
            source === 'personal' && filter === 'all' ? (
              <EmptyState
                icon="lock"
                title="No personal tasks yet"
                text="Keep your own to-dos here. Only you can see them."
                action={
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowAdd(true)}>
                    <Icon name="plus" size={15} /> Add personal task
                  </button>
                }
              />
            ) : (
              <EmptyState
                title="No tasks here"
                text={filtersOn ? 'No tasks match these filters.' : 'Nothing has been assigned to you yet.'}
                action={
                  filtersOn ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
                      Clear filters
                    </button>
                  ) : undefined
                }
              />
            )
          ) : (
            <div className={`task-table ${tasks.loading ? 'is-refreshing' : ''}`} role="table" aria-label={activeTab.label}>
              <div className={`task-row task-row-head ${showAssignInfo ? '' : 'compact'}`} role="row">
                <span />
                <span>{showAssignInfo ? 'Task · source' : 'Task'}</span>
                {showAssignInfo && <span>Assigned by</span>}
                <span>Priority</span>
                <span>Due</span>
                <span>Status</span>
              </div>
              {grouped && sort === 'due'
                ? GROUPS.map((g) => {
                    const rows = visible.filter((t) => bucketOf(t, today) === g.key)
                    if (rows.length === 0) return null
                    return (
                      <div key={g.key} className="task-group" role="rowgroup">
                        <div className={`task-group-head tone-${g.tone}`} role="row">
                          <i /> {g.label} <span className="seg-count">{rows.length}</span>
                        </div>
                        {rows.map((t) => (
                          <TaskRow key={t.id} task={t} showAssignInfo={showAssignInfo} highlight={t.id === justAddedId} currentUserId={currentUser.id} onOpen={openTask} />
                        ))}
                      </div>
                    )
                  })
                : visible.map((t) => <TaskRow key={t.id} task={t} showAssignInfo={showAssignInfo} highlight={t.id === justAddedId} currentUserId={currentUser.id} onOpen={openTask} />)}
            </div>
          )}
        </section>

        <aside className="dashboard-side">
          <section className="card ai-panel">
            <div className="ai-panel-head">
              <span className="ai-icon">
                <Icon name="sparkles" size={18} />
              </span>
              <div>
                <h2>AI review</h2>
                <p className="muted small">Action items from meetings where the owner wasn't clear.</p>
              </div>
            </div>

            {review.error && !review.data ? (
              <ErrorState message={review.error} onRetry={review.reload} compact />
            ) : !review.data ? (
              <LoadingState compact />
            ) : review.data.length === 0 ? (
              <div className="ai-empty">
                <Icon name="checkCircle" size={28} />
                <strong>All caught up</strong>
                <span className="muted small">No action items need an owner right now.</span>
              </div>
            ) : (
              <ul className="review-list">
                {review.data.map((r) => (
                  <li key={r.id} className="review-item">
                    <div className="review-title">{r.suggested_title}</div>
                    <div className="review-meta">
                      <Icon name="mic" size={13} />
                      <Link to={`/meetings/${r.meeting_id}`}>{r.meeting.title}</Link>
                      <span>· {formatShortDate(r.meeting.started_at)}</span>
                    </div>
                    <blockquote className="quote">
                      “{r.quote}”<cite>{r.speaker?.name}</cite>
                    </blockquote>
                    {r.ai_note && (
                      <div className="review-reason">
                        <Icon name="alert" size={14} />
                        {r.ai_note}
                      </div>
                    )}
                    <div className="review-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busyReviewId === r.id}
                        onClick={() => void resolveReview(r.id, 'assign', r.suggested_title)}
                      >
                        <Icon name="user" size={14} /> Assign to me
                      </button>
                      {canManageWork(r.meeting.workspace_id) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busyReviewId === r.id}
                          onClick={() => void resolveReview(r.id, 'ignore', r.suggested_title)}
                        >
                          Ignore
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="card-header">
              <h2>Recent meetings</h2>
              <Link to="/meetings" className="link-btn small">
                View all
              </Link>
            </div>
            {meetings.error && !meetings.data ? (
              <ErrorState message={meetings.error} onRetry={meetings.reload} compact />
            ) : !meetings.data ? (
              <LoadingState compact />
            ) : meetings.data.length === 0 ? (
              <EmptyState icon="mic" title="No meetings yet" compact />
            ) : (
              <ul className="mini-meetings">
                {meetings.data.slice(0, 3).map((m) => (
                  <li key={m.id}>
                    <Link to={`/meetings/${m.id}`} className="mini-meeting">
                      <span className="mini-meeting-icon">
                        <Icon name="mic" size={16} />
                      </span>
                      <span className="mini-meeting-body">
                        <span className="truncate strong">{m.title}</span>
                        <span className="muted small">
                          {formatDateTime(m.started_at)} · {m.action_item_count} action items
                        </span>
                      </span>
                      <AvatarStack users={m.attendees} max={3} size={22} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      </>
      )}

      {showAdd && <AddPersonalTaskModal onClose={closeAdd} onAdded={onAdded} />}
    </div>
  )
}

interface TaskRowProps {
  task: Task
  showAssignInfo: boolean
  highlight: boolean
  currentUserId: string
  onOpen: (id: string) => void
}

function TaskRow({ task: t, showAssignInfo, highlight, currentUserId, onOpen }: TaskRowProps) {
  const isPersonal = t.source === 'personal'
  const by = t.assigned_by_user
  const byName = by?.id === currentUserId ? 'You' : (t.assigned_by_name ?? by?.name ?? '—')

  return (
    <div
      role="row"
      tabIndex={0}
      className={`task-row ${showAssignInfo ? '' : 'compact'} ${t.status === 'done' ? 'is-done' : ''} ${highlight ? 'just-added' : ''}`}
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}
    >
      <span className="cell-check">
        <TaskCheck task={t} />
      </span>
      <span className="cell-title">
        <span className="task-title">
          {t.title}
          {t.estimate_minutes ? <span className="estimate-chip" title="Estimate">{formatMinutes(t.estimate_minutes)}</span> : null}
        </span>
        {showAssignInfo && (
          <span className="task-sub">
            {isPersonal ? (
              <span className="personal-tag">
                <Icon name="lock" size={11} /> Personal
              </span>
            ) : (
              <>
                {t.project && (
                  <span className="task-project">
                    <span className="dot" style={{ background: t.project.color }} />
                    {t.project.name}
                  </span>
                )}
                {t.meeting ? (
                  <span className="meeting-tag" title={`Came from: ${t.meeting.title}`}>
                    <Icon name="mic" size={12} />
                    <span className="truncate">{t.meeting.title}</span>
                  </span>
                ) : (
                  <span className="manual-tag">Added manually</span>
                )}
              </>
            )}
          </span>
        )}
      </span>
      {showAssignInfo &&
        (isPersonal ? (
          <span className="cell-by muted small" title="Personal task: nobody assigned it">
            —
          </span>
        ) : (
          <span className="cell-by" title={`Assigned by ${byName}`}>
            <Avatar user={by ?? (t.assigned_by_name ? { name: t.assigned_by_name, avatar_color: '#8b92a3' } : null)} size={22} />
            <span className="truncate by-name">{byName}</span>
          </span>
        ))}
      <span className="cell-priority">
        <PriorityBadge priority={t.priority} />
      </span>
      <span className="cell-due">
        <DueDate date={t.due_date} done={t.status === 'done'} />
      </span>
      <span className="cell-status">
        <StatusBadge status={t.status} />
      </span>
    </div>
  )
}

/** "My projects": the projects I'm on, with progress, my open work and what's late. */
function MyProjects({ userId }: { userId: string }) {
  const projects = useApi(() => api.projects(), [], true, { cache: 'projects', persist: true })
  const tasks = useApi(() => api.myTasks('assigned'), [], true, { cache: 'my-tasks-assigned', persist: true })
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'name' | 'due' | 'client' | 'progress'>('name')
  const today = todayISO()
  const soon = addDays(today, 7)

  const mine = (projects.data ?? []).filter((p) => p.members.some((m) => m.id === userId) || p.owner_id === userId)
  const q = query.trim().toLowerCase()
  const pct = (p: Project) => (p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0)
  const visible = mine
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.client?.name.toLowerCase().includes(q) ?? false))
    .sort((a, b) =>
      sort === 'due'
        ? (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
        : sort === 'client'
          ? (a.client?.name ?? '~').localeCompare(b.client?.name ?? '~') || a.name.localeCompare(b.name)
          : sort === 'progress'
            ? pct(a) - pct(b)
            : a.name.localeCompare(b.name),
    )

  if (projects.error && !projects.data) {
    return (
      <div className="card">
        <ErrorState message={projects.error} onRetry={projects.reload} />
      </div>
    )
  }
  if (!projects.data) {
    return (
      <div className="card">
        <LoadingState label="Loading your projects…" />
      </div>
    )
  }

  return (
    <>
      <div className="plan-toolbar">
        <label className="input-icon plan-search">
          <Icon name="search" size={16} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects or clients…" aria-label="Search my projects" />
        </label>
        <select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort projects">
          <option value="name">Sort: name</option>
          <option value="due">Sort: due date</option>
          <option value="client">Sort: client</option>
          <option value="progress">Sort: least done first</option>
        </select>
      </div>
      {visible.length === 0 ? (
        <div className="card">
          <EmptyState icon="folder" title={mine.length ? 'No projects match' : "You're not on any project yet"} text={mine.length ? undefined : 'When someone adds you to a project, it shows up here.'} />
        </div>
      ) : (
        <div className="my-project-grid">
          {visible.map((p) => {
            const myOpen = (tasks.data ?? []).filter((t) => t.project_id === p.id && t.status !== 'done')
            const myLate = myOpen.filter((t) => t.due_date && t.due_date < today).length
            const dueSoon = p.due_date && p.status !== 'completed' && p.due_date <= soon
            return (
              <Link key={p.id} to={`/projects/${p.id}`} className="card my-project">
                <div className="my-project-top">
                  <span className="dot dot-lg" style={{ background: p.color }} />
                  <div className="my-project-title">
                    <strong className="truncate">{p.name}</strong>
                    <span className="muted small truncate">{p.client ? p.client.name : 'Internal'}</span>
                  </div>
                  <ProjectStatusBadge status={p.status} />
                </div>
                <div className="progress-row">
                  <span className="small muted">
                    {p.done_count} of {p.task_count} tasks done
                  </span>
                  <span className="small strong">{pct(p)}%</span>
                </div>
                <div className="progress">
                  <span style={{ width: `${pct(p)}%`, background: p.color }} />
                </div>
                <div className="my-project-foot small">
                  <span>
                    <strong>{myOpen.length}</strong> <span className="muted">mine open</span>
                    {myLate > 0 && <span className="text-danger"> · {myLate} late</span>}
                  </span>
                  <span className={dueSoon ? 'text-warning' : 'muted'}>
                    <Icon name="calendar" size={13} /> {p.due_date ? `Due ${formatDue(p.due_date).toLowerCase()}` : 'No due date'}
                  </span>
                </div>
                <AvatarStack users={p.members} max={5} size={24} />
              </Link>
            )
          })}
        </div>
      )}
    </>
  )
}
