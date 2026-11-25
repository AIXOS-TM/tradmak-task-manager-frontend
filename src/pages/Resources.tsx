import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Avatar from '../components/Avatar'
import { DueDate, PriorityBadge, ProjectStatusBadge } from '../components/Badges'
import Icon from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import { buildWorkload, loadLevel, planning, TIME_OFF_LABELS, type WorkloadCell, type WorkloadRow } from '../lib/planning'
import type { Member, Project } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useAuth } from '../store/useApp'
import { addDays, daysBetween, formatMinutes, isoWeekday, parseDate, startOfWeek, toISODate, todayISO } from '../utils/format'
import { LoadBar } from './People'
import '../styles/planning.css'

type Tab = 'workload' | 'timeline'

export default function Resources() {
  const { workspaces } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'timeline' ? 'timeline' : 'workload'
  const [picked, setPicked] = useState<string | null>(null)
  const workspaceId = picked ?? workspaces[0]?.id ?? null

  return (
    <div className="page page-wide">
      <div className="page-header">
        <div>
          <h1>Resources</h1>
          <p className="muted">{tab === 'workload' ? 'Who is working on what, and who has room for more.' : 'Every project with dates, on one timeline.'}</p>
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
          <div className="segmented" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={tab === 'workload'} className={tab === 'workload' ? 'active' : ''} onClick={() => setParams({}, { replace: true })}>
              <Icon name="barChart" size={15} /> Workload
            </button>
            <button type="button" role="tab" aria-selected={tab === 'timeline'} className={tab === 'timeline' ? 'active' : ''} onClick={() => setParams({ tab: 'timeline' }, { replace: true })}>
              <Icon name="timeline" size={15} /> Timeline
            </button>
          </div>
        </div>
      </div>
      {!workspaceId ? (
        <div className="card">
          <EmptyState icon="users" title="No organization yet" />
        </div>
      ) : tab === 'workload' ? (
        <Workload workspaceId={workspaceId} />
      ) : (
        <Timeline workspaceId={workspaceId} />
      )}
    </div>
  )
}

// =====================================================================
// Workload: people × days
// =====================================================================

const RANGES = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 28, label: '4 weeks' },
]

function Workload({ workspaceId }: { workspaceId: string }) {
  const today = todayISO()
  const [start, setStart] = useState(() => startOfWeek(today))
  const [length, setLength] = useState(14)
  const [weekends, setWeekends] = useState(false)
  const [query, setQuery] = useState('')
  const [cell, setCell] = useState<{ row: WorkloadRow; cell: WorkloadCell } | null>(null)
  const end = addDays(start, length - 1)

  const data = useApi(() => planning.workload(workspaceId, start, end), [workspaceId, start, end], true, { cache: `workload:${workspaceId}:${start}:${length}` })
  const allDays = useMemo(() => Array.from({ length }, (_, i) => addDays(start, i)), [start, length])
  const rows = useMemo(() => (data.data ? buildWorkload(data.data, allDays) : []), [data.data, allDays])
  const days = weekends ? allDays : allDays.filter((d) => isoWeekday(d) <= 5)

  const q = query.trim().toLowerCase()
  const visible = rows.filter((r) => !q || r.member.name.toLowerCase().includes(q) || r.member.role.toLowerCase().includes(q))
  const over = rows.filter((r) => loadLevel(r.planned, r.capacity) === 'over').length
  const unestimated = rows.reduce((n, r) => n + r.unestimated, 0)
  const unscheduled = rows.reduce((n, r) => n + r.unscheduled.length, 0)
  const total = rows.reduce((n, r) => n + r.planned, 0)
  const capacity = rows.reduce((n, r) => n + r.capacity, 0)

  // Keep an open cell in sync after a reload (e.g. after reassigning a task from it).
  const openCell = cell ? (rows.find((r) => r.member.id === cell.row.member.id)?.cells.find((c) => c.date === cell.cell.date) ?? null) : null
  const openRow = cell ? (rows.find((r) => r.member.id === cell.row.member.id) ?? null) : null

  const rangeLabel = `${parseDate(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${parseDate(end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  return (
    <>
      <div className="plan-toolbar">
        <div className="date-nav">
          <button type="button" className="icon-btn" aria-label="Earlier" onClick={() => setStart(addDays(start, -7))}>
            <Icon name="chevronLeft" />
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStart(startOfWeek(today))}>
            Today
          </button>
          <button type="button" className="icon-btn" aria-label="Later" onClick={() => setStart(addDays(start, 7))}>
            <Icon name="chevronRight" />
          </button>
          <strong className="date-nav-label">{rangeLabel}</strong>
        </div>
        <div className="segmented" role="tablist" aria-label="How many weeks">
          {RANGES.map((r) => (
            <button key={r.days} type="button" role="tab" aria-selected={length === r.days} className={length === r.days ? 'active' : ''} onClick={() => setLength(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
        <label className="check-inline small">
          <input type="checkbox" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} /> Show weekends
        </label>
        <label className="input-icon plan-search plan-search-sm">
          <Icon name="search" size={16} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a person…" aria-label="Find a person" />
        </label>
      </div>

      {data.data && (
        <div className="workload-summary">
          <div className="card mini-stat">
            <span className="muted small">Team load</span>
            <LoadBar planned={total} capacity={capacity} />
          </div>
          <div className={`card mini-stat ${over ? 'is-late' : ''}`}>
            <span className="muted small">Overloaded</span>
            <strong>
              {over} {over === 1 ? 'person' : 'people'}
            </strong>
          </div>
          <div className="card mini-stat">
            <span className="muted small">Tasks without an estimate</span>
            <strong>{unestimated}</strong>
          </div>
          <div className="card mini-stat">
            <span className="muted small">Open tasks without dates</span>
            <strong>{unscheduled}</strong>
          </div>
        </div>
      )}

      {data.error && !data.data ? (
        <div className="card">
          <ErrorState message={data.error} onRetry={data.reload} />
        </div>
      ) : !data.data ? (
        <div className="card">
          <LoadingState label="Working out everyone's load…" />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState icon="users" title="Nobody matches" />
        </div>
      ) : (
        <div className={`card workload-grid-wrap ${data.loading ? 'is-refreshing' : ''}`}>
          <div className="workload-grid" style={{ gridTemplateColumns: `minmax(190px, 240px) repeat(${days.length}, minmax(58px, 1fr))` }} role="grid" aria-label="Workload">
            <div className="wl-corner" role="columnheader">
              Person
            </div>
            {days.map((d) => {
              const date = parseDate(d)
              const isMonday = isoWeekday(d) === 1
              return (
                <div key={d} role="columnheader" className={`wl-day ${d === today ? 'is-today' : ''} ${isoWeekday(d) > 5 ? 'is-weekend' : ''} ${isMonday ? 'week-start' : ''}`}>
                  <span>{date.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <strong>{date.getDate()}</strong>
                </div>
              )
            })}
            {visible.map((r) => (
              <WorkloadLine key={r.member.id} row={r} days={days} today={today} onOpen={(c) => setCell({ row: r, cell: c })} />
            ))}
          </div>
        </div>
      )}

      <div className="wl-legend small muted">
        <span>
          <i className="load-free" /> Free
        </span>
        <span>
          <i className="load-ok" /> Has room
        </span>
        <span>
          <i className="load-busy" /> Nearly full (85%+)
        </span>
        <span>
          <i className="load-over" /> Overloaded
        </span>
        <span>
          <i className="load-off" /> Day off
        </span>
        <span className="wl-legend-note">Each open task's estimate is spread over the working days between its start and due date.</span>
      </div>

      {cell && openCell && openRow && (
        <CellDetails
          row={openRow}
          cell={openCell}
          members={data.data?.members ?? []}
          workspaceId={workspaceId}
          onClose={() => setCell(null)}
          onChanged={() => data.reload()}
        />
      )}
    </>
  )
}

function WorkloadLine({ row, days, today, onOpen }: { row: WorkloadRow; days: string[]; today: string; onOpen: (c: WorkloadCell) => void }) {
  const byDate = new Map(row.cells.map((c) => [c.date, c]))
  const m = row.member
  return (
    <>
      <div className="wl-person" role="rowheader">
        <Avatar user={m} size={30} />
        <span className="wl-person-name">
          <strong className="truncate">{m.name}</strong>
          <LoadBar planned={row.planned} capacity={row.capacity} compact />
          <span className="muted small">
            {formatMinutes(row.planned)} of {formatMinutes(row.capacity)}
            {row.unscheduled.length > 0 && ` · ${row.unscheduled.length} undated`}
          </span>
        </span>
      </div>
      {days.map((d) => {
        const c = byDate.get(d)!
        const level = c.timeOff || c.weekend ? (c.planned > 0 ? 'over' : 'off') : loadLevel(c.planned, c.capacity)
        const label = c.timeOff
          ? `${m.name}: ${TIME_OFF_LABELS[c.timeOff.kind]}`
          : `${m.name}, ${parseDate(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}: ${formatMinutes(c.planned)} planned of ${formatMinutes(c.capacity)}, ${c.tasks.length} tasks`
        return (
          <button
            key={d}
            type="button"
            role="gridcell"
            className={`wl-cell load-${level} ${d === today ? 'is-today' : ''} ${c.weekend ? 'is-weekend' : ''} ${isoWeekday(d) === 1 ? 'week-start' : ''}`}
            onClick={() => onOpen(c)}
            title={label}
            aria-label={label}
          >
            {c.timeOff ? (
              <span className="wl-off">
                <Icon name="plane" size={13} />
                <span>Off</span>
              </span>
            ) : c.tasks.length ? (
              <>
                <strong>{formatMinutes(c.planned)}</strong>
                <span className="wl-count">
                  {c.tasks.length} {c.tasks.length === 1 ? 'task' : 'tasks'}
                </span>
              </>
            ) : null}
          </button>
        )
      })}
    </>
  )
}

function CellDetails({ row, cell, members, workspaceId, onClose, onChanged }: { row: WorkloadRow; cell: WorkloadCell; members: Member[]; workspaceId: string; onClose: () => void; onChanged: () => void }) {
  const { openTask, showToast, invalidate } = useApp()
  const { canManageWork } = usePermissions()
  const manager = canManageWork(workspaceId)
  const [busy, setBusy] = useState<string | null>(null)
  const m = row.member
  const date = parseDate(cell.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Who has the most room that day (suggested first in the "Move to" list).
  const others = members
    .filter((x) => x.id !== m.id)
    .map((x) => ({ x, free: x.work_days.includes(isoWeekday(cell.date)) ? x.hours_per_day * 60 : 0 }))
    .sort((a, b) => b.free - a.free || a.x.name.localeCompare(b.x.name))

  const move = async (taskId: string, title: string, to: Member) => {
    setBusy(taskId)
    try {
      await api.updateTask(taskId, { assignee_id: to.id })
      showToast(`"${title}" moved to ${to.name}`)
      invalidate()
      onChanged()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="cell-title">
        <header className="modal-header">
          <div className="person-head">
            <Avatar user={m} size={40} />
            <div>
              <h2 id="cell-title">{m.name}</h2>
              <p className="muted small">{date}</p>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          {cell.timeOff ? (
            <p className="form-info">
              <Icon name="plane" size={14} /> {TIME_OFF_LABELS[cell.timeOff.kind]}
              {cell.timeOff.note ? `: ${cell.timeOff.note}` : ''}. Nothing should be planned for this day.
            </p>
          ) : cell.weekend ? (
            <p className="form-info">Not a working day for {m.name.split(' ')[0]}.</p>
          ) : null}
          <div className="cell-load">
            <LoadBar planned={cell.planned} capacity={cell.capacity} />
          </div>
          {cell.tasks.length === 0 ? (
            <EmptyState icon="checkCircle" title="Nothing planned" text={cell.capacity ? `${formatMinutes(cell.capacity)} free on this day.` : undefined} compact />
          ) : (
            <ul className="cell-tasks">
              {cell.tasks.map(({ task: t, perDay }) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="cell-task-main"
                    onClick={() => {
                      onClose()
                      openTask(t.id)
                    }}
                  >
                    <span className="truncate strong">{t.title}</span>
                    <span className="muted small">
                      {t.project && (
                        <>
                          <span className="dot" style={{ background: t.project.color }} /> {t.project.name} ·{' '}
                        </>
                      )}
                      {t.estimate_minutes ? `${formatMinutes(Math.round(perDay))} today of ${formatMinutes(t.estimate_minutes)}` : 'No estimate'}
                    </span>
                  </button>
                  <PriorityBadge priority={t.priority} />
                  <DueDate date={t.due_date} />
                  {manager && (
                    <select
                      className="input input-sm"
                      value=""
                      disabled={busy === t.id}
                      aria-label={`Move "${t.title}" to someone else`}
                      onChange={(e) => {
                        const to = members.find((x) => x.id === e.target.value)
                        if (to) void move(t.id, t.title, to)
                      }}
                    >
                      <option value="">{busy === t.id ? 'Moving…' : 'Move to…'}</option>
                      {others.map(({ x }) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          )}
          {row.unscheduled.length > 0 && (
            <details className="cell-undated">
              <summary className="small">
                {row.unscheduled.length} open {row.unscheduled.length === 1 ? 'task has' : 'tasks have'} no dates (not counted)
              </summary>
              <ul>
                {row.unscheduled.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="link-btn small"
                      onClick={() => {
                        onClose()
                        openTask(t.id)
                      }}
                    >
                      {t.title}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </>
  )
}

// =====================================================================
// Timeline: projects across months
// =====================================================================

const SPANS = [3, 6, 12]
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`
const addMonths = (iso: string, n: number) => {
  const d = parseDate(monthStart(iso))
  d.setMonth(d.getMonth() + n)
  return toISODate(d)
}

function Timeline({ workspaceId }: { workspaceId: string }) {
  const today = todayISO()
  const { canManageWork } = usePermissions()
  const manager = canManageWork(workspaceId)
  const [from, setFrom] = useState(() => addMonths(today, -1))
  const [span, setSpan] = useState(6)
  const [clientId, setClientId] = useState('all')
  const [hideDone, setHideDone] = useState(true)
  const [sort, setSort] = useState<'start' | 'due' | 'name' | 'client'>('start')
  const [editing, setEditing] = useState<Project | null>(null)

  const projects = useApi(() => api.projects(), [], true, { cache: 'projects', persist: true })
  const clients = useApi(() => planning.clients(workspaceId), [workspaceId], true)
  const to = addDays(addMonths(from, span), -1)
  const total = daysBetween(from, to) + 1
  const months = Array.from({ length: span }, (_, i) => addMonths(from, i))

  const list = (projects.data ?? [])
    .filter((p) => p.workspace_id === workspaceId)
    .filter((p) => clientId === 'all' || (clientId === 'none' ? !p.client_id : p.client_id === clientId))
    .filter((p) => !hideDone || p.status !== 'completed')
  const dated = list.filter((p) => p.start_date || p.due_date)
  const undated = list.filter((p) => !p.start_date && !p.due_date)
  const startOf = (p: Project) => p.start_date ?? p.created_at.slice(0, 10)
  const sorted = dated.slice().sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name)
      : sort === 'due'
        ? (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
        : sort === 'client'
          ? (a.client?.name ?? '~').localeCompare(b.client?.name ?? '~') || a.name.localeCompare(b.name)
          : startOf(a).localeCompare(startOf(b)),
  )
  const pos = (iso: string) => (daysBetween(from, iso) / total) * 100
  const todayPos = today >= from && today <= to ? pos(today) : null

  return (
    <>
      <div className="plan-toolbar">
        <div className="date-nav">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFrom(addMonths(from, -span))}>
            −{span} months
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFrom(addMonths(today, -1))}>
            Today
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFrom(addMonths(from, span))}>
            +{span} months
          </button>
        </div>
        <div className="segmented" role="tablist" aria-label="How many months">
          {SPANS.map((n) => (
            <button key={n} type="button" role="tab" aria-selected={span === n} className={span === n ? 'active' : ''} onClick={() => setSpan(n)}>
              {n} months
            </button>
          ))}
        </div>
        {(clients.data?.length ?? 0) > 0 && (
          <select className="input input-sm" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
            <option value="all">All clients</option>
            <option value="none">No client</option>
            {clients.data!.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort projects">
          <option value="start">Sort: start date</option>
          <option value="due">Sort: due date</option>
          <option value="name">Sort: name</option>
          <option value="client">Sort: client</option>
        </select>
        <label className="check-inline small">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide completed
        </label>
      </div>

      {projects.error && !projects.data ? (
        <div className="card">
          <ErrorState message={projects.error} onRetry={projects.reload} />
        </div>
      ) : !projects.data ? (
        <div className="card">
          <LoadingState label="Loading projects…" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="timeline"
            title="No projects to show"
            text={list.length ? 'None of these projects has a start or due date yet. Give them dates below to see them here.' : 'No projects match these filters.'}
          />
        </div>
      ) : (
        <div className="card timeline">
          <div className="tl-head">
            <div className="tl-label-col">Project</div>
            <div className="tl-track">
              {months.map((mo) => (
                <div key={mo} className="tl-month" style={{ left: `${pos(mo)}%`, width: `${(daysBetween(mo, addMonths(mo, 1)) / total) * 100}%` }}>
                  {parseDate(mo).toLocaleDateString('en-US', { month: 'short', year: span > 6 || mo.slice(5, 7) === '01' ? '2-digit' : undefined })}
                </div>
              ))}
            </div>
          </div>
          {sorted.map((p) => {
            const s = startOf(p)
            const e = p.due_date ?? s
            const visible = e >= from && s <= to
            const left = Math.max(0, pos(s < from ? from : s))
            const right = Math.min(100, pos(addDays(e > to ? to : e, 1)))
            const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0
            const late = p.due_date && p.due_date < today && p.status !== 'completed'
            return (
              <div key={p.id} className="tl-row">
                <div className="tl-label-col">
                  <Link to={`/projects/${p.id}`} className="tl-name">
                    <span className="dot" style={{ background: p.color }} />
                    <span className="truncate">{p.name}</span>
                  </Link>
                  <span className="muted small truncate">
                    {p.client ? p.client.name : 'No client'} · {pct}% done
                  </span>
                </div>
                <div className="tl-track">
                  {months.map((mo) => (
                    <span key={mo} className="tl-gridline" style={{ left: `${pos(mo)}%` }} />
                  ))}
                  {todayPos !== null && <span className="tl-today" style={{ left: `${todayPos}%` }} />}
                  {visible ? (
                    <button
                      type="button"
                      className={`tl-bar ${late ? 'is-late' : ''} ${!p.due_date ? 'open-ended' : ''}`}
                      style={{ left: `${left}%`, width: `${Math.max(0.8, right - left)}%`, background: `${p.color}2e`, borderColor: p.color }}
                      title={`${p.name}: ${s} → ${p.due_date ?? 'no due date'} · ${pct}% done${late ? ' · late' : ''}`}
                      onClick={() => (manager ? setEditing(p) : undefined)}
                      disabled={!manager}
                    >
                      <span className="tl-progress" style={{ width: `${pct}%`, background: p.color }} />
                      <span className="tl-bar-label">{p.name}</span>
                    </button>
                  ) : (
                    <span className="tl-outside muted small">{e < from ? '← earlier' : 'later →'}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {undated.length > 0 && (
        <section className="card tl-undated">
          <div className="card-header">
            <h2>Projects without dates</h2>
            <span className="muted small">{manager ? 'Give them a start and due date to place them on the timeline.' : 'An admin or manager can give them dates.'}</span>
          </div>
          <ul>
            {undated.map((p) => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="tl-name">
                  <span className="dot" style={{ background: p.color }} />
                  {p.name}
                </Link>
                <ProjectStatusBadge status={p.status} />
                {manager && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>
                    <Icon name="calendar" size={14} /> Set dates
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && <ProjectDatesModal project={editing} clients={(clients.data ?? []).filter((c) => c.status === 'active' || c.id === editing.client_id)} onClose={() => setEditing(null)} />}
    </>
  )
}

function ProjectDatesModal({ project, clients, onClose }: { project: Project; clients: { id: string; name: string }[]; onClose: () => void }) {
  const { showToast, invalidate } = useApp()
  const [start, setStart] = useState(project.start_date ?? '')
  const [due, setDue] = useState(project.due_date ?? '')
  const [clientId, setClientId] = useState(project.client_id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (start && due && start > due) {
      setError('The due date must be on or after the start date.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const patch: { start_date: string | null; due_date: string | null; client_id?: string | null } = { start_date: start || null, due_date: due || null }
      if ((clientId || null) !== project.client_id) patch.client_id = clientId || null
      await api.updateProjectDetails(project.id, patch)
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
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="dates-title" onSubmit={submit}>
        <header className="modal-header">
          <div>
            <h2 id="dates-title">{project.name}</h2>
            <p className="muted small">Dates and client</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          <div className="modal-row modal-row-even">
            <label className="field">
              <span>Start date</span>
              <input id="pd-start" className="input" type="date" value={start} max={due || undefined} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field">
              <span>Due date</span>
              <input id="pd-due" className="input" type="date" value={due} min={start || undefined} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
          {clients.length > 0 && (
            <label className="field">
              <span>Client</span>
              <select id="pd-client" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">No client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </>
  )
}
