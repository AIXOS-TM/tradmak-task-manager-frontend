import { useState, type FormEvent } from 'react'
import Icon from '../components/Icon'
import { api, errorMessage } from '../lib/api'
import { useAuth } from '../store/useApp'
import '../styles/onboarding.css'

/** Shown to signed-in people who aren't in any organization yet (e.g. right after signing up). */
export default function CreateOrganization() {
  const { user, refreshProfile, signOut } = useAuth()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api.createWorkspace(name.trim())
      refreshProfile()
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <div className="onboarding-page">
      <form className="card onboarding-card" onSubmit={onSubmit}>
        <div className="onboarding-brand">
          <span className="brand-mark">
            <Icon name="check" size={16} strokeWidth={3} />
          </span>
          Tradmak Tasks
        </div>
        <div>
          <h1>Create your organization</h1>
          <p className="muted">You'll be its owner, and you can invite your team by email right after.</p>
        </div>

        {error && <p className="form-error">{error}</p>}

        <label className="field">
          <span>Organization name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tradmak" maxLength={120} required autoFocus />
        </label>

        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={saving || !name.trim()}>
          {saving ? 'Creating…' : 'Create organization'}
          {!saving && <Icon name="arrowRight" size={16} />}
        </button>

        <div className="onboarding-foot">
          <span className="muted small">
            Joining a team instead? Ask its admin to invite <strong>{user?.email}</strong>.
          </span>
          <button type="button" className="link-btn small" onClick={() => void signOut()}>
            Log out
          </button>
        </div>
      </form>
    </div>
  )
}
