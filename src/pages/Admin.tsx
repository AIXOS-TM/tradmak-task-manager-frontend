import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Avatar from '../components/Avatar'
import Icon, { type IconName } from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABELS } from '../lib/permissions'
import type { AdminOverview, AssignableRole, Invitation, InviteResult, Workspace } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useAuth } from '../store/useApp'
import { timeAgo } from '../utils/format'
import ActivityTab, { RecentActivity } from './AdminActivity'
import MembersTab from './AdminMembers'
import ProjectsTab from './AdminProjects'
import SettingsTab from './AdminSettings'
import '../styles/admin.css'
import '../styles/dashboard.css'
import '../styles/team.css'

const ASSIGNABLE: AssignableRole[] = ['member', 'manager', 'admin']
const ROLE_HELP: Record<AssignableRole, string> = {
  admin: 'Everything, including inviting people and changing roles',
  manager: 'Assigns and manages everyone’s tasks, creates projects',
  member: 'Works on their own tasks, comments on any task',
}

/** Organization admin: settings, invitations and the team's workload. Owners and admins only. */
export default function Admin() {
  const { workspaces } = useAuth()
  const adminOf = workspaces.filter((w) => w.member_role === 'owner' || w.member_role === 'admin')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const workspace = adminOf.find((w) => w.id === selected) ?? adminOf[0] ?? null

  if (!workspace) {
    return (
      <div className="page">
        <div className="card">
          <EmptyState icon="lock" title="Admins only" text="Only organization owners and admins can open this page." />
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p className="muted">Manage your organization, invite people and keep an eye on the team’s workload.</p>
        </div>
        <div className="page-header-actions admin-orgs">
          {adminOf.length > 1 && (
            <div className="segmented" role="tablist" aria-label="Organization">
              {adminOf.map((w) => (
                <button key={w.id} type="button" role="tab" aria-selected={w.id === workspace.id} className={w.id === workspace.id ? 'active' : ''} onClick={() => setSelected(w.id)}>
                  {w.name}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setCreating((c) => !c)}>
            <Icon name="plus" size={16} /> New organization
          </button>
        </div>
      </div>

      {creating && (
        <NewOrganizationForm
          onCreated={(id) => {
            setSelected(id)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {/* key: reset every form when switching organizations */}
      <AdminWorkspace key={workspace.id} workspace={workspace} />
    </div>
  )
}

type TabId = 'overview' | 'members' | 'projects' | 'invites' | 'activity' | 'settings'
const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'layers' },
  { id: 'members', label: 'Members', icon: 'users' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'invites', label: 'Invites', icon: 'mail' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]

function AdminWorkspace({ workspace }: { workspace: Workspace }) {
  // The tab lives in the URL (/admin?tab=members) so it survives a refresh and can be linked to.
  const [params, setParams] = useSearchParams()
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview'
  const overview = useApi(() => api.adminOverview(workspace.id), [workspace.id], tab === 'overview')

  return (
    <>
      <nav className="admin-tabs" role="tablist" aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setParams(t.id === 'overview' ? {} : { tab: t.id }, { replace: true })}
          >
            <Icon name={t.icon} size={16} /> {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          <Stats overview={overview.data} />
          <div className="admin-grid">
            <Workload overview={overview.data} error={overview.error} onRetry={overview.reload} />
            <RecentActivity workspaceId={workspace.id} />
          </div>
        </>
      )}

      {tab === 'members' && <MembersTab workspace={workspace} />}

      {tab === 'projects' && <ProjectsTab workspace={workspace} />}

      {tab === 'invites' && (
        <div className="admin-grid admin-grid-flush">
          <InviteForm workspaceId={workspace.id} />
          <PendingInvites workspaceId={workspace.id} />
        </div>
      )}

      {tab === 'activity' && <ActivityTab workspace={workspace} />}

      {tab === 'settings' && (
        <div className="admin-narrow">
          <SettingsTab workspace={workspace}>
            <OrganizationSettings workspace={workspace} />
          </SettingsTab>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------

function Stats({ overview: o }: { overview: AdminOverview | undefined }) {
  const roleSummary = o
    ? (['owner', 'admin', 'manager', 'member'] as const)
        .filter((r) => o.roles[r] > 0)
        .map((r) => `${o.roles[r]} ${ROLE_LABELS[r].toLowerCase()}${o.roles[r] > 1 ? 's' : ''}`)
        .join(' · ')
    : ''
  const cards = [
    { label: 'Members', value: o?.members, sub: roleSummary || '—', icon: 'users' as const, tone: 'indigo' },
    { label: 'Open tasks', value: o?.open, sub: o ? `${o.due_this_week} due this week · ${o.projects} projects` : '—', icon: 'layers' as const, tone: 'violet' },
    { label: 'Overdue', value: o?.overdue, sub: o ? (o.overdue ? 'Past their due date' : 'Nothing overdue') : '—', icon: 'clock' as const, tone: 'amber' },
    { label: 'Pending invites', value: o?.pending_invites, sub: o ? `${o.done} tasks completed` : '—', icon: 'mail' as const, tone: 'green' },
  ]
  return (
    <div className="stat-grid">
      {cards.map((c) => (
        <div key={c.label} className={`card stat-card ${o ? '' : 'is-loading'}`}>
          <span className={`stat-icon tone-${c.tone}`}>
            <Icon name={c.icon} size={20} />
          </span>
          <div className="admin-stat-body">
            <div className="stat-label">{c.label}</div>
            <div className="stat-value">{c.value ?? '–'}</div>
            <div className="stat-sub">{c.sub}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------
// Invite people
// ---------------------------------------------------------------------

function InviteForm({ workspaceId }: { workspaceId: string }) {
  const { showToast, invalidate } = useApp()
  const [emails, setEmails] = useState('')
  const [role, setRole] = useState<AssignableRole>('member')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<InviteResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = emails.split(/[\s,;]+/).filter(Boolean)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (list.length === 0) return
    setSending(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.invite(workspaceId, list, role)
      setResult(res)
      if (res.sent.length) {
        showToast(res.sent.length === 1 ? `Invite sent to ${res.sent[0]}` : `${res.sent.length} invites sent`)
        // Keep only the addresses that still need attention in the box.
        setEmails(res.failed.map((f) => f.email).join('\n'))
      }
      invalidate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <form className="card admin-card" onSubmit={onSubmit}>
      <div className="admin-card-head">
        <h2>
          <Icon name="send" size={16} /> Invite people
        </h2>
        <p className="muted small">They get an email with a sign-in link. New people set their name and password when they open it.</p>
      </div>

      {error && <p className="form-error">{error}</p>}

      <label className="field">
        <span>Email addresses</span>
        <textarea
          className="input admin-emails"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder={'sara@company.com\nali@company.com'}
          rows={3}
        />
        <span className="muted small">One or more, separated by commas or new lines.</span>
      </label>

      <div className="admin-invite-row">
        <label className="field">
          <span>Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={sending || list.length === 0}>
          {sending ? 'Sending…' : list.length > 1 ? `Send ${list.length} invites` : 'Send invite'}
        </button>
      </div>
      <p className="muted small">
        <strong>{ROLE_LABELS[role]}:</strong> {ROLE_HELP[role]}.
      </p>

      {result && (result.sent.length > 0 || result.failed.length > 0) && (
        <ul className="invite-results">
          {result.sent.map((email) => (
            <li key={email} className="ok">
              <Icon name="check" size={14} /> {email}: invite sent
            </li>
          ))}
          {result.failed.map((f) => (
            <li key={f.email} className="fail">
              <Icon name="alert" size={14} /> {f.email}: {f.error}
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}

function PendingInvites({ workspaceId }: { workspaceId: string }) {
  const invites = useApi(() => api.invitations(workspaceId), [workspaceId])

  return (
    <section className="card admin-card">
      <div className="admin-card-head">
        <h2>
          <Icon name="mail" size={16} /> Pending invites
          {!!invites.data?.length && <span className="admin-count">{invites.data.length}</span>}
        </h2>
        <p className="muted small">People who haven’t opened their invite yet. Links expire after 7 days.</p>
      </div>
      {invites.error && !invites.data ? (
        <ErrorState compact message={invites.error} onRetry={invites.reload} />
      ) : !invites.data ? (
        <LoadingState compact label="Loading invites…" />
      ) : invites.data.length === 0 ? (
        <p className="muted small admin-empty">No pending invites.</p>
      ) : (
        <ul className="invite-list">
          {invites.data.map((inv) => (
            <InviteRow key={inv.id} invite={inv} />
          ))}
        </ul>
      )}
    </section>
  )
}

function InviteRow({ invite }: { invite: Invitation }) {
  const { showToast, invalidate } = useApp()
  const [busy, setBusy] = useState(false)
  const daysLeft = Math.ceil((new Date(invite.expires_at).getTime() - Date.now()) / 86_400_000)
  const expired = daysLeft <= 0

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await action()
      showToast(done)
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="invite-row">
      <div className="invite-main">
        <div className="strong truncate">{invite.email}</div>
        <div className="muted small">
          <span className={`role-badge role-${invite.role}`}>{ROLE_LABELS[invite.role]}</span> · sent {timeAgo(invite.created_at)}
          {invite.invited_by ? ` by ${invite.invited_by.name}` : ''} ·{' '}
          <span className={expired ? 'invite-expired' : ''}>{expired ? 'expired' : `expires in ${daysLeft}d`}</span>
        </div>
      </div>
      <div className="invite-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => api.resendInvite(invite), `Invite sent again to ${invite.email}`)}>
          Resend
        </button>
        <button
          type="button"
          className="link-btn link-danger small"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Cancel the invite for ${invite.email}? Their link will stop working.`)) {
              void run(() => api.cancelInvite(invite.id), 'Invite cancelled')
            }
          }}
        >
          Cancel
        </button>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------
// Organization settings
// ---------------------------------------------------------------------

function OrganizationSettings({ workspace }: { workspace: Workspace }) {
  const { showToast } = useApp()
  const { refreshProfile } = useAuth()
  const [name, setName] = useState(workspace.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = name.trim() !== workspace.name && !!name.trim()

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!dirty) return
    setSaving(true)
    setError(null)
    try {
      await api.renameWorkspace(workspace.id, name)
      refreshProfile()
      showToast('Organization renamed')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card admin-card" onSubmit={onSubmit}>
      <div className="admin-card-head">
        <h2>
          <Icon name="settings" size={16} /> Organization
        </h2>
        <p className="muted small">
          Created {new Date(workspace.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · you are{' '}
          {ROLE_LABELS[workspace.member_role]}
        </p>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="admin-invite-row">
        <label className="field admin-grow">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function NewOrganizationForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const { refreshProfile } = useAuth()
  const { showToast } = useApp()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const ws = await api.createWorkspace(name.trim())
      refreshProfile()
      showToast(`${ws.name} created. You're its owner.`)
      onCreated(ws.id)
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form className="card admin-card admin-new-org" onSubmit={onSubmit}>
      <div className="admin-card-head">
        <h2>
          <Icon name="plus" size={16} /> New organization
        </h2>
        <p className="muted small">A separate team with its own projects and members. You’ll be its owner.</p>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="admin-invite-row">
        <label className="field admin-grow">
          <span>Organization name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tradmak Marketing" maxLength={120} required autoFocus />
        </label>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
          {saving ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Team workload
// ---------------------------------------------------------------------

function Workload({ overview, error, onRetry }: { overview: AdminOverview | undefined; error: string | null; onRetry: () => void }) {
  const max = Math.max(1, ...(overview?.workload.map((w) => w.open) ?? [1]))
  return (
    <section className="card admin-card">
      <div className="admin-card-head admin-card-head-row">
        <div>
          <h2>
            <Icon name="users" size={16} /> Team workload
          </h2>
          <p className="muted small">Open project tasks per person, most overdue first.</p>
        </div>
        <Link to="/admin?tab=members" className="link-btn small">
          Manage members →
        </Link>
      </div>
      {error && !overview ? (
        <ErrorState compact message={error} onRetry={onRetry} />
      ) : !overview ? (
        <LoadingState compact label="Loading workload…" />
      ) : overview.workload.length === 0 ? (
        <p className="muted small admin-empty">No members yet. Invite your team to get started.</p>
      ) : (
        <ul className="workload-list">
          {overview.workload.map(({ user, open, overdue, done }) => (
            <li key={user.id} className="workload-row">
              <Avatar user={user} size={30} />
              <div className="workload-who">
                <div className="strong truncate">{user.name}</div>
                <div className="muted small truncate">
                  {ROLE_LABELS[user.member_role]} · {user.role}
                </div>
              </div>
              <div className="workload-bar" title={`${open} open, ${overdue} overdue, ${done} done`}>
                <span className="workload-bar-fill" style={{ width: `${(open / max) * 100}%` }} />
              </div>
              <div className="workload-nums small">
                <span>
                  <strong>{open}</strong> open
                </span>
                <span className={overdue ? 'workload-overdue' : 'muted'}>{overdue} overdue</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
