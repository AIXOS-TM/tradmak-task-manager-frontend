/**
 * Error Supabase puts in the URL when an email link (invite, password reset) is expired,
 * already used or otherwise invalid. Read it once when the page opens.
 */
export function linkErrorFromUrl(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search)
  const code = params.get('error_code')
  if (!params.get('error') && !code) return null
  if (code === 'otp_expired') return 'This link has expired or was already used.'
  return params.get('error_description')?.replace(/\+/g, ' ') ?? 'This link is not valid.'
}
