import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, AUTH_EXPIRED_EVENT, errorMessage } from '../lib/api'
import { supabase } from '../lib/supabase'
import type { JoinedWorkspace, User, Workspace } from '../lib/types'
import { AuthContext, type AuthContextValue, type AuthStatus, type SignUpResult } from './context'

interface ProfileState {
  /** Which signed-in user this profile belongs to. */
  userId: string
  data: { user: User; workspaces: Workspace[] } | null
  error: string | null
  /** Organizations joined through an invite during this visit (for the Welcome page). */
  joined: JoinedWorkspace[]
}

const NOT_CONFIGURED =
  'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env, then restart the dev server.'

/**
 * Auth with the browser Supabase client (anon key):
 * - checks for an existing session on load and listens for sign-in / sign-out,
 * - loads the profile (api.me) for the signed-in user,
 * - accepts pending email invitations (joins those organizations),
 * - signs out when Supabase rejects the session (expired / invalid).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionChecked, setSessionChecked] = useState(!supabase)
  const [profile, setProfile] = useState<ProfileState | null>(null)
  const [profileNonce, setProfileNonce] = useState(0)
  const [notice, setNotice] = useState<string | null>(supabase ? null : NOT_CONFIGURED)

  // 1. Existing session on load + live updates (login, logout, token refresh).
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionChecked(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  // 2. Load the profile whenever the signed-in user changes (or refreshProfile() is called).
  //    The previous profile stays on screen during a refresh, so the app doesn't flash.
  const userId = session?.user.id
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    ;(async () => {
      try {
        // Join any organization that invited this email (magic link invites). No-op otherwise.
        const joined = await api.acceptInvitations()
        const me = await api.me()
        if (!cancelled) {
          setProfile((prev) => ({ userId, data: me, error: null, joined: [...(prev?.userId === userId ? prev.joined : []), ...joined] }))
        }
      } catch (err) {
        if (!cancelled) setProfile((prev) => ({
            userId,
            data: prev?.userId === userId ? prev.data : null,
            error: errorMessage(err),
            joined: prev?.userId === userId ? prev.joined : [],
          }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId, profileNonce])

  // 3. Supabase rejected the session: it is no longer valid, so go back to login.
  useEffect(() => {
    const onExpired = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      setNotice(detail && detail !== 'Invalid or expired token' ? detail : 'Your session has expired. Please log in again.')
      void supabase?.auth.signOut()
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return NOT_CONFIGURED
    setNotice(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    return error ? error.message : null
  }, [])

  const signUp = useCallback(async (name: string, email: string, password: string): Promise<SignUpResult> => {
    if (!supabase) return { error: NOT_CONFIGURED }
    setNotice(null)
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      // "name" fills the profile; "app" marks this app's signups on the shared Supabase instance.
      options: { data: { name: name.trim(), app: 'taskapp' } },
    })
    if (error) return { error: error.message }
    if (data.user && data.user.identities?.length === 0) return { error: 'An account with that email already exists.' }
    return data.session ? {} : { needsConfirmation: true }
  }, [])

  const signOut = useCallback(async () => {
    setNotice(null)
    await supabase?.auth.signOut()
  }, [])

  const refreshProfile = useCallback(() => setProfileNonce((n) => n + 1), [])
  const clearNotice = useCallback(() => setNotice(null), [])

  // Only trust a profile loaded for the user who is signed in right now.
  const mine = profile && profile.userId === userId ? profile : null

  let status: AuthStatus
  if (!sessionChecked) status = 'loading'
  else if (!session) status = 'signed_out'
  else if (mine?.data) status = 'ready'
  else if (mine?.error) status = 'error'
  else status = 'loading'

  const value: AuthContextValue = {
    status,
    session,
    user: mine?.data?.user ?? null,
    workspaces: mine?.data?.workspaces ?? [],
    notice,
    profileError: mine?.error ?? null,
    joined: mine?.joined ?? [],
    needsWelcome: !!session?.user.user_metadata?.invited && !session.user.user_metadata?.onboarded,
    signIn,
    signUp,
    signOut,
    refreshProfile,
    clearNotice,
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
