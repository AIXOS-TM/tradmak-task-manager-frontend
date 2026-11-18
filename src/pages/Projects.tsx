import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AvatarStack } from '../components/Avatar'
import { ProjectStatusBadge } from '../components/Badges'
import Icon from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { ProjectStatus } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp } from '../store/useApp'
import { formatDue } from '../utils/format'
import { PROJECT_STATUS_LABELS } from '../utils/labels'
import '../styles/projects.css'

type Filter = 'all' | ProjectStatus
const FILTERS: Filter[] = ['all', 'on_track', 'at_risk', 'on_hold', 'completed']

export default function Projects() {
  const projects = useApi(() => api.projects(), [])
  const [filter, setFilter] = useState<Filter>('all')
  const [showNew, setShowNew] = useState(false)
  const { projectWorkspaces } = usePermissions()
  const canCreate = projectWorkspaces.length > 0

  const all = projects.data ?? []
  const visible = filter === 'all' ? all : all.filter((p) => p.status === filter)
  const totalTasks = all.reduce((n, p) => n + p.task_count, 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="muted">{projects.data ? `${all.length} projects · ${totalTasks} tasks in total` : 'Loading projects…'}</p>
        </div>
        <div className="page-header-actions">
          <div className="segmented" role="tablist" aria-label="Filter projects">
            {FILTERS.map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : PROJECT_STATUS_LABELS[f]}
              </button>
            ))}
          </div>
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
              <Icon name="plus" size={16} /> New project
            </button>
          )}
        </div>
      </div>

      {projects.error && !projects.data ? (
        <div className="card">
          <ErrorState message={projects.error} onRetry={projects.reload} />
        </div>
      ) : !projects.data ? (
        <div className="card">
          <LoadingState label="Loading projects…" />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          {all.length === 0 ? (
            <EmptyState
              icon="folder"
              title="No projects yet"
              text={canCreate ? 'Create your first project to start planning tasks with your team.' : 'An admin or manager can create projects for the team.'}
              action={
                canCreate ? (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
                    <Icon name="plus" size={15} /> New project
                  </button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState icon="folder" title="No projects with this status" />
          )}
        </div>
      ) : (
        <div className="project-grid">
          {visible.map((p) => {
            const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0
            return (
              <Link key={p.id} to={`/projects/${p.id}`} className="card project-card">
                <span className="project-accent" style={{ background: p.color }} />
                <div className="project-card-top">
                  <span className="project-icon" style={{ background: `${p.color}1a`, color: p.color }}>
                    <Icon name="folder" size={20} />
                  </span>
                  <ProjectStatusBadge status={p.status} />
                </div>
                <h2>{p.name}</h2>
                <p className="muted project-desc">{p.description || 'No description.'}</p>

                <div className="progress-row">
                  <span className="small muted">Progress</span>
                  <span className="small strong">{pct}%</span>
                </div>
                <div className="progress">
                  <span style={{ width: `${pct}%`, background: p.color }} />
                </div>

                <div className="project-card-foot">
                  <span className="project-stat">
                    <Icon name="tasks" size={15} />
                    {p.task_count} tasks
                    <span className="muted">· {p.open_count} open</span>
                  </span>
                  <AvatarStack users={p.members} max={4} size={26} />
                </div>
                <div className="project-due small muted">
                  <Icon name="calendar" size={14} />
                  {p.due_date ? `${p.status === 'completed' ? 'Finished' : 'Due'} ${formatDue(p.due_date)}` : 'No due date'}
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  )
}

const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#e11d48', '#475569']

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { showToast, invalidate } = useApp()
  const { projectWorkspaces } = usePermissions()
  const [workspaceId, setWorkspaceId] = useState(projectWorkspaces[0]?.id ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const project = await api.createProject({ name: name.trim(), workspace_id: workspaceId || undefined, description: description.trim(), color, due_date: dueDate || null })
      showToast(`Project "${project.name}" created`)
      invalidate()
      navigate(`/projects/${project.id}`)
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={() => !saving && onClose()} />
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onSubmit={onSubmit}>
        <header className="modal-header">
          <div>
            <h2 id="new-project-title">New project</h2>
            <p className="muted small">You'll be the project owner.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          {projectWorkspaces.length > 1 && (
            <label className="field">
              <span>Workspace</span>
              <select id="np-workspace" className="input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                {projectWorkspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Name</span>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer Portal" required maxLength={120} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea className="input textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" />
          </label>
          <div className="modal-row">
            <label className="field">
              <span>Due date</span>
              <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
            <div className="field">
              <span>Colour</span>
              <div className="color-picker" role="radiogroup" aria-label="Colour">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={color === c}
                    aria-label={c}
                    className={`color-swatch ${color === c ? 'selected' : ''}`}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || saving}>
            {saving ? 'Creating…' : 'Create project'}
          </button>
        </footer>
      </form>
    </>
  )
}
