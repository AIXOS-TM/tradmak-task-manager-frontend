import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AvatarStack } from '../components/Avatar'
import { ProjectStatusBadge } from '../components/Badges'
import Icon from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import { planning } from '../lib/planning'
import type { Client, ClientInput, Project } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useAuth } from '../store/useApp'
import { formatDue } from '../utils/format'
import '../styles/planning.css'

const COLORS = ['#0891b2', '#4f46e5', '#059669', '#d97706', '#db2777', '#7c3aed', '#e11d48', '#475569']

/** Organizations where I may see the Clients page (admins, owners and managers). */
function useClientWorkspaces() {
  const { workspaces } = useAuth()
  const { canManageWork } = usePermissions()
  return workspaces.filter((w) => canManageWork(w.id))
}

export default function Clients() {
  const { clientId } = useParams()
  const allowed = useClientWorkspaces()
  if (allowed.length === 0) return <NoAccess />
  return clientId ? <ClientDetail id={clientId} /> : <ClientList />
}

export function NoAccess({ what = 'Clients' }: { what?: string }) {
  return (
    <div className="page">
      <div className="card no-access">
        <span className="no-access-icon">
          <Icon name="lock" size={26} />
        </span>
        <h1>You don't have access to {what}</h1>
        <p className="muted">Only admins and managers can open this page. Ask one of them if you need something here.</p>
        <Link to="/dashboard" className="btn btn-secondary btn-sm">
          Back to my work
        </Link>
      </div>
    </div>
  )
}

function ClientList() {
  const allowed = useClientWorkspaces()
  const [picked, setPicked] = useState<string | null>(null)
  const workspaceId = picked && allowed.some((w) => w.id === picked) ? picked : allowed[0].id
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [sort, setSort] = useState<'name' | 'open' | 'projects' | 'newest'>('name')
  const [editing, setEditing] = useState<Client | 'new' | null>(null)

  const clients = useApi(() => planning.clients(workspaceId), [workspaceId], true, { cache: `clients:${workspaceId}`, persist: true })
  const all = clients.data ?? []
  const archivedCount = all.filter((c) => c.status === 'archived').length

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all
      .filter((c) => (showArchived ? c.status === 'archived' : c.status === 'active'))
      .filter((c) => !q || [c.name, c.contact_name, c.email].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) =>
        sort === 'open'
          ? b.open_count - a.open_count
          : sort === 'projects'
            ? b.project_count - a.project_count
            : sort === 'newest'
              ? b.created_at.localeCompare(a.created_at)
              : a.name.localeCompare(b.name),
      )
  }, [all, query, showArchived, sort])

  const active = all.filter((c) => c.status === 'active')
  const openTotal = active.reduce((n, c) => n + c.open_count, 0)
  const lateTotal = active.reduce((n, c) => n + c.overdue_count, 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Clients</h1>
          <p className="muted">
            {clients.data
              ? `${active.length} ${active.length === 1 ? 'client' : 'clients'} · ${openTotal} open tasks${lateTotal ? ` · ${lateTotal} late` : ''}`
              : 'Loading clients…'}
          </p>
        </div>
        <div className="page-header-actions">
          {allowed.length > 1 && (
            <select className="input input-sm" value={workspaceId} onChange={(e) => setPicked(e.target.value)} aria-label="Organization">
              {allowed.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} /> Add client
          </button>
        </div>
      </div>

      <div className="plan-toolbar">
        <label className="input-icon plan-search">
          <Icon name="search" size={16} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clients, contacts, emails…" aria-label="Search clients" />
        </label>
        <select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort clients">
          <option value="name">Name (A–Z)</option>
          <option value="open">Most open tasks</option>
          <option value="projects">Most projects</option>
          <option value="newest">Newest first</option>
        </select>
        <div className="segmented" role="tablist" aria-label="Client status">
          <button type="button" role="tab" aria-selected={!showArchived} className={!showArchived ? 'active' : ''} onClick={() => setShowArchived(false)}>
            Active <span className="seg-count">{active.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={showArchived} className={showArchived ? 'active' : ''} onClick={() => setShowArchived(true)}>
            Archived <span className="seg-count">{archivedCount}</span>
          </button>
        </div>
      </div>

      {clients.error && !clients.data ? (
        <div className="card">
          <ErrorState message={clients.error} onRetry={clients.reload} />
        </div>
      ) : !clients.data ? (
        <div className="card">
          <LoadingState label="Loading clients…" />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          {all.length === 0 ? (
            <EmptyState
              icon="briefcase"
              title="No clients yet"
              text="Add the companies you work for, then link their projects to see everything for one client in one place."
              action={
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
                  <Icon name="plus" size={15} /> Add client
                </button>
              }
            />
          ) : (
            <EmptyState icon="search" title={query ? 'No clients match your search' : showArchived ? 'No archived clients' : 'No active clients'} />
          )}
        </div>
      ) : (
        <div className="client-grid">
          {visible.map((c) => (
            <Link key={c.id} to={`/clients/${c.id}`} className="card client-card">
              <div className="client-card-top">
                <ClientAvatar client={c} size={44} />
                <div className="client-card-title">
                  <h2 className="truncate">{c.name}</h2>
                  <span className="muted small truncate">{c.contact_name || c.email || 'No contact yet'}</span>
                </div>
              </div>
              <div className="client-stats">
                <div>
                  <strong>{c.project_count}</strong>
                  <span className="muted small">{c.project_count === 1 ? 'Project' : 'Projects'}</span>
                </div>
                <div>
                  <strong>{c.open_count}</strong>
                  <span className="muted small">Open tasks</span>
                </div>
                <div className={c.overdue_count ? 'is-late' : ''}>
                  <strong>{c.overdue_count}</strong>
                  <span className="muted small">Late</span>
                </div>
              </div>
              {(c.email || c.phone) && (
                <div className="client-contact small muted">
                  {c.email && (
                    <span className="truncate">
                      <Icon name="mail" size={13} /> {c.email}
                    </span>
                  )}
                  {c.phone && (
                    <span className="truncate">
                      <Icon name="phone" size={13} /> {c.phone}
                    </span>
                  )}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      {editing && <ClientModal workspaceId={workspaceId} client={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

export function ClientAvatar({ client, size = 36 }: { client: Pick<Client, 'name' | 'color'>; size?: number }) {
  const letters = client.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <span className="client-avatar" style={{ width: size, height: size, background: `${client.color}1f`, color: client.color, fontSize: size * 0.36 }} aria-hidden>
      {letters || '?'}
    </span>
  )
}

function ClientDetail({ id }: { id: string }) {
  const navigate = useNavigate()
  const { showToast, invalidate } = useApp()
  const { canManageMembers, canManageWork } = usePermissions()
  const data = useApi(() => planning.client(id), [id], true, { cache: `client:${id}` })
  const [editing, setEditing] = useState(false)
  const [linking, setLinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const c = data.data?.client
  const allProjects = useApi(() => api.projects(), [], !!c, { cache: 'projects', persist: true })

  if (data.error && !data.data) {
    return (
      <div className="page">
        <Link to="/clients" className="back-link">
          <Icon name="chevronLeft" size={16} /> Clients
        </Link>
        <div className="card">
          <ErrorState message={data.error} onRetry={data.reload} />
        </div>
      </div>
    )
  }
  if (!c || !data.data) {
    return (
      <div className="page">
        <div className="card">
          <LoadingState label="Loading client…" />
        </div>
      </div>
    )
  }
  if (!canManageWork(c.workspace_id)) return <NoAccess />

  const projects = data.data.projects
  const isAdmin = canManageMembers(c.workspace_id)
  const unlinked = (allProjects.data ?? []).filter((p) => p.workspace_id === c.workspace_id && !p.client_id)
  const done = c.done_count
  const total = c.open_count + c.done_count
  const pct = total ? Math.round((done / total) * 100) : 0

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      showToast(ok)
      invalidate()
      data.reload()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete ${c.name}? Its projects stay, they just won't belong to a client any more.`)) return
    setBusy(true)
    try {
      await planning.deleteClient(c.id)
      showToast(`${c.name} was deleted`)
      invalidate()
      navigate('/clients')
    } catch (err) {
      showToast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <Link to="/clients" className="back-link">
        <Icon name="chevronLeft" size={16} /> Clients
      </Link>
      <div className="page-header">
        <div className="client-hero">
          <ClientAvatar client={c} size={56} />
          <div>
            <h1>
              {c.name}
              {c.status === 'archived' && <span className="chip chip-sm archived-chip">Archived</span>}
            </h1>
            <p className="muted">
              {c.project_count} {c.project_count === 1 ? 'project' : 'projects'} · {c.open_count} open tasks
              {c.overdue_count > 0 && <span className="text-danger"> · {c.overdue_count} late</span>}
            </p>
          </div>
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)} disabled={busy}>
            <Icon name="edit" size={15} /> Edit
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() =>
              void run(
                () => planning.updateClient(c.id, { status: c.status === 'archived' ? 'active' : 'archived' }),
                c.status === 'archived' ? `${c.name} is active again` : `${c.name} was archived`,
              )
            }
          >
            {c.status === 'archived' ? 'Restore' : 'Archive'}
          </button>
          {isAdmin && (
            <button type="button" className="btn btn-ghost btn-sm link-danger" onClick={() => void remove()} disabled={busy}>
              <Icon name="trash" size={15} /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="client-layout">
        <aside className="card client-info">
          <h2>Contact</h2>
          <dl>
            <dt>Contact person</dt>
            <dd>{c.contact_name || <span className="muted">—</span>}</dd>
            <dt>Email</dt>
            <dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="muted">—</span>}</dd>
            <dt>Phone</dt>
            <dd>{c.phone ? <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a> : <span className="muted">—</span>}</dd>
            <dt>Website</dt>
            <dd>
              {c.website ? (
                <a href={/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer noopener">
                  {c.website.replace(/^https?:\/\//i, '')}
                </a>
              ) : (
                <span className="muted">—</span>
              )}
            </dd>
            <dt>Address</dt>
            <dd className="pre-line">{c.address || <span className="muted">—</span>}</dd>
          </dl>
          <h2>Notes</h2>
          <p className={`pre-line ${c.notes ? '' : 'muted'}`}>{c.notes || 'No notes yet.'}</p>
          <h2>Progress</h2>
          <div className="progress-row">
            <span className="small muted">
              {done} of {total} tasks done
            </span>
            <span className="small strong">{pct}%</span>
          </div>
          <div className="progress">
            <span style={{ width: `${pct}%`, background: c.color }} />
          </div>
        </aside>

        <section className="card client-projects">
          <div className="card-header">
            <h2>Projects</h2>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLinking((v) => !v)} disabled={busy}>
              <Icon name="plus" size={15} /> Add project
            </button>
          </div>
          {linking && (
            <div className="client-link-row">
              {allProjects.data && unlinked.length === 0 ? (
                <span className="muted small">Every project already has a client. Create a new project and pick {c.name} as its client.</span>
              ) : (
                <select
                  className="input"
                  defaultValue=""
                  disabled={busy || !allProjects.data}
                  aria-label="Project to add"
                  onChange={(e) => {
                    const p = unlinked.find((x) => x.id === e.target.value)
                    if (p) void run(() => api.updateProjectDetails(p.id, { client_id: c.id }), `${p.name} now belongs to ${c.name}`).then(() => setLinking(false))
                  }}
                >
                  <option value="" disabled>
                    {allProjects.data ? 'Pick a project without a client…' : 'Loading projects…'}
                  </option>
                  {unlinked.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {projects.length === 0 ? (
            <EmptyState icon="folder" title="No projects yet" text={`Add a project to see ${c.name}'s work here.`} compact />
          ) : (
            <ul className="client-project-list">
              {projects.map((p) => (
                <ClientProjectRow key={p.id} project={p} busy={busy} onUnlink={() => void run(() => api.updateProjectDetails(p.id, { client_id: null }), `${p.name} was removed from ${c.name}`)} />
              ))}
            </ul>
          )}
        </section>
      </div>

      {editing && <ClientModal workspaceId={c.workspace_id} client={c} onClose={() => setEditing(false)} onSaved={() => data.reload()} />}
    </div>
  )
}

function ClientProjectRow({ project: p, busy, onUnlink }: { project: Project; busy: boolean; onUnlink: () => void }) {
  const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0
  return (
    <li className="client-project">
      <Link to={`/projects/${p.id}`} className="client-project-main">
        <span className="dot" style={{ background: p.color }} />
        <span className="client-project-name">
          <strong className="truncate">{p.name}</strong>
          <span className="muted small">
            {p.open_count} open · {p.done_count} done{p.due_date ? ` · due ${formatDue(p.due_date).toLowerCase()}` : ''}
            {p.archived ? ' · archived' : ''}
          </span>
        </span>
      </Link>
      <span className="client-project-progress" title={`${pct}% done`}>
        <span className="progress">
          <span style={{ width: `${pct}%`, background: p.color }} />
        </span>
        <span className="small muted">{pct}%</span>
      </span>
      <ProjectStatusBadge status={p.status} />
      <AvatarStack users={p.members} max={3} size={24} />
      <button type="button" className="icon-btn" title="Remove from this client" aria-label={`Remove ${p.name} from this client`} onClick={onUnlink} disabled={busy}>
        <Icon name="x" size={16} />
      </button>
    </li>
  )
}

function ClientModal({ workspaceId, client, onClose, onSaved }: { workspaceId: string; client: Client | null; onClose: () => void; onSaved?: () => void }) {
  const navigate = useNavigate()
  const { showToast, invalidate } = useApp()
  const [form, setForm] = useState<ClientInput>({
    name: client?.name ?? '',
    contact_name: client?.contact_name ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    website: client?.website ?? '',
    address: client?.address ?? '',
    notes: client?.notes ?? '',
    color: client?.color ?? COLORS[0],
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof ClientInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (client) {
        await planning.updateClient(client.id, form)
        showToast('Client saved')
        invalidate()
        onSaved?.()
        onClose()
      } else {
        const created = await planning.createClient(workspaceId, form)
        showToast(`${created.name} was added`)
        invalidate()
        navigate(`/clients/${created.id}`)
      }
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={() => !saving && onClose()} />
      <form className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="client-modal-title" onSubmit={onSubmit}>
        <header className="modal-header">
          <div>
            <h2 id="client-modal-title">{client ? 'Edit client' : 'Add client'}</h2>
            <p className="muted small">Only the name is required.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          <label className="field">
            <span>Company name</span>
            <input id="cl-name" className="input" autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Acme Ltd" required maxLength={120} />
          </label>
          <div className="modal-row modal-row-even">
            <label className="field">
              <span>Contact person</span>
              <input id="cl-contact" className="input" value={form.contact_name} onChange={set('contact_name')} maxLength={120} />
            </label>
            <label className="field">
              <span>Email</span>
              <input id="cl-email" className="input" type="email" value={form.email} onChange={set('email')} maxLength={200} />
            </label>
          </div>
          <div className="modal-row modal-row-even">
            <label className="field">
              <span>Phone</span>
              <input id="cl-phone" className="input" type="tel" value={form.phone} onChange={set('phone')} maxLength={60} />
            </label>
            <label className="field">
              <span>Website</span>
              <input id="cl-website" className="input" value={form.website} onChange={set('website')} placeholder="example.com" maxLength={300} />
            </label>
          </div>
          <label className="field">
            <span>Address</span>
            <textarea id="cl-address" className="input textarea" rows={2} value={form.address} onChange={set('address')} maxLength={500} />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea id="cl-notes" className="input textarea" rows={3} value={form.notes} onChange={set('notes')} placeholder="Billing details, how they like to work, anything useful…" maxLength={5000} />
          </label>
          <div className="field">
            <span>Colour</span>
            <div className="color-picker" role="radiogroup" aria-label="Colour">
              {COLORS.map((col) => (
                <button
                  key={col}
                  type="button"
                  role="radio"
                  aria-checked={form.color === col}
                  aria-label={col}
                  className={`color-swatch ${form.color === col ? 'selected' : ''}`}
                  style={{ background: col }}
                  onClick={() => setForm((f) => ({ ...f, color: col }))}
                />
              ))}
            </div>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!form.name.trim() || saving}>
            {saving ? 'Saving…' : client ? 'Save' : 'Add client'}
          </button>
        </footer>
      </form>
    </>
  )
}
