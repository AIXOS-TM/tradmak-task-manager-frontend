const DAY_MS = 24 * 60 * 60 * 1000

/** Parse a YYYY-MM-DD string as a local date (not UTC). */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Whole days from today until the date (negative = in the past). */
export function daysUntil(iso: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((parseDate(iso).getTime() - today.getTime()) / DAY_MS)
}

export function formatDue(iso: string): string {
  const n = daysUntil(iso)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n === -1) return 'Yesterday'
  return parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatLongDate(iso: string): string {
  return parseDate(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A local date as YYYY-MM-DD. */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The date `n` days after (or before, if negative) a YYYY-MM-DD date. */
export function addDays(iso: string, n: number): string {
  const d = parseDate(iso)
  d.setDate(d.getDate() + n)
  return toISODate(d)
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS)
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: string): number {
  return parseDate(iso).getDay() || 7
}

/** Monday of the week the date is in. */
export function startOfWeek(iso: string): string {
  return addDays(iso, 1 - isoWeekday(iso))
}

/** Minutes as "1h 30m", "45m", "8h". */
export function formatMinutes(min: number | null | undefined): string {
  if (!min) return '0h'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * Reads an estimate typed by a person: "2h", "1h 30m", "90m", "1.5" (hours), "1:30".
 * Returns minutes, null for an empty box, or NaN when it can't be read.
 */
export function parseEstimate(text: string): number | null {
  const s = text.trim().toLowerCase()
  if (!s) return null
  const colon = /^(\d+):(\d{1,2})$/.exec(s)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60)
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs|hr|h|minutes?|mins|min|m|days?|d)/g
  let total = 0
  let matched = ''
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const n = Number(m[1])
    const unit = m[2][0]
    total += unit === 'h' ? n * 60 : unit === 'd' ? n * 8 * 60 : n
    matched += m[0]
  }
  if (!matched || matched.replace(/\s/g, '') !== s.replace(/\s/g, '')) return NaN
  return Math.round(total)
}
