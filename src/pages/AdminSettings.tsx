import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABELS } from '../lib/permissions'
import type { Workspace, WorkspaceSettings } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useAuth, useCurrentUser } from '../store/useApp'

/** Admin → Settings. `children` (the organization name form) is shown first. */
export default function SettingsTab({ workspace, children }: { workspace: Workspace; children?: ReactNode }) {
  const settings = useApi(() => api.workspaceSettings(workspace.id), [workspace.id])
  const isOwner = workspace.member_role === 'owner'

  return (
    <div className="settings-stack">
      {children}
      {settings.error && !settings.data ? (
        <div className="card admin-card">
          <ErrorState compact message={settings.error} onRetry={settings.reload} />
        </div>
      ) : !settings.data ? (
        <div className="card admin-card">
          <LoadingState compact label="Loading settings…" />
        </div>
      ) : (
        <>
          {/* key: start the forms over when the saved values change */}
          <DefaultListsCard key={`l-${settings.data.default_lists.join('|')}`} workspaceId={workspace.id} settings={settings.data} />
          <DomainsCard key={`d-${settings.data.allowed_domains.join('|')}`} workspaceId={workspace.id} settings={settings.data} />
        </>
      )}
      <ExportCard workspace={workspace} />
      {isOwner ? <TransferCard workspace={workspace} /> : null}
      <DangerZone workspace={workspace} />
    </div>
  )
}

function Card({ icon, title, text, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; text: ReactNode; children: ReactNode }) {
  return (
    <section className="card admin-card">
      <div className="admin-card-head">
        <h2>
          <Icon name={icon} size={16} /> {title}
        </h2>
        <p className="muted small">{text}</p>
      </div>
      {children}
    </section>
  )
}

/** Shared save handling for the settings forms. */
function useSave() {
  const { showToast, invalidate } = useApp()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (action: () => Promise<unknown>, done: string) => {
    setSaving(true)
    setError(null)
    try {
      await action()
      showToast(done)
      invalidate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }
  return { saving, error, save }
}

// ---------------------------------------------------------------------
// Default lists for new projects
// ---------------------------------------------------------------------

function DefaultListsCard({ workspaceId, settings }: { workspaceId: string; settings: WorkspaceSettings }) {
  const [lists, setLists] = useState(settings.default_lists)
  const [draft, setDraft] = useState('')
  const { saving, error, save } = useSave()
  const dirty = lists.join('|') !== settings.default_lists.join('|')

  const add = () => {
    const name = draft.trim()
    if (!name || lists.some((l) => l.toLowerCase() === name.toLowerCase()) || lists.length >= 12) return
    setLists([...lists, name])
    setDraft('')
  }
  const move = (i: number, by: -1 | 1) => {
    const next = [...lists]
    const [item] = next.splice(i, 1)
    next.splice(i + by, 0, item)
    setLists(next)
  }

  return (
    <Card icon="list" title="Default lists for new projects" text="Every new project starts with these lists, in this order. Existing projects don’t change.">
      {error && <p className="form-error">{error}</p>}
      <ol className="list-editor">
        {lists.map((l, i) => (
          <li key={l}>
            <span className="list-editor-num">{i + 1}</span>
            <span className="truncate">{l}</span>
            <div className="list-editor-actions">
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${l} up`}>
                ↑
              </button>
              <button type="button" className="icon-btn" disabled={i === lists.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${l} down`}>
                ↓
              </button>
              <button type="button" className="icon-btn" disabled={lists.length === 1} onClick={() => setLists(lists.filter((x) => x !== l))} aria-label={`Remove ${l}`}>
                <Icon name="x" size={15} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="admin-invite-row">
        <label className="field admin-grow">
          <span>Add a list</span>
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="e.g. QA"
            maxLength={60}
          />
        </label>
        <button type="button" className="btn btn-ghost" onClick={add} disabled={!draft.trim() || lists.length >= 12}>
          <Icon name="plus" size={15} /> Add
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save(() => api.updateWorkspaceSettings(workspaceId, { default_lists: lists }), 'Default lists saved')}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------
// Allowed email domains
// ---------------------------------------------------------------------

function DomainsCard({ workspaceId, settings }: { workspaceId: string; settings: WorkspaceSettings }) {
  const [text, setText] = useState(settings.allowed_domains.join(', '))
  const { saving, error, save } = useSave()
  const domains = text.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  const dirty = domains.join('|') !== settings.allowed_domains.join('|')

  return (
    <Card
      icon="shield"
      title="Who can be invited"
      text={
        settings.allowed_domains.length ? (
          <>
            Only <strong>{settings.allowed_domains.map((d) => '@' + d).join(', ')}</strong> email addresses can be invited right now.
          </>
        ) : (
          'Anyone can be invited right now. Add your company’s email domain to allow only those addresses.'
        )
      }
    >
      {error && <p className="form-error">{error}</p>}
      <div className="admin-invite-row">
        <label className="field admin-grow">
          <span>Allowed email domains</span>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="tradmak.com" />
          <span className="muted small">Separate several with commas. Leave empty to allow any address. People already in the organization stay.</span>
        </label>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save(() => api.updateWorkspaceSettings(workspaceId, { allowed_domains: domains }), 'Invite rules saved')}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------

function download(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ExportCard({ workspace }: { workspace: Workspace }) {
  const { showToast } = useApp()
  const [busy, setBusy] = useState<'tasks' | 'members' | null>(null)
  const slug = workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'organization'
  const today = new Date().toISOString().slice(0, 10)

  const run = async (kind: 'tasks' | 'members') => {
    setBusy(kind)
    try {
      const csv = kind === 'tasks' ? await api.exportTasksCsv(workspace.id) : await api.exportMembersCsv(workspace.id)
      download(`${slug}-${kind}-${today}.csv`, csv)
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card icon="layers" title="Export data" text="Download a CSV file that opens in Excel or Google Sheets. Personal tasks are never included.">
      <div className="export-buttons">
        <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => void run('tasks')}>
          <Icon name="tasks" size={15} /> {busy === 'tasks' ? 'Preparing…' : 'All project tasks (CSV)'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => void run('members')}>
          <Icon name="users" size={15} /> {busy === 'members' ? 'Preparing…' : 'Members (CSV)'}
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------

function TransferCard({ workspace }: { workspace: Workspace }) {
  const currentUser = useCurrentUser()
  const { refreshProfile } = useAuth()
  const people = useApi(() => api.users(workspace.id), [workspace.id])
  const [to, setTo] = useState('')
  const { saving, error, save } = useSave()
  const candidates = (people.data ?? []).filter((p) => p.id !== currentUser.id)

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const person = candidates.find((c) => c.id === to)
    if (!person) return
    if (!window.confirm(`Make ${person.name} the owner of ${workspace.name}? You'll stay on as an admin, and only ${person.name} will be able to transfer it again or delete it.`)) return
    void save(async () => {
      await api.transferOwnership(workspace.id, person.id)
      refreshProfile()
    }, `${person.name} is now the owner`)
  }

  return (
    <Card icon="user" title="Transfer ownership" text="Hand the organization to another member. You stay on as an admin.">
      {error && <p className="form-error">{error}</p>}
      <form className="admin-invite-row" onSubmit={onSubmit}>
        <label className="field admin-grow">
          <span>New owner</span>
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)} required>
            <option value="">Choose a member…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({ROLE_LABELS[c.member_role]})
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-ghost" disabled={!to || saving}>
          {saving ? 'Transferring…' : 'Transfer'}
        </button>
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------

function DangerZone({ workspace }: { workspace: Workspace }) {
  const { refreshProfile } = useAuth()
  const navigate = useNavigate()
  const isOwner = workspace.member_role === 'owner'
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const { saving, error, save } = useSave()

  const leave = () => {
    if (!window.confirm(`Leave ${workspace.name}? You'll lose access to its projects and tasks until someone invites you again.`)) return
    void save(async () => {
      await api.leaveWorkspace(workspace.id)
      refreshProfile()
      navigate('/dashboard')
    }, `You left ${workspace.name}`)
  }

  const remove = (e: FormEvent) => {
    e.preventDefault()
    if (typed.trim() !== workspace.name) return
    void save(async () => {
      await api.deleteWorkspace(workspace.id)
      refreshProfile()
      navigate('/dashboard')
    }, `${workspace.name} was deleted`)
  }

  return (
    <section className="card admin-card danger-zone">
      <div className="admin-card-head">
        <h2>
          <Icon name="alert" size={16} /> Danger zone
        </h2>
        <p className="muted small">
          {isOwner
            ? 'Deleting removes every project, task, meeting, comment and the activity log of this organization. It can’t be undone.'
            : 'Leaving removes your access to this organization. Your tasks stay and can be reassigned.'}
        </p>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!isOwner ? (
        <div>
          <button type="button" className="btn btn-danger" disabled={saving} onClick={leave}>
            {saving ? 'Leaving…' : 'Leave organization'}
          </button>
        </div>
      ) : !confirming ? (
        <div>
          <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
            Delete organization
          </button>
        </div>
      ) : (
        <form className="admin-invite-row" onSubmit={remove}>
          <label className="field admin-grow">
            <span>
              Type <strong>{workspace.name}</strong> to confirm
            </span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={typed.trim() !== workspace.name || saving}>
            {saving ? 'Deleting…' : 'Delete forever'}
          </button>
        </form>
      )}
    </section>
  )
}
