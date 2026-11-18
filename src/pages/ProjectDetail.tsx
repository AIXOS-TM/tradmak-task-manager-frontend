import { useState, type DragEvent, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Avatar, { AvatarStack } from '../components/Avatar'
import { DueDate, PriorityBadge, ProjectStatusBadge, StatusBadge } from '../components/Badges'
import Icon from '../components/Icon'
import NewTaskModal from '../components/NewTaskModal'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import TaskCheck from '../components/TaskCheck'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { Project, Task, TaskList, TaskStatus } from '../lib/types'
import { useApi, type ApiState } from '../lib/useApi'
import { useApp, useCurrentUser } from '../store/useApp'
import { daysUntil, formatDue } from '../utils/format'
import { STATUS_LABELS, STATUS_ORDER, byStatusThenDue } from '../utils/labels'
import '../styles/projects.css'
import '../styles/project-detail.css'

type View = 'list' | 'board'

export default function ProjectDetail() {
  const { projectId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const project = useApi(() => api.project(projectId), [projectId])
  const lists = useApi(() => api.projectLists(projectId), [projectId])
  const tasks = useApi(() => api.projectTasks(projectId), [projectId])
  const { canManageMembers } = usePermissions()
  const { showToast, invalidate } = useApp()
  const navigate = useNavigate()
  const [showNewTask, setShowNewTask] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const view: View = params.get('view') === 'board' ? 'board' : 'list'

  const deleteProject = async () => {
    if (!project.data) return
    if (!window.confirm(`Delete "${project.data.name}" and all of its tasks? This can't be undone.`)) return
    setDeleting(true)
    try {
      await api.deleteProject(project.data.id)
      showToast(`Project "${project.data.name}" deleted`)
      invalidate()
      navigate('/projects')
    } catch (err) {
      showToast(errorMessage(err), 'error')
      setDeleting(false)
    }
  }

  if (project.error && !project.data) {
    const notFound = project.error.toLowerCase().includes('not found')
    return (
      <div className="page">
        <Link to="/projects" className="back-link">
          <Icon name="chevronLeft" size={16} /> All projects
        </Link>
        <div className="card">
          {notFound ? (
            <EmptyState icon="folder" title="Project not found" text="It may have been deleted, or you don't have access to it." />
          ) : (
            <ErrorState message={project.error} onRetry={project.reload} />
          )}
        </div>
      </div>
    )
  }

  if (!project.data) {
    return (
      <div className="page">
        <div className="card">
          <LoadingState label="Loading project…" />
        </div>
      </div>
    )
  }

  const p = project.data
  const projectTasks = tasks.data ?? []
  const doneCount = projectTasks.filter((t) => t.status === 'done').length
  const total = tasks.data ? projectTasks.length : p.task_count
  const done = tasks.data ? doneCount : p.done_count
  const pct = total ? Math.round((done / total) * 100) : 0
  const overdue = projectTasks.filter((t) => t.status !== 'done' && t.due_date && daysUntil(t.due_date) < 0).length
  const owner = p.members.find((m) => m.id === p.owner_id)

  return (
    <div className="page">
      <Link to="/projects" className="back-link">
        <Icon name="chevronLeft" size={16} /> All projects
      </Link>

      <div className="card project-hero">
        <div className="project-hero-main">
          <span className="project-icon lg" style={{ background: `${p.color}1a`, color: p.color }}>
            <Icon name="folder" size={24} />
          </span>
          <div>
            <div className="project-hero-title">
              <h1>{p.name}</h1>
              <ProjectStatusBadge status={p.status} />
              {canManageMembers(p.workspace_id) && (
                <button type="button" className="link-btn link-danger small hero-delete" onClick={() => void deleteProject()} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Delete project'}
                </button>
              )}
            </div>
            <p className="muted">{p.description || 'No description.'}</p>
          </div>
        </div>
        <div className="project-hero-stats">
          <div>
            <span className="muted small">Owner</span>
            <span className="with-avatar">
              <Avatar user={owner} size={22} />
              {owner?.name ?? '—'}
            </span>
          </div>
          <div>
            <span className="muted small">Team</span>
            {p.members.length ? <AvatarStack users={p.members} max={5} size={24} /> : <span className="muted">—</span>}
          </div>
          <div>
            <span className="muted small">Due</span>
            <span className="strong">{p.due_date ? formatDue(p.due_date) : '—'}</span>
          </div>
          <div>
            <span className="muted small">Tasks</span>
            <span className="strong">
              {done}/{total} done
              {overdue > 0 && <span className="text-danger"> · {overdue} overdue</span>}
            </span>
          </div>
          <div className="hero-progress">
            <span className="muted small">Progress · {pct}%</span>
            <div className="progress">
              <span style={{ width: `${pct}%`, background: p.color }} />
            </div>
          </div>
        </div>
      </div>

      <div className="view-bar">
        <div className="segmented" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setParams({}, { replace: true })}>
            <Icon name="list" size={15} /> List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'board'}
            className={view === 'board' ? 'active' : ''}
            onClick={() => setParams({ view: 'board' }, { replace: true })}
          >
            <Icon name="board" size={15} /> Board
          </button>
        </div>
        {view === 'board' && <span className="muted small hide-sm">Drag cards between columns to change their status.</span>}
        <button type="button" className="btn btn-primary btn-sm view-bar-action" onClick={() => setShowNewTask(true)} disabled={!lists.data}>
          <Icon name="plus" size={15} /> New task
        </button>
      </div>

      {showNewTask && lists.data && <NewTaskModal project={p} lists={lists.data} onClose={() => setShowNewTask(false)} />}

      {tasks.error && !tasks.data ? (
        <div className="card">
          <ErrorState message={tasks.error} onRetry={tasks.reload} />
        </div>
      ) : !tasks.data || !lists.data ? (
        lists.error ? (
          <div className="card">
            <ErrorState message={lists.error} onRetry={lists.reload} />
          </div>
        ) : (
          <div className="card">
            <LoadingState label="Loading tasks…" />
          </div>
        )
      ) : view === 'list' ? (
        <ListView lists={lists.data} tasks={tasks.data} />
      ) : (
        <BoardView project={p} tasks={tasks} />
      )}
    </div>
  )
}

function ListView({ lists, tasks }: { lists: TaskList[]; tasks: Task[] }) {
  const { openTask } = useApp()

  if (tasks.length === 0) {
    return (
      <div className="card">
        <EmptyState title="No tasks in this project yet" text='Switch to the Board view and use "Add task" to create one.' />
      </div>
    )
  }

  // Tasks whose list isn't in this project's lists (shouldn't happen) still get shown.
  const known = new Set(lists.map((l) => l.id))
  const groups: { id: string; name: string; tasks: Task[] }[] = lists.map((l) => ({
    id: l.id,
    name: l.name,
    tasks: tasks.filter((t) => t.list_id === l.id),
  }))
  const other = tasks.filter((t) => !t.list_id || !known.has(t.list_id))
  if (other.length) groups.push({ id: 'other', name: 'Other', tasks: other })

  return (
    <div className="list-view">
      {groups.map((group) => {
        const sorted = [...group.tasks].sort(byStatusThenDue)
        const doneCount = sorted.filter((t) => t.status === 'done').length
        return (
          <section key={group.id} className="card task-group">
            <header className="task-group-head">
              <h2>{group.name}</h2>
              <span className="muted small">
                {doneCount}/{sorted.length} done
              </span>
            </header>
            {sorted.length === 0 && <div className="empty">No tasks in this list.</div>}
            {sorted.map((t) => (
              <div
                key={t.id}
                className={`list-row ${t.status === 'done' ? 'is-done' : ''}`}
                tabIndex={0}
                role="button"
                onClick={() => openTask(t.id)}
                onKeyDown={(e) => e.key === 'Enter' && openTask(t.id)}
              >
                <TaskCheck task={t} />
                <span className="list-title">{t.title}</span>
                <span className="list-assignee">
                  <Avatar user={t.assignee} size={22} />
                  <span className="truncate">{t.assignee?.name ?? 'Unassigned'}</span>
                </span>
                <span className="list-due">
                  <DueDate date={t.due_date} done={t.status === 'done'} />
                </span>
                <span className="list-priority">
                  <PriorityBadge priority={t.priority} />
                </span>
                <span className="list-status">
                  <StatusBadge status={t.status} />
                </span>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

function BoardView({ project, tasks }: { project: Project; tasks: ApiState<Task[]> }) {
  const { openTask, showToast, invalidate } = useApp()
  const currentUser = useCurrentUser()
  const { canEditTask } = usePermissions()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<TaskStatus | null>(null)
  const [adding, setAdding] = useState<TaskStatus | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const all = tasks.data ?? []
  const column = (status: TaskStatus) => all.filter((t) => t.status === status).sort((a, b) => a.position - b.position)

  const moveTo = async (id: string, status: TaskStatus) => {
    const task = all.find((t) => t.id === id)
    if (!task || task.status === status) return
    // Drop at the bottom of the target column.
    const position = column(status).length
    const before = all
    // Optimistic: move the card right away, then save.
    tasks.setData((cur) => cur?.map((t) => (t.id === id ? { ...t, status, position } : t)))
    try {
      await api.updateTask(id, { status, position })
      invalidate()
    } catch (err) {
      tasks.setData(() => before) // put it back
      showToast(errorMessage(err), 'error')
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>, status: TaskStatus) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain') || dragId
    setDragId(null)
    setOverCol(null)
    if (id) void moveTo(id, status)
  }

  const submitNew = async (e: FormEvent, status: TaskStatus) => {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title || creating) return
    setCreating(true)
    try {
      await api.createTask({ title, project_id: project.id, status, assignee_id: currentUser.id })
      setNewTitle('')
      setAdding(null)
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="board">
      {STATUS_ORDER.map((status) => {
        const colTasks = column(status)
        return (
          <div
            key={status}
            className={`board-col col-${status} ${overCol === status ? 'drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overCol !== status) setOverCol(status)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverCol(null)
            }}
            onDrop={(e) => onDrop(e, status)}
          >
            <header className="board-col-head">
              <span className="board-col-dot" />
              <h2>{STATUS_LABELS[status]}</h2>
              <span className="count-pill">{colTasks.length}</span>
            </header>

            <div className="board-cards">
              {colTasks.map((t) => (
                <article
                  key={t.id}
                  className={`board-card ${dragId === t.id ? 'dragging' : ''} ${t.status === 'done' ? 'is-done' : ''}`}
                  draggable={canEditTask(t)}
                  title={canEditTask(t) ? undefined : 'Only admins, managers and the task owner can move this card'}
                  tabIndex={0}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', t.id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDragId(t.id)
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setOverCol(null)
                  }}
                  onClick={() => openTask(t.id)}
                  onKeyDown={(e) => e.key === 'Enter' && openTask(t.id)}
                >
                  <div className="board-card-top">
                    <span className="list-tag">{t.list?.name ?? 'No list'}</span>
                    <PriorityBadge priority={t.priority} />
                  </div>
                  <h3>{t.title}</h3>
                  <div className="board-card-foot">
                    <DueDate date={t.due_date} done={t.status === 'done'} />
                    <span className="board-card-meta">
                      {t.meeting_id && (
                        <span className="meta-icon" title="Created from a meeting">
                          <Icon name="mic" size={13} />
                        </span>
                      )}
                      {t.comment_count > 0 && (
                        <span className="meta-icon">
                          <Icon name="message" size={13} />
                          {t.comment_count}
                        </span>
                      )}
                      <Avatar user={t.assignee} size={24} />
                    </span>
                  </div>
                </article>
              ))}
              {colTasks.length === 0 && <div className="board-empty">Drop tasks here</div>}
            </div>

            {adding === status ? (
              <form className="board-add-form" onSubmit={(e) => void submitNew(e, status)}>
                <input
                  className="input"
                  autoFocus
                  placeholder="Task title…"
                  value={newTitle}
                  disabled={creating}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
                />
                <div className="board-add-actions">
                  <button type="submit" className="btn btn-primary btn-sm" disabled={!newTitle.trim() || creating}>
                    {creating ? 'Adding…' : 'Add task'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(null)} disabled={creating}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="board-add"
                onClick={() => {
                  setAdding(status)
                  setNewTitle('')
                }}
              >
                <Icon name="plus" size={15} /> Add task
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
