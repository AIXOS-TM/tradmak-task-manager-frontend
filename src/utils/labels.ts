import type { Priority, ProjectStatus, TaskStatus } from '../lib/types'

export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'done']
export const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low']

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  on_hold: 'On hold',
  completed: 'Completed',
}

interface Sortable {
  status: TaskStatus
  due_date: string | null
}

/** Unfinished tasks first, then by due date. */
export function byStatusThenDue(a: Sortable, b: Sortable): number {
  const aDone = a.status === 'done' ? 1 : 0
  const bDone = b.status === 'done' ? 1 : 0
  if (aDone !== bDone) return aDone - bDone
  return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
}
