import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import Avatar from '../components/Avatar'
import { DueDate, PriorityBadge } from '../components/Badges'
import Icon from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABELS, usePermissions } from '../lib/permissions'
import { buildWorkload, loadLevel, planning, TIME_OFF_LABELS, type WorkloadRow } from '../lib/planning'
import type { AssignableRole, Member, Project, TimeOff, TimeOffKind, WorkspaceRole } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useAuth, useCurrentUser } from '../store/useApp'
import { addDays, formatMinutes, parseDate, startOfWeek, todayISO } from '../utils/format'
import '../styles/planning.css'

const ASSIGNABLE: AssignableRole[] = ['admin', 'manager', 'member']
const WEEKDAYS = [
  { n: 1, short: 'M', label: 'Monday' },
  { n: 2, short: 'T', label: 'Tuesday' },
  { n: 3, short: 'W', label: 'Wednesday' },
  { n: 4, short: 'T', label: 'Thursday' },
  { n: 5, short: 'F', label: 'Friday' },
  { n: 6, short: 'S', label: 'Saturday' },
  { n: 7, short: 'S', label: 'Sunday' },
]

const fmtDay = (iso: string) => parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
export const formatRange = (a: string, b: string) => (a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`)

export default function People() {
  const currentUser = useCurrentUser()
  const { workspaces } = useAuth()
  const { canManageMembers } = usePermissions()
  const [picked, setPicked] = useState<string | null>(null)
  const workspaceId = picked ?? workspaces[0]?.id ?? null
  const isAdmin = canManageMembers(workspaceId)
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<'all' | WorkspaceRole>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  const today = todayISO()
  const weekStart = startOfWeek(today)
  const weekEnd = addDays(weekStart, 6)
  const horizon = addDays(today, 60)

  const members = useApi(() => api.users(workspaceId), [workspaceId], !!workspaceId, { cache: 'team', persist: true })
  const load = useApi(() => planning.workload(workspaceId!, weekStart, weekEnd), [workspaceId, weekStart], !!workspaceId, { cache: `people-load:${workspaceId}` })
  const timeOff = useApi(() => planning.timeOff(workspaceId!, today, horizon), [workspaceId, today], !!workspaceId, { cache: `people-off:${workspaceId}` })
  const projects = useApi(() => api.projects(), [], true, { cache: 'projects', persist: true })

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])
  // Members from the Team list (always works) + this week's load (needs migration 013).
  const rows = useMemo(() => {
    const byId = new Map<string, WorkloadRow>()
    if (load.data) for (const r of buildWorkload(load.data, days)) byId.set(r.member.id, r)
    return (members.data ?? []).map((m) => ({ member: byId.get(m.id)?.member ?? m, week: byId.get(m.id) ?? null }))
  }, [members.data, load.data, days])

  const q = query.trim().toLowerCase()
  const visible = rows
    .filter(({ member: m }) => role === 'all' || m.member_role === role)
    .filter(({ member: m }) => !q || [m.name, m.email, m.role].some((v) => v.toLowerCase().includes(q)))
    .sort((a, b) => (a.member.id === currentUser.id ? -1 : b.member.id === currentUser.id ? 1 : a.member.name.localeCompare(b.member.name)))

  const offToday = (timeOff.data ?? []).filter((t) => t.start_date <= today && today <= t.end_date)
  const overloaded = rows.filter((r) => r.week && loadLevel(r.week.planned, r.week.capacity) === 'over').length
  const open = rows.find((r) => r.member.id === openId) ?? null
  const needs013 = load.error && /013/.test(load.error)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>People</h1>
          <p className="muted">
            {members.data
              ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}${offToday.length ? ` · ${offToday.length} off today` : ''}${overloaded ? ` · ${overloaded} overloaded this week` : ''}`
              : 'Loading people…'}
          </p>
        </div>
        <div className="page-header-actions">
          {workspaces.length > 1 && (
            <select className="input input-sm" value={workspaceId ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="Organization">
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <Link to="/resources" className="btn btn-secondary">
            <Icon name="barChart" size={16} /> Workload
          </Link>
          {isAdmin && (
            <Link to="/admin?tab=invites" className="btn btn-primary">
              <Icon name="plus" size={16} /> Invite people
            </Link>
          )}
        </div>
      </div>

      {needs013 && <p className="form-info">{load.error} Until then, capacity, time off and workload are hidden.</p>}

      <div className="plan-toolbar">
        <label className="input-icon plan-search">
          <Icon name="search" size={16} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email or job title…" aria-label="Search people" />
        </label>
        <div className="segmented" role="tablist" aria-label="Filter by role">
          {(['all', 'owner', 'admin', 'manager', 'member'] as const).map((r) => (
            <button key={r} type="button" role="tab" aria-selected={role === r} className={role === r ? 'active' : ''} onClick={() => setRole(r)}>
              {r === 'all' ? 'Everyone' : ROLE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {members.error && !members.data ? (
        <div className="card">
          <ErrorState message={members.error} onRetry={members.reload} />
        </div>
      ) : !members.data ? (
        <div className="card">
          <LoadingState label="Loading people…" />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState icon="users" title={rows.length ? 'Nobody matches' : 'No people yet'} text={rows.length ? 'Try another search or role.' : 'People in your organization will show up here.'} />
        </div>
      ) : (
        <div className="card people-table" role="table" aria-label="People">
          <div className="people-row people-head" role="row">
            <span role="columnheader">Person</span>
            <span role="columnheader">Role</span>
            <span role="columnheader" title="Planned hours this week vs. available hours">
              This week
            </span>
            <span role="columnheader">Open</span>
            <span role="columnheader">Late</span>
            <span role="columnheader">Status</span>
          </div>
          {visible.map(({ member: m, week }) => {
            const off = (timeOff.data ?? []).find((t) => t.user_id === m.id && t.start_date <= today && today <= t.end_date)
            const nextOff = (timeOff.data ?? []).find((t) => t.user_id === m.id && t.start_date > today)
            const late = load.data ? load.data.tasks.filter((t) => t.assignee_id === m.id && t.due_date && t.due_date < today).length : null
            return (
              <button key={m.id} type="button" role="row" className="people-row" onClick={() => setOpenId(m.id)}>
                <span className="people-person" role="cell">
                  <Avatar user={m} size={36} />
                  <span className="people-name">
                    <strong className="truncate">
                      {m.name}
                      {m.id === currentUser.id && <span className="you-tag">You</span>}
                    </strong>
                    <span className="muted small truncate">{m.role}</span>
                  </span>
                </span>
                <span role="cell">
                  <span className={`role-badge role-${m.member_role}`}>{ROLE_LABELS[m.member_role]}</span>
                </span>
                <span role="cell" className="people-week">{week ? <LoadBar planned={week.planned} capacity={week.capacity} /> : <span className="muted small">—</span>}</span>
                <span role="cell" className="strong">
                  {m.open_count}
                </span>
                <span role="cell" className={late ? 'text-danger strong' : 'muted'}>
                  {late ?? '—'}
                </span>
                <span role="cell" className="small">
                  {off ? (
                    <span className="off-chip">
                      <Icon name="plane" size={12} /> {TIME_OFF_LABELS[off.kind]} until {fmtDay(off.end_date)}
                    </span>
                  ) : nextOff ? (
                    <span className="muted">Off {formatRange(nextOff.start_date, nextOff.end_date)}</span>
                  ) : (
                    <span className="avail-chip">Available</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {open && workspaceId && (
        <PersonPanel
          key={open.member.id}
          workspaceId={workspaceId}
          member={open.member}
          week={open.week}
          tasks={load.data?.tasks.filter((t) => t.assignee_id === open.member.id) ?? null}
          projects={(projects.data ?? []).filter((p) => p.workspace_id === workspaceId && p.members.some((u) => u.id === open.member.id))}
          timeOff={(timeOff.data ?? []).filter((t) => t.user_id === open.member.id)}
          has013={!needs013}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            members.reload()
            load.reload()
            timeOff.reload()
          }}
        />
      )}
    </div>
  )
}

export function LoadBar({ planned, capacity, compact = false }: { planned: number; capacity: number; compact?: boolean }) {
  const level = loadLevel(planned, capacity)
  const pct = capacity ? Math.round((planned / capacity) * 100) : 0
  return (
    <span className={`load-bar load-${level} ${compact ? 'compact' : ''}`} title={`${formatMinutes(planned)} planned of ${formatMinutes(capacity)} available (${pct}%)`}>
      <span className="load-track">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      {!compact && (
        <span className="small">
          {formatMinutes(planned)} / {formatMinutes(capacity)}
        </span>
      )}
    </span>
  )
}

interface PanelProps {
  workspaceId: string
  member: Member
  week: WorkloadRow | null
  tasks: import('../lib/types').Task[] | null
  projects: Project[]
  timeOff: TimeOff[]
  has013: boolean
  onClose: () => void
  onChanged: () => void
}

function PersonPanel({ workspaceId, member: m, week, tasks, projects, timeOff, has013, onClose, onChanged }: PanelProps) {
  const currentUser = useCurrentUser()
  const { openTask, showToast, invalidate } = useApp()
  const { canManageMembers } = usePermissions()
  const isAdmin = canManageMembers(workspaceId)
  const isMe = m.id === currentUser.id
  const canEditRole = isAdmin && m.member_role !== 'owner' && !isMe
  const [tab, setTab] = useState<'work' | 'off' | 'hours'>('work')
  const [busy, setBusy] = useState(false)
  const today = todayISO()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      showToast(ok)
      invalidate()
      onChanged()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Remove ${m.name} from this organization? Their tasks stay and can be reassigned.`)) return
    await run(() => api.removeMember(workspaceId, m.id), `${m.name} was removed`)
    onClose()
  }

  const open = (tasks ?? []).slice().sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
  const late = open.filter((t) => t.due_date && t.due_date < today)
  const upcoming = open.filter((t) => !t.due_date || t.due_date >= today)

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer person-panel" role="dialog" aria-modal="true" aria-labelledby="person-name">
        <header className="drawer-header">
          <div className="person-head">
            <Avatar user={m} size={52} />
            <div>
              <h2 id="person-name">
                {m.name}
                {isMe && <span className="you-tag">You</span>}
              </h2>
              <div className="muted">{m.role}</div>
              <a className="small" href={`mailto:${m.email}`}>
                {m.email}
              </a>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>

        <div className="person-role-row">
          <span className="muted small">Role</span>
          {canEditRole ? (
            <select
              className="input input-sm"
              value={m.member_role === 'owner' ? 'admin' : m.member_role}
              disabled={busy}
              onChange={(e) => void run(() => api.updateMemberRole(workspaceId, m.id, e.target.value as AssignableRole), `${m.name} is now ${ROLE_LABELS[e.target.value as AssignableRole]}`)}
              aria-label={`Role of ${m.name}`}
            >
              {ASSIGNABLE.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          ) : (
            <span className={`role-badge role-${m.member_role}`}>{ROLE_LABELS[m.member_role]}</span>
          )}
          {canEditRole && (
            <button type="button" className="link-btn link-danger small" onClick={() => void remove()} disabled={busy}>
              Remove from organization
            </button>
          )}
        </div>

        <div className="person-stats">
          <div>
            <strong>{m.open_count}</strong>
            <span className="muted small">Open</span>
          </div>
          <div className={late.length ? 'is-late' : ''}>
            <strong>{tasks ? late.length : '—'}</strong>
            <span className="muted small">Late</span>
          </div>
          <div>
            <strong>{m.done_count}</strong>
            <span className="muted small">Done</span>
          </div>
          <div>
            <strong>{m.hours_per_day}h</strong>
            <span className="muted small">Per day</span>
          </div>
        </div>
        {week && (
          <div className="person-week">
            <span className="muted small">This week</span>
            <LoadBar planned={week.planned} capacity={week.capacity} />
          </div>
        )}

        <div className="drawer-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'work'} className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}>
            Work
          </button>
          <button type="button" role="tab" aria-selected={tab === 'off'} className={tab === 'off' ? 'active' : ''} onClick={() => setTab('off')}>
            Time off {timeOff.length > 0 && <span className="seg-count">{timeOff.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'hours'} className={tab === 'hours' ? 'active' : ''} onClick={() => setTab('hours')}>
            Working hours
          </button>
        </div>

        <div className="drawer-body">
          {tab === 'work' && (
            <>
              {projects.length > 0 && (
                <div className="person-section">
                  <h3>Projects</h3>
                  <div className="member-projects">
                    {projects.map((p) => (
                      <Link key={p.id} to={`/projects/${p.id}`} className="chip" onClick={onClose}>
                        <span className="dot" style={{ background: p.color }} />
                        {p.name}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {!tasks ? (
                has013 ? <LoadingState compact /> : <p className="muted small">Open tasks show here after migration 013.</p>
              ) : open.length === 0 ? (
                <EmptyState icon="checkCircle" title="No open tasks" text={`${isMe ? 'You have' : `${m.name.split(' ')[0]} has`} nothing assigned right now.`} compact />
              ) : (
                <>
                  {late.length > 0 && <TaskGroup title="Late" tone="danger" tasks={late} onOpen={openTask} />}
                  <TaskGroup title="Upcoming" tasks={upcoming} onOpen={openTask} />
                </>
              )}
            </>
          )}

          {tab === 'off' && <TimeOffTab workspaceId={workspaceId} member={m} timeOff={timeOff} canEdit={isMe || isAdmin} has013={has013} busy={busy} run={run} />}

          {tab === 'hours' && <HoursTab workspaceId={workspaceId} member={m} canEdit={isAdmin} has013={has013} busy={busy} run={run} />}
        </div>
      </aside>
    </>
  )
}

function TaskGroup({ title, tone, tasks, onOpen }: { title: string; tone?: 'danger'; tasks: import('../lib/types').Task[]; onOpen: (id: string) => void }) {
  return (
    <div className="person-section">
      <h3 className={tone === 'danger' ? 'text-danger' : ''}>
        {title} <span className="seg-count">{tasks.length}</span>
      </h3>
      <ul className="person-tasks">
        {tasks.map((t) => (
          <li key={t.id}>
            <button type="button" className="person-task" onClick={() => onOpen(t.id)}>
              <span className="person-task-title">
                <span className="truncate">{t.title}</span>
                {t.project && (
                  <span className="muted small truncate">
                    <span className="dot" style={{ background: t.project.color }} /> {t.project.name}
                  </span>
                )}
              </span>
              {t.estimate_minutes ? <span className="muted small">{formatMinutes(t.estimate_minutes)}</span> : null}
              <PriorityBadge priority={t.priority} />
              <DueDate date={t.due_date} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface TabProps {
  workspaceId: string
  member: Member
  canEdit: boolean
  has013: boolean
  busy: boolean
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>
}

function TimeOffTab({ workspaceId, member: m, timeOff, canEdit, has013, busy, run }: TabProps & { timeOff: TimeOff[] }) {
  const today = todayISO()
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [kind, setKind] = useState<TimeOffKind>('vacation')
  const [note, setNote] = useState('')

  if (!has013) return <p className="muted small">Time off needs database migration 013.</p>

  const add = (e: FormEvent) => {
    e.preventDefault()
    void run(() => planning.addTimeOff(workspaceId, m.id, { start_date: start, end_date: end < start ? start : end, kind, note }), 'Time off added').then(() => setNote(''))
  }

  return (
    <>
      <div className="person-section">
        <h3>Coming up (next 60 days)</h3>
        {timeOff.length === 0 ? (
          <p className="muted small">No time off planned.</p>
        ) : (
          <ul className="off-list">
            {timeOff.map((t) => (
              <li key={t.id}>
                <span className={`off-kind off-${t.kind}`}>{TIME_OFF_LABELS[t.kind]}</span>
                <span className="off-dates">
                  <strong>{formatRange(t.start_date, t.end_date)}</strong>
                  {t.note && <span className="muted small">{t.note}</span>}
                </span>
                {canEdit && (
                  <button type="button" className="icon-btn" aria-label="Remove this time off" title="Remove" disabled={busy} onClick={() => void run(() => planning.deleteTimeOff(t.id), 'Time off removed')}>
                    <Icon name="trash" size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canEdit ? (
        <form className="person-section off-form" onSubmit={add}>
          <h3>Add time off</h3>
          <div className="modal-row modal-row-even">
            <label className="field">
              <span>First day</span>
              <input id="off-start" className="input" type="date" value={start} required onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field">
              <span>Last day</span>
              <input id="off-end" className="input" type="date" value={end} min={start} required onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
          <div className="modal-row modal-row-even">
            <label className="field">
              <span>Type</span>
              <select id="off-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as TimeOffKind)}>
                {(Object.keys(TIME_OFF_LABELS) as TimeOffKind[]).map((k) => (
                  <option key={k} value={k}>
                    {TIME_OFF_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Note (optional)</span>
              <input id="off-note" className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            <Icon name="plus" size={15} /> Add time off
          </button>
        </form>
      ) : (
        <p className="muted small">Only {m.name.split(' ')[0]} or an admin can change this.</p>
      )}
    </>
  )
}

function HoursTab({ workspaceId, member: m, canEdit, has013, busy, run }: TabProps) {
  const [hours, setHours] = useState(String(m.hours_per_day))
  const [days, setDays] = useState<number[]>(m.work_days)
  if (!has013) return <p className="muted small">Working hours need database migration 013.</p>
  const h = Number(hours)
  const valid = hours.trim() !== '' && h >= 0 && h <= 24
  const changed = valid && (h !== m.hours_per_day || days.slice().sort().join() !== m.work_days.slice().sort().join())

  return (
    <div className="person-section">
      <h3>Working hours</h3>
      <p className="muted small">The Resources workload uses these to see who has room for more work.</p>
      <label className="field hours-field">
        <span>Hours per working day</span>
        <input id="hours-per-day" className="input" type="number" min={0} max={24} step={0.5} value={hours} disabled={!canEdit || busy} onChange={(e) => setHours(e.target.value)} />
      </label>
      <div className="field">
        <span>Working days</span>
        <div className="weekday-picker" role="group" aria-label="Working days">
          {WEEKDAYS.map((d) => {
            const on = days.includes(d.n)
            return (
              <button
                key={d.n}
                type="button"
                className={`weekday ${on ? 'on' : ''}`}
                aria-pressed={on}
                aria-label={d.label}
                title={d.label}
                disabled={!canEdit || busy}
                onClick={() => setDays((cur) => (on ? cur.filter((x) => x !== d.n) : [...cur, d.n]))}
              >
                {d.short}
              </button>
            )
          })}
        </div>
      </div>
      <p className="small">
        = <strong>{valid ? formatMinutes(Math.round(h * 60 * days.length)) : '—'}</strong> a week
      </p>
      {canEdit ? (
        <button type="button" className="btn btn-primary btn-sm" disabled={!changed || busy} onClick={() => void run(() => planning.setCapacity(workspaceId, m.id, h, days), 'Working hours saved')}>
          Save working hours
        </button>
      ) : (
        <p className="muted small">Only admins can change working hours.</p>
      )}
    </div>
  )
}
