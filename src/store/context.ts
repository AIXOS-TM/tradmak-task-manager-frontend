import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { JoinedWorkspace, User, Workspace } from '../lib/types'

// ---------- UI state shared across pages ----------

export interface Toast {
  id: number
  message: string
  tone: 'success' | 'error'
}

export interface AppContextValue {
  selectedTaskId: string | null
  openTask: (id: string) => void
  closeTask: () => void
  toast: Toast | null
  showToast: (message: string, tone?: Toast['tone']) => void
  dismissToast: () => void
  /** Bumped after every change; data hooks refetch when it changes. */
  version: number
  /** Call after a create/update/delete so every page on screen reloads its data. */
  invalidate: () => void
}

export const AppContext = createContext<AppContextValue | null>(null)

// ---------- Auth ----------

/**
 * loading    = checking the session / loading the profile
 * signed_out = no session (show the login page)
 * error      = signed in, but the profile couldn't be loaded (e.g. Supabase unreachable)
 * ready      = signed in with a profile
 */
export type AuthStatus = 'loading' | 'signed_out' | 'error' | 'ready'

export interface SignUpResult {
  error?: string
  /** True when the server requires email confirmation before the first login. */
  needsConfirmation?: boolean
}

export interface AuthContextValue {
  status: AuthStatus
  session: Session | null
  user: User | null
  workspaces: Workspace[]
  /** Why the user was sent back to login (e.g. session expired). */
  notice: string | null
  profileError: string | null
  /** Organizations just joined by accepting an email invite. */
  joined: JoinedWorkspace[]
  /** Invited by email and hasn't filled in the Welcome form (name, password) yet. */
  needsWelcome: boolean
  signIn: (email: string, password: string) => Promise<string | null>
  signUp: (name: string, email: string, password: string) => Promise<SignUpResult>
  signOut: () => Promise<void>
  refreshProfile: () => void
  clearNotice: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
