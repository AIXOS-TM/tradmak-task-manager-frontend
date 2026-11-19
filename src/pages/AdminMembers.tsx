import { useEffect, useRef, useState, type FormEvent } from 'react'
import Avatar from '../components/Avatar'
import Icon, { type IconName } from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABELS } from '../lib/permissions'
import type { AdminMember, AssignableRole, Workspace } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useCurrentUser } from '../store/useApp'
import { formatShortDate, timeAgo } from '../utils/format'

const ASSIGNABLE: AssignableRole[] = ['admin', 'manager', 'member']

type Filter = 'all' | 'admins' | 'managers' | 'members' | 'deactivated'
const FILTERS: { id: Filter; label: string; match: (m: AdminMember) => boolean }[] = [
  { id: 'all', label: 'All', match: (m) => m.status === 'active' },
  { id: 'admins', label: 'Admins', match: (m) => m.status === 'active' && (m.member_role === 'owner' || m.member_role === 'admin') },
  { id: 'managers', label: 'Managers', match: (m) => m.status === 'active' && m.member_role === 'manager' },
  { id: 'members', label: 'Members', match: (m) => m.status === 'active' && m.member_role === 'member' },
  { id: 'deactivated', label: 'Deactivated', match: (m) => m.status === 'deactivated' },
]

/** Admin → Members: everyone in the organization, their role, workload and what an admin can do to them. */
export default function MembersTab({ workspace }: { workspace: Workspace }) {
  const members = useApi(() => api.adminMembers(workspace.id), [workspace.id])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [reassigning, setReassigning] = useState<AdminMember | null>(null)

  const all = members.data ?? []
  const q = query.trim().toLowerCase()
  const rule = FILTERS.find((f) => f.id === filter)!
  const visible = all.filter((m) => rule.match(m) && (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)))
  const activeOthers = (m: AdminMember) => all.filter((x) => x.status === 'active' && x.id !== m.id)

  return (
    <section className="card admin-members">
      <div className="members-toolbar">
        <div className="search members-search">
          <Icon name="search" size={16} className="search-icon" />
          <input type="search" placeholder="Search by name or email…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search members" />
        </div>
        <div className="segmented members-filter" role="tablist" aria-label="Filter members">
          {FILTERS.map((f) => {
            const count = all.filter(f.match).length
            if (f.id === 'deactivated' && count === 0) return null
            return (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
                {f.label} <span className="muted">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {members.error && !members.data ? (
        <ErrorState message={members.error} onRetry={members.reload} />
      ) : !members.data ? (
        <LoadingState label="Loading members…" />
      ) : visible.length === 0 ? (
        <EmptyState compact icon="users" title="No one here" text={q ? 'No member matches that search.' : 'Nobody in this group yet.'} />
      ) : (
        <div className="members-table" role="table" aria-label="Members">
          <div className="members-row members-head" role="row">
            <span role="columnheader">Member</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Tasks</span>
            <span role="columnheader">Joined</span>
            <span role="columnheader">Last active</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {visible.map((m) => (
            <MemberRow key={m.id} member={m} workspace={workspace} onReassign={() => setReassigning(m)} />
          ))}
        </div>
      )}

      {reassigning && (
        <ReassignModal workspaceId={workspace.id} member={reassigning} candidates={activeOthers(reassigning)} onClose={() => setReassigning(null)} />
      )}
    </section>
  )
}

function MemberRow({ member: m, workspace, onReassign }: { member: AdminMember; workspace: Workspace; onReassign: () => void }) {
  const currentUser = useCurrentUser()
  const { showToast, invalidate } = useApp()
  const [busy, setBusy] = useState(false)
  const isYou = m.id === currentUser.id
  const isOwner = m.member_role === 'owner'
  const deactivated = m.status === 'deactivated'
  const canChange = !isOwner && !isYou

  /** Runs an action with a toast; resolves to true when it worked. */
  const run = async (action: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true)
    try {
      await action()
      showToast(done)
      invalidate()
      return true
    } catch (err) {
      showToast(errorMessage(err), 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const deactivate = () => {
    const tasksNote = m.open ? ` Their ${m.open} open task${m.open > 1 ? 's' : ''} stay assigned to them until you reassign them.` : ''
    if (!window.confirm(`Deactivate ${m.name}? They won't be able to open ${workspace.name} until you reactivate them.${tasksNote}`)) return
    void run(() => api.setMemberStatus(workspace.id, m.id, 'deactivated'), `${m.name} was deactivated`).then((ok) => {
      // Offer to hand their open work to someone else right away.
      if (ok && m.open) onReassign()
    })
  }

  const remove = () => {
    if (!window.confirm(`Remove ${m.name} from ${workspace.name}? Their tasks stay and can be reassigned. To let them back in you'll need to invite them again.`)) return
    void run(() => api.removeMember(workspace.id, m.id), `${m.name} was removed`)
  }

  return (
    <div className={`members-row ${deactivated ? 'is-deactivated' : ''}`} role="row">
      <div className="members-who" role="cell">
        <Avatar user={m} size={34} />
        <div className="members-who-text">
          <div className="strong truncate">
            {m.name}
            {isYou && <span className="you-tag">You</span>}
          </div>
          <div className="muted small truncate">{m.email}</div>
        </div>
      </div>

      <div role="cell" className="members-cell" data-label="Role">
        {deactivated ? (
          <span className="role-badge role-deactivated">Deactivated</span>
        ) : canChange ? (
          <select
            className="input role-select"
            value={m.member_role}
            disabled={busy}
            aria-label={`Role of ${m.name}`}
            onChange={(e) => {
              const role = e.target.value as AssignableRole
              void run(() => api.updateMemberRole(workspace.id, m.id, role), `${m.name} is now ${ROLE_LABELS[role]}`)
            }}
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
      </div>

      <div role="cell" className="members-cell small" data-label="Tasks">
        <strong>{m.open}</strong> open
        {m.overdue > 0 && <span className="workload-overdue"> · {m.overdue} overdue</span>}
      </div>
      <div role="cell" className="members-cell small muted" data-label="Joined">
        {m.joined_at ? formatShortDate(m.joined_at) : '—'}
      </div>
      <div role="cell" className="members-cell small muted" data-label="Last active">
        {m.last_sign_in_at ? timeAgo(m.last_sign_in_at) : '—'}
      </div>

      <div role="cell" className="members-actions">
        <RowMenu
          disabled={busy}
          label={`Actions for ${m.name}`}
          items={[
            { label: 'Reassign open tasks', icon: 'users', hidden: m.open === 0, onClick: onReassign },
            { label: 'Send password reset email', icon: 'lock', hidden: deactivated, onClick: () => void run(() => api.sendPasswordReset(m.email), `Password reset email sent to ${m.email}`) },
            { label: 'Reactivate', icon: 'check', hidden: !deactivated || !canChange, onClick: () => void run(() => api.setMemberStatus(workspace.id, m.id, 'active'), `${m.name} can use ${workspace.name} again`) },
            { label: 'Deactivate', icon: 'x', hidden: deactivated || !canChange, danger: true, onClick: deactivate },
            { label: 'Remove from organization', icon: 'logout', hidden: !canChange, danger: true, onClick: remove },
          ]}
        />
      </div>
    </div>
  )
}

export interface MenuItem {
  label: string
  icon: IconName
  onClick: () => void
  hidden?: boolean
  danger?: boolean
}

/** The "⋯" actions menu used on admin table rows. */
export function RowMenu({ items, label, disabled }: { items: MenuItem[]; label: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const shown = items.filter((i) => !i.hidden)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  if (shown.length === 0) return null
  return (
    <div className="row-menu" ref={ref}>
      <button type="button" className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="dropdown row-menu-list" role="menu">
          {shown.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`dropdown-item ${item.danger ? 'danger' : ''}`}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              <Icon name={item.icon} size={15} /> {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ReassignModal({
  workspaceId,
  member,
  candidates,
  onClose,
}: {
  workspaceId: string
  member: AdminMember
  candidates: AdminMember[]
  onClose: () => void
}) {
  const { showToast, invalidate } = useApp()
  const [to, setTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!to) return
    setSaving(true)
    setError(null)
    try {
      const moved = await api.reassignOpenTasks(workspaceId, member.id, to)
      const name = candidates.find((c) => c.id === to)?.name ?? 'them'
      showToast(moved ? `${moved} task${moved > 1 ? 's' : ''} moved to ${name}` : 'No open tasks to move')
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
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="reassign-title" onSubmit={onSubmit}>
        <header className="modal-header">
          <div>
            <h2 id="reassign-title">Reassign open tasks</h2>
            <p className="muted small">
              Move {member.name}’s {member.open} unfinished project task{member.open === 1 ? '' : 's'} to someone else. Completed tasks and personal tasks stay
              with {member.name}.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          <label className="field">
            <span>Give the tasks to</span>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)} required autoFocus>
              <option value="">Choose a person…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({ROLE_LABELS[c.member_role]}, {c.open} open)
                </option>
              ))}
            </select>
          </label>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Not now
          </button>
          <button type="submit" className="btn btn-primary" disabled={!to || saving}>
            {saving ? 'Moving…' : `Move ${member.open} task${member.open === 1 ? '' : 's'}`}
          </button>
        </footer>
      </form>
    </>
  )
}
