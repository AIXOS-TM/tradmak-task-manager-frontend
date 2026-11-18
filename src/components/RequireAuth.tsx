import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../store/useApp'
import Icon from './Icon'
import { FullPageLoader } from './States'

/** Shows the app only to signed-in users; everyone else goes to /login. */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status, profileError, refreshProfile, signOut } = useAuth()

  if (status === 'loading') return <FullPageLoader label="Loading your workspace…" />
  if (status === 'signed_out') return <Navigate to="/login" replace />
  if (status === 'error') {
    return (
      <div className="full-page-state">
        <span className="state-icon state-icon-error">
          <Icon name="alert" size={24} />
        </span>
        <h1 className="full-page-title">We couldn't load your account</h1>
        <p className="muted">{profileError}</p>
        <div className="full-page-actions">
          <button type="button" className="btn btn-primary" onClick={refreshProfile}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>
            Log out
          </button>
        </div>
      </div>
    )
  }
  return <>{children}</>
}
