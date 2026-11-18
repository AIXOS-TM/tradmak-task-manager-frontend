import type { Priority, ProjectStatus, TaskStatus } from '../lib/types'
import { daysUntil, formatDue } from '../utils/format'
import { PRIORITY_LABELS, PROJECT_STATUS_LABELS, STATUS_LABELS } from '../utils/labels'
import Icon from './Icon'

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`badge priority-${priority}`}>
      <Icon name="flag" size={12} />
      {PRIORITY_LABELS[priority]}
    </span>
  )
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge status-${status}`}>
      <span className="badge-dot" />
      {STATUS_LABELS[status]}
    </span>
  )
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`badge project-${status}`}>
      <span className="badge-dot" />
      {PROJECT_STATUS_LABELS[status]}
    </span>
  )
}

export function DueDate({ date, done = false }: { date: string | null; done?: boolean }) {
  if (!date) {
    return (
      <span className="due due-done">
        <Icon name="calendar" size={14} />
        No date
      </span>
    )
  }
  const n = daysUntil(date)
  const tone = done ? 'due-done' : n < 0 ? 'due-overdue' : n === 0 ? 'due-today' : ''
  return (
    <span className={`due ${tone}`} title={n < 0 && !done ? 'Overdue' : undefined}>
      <Icon name="calendar" size={14} />
      {formatDue(date)}
    </span>
  )
}
