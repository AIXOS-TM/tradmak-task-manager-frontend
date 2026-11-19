import { createClient } from '@supabase/supabase-js'

// Browser-side client: uses ONLY the public anon key. Never the service_role key.
const supabaseUrl = import.meta.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env, then restart "npm run dev".',
  )
}

/** null until the env vars are set; the login page then explains what is missing. */
export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, { db: { schema: 'taskapp' } })
    : null

/**
 * A separate, session-less client used only to email magic links to invited people.
 * Keeping it apart means sending an invite can never touch the admin's own login.
 */
export function createMailerClient() {
  if (!supabaseUrl || !supabaseAnonKey) return null
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'tradmak-invite-mailer' },
  })
}
