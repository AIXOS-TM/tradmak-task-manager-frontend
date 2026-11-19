import { useState } from 'react'
import { Link } from 'react-router-dom'
import Avatar from '../components/Avatar'
import Icon from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABELS, usePermissions } from '../lib/permissions'
import type { AssignableRole, Member } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useAuth, useCurrentUser } from '../store/useApp'
import '../styles/team.css'

const ASSIGNABLE: AssignableRole[] = ['admin', 'manager', 'member']
export default function Team() {
  const currentUser = useCurrentUser()
  const { workspaces } = useAuth()
  const { canManageMembers } = usePermissions()
  const [selected, setSelected] = useState<string | null>(null)
  const workspaceId = selected ?? workspaces[0]?.id ?? null
  const isAdmin = canManageMembers(workspaceId)

  const members = useApi(() => api.users(workspaceId), [workspaceId], !!workspaceId)
  const projects = useApi(() => api.projects(), [])

  const list = members.data ?? []
  const openTotal = list.reduce((n, m) => n + m.open_count, 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <p className="muted">
            {members.data ? `${list.length} members · ${openTotal} open tasks across the team` : 'Loading your team…'}
          </p>
        </div>
        {workspaces.length > 1 && (
          <div className="segmented" role="tablist" aria-label="Workspace">
            {workspaces.map((w) => (
              <button key={w.id} type="button" role="tab" aria-selected={w.id === workspaceId} className={w.id === workspaceId ? 'active' : ''} onClick={() => setSelected(w.id)}>
                {w.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="card team-invite-banner">
          <span className="muted">
            <Icon name="mail" size={15} /> Want to add someone? Send them an email invite from the Admin page.
          </span>
          <Link to="/admin?tab=invites" className="btn btn-primary btn-sm">
            Invite people
          </Link>
        </div>
      )}

      {members.error && !members.data ? (
        <div className="card">
          <ErrorState message={members.error} onRetry={members.reload} />
        </div>
      ) : !members.data ? (
        <div className="card">
          <LoadingState label="Loading team…" />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState icon="users" title="No team members yet" text="People in your workspace will show up here." />
        </div>
      ) : (
        <div className="team-grid">
          {list.map((u) => (
            <MemberCard
              key={u.id}
              member={u}
              workspaceId={workspaceId!}
              isYou={u.id === currentUser.id}
              canEdit={isAdmin && u.member_role !== 'owner' && u.id !== currentUser.id}
              projects={(projects.data ?? []).filter((p) => p.workspace_id === workspaceId && p.members.some((m) => m.id === u.id))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface MemberCardProps {
  member: Member
  workspaceId: string
  isYou: boolean
  canEdit: boolean
  projects: { id: string; name: string; color: string }[]
}

function MemberCard({ member: u, workspaceId, isYou, canEdit, projects }: MemberCardProps) {
  const { showToast, invalidate } = useApp()
  const [busy, setBusy] = useState(false)
  const total = u.task_count || 1

  const changeRole = async (role: AssignableRole) => {
    setBusy(true)
    try {
      await api.updateMemberRole(workspaceId, u.id, role)
      showToast(`${u.name} is now ${ROLE_LABELS[role]}`)
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Remove ${u.name} from this workspace? Their tasks stay and can be reassigned.`)) return
    setBusy(true)
    try {
      await api.removeMember(workspaceId, u.id)
      showToast(`${u.name} was removed`)
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <article className="card member-card">
      <div className="member-top">
        <Avatar user={u} size={56} />
        <div className="member-info">
          <h2>
            {u.name}
            {isYou && <span className="you-tag">You</span>}
          </h2>
          <div className="muted">{u.role}</div>
          <span className="small member-email">
            <Icon name="mail" size={13} /> {u.email}
          </span>
        </div>
      </div>

      <div className="member-role-row">
        <span className="muted small">Role</span>
        {canEdit ? (
          <select
            className="input role-select"
            value={u.member_role === 'owner' ? 'admin' : u.member_role}
            disabled={busy}
            onChange={(e) => void changeRole(e.target.value as AssignableRole)}
            aria-label={`Role of ${u.name}`}
          >
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        ) : (
          <span className={`role-badge role-${u.member_role}`}>{ROLE_LABELS[u.member_role]}</span>
        )}
        {canEdit && (
          <button type="button" className="link-btn link-danger small" onClick={() => void remove()} disabled={busy}>
            Remove
          </button>
        )}
      </div>

      <div className="member-stats member-stats-3">
        <div>
          <span className="member-stat-value">{u.task_count}</span>
          <span className="muted small">Tasks</span>
        </div>
        <div>
          <span className="member-stat-value">{u.open_count}</span>
          <span className="muted small">Open</span>
        </div>
        <div>
          <span className="member-stat-value">{u.done_count}</span>
          <span className="muted small">Done</span>
        </div>
      </div>

      <div className="workload" title={`${u.open_count} open · ${u.done_count} done`}>
        <span className="wl-doing" style={{ width: `${(u.open_count / total) * 100}%` }} />
        <span className="wl-done" style={{ width: `${(u.done_count / total) * 100}%` }} />
      </div>
      <div className="workload-legend small muted">
        <span>
          <i className="wl-doing" /> Open {u.open_count}
        </span>
        <span>
          <i className="wl-done" /> Done {u.done_count}
        </span>
      </div>

      {projects.length > 0 && (
        <div className="member-projects">
          {projects.map((p) => (
            <span key={p.id} className="chip">
              <span className="dot" style={{ background: p.color }} />
              {p.name}
            </span>
          ))}
        </div>
      )}
    </article>
  )
}
