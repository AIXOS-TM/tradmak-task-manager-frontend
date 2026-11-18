import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { FullPageLoader } from '../components/States'
import { useAuth } from '../store/useApp'
import '../styles/login.css'

const YEAR = new Date().getFullYear()

export default function Login() {
  const { status, session, notice, clearNotice, signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const isSignup = mode === 'signup'

  // Already signed in: go straight to the app.
  if (status === 'ready') return <Navigate to="/dashboard" replace />
  if (session && status === 'loading') return <FullPageLoader label="Signing you in…" />

  const switchMode = (next: 'login' | 'signup') => {
    setMode(next)
    setError(null)
    setInfo(null)
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setInfo(null)
    clearNotice()
    if (isSignup) {
      const result = await signUp(name, email, password)
      if (result.error) setError(result.error)
      else if (result.needsConfirmation) {
        setInfo('Account created. Check your email to confirm it, then log in.')
        setMode('login')
      }
      // With a session, AuthProvider loads the profile and this page redirects.
    } else {
      const message = await signIn(email, password)
      if (message) setError(message === 'Invalid login credentials' ? 'Wrong email or password.' : message)
    }
    setSubmitting(false)
  }

  return (
    <div className="login-page">
      <section className="login-hero">
        <div className="login-brand">
          <span className="brand-mark">
            <Icon name="check" size={18} strokeWidth={3} />
          </span>
          Tradmak Tasks
        </div>
        <div className="login-hero-body">
          <h1>Turn meetings into work that gets done.</h1>
          <p>Plan projects, track every task and let AI pull action items out of your meetings automatically.</p>
          <ul className="login-features">
            <li>
              <Icon name="sparkles" /> AI finds the action items in your meetings
            </li>
            <li>
              <Icon name="board" /> List and board views for every project
            </li>
            <li>
              <Icon name="users" /> See who owns what across the team
            </li>
          </ul>
        </div>
        <div className="login-hero-foot">© {YEAR} Tradmak</div>
      </section>

      <section className="login-form-wrap">
        <form className="login-card" onSubmit={onSubmit}>
          <div className="login-mobile-brand">
            <span className="brand-mark">
              <Icon name="check" size={16} strokeWidth={3} />
            </span>
            Tradmak Tasks
          </div>
          <h2>{isSignup ? 'Create your account' : 'Welcome back'}</h2>
          <p className="muted">{isSignup ? 'Start organizing your team in minutes.' : 'Log in to see your tasks.'}</p>

          <div className="segmented login-toggle" role="tablist">
            <button type="button" role="tab" aria-selected={!isSignup} className={!isSignup ? 'active' : ''} onClick={() => switchMode('login')}>
              Log in
            </button>
            <button type="button" role="tab" aria-selected={isSignup} className={isSignup ? 'active' : ''} onClick={() => switchMode('signup')}>
              Sign up
            </button>
          </div>

          {(error || notice) && (
            <p className="form-error" role="alert">
              {error ?? notice}
            </p>
          )}
          {info && (
            <p className="form-info" role="status">
              {info}
            </p>
          )}

          {isSignup && (
            <label className="field">
              <span>Full name</span>
              <div className="input-icon">
                <Icon name="user" size={16} />
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="name" required />
              </div>
            </label>
          )}

          <label className="field">
            <span>Email</span>
            <div className="input-icon">
              <Icon name="mail" size={16} />
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required />
            </div>
          </label>

          <label className="field">
            <span>Password</span>
            <div className="input-icon">
              <Icon name="lock" size={16} />
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSignup ? 'At least 6 characters' : '••••••••'}
                minLength={isSignup ? 6 : undefined}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                required
              />
            </div>
          </label>

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={submitting || status === 'loading'}>
            {submitting ? (isSignup ? 'Creating account…' : 'Logging in…') : isSignup ? 'Create account' : 'Login'}
            {!submitting && <Icon name="arrowRight" size={16} />}
          </button>

          <p className="login-switch muted">
            {isSignup ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button type="button" className="link-btn" onClick={() => switchMode(isSignup ? 'login' : 'signup')}>
              {isSignup ? 'Log in' : 'Sign up'}
            </button>
          </p>
        </form>
      </section>
    </div>
  )
}
