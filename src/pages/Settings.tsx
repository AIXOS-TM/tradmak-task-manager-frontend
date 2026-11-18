import { useState, type FormEvent } from 'react'
import Avatar from '../components/Avatar'
import { api, errorMessage } from '../lib/api'
import { useApp, useAuth, useCurrentUser } from '../store/useApp'
import '../styles/settings.css'

// Notification preferences have no backend yet, so they're kept on this device only.
const NOTIFICATION_OPTIONS = [
  { key: 'assigned', label: 'A task is assigned to me', desc: 'Get notified when someone gives you a task.' },
  { key: 'due', label: 'Tasks due soon', desc: 'A reminder the day before a task is due.' },
  { key: 'comments', label: 'Comments and mentions', desc: 'When someone comments on your tasks.' },
  { key: 'ai', label: 'AI meeting action items', desc: 'When AI finds tasks for you in a meeting.' },
] as const

type NotifKey = (typeof NOTIFICATION_OPTIONS)[number]['key']
const PREFS_KEY = 'tradmak.notificationPrefs'

function loadPrefs(): Record<NotifKey, boolean> {
  const defaults = { assigned: true, due: true, comments: true, ai: false }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return defaults
  }
}

export default function Settings() {
  const currentUser = useCurrentUser()
  const { refreshProfile, workspaces } = useAuth()
  const { showToast } = useApp()
  const [name, setName] = useState(currentUser.name)
  const [role, setRole] = useState(currentUser.role)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notif, setNotif] = useState<Record<NotifKey, boolean>>(loadPrefs)

  const dirty = name.trim() !== currentUser.name || role.trim() !== currentUser.role

  const onSave = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api.updateMe({ name: name.trim(), role: role.trim() })
      refreshProfile()
      showToast('Profile saved')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const toggle = (key: NotifKey, value: boolean) => {
    setNotif((n) => {
      const next = { ...n, [key]: value }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        // storage unavailable: keep the change for this session only
      }
      return next
    })
  }

  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">Manage your profile and notifications.</p>
        </div>
      </div>

      <form className="card settings-card" onSubmit={onSave}>
        <div className="settings-card-head">
          <h2>Profile</h2>
          <p className="muted small">This is how you appear to your team.</p>
        </div>

        <div className="profile-row">
          <Avatar user={{ ...currentUser, name: name || currentUser.name }} size={64} />
          <div>
            <div className="strong">{currentUser.name}</div>
            <p className="muted small">
              {workspaces.map((w) => `${w.name} (${w.member_role})`).join(' · ') || 'No workspace'}
            </p>
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-grid">
          <label className="field">
            <span>Full name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </label>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" value={currentUser.email} readOnly disabled title="Your login email can't be changed here" />
          </label>
          <label className="field">
            <span>Job title</span>
            <input className="input" value={role} onChange={(e) => setRole(e.target.value)} maxLength={100} />
          </label>
        </div>

        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setName(currentUser.name)
              setRole(currentUser.role)
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <section className="card settings-card">
        <div className="settings-card-head">
          <h2>Notifications</h2>
          <p className="muted small">Saved on this device.</p>
        </div>
        <ul className="toggle-list">
          {NOTIFICATION_OPTIONS.map((o) => (
            <li key={o.key}>
              <div>
                <div className="strong">{o.label}</div>
                <div className="muted small">{o.desc}</div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={notif[o.key]} onChange={(e) => toggle(o.key, e.target.checked)} aria-label={o.label} />
                <span className="switch-track" />
              </label>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
