/**
 * The workload maths for Resources and People (no database calls, so it is easy to test).
 * A person's capacity on a day = hours_per_day on their working days, 0 on time off.
 */
import type { Member, Task, TimeOff } from './types'
import { addDays, isoWeekday } from '../utils/format'

/** One open task placed on the workload grid. */
export interface WorkloadTask {
  task: Task
  /** Minutes of this task that fall on each day it covers. */
  perDay: number
}

export interface WorkloadCell {
  date: string
  /** Minutes the person can work that day (0 on days off). */
  capacity: number
  /** Planned minutes that day. */
  planned: number
  tasks: WorkloadTask[]
  /** Not a working day for them. */
  weekend: boolean
  timeOff: TimeOff | null
}

export interface WorkloadRow {
  member: Member
  cells: WorkloadCell[]
  capacity: number
  planned: number
  /** Open tasks without dates (can't be placed on a day). */
  unscheduled: Task[]
  /** Open tasks that have dates but no estimate. */
  unestimated: number
}

export interface WorkloadData {
  members: Member[]
  tasks: Task[]
  timeOff: TimeOff[]
}

export type LoadLevel = 'off' | 'free' | 'ok' | 'busy' | 'over'

/** How full a day (or a period) is. */
export function loadLevel(planned: number, capacity: number): LoadLevel {
  if (capacity <= 0) return planned > 0 ? 'over' : 'off'
  if (planned <= 0) return 'free'
  const pct = planned / capacity
  if (pct > 1) return 'over'
  if (pct >= 0.85) return 'busy'
  return 'ok'
}

/**
 * Places each person's open tasks on the days they cover.
 * A task covers its start date … due date (just one of them if only one is set). Its estimate
 * is split evenly over the person's working days in that span (not weekends / time off);
 * if none of those days is a working day, all of it lands on the due date.
 */
export function buildWorkload(data: WorkloadData, days: string[]): WorkloadRow[] {
  return data.members.map((member) => {
    const off = data.timeOff.filter((t) => t.user_id === member.id)
    const offOn = (d: string) => off.find((t) => t.start_date <= d && d <= t.end_date) ?? null
    const works = (d: string) => member.work_days.includes(isoWeekday(d)) && !offOn(d)
    const cells: WorkloadCell[] = days.map((date) => {
      const timeOff = offOn(date)
      const weekend = !member.work_days.includes(isoWeekday(date))
      return { date, capacity: weekend || timeOff ? 0 : Math.round(member.hours_per_day * 60), planned: 0, tasks: [], weekend, timeOff }
    })
    const byDate = new Map(cells.map((c) => [c.date, c]))
    const mine = data.tasks.filter((t) => t.assignee_id === member.id && t.status !== 'done')
    const unscheduled: Task[] = []
    let unestimated = 0
    for (const task of mine) {
      const start = task.start_date ?? task.due_date
      const end = task.due_date ?? task.start_date
      if (!start || !end) {
        unscheduled.push(task)
        continue
      }
      if (!task.estimate_minutes) unestimated++
      // Every day the task covers (capped at a year, to stay cheap on odd data).
      const span: string[] = []
      for (let d = start; d <= end && span.length < 366; d = addDays(d, 1)) span.push(d)
      const working = span.filter(works)
      const target = working.length ? working : [end]
      const perDay = (task.estimate_minutes ?? 0) / target.length
      for (const d of target) {
        const cell = byDate.get(d)
        if (!cell) continue
        cell.planned += perDay
        cell.tasks.push({ task, perDay })
      }
    }
    return {
      member,
      cells,
      capacity: cells.reduce((n, c) => n + c.capacity, 0),
      planned: cells.reduce((n, c) => n + c.planned, 0),
      unscheduled,
      unestimated,
    }
  })
}
