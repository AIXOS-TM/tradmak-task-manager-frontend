import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { FullPageLoader } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { linkErrorFromUrl } from '../lib/authLinks'
import { ROLE_LABELS } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { useAuth } from '../store/useApp'
import '../styles/onboarding.css'

/**
 * Where the invite email's magic link lands. The link signs the person in and AuthProvider
 * accepts their invitations; here new people set their name, job title and a password.
 */
export default function Welcome() {
  const { status, session, user, workspaces, needsWelcome, refreshProfile, signOut } = useAuth()
  const [linkError] = useState(linkErrorFromUrl)

  if (status === 'loading' || (session && !user && status !== 'error')) return <FullPageLoader label="Signing you in…" />

  if (status === 'signed_out' || status === 'error') {
    return (
      <div className="onboarding-page">
        <div className="card onboarding-card">
          <Brand />
          <h1>Invite link not valid</h1>
          <p className="muted">
            {linkError ?? 'We could not sign you in with this link.'} Ask your admin to press <strong>Resend</strong> on your invite, then use the
            newest email.
          </p>
          <Link to="/login" className="btn btn-primary">
            Go to login
          </Link>
        </div>
      </div>
    )
  }

  // Already set up (or an existing user who accepted an invite): straight into the app.
  if (!needsWelcome) return <Navigate to="/dashboard" replace />

  return <WelcomeForm key={user!.id} initialName={user!.name} email={user!.email} workspaces={workspaces} onDone={refreshProfile} onCancel={signOut} />
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

interface WelcomeFormProps {
  initialName: string
  email: string
  workspaces: { id: string; name: string; member_role: keyof typeof ROLE_LABELS }[]
  onDone: () => void
  onCancel: () => Promise<void>
}

function WelcomeForm({ initialName, email, workspaces, onDone, onCancel }: WelcomeFormProps) {
  const navigate = useNavigate()
  // The account was created from the email address alone, so its "name" is just the email prefix.
  const [name, setName] = useState(initialName === email.split('@')[0] ? '' : initialName)
  const [jobTitle, setJobTitle] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 6) return setError('Password must be at least 6 characters.')
    if (password !== confirm) return setError("The two passwords don't match.")
    setSaving(true)
    setError(null)
    try {
      await api.updateMe({ name: name.trim(), role: jobTitle.trim() })
      const { error: authError } = await supabase!.auth.updateUser({ password, data: { name: name.trim(), onboarded: true } })
      if (authError) throw new Error(authError.message)
      onDone()
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
          <h1>Welcome! Set up your account</h1>
          <p className="muted">You're signed in as {email}. Add your details and a password for next time.</p>
        </div>

        {workspaces.length > 0 && (
          <div className="onboarding-joined">
            {workspaces.map((w) => (
              <span key={w.id}>
                <Icon name="check" size={14} /> You joined <strong>{w.name}</strong> as {ROLE_LABELS[w.member_role]}
              </span>
            ))}
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <label className="field">
          <span>Full name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="name" required maxLength={100} autoFocus />
        </label>
        <label className="field">
          <span>Job title</span>
          <input className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. QA Engineer" maxLength={100} />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" minLength={6} required />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>

        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save and continue'}
          {!saving && <Icon name="arrowRight" size={16} />}
        </button>
        <div className="onboarding-foot">
          <span className="muted small">Next time, log in with your email and this password.</span>
          <button type="button" className="link-btn small" onClick={() => void onCancel()}>
            Not you? Log out
          </button>
        </div>
      </form>
    </div>
  )
}
