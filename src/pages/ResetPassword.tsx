import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { FullPageLoader } from '../components/States'
import { errorMessage } from '../lib/api'
import { linkErrorFromUrl } from '../lib/authLinks'
import { supabase } from '../lib/supabase'
import { useApp, useAuth } from '../store/useApp'
import '../styles/onboarding.css'

/** Where "reset your password" emails land: the link signs the person in, then they choose a new password. */
export default function ResetPassword() {
  const { status, session, user, signOut } = useAuth()
  const { showToast } = useApp()
  const navigate = useNavigate()
  const [linkError] = useState(linkErrorFromUrl)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status === 'loading' || (session && !user && status !== 'error')) return <FullPageLoader label="Checking your link…" />

  if (!session) {
    return (
      <div className="onboarding-page">
        <div className="card onboarding-card">
          <Brand />
          <h1>Reset link not valid</h1>
          <p className="muted">{linkError ?? 'This password reset link is not valid.'} Request a new one from the login page.</p>
          <Link to="/login" className="btn btn-primary">
            Go to login
          </Link>
        </div>
      </div>
    )
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 6) return setError('Password must be at least 6 characters.')
    if (password !== confirm) return setError("The two passwords don't match.")
    setSaving(true)
    setError(null)
    try {
      const { error: authError } = await supabase!.auth.updateUser({ password })
      if (authError) throw new Error(authError.message)
      showToast('Password changed')
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <div className="onboarding-page">
      <form className="card onboarding-card" onSubmit={onSubmit}>
        <Brand />
        <div>
          <h1>Choose a new password</h1>
          <p className="muted">For {session.user.email}.</p>
        </div>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>New password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" minLength={6} required autoFocus />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={saving}>
          {saving ? 'Saving…' : 'Save new password'}
        </button>
        <div className="onboarding-foot">
          <span className="muted small">You’ll stay signed in on this device.</span>
          <button type="button" className="link-btn small" onClick={() => void signOut()}>
            Not you? Log out
          </button>
        </div>
      </form>
    </div>
  )
}

function Brand() {
  return (
    <div className="onboarding-brand">
      <span className="brand-mark">
        <Icon name="check" size={16} strokeWidth={3} />
      </span>
      Tradmak Tasks
    </div>
  )
}
