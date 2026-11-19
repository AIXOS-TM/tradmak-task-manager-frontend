import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../lib/api'
import type { Priority } from '../lib/types'
import { useApp } from '../store/useApp'
import { todayISO } from '../utils/format'
import { PRIORITY_LABELS, PRIORITY_ORDER } from '../utils/labels'
import Icon from './Icon'

interface Props {
  onClose: () => void
  /** Called with the new task's id after it is saved. */
  onAdded: (id: string) => void
}

/** api.createPersonalTask: a private task assigned to the current user. */
export default function AddPersonalTaskModal({ onClose, onAdded }: Props) {
  const { showToast, invalidate } = useApp()
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState(todayISO())
  const [priority, setPriority] = useState<Priority>('medium')
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
      const task = await api.createPersonalTask({ title: clean, due_date: dueDate || null, priority })
      showToast(`Personal task "${clean}" added`)
      invalidate()
      onAdded(task.id)
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={() => !saving && onClose()} />
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="add-personal-title" onSubmit={onSubmit}>
        <header className="modal-header">
          <div>
            <h2 id="add-personal-title">Add personal task</h2>
            <p className="muted small">
              <Icon name="lock" size={12} /> Only you can see personal tasks.
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
            <input
              className="input"
              autoFocus
              placeholder="e.g. Prepare notes for Monday's team meeting"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>

          <div className="modal-row">
            <label className="field">
              <span>Due date</span>
              <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>

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
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || saving}>
            <Icon name="plus" size={16} /> {saving ? 'Adding…' : 'Add task'}
          </button>
        </footer>
      </form>
    </>
  )
}
