import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import AddPersonalTaskModal from '../components/AddPersonalTaskModal'
import Avatar, { AvatarStack } from '../components/Avatar'
import { DueDate, PriorityBadge, StatusBadge } from '../components/Badges'
import Icon, { type IconName } from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import TaskCheck from '../components/TaskCheck'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { Task, TaskSource, TaskStatus } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useCurrentUser } from '../store/useApp'
import { formatDateTime, formatLongDate, formatShortDate, greeting, todayISO } from '../utils/format'
import '../styles/dashboard.css'

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

export default function Dashboard() {
  const currentUser = useCurrentUser()
  const { openTask, showToast, invalidate } = useApp()
  const [source, setSource] = useState<SourceTab>('assigned')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [justAddedId, setJustAddedId] = useState<string | null>(null)
  const [busyReviewId, setBusyReviewId] = useState<string | null>(null)
  const { canManageWork } = usePermissions()

  const summary = useApi(() => api.summary(), [])
  const tasks = useApi(() => api.myTasks(source), [source])
  const review = useApi(() => api.reviewItems(), [])
  const meetings = useApi(() => api.meetings(), [])

  const s = summary.data
  const list = tasks.data ?? []
  const statusCount = (f: StatusFilter) => (f === 'all' ? list.length : list.filter((t) => t.status === f).length)
  const visible = filter === 'all' ? list : list.filter((t) => t.status === filter)
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
                You have <strong>{s.today} tasks due today</strong>
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
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
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
              <EmptyState title="No tasks here" text={filter === 'all' ? 'Nothing has been assigned to you yet.' : 'No tasks match this filter.'} />
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
              {visible.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  showAssignInfo={showAssignInfo}
                  highlight={t.id === justAddedId}
                  currentUserId={currentUser.id}
                  onOpen={openTask}
                />
              ))}
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
        <span className="task-title">{t.title}</span>
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
