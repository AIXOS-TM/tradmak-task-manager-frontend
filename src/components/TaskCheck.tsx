import { useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { Task } from '../lib/types'
import { useApp } from '../store/useApp'
import Icon from './Icon'

/** Round checkbox that toggles a task between done and to-do (PATCH /tasks/:id). */
export default function TaskCheck({ task, onChanged }: { task: Task; onChanged?: (task: Task) => void }) {
  const { showToast, invalidate } = useApp()
  const [saving, setSaving] = useState(false)
  const allowed = usePermissions().canEditTask(task)
  const done = task.status === 'done'

  const toggle = async () => {
    setSaving(true)
    try {
      const updated = await api.updateTask(task.id, { status: done ? 'todo' : 'done' })
      onChanged?.(updated)
      if (!done) showToast(`Nice! "${task.title}" is done`)
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      type="button"
      className={`task-check ${done ? 'checked' : ''} ${saving ? 'saving' : ''}`}
      aria-label={done ? 'Mark as not done' : 'Mark as done'}
      aria-pressed={done}
      disabled={saving || !allowed}
      title={allowed ? undefined : 'Only admins, managers and the task owner can change this task'}
      onClick={(e) => {
        e.stopPropagation()
        void toggle()
      }}
    >
      <Icon name="check" size={12} strokeWidth={3} />
    </button>
  )
}
