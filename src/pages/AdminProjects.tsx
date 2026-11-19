import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AvatarStack } from '../components/Avatar'
import Icon from '../components/Icon'
import { ProjectStatusBadge } from '../components/Badges'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABELS } from '../lib/permissions'
import type { AdminProject, Member, Workspace } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp } from '../store/useApp'
import { RowMenu } from './AdminMembers'

type Filter = 'active' | 'private' | 'archived'
const FILTERS: { id: Filter; label: string; match: (p: AdminProject) => boolean }[] = [
  { id: 'active', label: 'Active', match: (p) => !p.archived },
  { id: 'private', label: 'Private', match: (p) => !p.archived && p.is_private },
  { id: 'archived', label: 'Archived', match: (p) => p.archived },
]

/** Admin → Projects: every project with its owner, people, progress, and admin actions. */
export default function ProjectsTab({ workspace }: { workspace: Workspace }) {
  const projects = useApi(() => api.adminProjects(workspace.id), [workspace.id])
  const people = useApi(() => api.users(workspace.id), [workspace.id])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('active')
  const [editing, setEditing] = useState<AdminProject | null>(null)
  const [deleting, setDeleting] = useState<AdminProject | null>(null)
  const isAdmin = workspace.member_role === 'owner' || workspace.member_role === 'admin'

  const all = projects.data ?? []
  const q = query.trim().toLowerCase()
  const rule = FILTERS.find((f) => f.id === filter)!
  const visible = all.filter((p) => rule.match(p) && (!q || p.name.toLowerCase().includes(q)))

  return (
    <section className="card admin-members">
      <div className="members-toolbar">
        <div className="search members-search">
          <Icon name="search" size={16} className="search-icon" />
          <input type="search" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search projects" />
        </div>
        <div className="segmented members-filter" role="tablist" aria-label="Filter projects">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label} <span className="muted">{all.filter(f.match).length}</span>
            </button>
          ))}
        </div>
      </div>

      {projects.error && !projects.data ? (
        <ErrorState message={projects.error} onRetry={projects.reload} />
      ) : !projects.data ? (
        <LoadingState label="Loading projects…" />
      ) : visible.length === 0 ? (
        <EmptyState
          compact
          icon="folder"
          title={filter === 'archived' ? 'No archived projects' : filter === 'private' ? 'No private projects' : 'No projects'}
          text={q ? 'No project matches that search.' : filter === 'archived' ? 'Archived projects show up here and can be restored.' : undefined}
        />
      ) : (
        <div className="members-table" role="table" aria-label="Projects">
          <div className="members-row projects-row members-head" role="row">
            <span role="columnheader">Project</span>
            <span role="columnheader">Owner</span>
            <span role="columnheader">People</span>
            <span role="columnheader">Progress</span>
            <span role="columnheader">Open</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {visible.map((p) => (
            <ProjectRow key={p.id} project={p} isAdmin={isAdmin} onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />
          ))}
        </div>
      )}

      {editing && <AccessModal project={editing} people={people.data ?? []} onClose={() => setEditing(null)} />}
      {deleting && <DeleteModal project={deleting} onClose={() => setDeleting(null)} />}
    </section>
  )
}

function ProjectRow({ project: p, isAdmin, onEdit, onDelete }: { project: AdminProject; isAdmin: boolean; onEdit: () => void; onDelete: () => void }) {
  const { showToast, invalidate } = useApp()
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await action()
      showToast(done)
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`members-row projects-row ${p.archived ? 'is-deactivated' : ''}`} role="row">
      <div className="members-who" role="cell">
        <span className="project-swatch" style={{ background: p.color }} />
        <div className="members-who-text">
          <div className="strong truncate">
            <Link to={`/projects/${p.id}`} className="project-link">
              {p.name}
            </Link>
            {p.is_private && (
              <span className="private-tag" title="Only admins, the owner and the project's people can see it">
                <Icon name="lock" size={11} /> Private
              </span>
            )}
            {p.archived && <span className="role-badge role-deactivated">Archived</span>}
          </div>
          <div className="small">
            <ProjectStatusBadge status={p.status} />
          </div>
        </div>
      </div>

      <div role="cell" className="members-cell small" data-label="Owner">
        {p.owner?.name ?? <span className="muted">No owner</span>}
      </div>
      <div role="cell" className="members-cell" data-label="People">
        {p.members.length ? <AvatarStack users={p.members} max={4} size={24} /> : <span className="muted small">Nobody</span>}
      </div>
      <div role="cell" className="members-cell small" data-label="Progress">
        <div className="project-progress">
          <div className="workload-bar">
            <span className="workload-bar-fill progress-fill" style={{ width: `${p.progress}%` }} />
          </div>
          <span>{p.progress}%</span>
        </div>
      </div>
      <div role="cell" className="members-cell small" data-label="Open">
        <strong>{p.open_count}</strong>
        {p.overdue_count > 0 && <span className="workload-overdue"> · {p.overdue_count} overdue</span>}
      </div>

      <div role="cell" className="members-actions">
        <RowMenu
          disabled={busy}
          label={`Actions for ${p.name}`}
          items={[
            { label: 'Owner & people', icon: 'users', hidden: p.archived, onClick: onEdit },
            {
              label: p.is_private ? 'Make visible to everyone' : 'Make private',
              icon: 'lock',
              hidden: p.archived,
              onClick: () =>
                void run(
                  () => api.updateProjectAdmin(p.id, { is_private: !p.is_private }),
                  p.is_private ? `${p.name} is now visible to everyone` : `${p.name} is now private`,
                ),
            },
            {
              label: p.archived ? 'Restore' : 'Archive',
              icon: p.archived ? 'check' : 'folder',
              onClick: () => {
                if (!p.archived && !window.confirm(`Archive ${p.name}? It disappears from the sidebar and Projects page. Its tasks stay, and you can restore it here.`)) return
                void run(() => api.updateProjectAdmin(p.id, { archived: !p.archived }), p.archived ? `${p.name} was restored` : `${p.name} was archived`)
              },
            },
            { label: 'Delete project', icon: 'x', danger: true, hidden: !isAdmin, onClick: onDelete },
          ]}
        />
      </div>
    </div>
  )
}

function AccessModal({ project, people, onClose }: { project: AdminProject; people: Member[]; onClose: () => void }) {
  const { showToast, invalidate } = useApp()
  const [ownerId, setOwnerId] = useState(project.owner?.id ?? '')
  const [memberIds, setMemberIds] = useState(() => new Set(project.members.map((m) => m.id)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (id: string) =>
    setMemberIds((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (ownerId && ownerId !== project.owner?.id) await api.updateProjectAdmin(project.id, { owner_id: ownerId })
      await api.setProjectMembers(project.id, [...memberIds, ...(ownerId ? [ownerId] : [])])
      showToast(`${project.name} updated`)
      invalidate()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={() => !saving && onClose()} />
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="access-title" onSubmit={onSubmit}>
        <header className="modal-header">
          <div>
            <h2 id="access-title">Owner &amp; people</h2>
            <p className="muted small">
              <span className="dot" style={{ background: project.color }} /> {project.name}
              {project.is_private && ' · private: only these people (and admins) can see it'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          <label className="field">
            <span>Project owner</span>
            <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {!ownerId && <option value="">Choose an owner…</option>}
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({ROLE_LABELS[p.member_role]})
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>People on this project</span>
            <ul className="people-checklist">
              {people.map((p) => {
                const isOwner = p.id === ownerId
                return (
                  <li key={p.id}>
                    <label>
                      <input type="checkbox" checked={isOwner || memberIds.has(p.id)} disabled={isOwner} onChange={() => toggle(p.id)} />
                      <span className="truncate">{p.name}</span>
                      <span className="muted small">{isOwner ? 'Owner' : p.role}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !ownerId}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </>
  )
}

/** Deleting can't be undone, so the admin types the project's name to confirm. */
function DeleteModal({ project, onClose }: { project: AdminProject; onClose: () => void }) {
  const { showToast, invalidate } = useApp()
  const [typed, setTyped] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const matches = typed.trim() === project.name

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!matches) return
    setSaving(true)
    setError(null)
    try {
      await api.deleteProject(project.id)
      showToast(`${project.name} was deleted`)
      invalidate()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={() => !saving && onClose()} />
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" onSubmit={onSubmit}>
        <header className="modal-header">
          <div>
            <h2 id="delete-title">Delete {project.name}?</h2>
            <p className="muted small">
              This permanently deletes the project with its {project.task_count} task{project.task_count === 1 ? '' : 's'}, lists and comments. It can’t be
              undone. To keep the history, archive it instead.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          <label className="field">
            <span>
              Type <strong>{project.name}</strong> to confirm
            </span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
          </label>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={!matches || saving}>
            {saving ? 'Deleting…' : 'Delete project'}
          </button>
        </footer>
      </form>
    </>
  )
}
