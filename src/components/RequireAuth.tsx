import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import CreateOrganization from '../pages/CreateOrganization'
import { useAuth } from '../store/useApp'
import Icon from './Icon'
import { FullPageLoader } from './States'

/**
 * Shows the app only to signed-in users; everyone else goes to /login.
 * Invited people finish their account on /welcome first; people without an organization create one.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status, profileError, refreshProfile, signOut, needsWelcome, workspaces } = useAuth()

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
  if (needsWelcome) return <Navigate to="/welcome" replace />
  if (workspaces.length === 0) return <CreateOrganization />
  return <>{children}</>
}
