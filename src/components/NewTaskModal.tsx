import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { Priority, Project, TaskList, TaskStatus } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useCurrentUser } from '../store/useApp'
import { PRIORITY_LABELS, PRIORITY_ORDER, STATUS_LABELS, STATUS_ORDER } from '../utils/labels'
import Avatar from './Avatar'
import Icon from './Icon'

interface Props {
  project: Project
  lists: TaskList[]
  defaultStatus?: TaskStatus
  onClose: () => void
}

/**
 * POST /tasks: create a project task in one go.
 * Admins and managers pick who gets it; members can only create tasks for themselves.
 */
export default function NewTaskModal({ project, lists, defaultStatus = 'todo', onClose }: Props) {
  const currentUser = useCurrentUser()
  const { showToast, invalidate } = useApp()
  const { canManageWork } = usePermissions()
  const manager = canManageWork(project.workspace_id)
  const members = useApi(() => api.users(project.workspace_id), [project.workspace_id], manager)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeId, setAssigneeId] = useState(currentUser.id)
  const [listId, setListId] = useState(lists[0]?.id ?? '')
  const [status, setStatus] = useState<TaskStatus>(defaultStatus)
  const [priority, setPriority] = useState<Priority>('medium')
  const [dueDate, setDueDate] = useState('')
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
    const clean = title.trim()
    if (!clean) return
    setSaving(true)
    setError(null)
    try {
      await api.createTask({
        title: clean,
        description: description.trim(),
        project_id: project.id,
        list_id: listId || undefined,
        assignee_id: manager ? assigneeId || null : currentUser.id,
        status,
        priority,
        due_date: dueDate || null,
      })
      const who = members.data?.find((m) => m.id === assigneeId)
      showToast(manager && who && who.id !== currentUser.id ? `Task assigned to ${who.name}` : 'Task created')
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
      <form className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onSubmit={onSubmit}>
        <header className="modal-header">
          <div>
            <h2 id="new-task-title">New task</h2>
            <p className="muted small">
              <span className="dot" style={{ background: project.color }} /> {project.name}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon name="x" />
          </button>
        </header>

        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}

          <label className="field">
            <span>Title</span>
            <input id="nt-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Prepare the launch checklist" required maxLength={200} />
          </label>

          <label className="field">
            <span>Description</span>
            <textarea id="nt-desc" className="input textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Details, links, what done looks like…" />
          </label>

          <div className="modal-row">
            <label className="field">
              <span>Assign to</span>
              {manager ? (
                <select id="nt-assignee" className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!members.data}>
                  <option value="">Unassigned</option>
                  {!members.data && <option value={currentUser.id}>Loading team…</option>}
                  {members.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.id === currentUser.id ? ' (you)' : ` · ${m.role}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="input input-static">
                  <Avatar user={currentUser} size={22} /> You
                </span>
              )}
              {!manager && <small className="muted">Only admins and managers can assign tasks to other people.</small>}
              {members.error && <small className="text-danger">{members.error}</small>}
            </label>

            <label className="field">
              <span>Due date</span>
              <input id="nt-due" className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
          </div>

          <div className="modal-row">
            <label className="field">
              <span>List</span>
              <select id="nt-list" className="input" value={listId} onChange={(e) => setListId(e.target.value)}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select id="nt-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field">
            <span>Priority</span>
            <div className="priority-picker" role="radiogroup" aria-label="Priority">
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={priority === p}
                  className={`priority-option priority-${p} ${priority === p ? 'selected' : ''}`}
                  onClick={() => setPriority(p)}
                >
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || saving}>
            <Icon name="plus" size={16} /> {saving ? 'Creating…' : 'Create task'}
          </button>
        </footer>
      </form>
    </>
  )
}
