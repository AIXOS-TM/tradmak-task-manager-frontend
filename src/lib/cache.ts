/**
 * Two small caches that make the app feel fast over a slow connection to the Supabase server:
 *
 * 1. shared(key, fn): identical reads that run at the same time share one request
 *    (e.g. the sidebar, the bell and the dashboard all asking for "my tasks"). With a ttl the
 *    result is also reused for a while. resetShared() (called after every change in the app)
 *    makes the next read go to the server again, so nothing stale is reused after a write.
 *
 * 2. The page cache (readCache / writeCache): the last data each page showed. useApi shows it
 *    immediately when you come back to a page and refreshes it in the background. Entries marked
 *    persist are also kept in localStorage (per user, removed on sign-out) so a reload paints at once.
 */

// ---------------------------------------------------------------------
// 1. Shared requests
// ---------------------------------------------------------------------
interface SharedEntry {
  gen: number
  at: number
  promise: Promise<unknown>
  done: boolean
}
const sharedMap = new Map<string, SharedEntry>()
let generation = 0

export function shared<T>(key: string, fn: () => Promise<T>, ttlMs = 0): Promise<T> {
  const hit = sharedMap.get(key)
  if (hit && hit.gen === generation && (!hit.done || Date.now() - hit.at < ttlMs)) return hit.promise as Promise<T>
  const entry: SharedEntry = { gen: generation, at: Date.now(), promise: Promise.resolve(), done: false }
  entry.promise = fn().then(
    (value) => {
      entry.done = true
      entry.at = Date.now()
      return value
    },
    (err: unknown) => {
      if (sharedMap.get(key) === entry) sharedMap.delete(key) // never reuse a failure
      throw err
    },
  )
  sharedMap.set(key, entry)
  return entry.promise as Promise<T>
}

/** Stores an answer we already have (e.g. from a bigger request), so the next shared() read reuses it. */
export function seedShared<T>(key: string, value: T) {
  sharedMap.set(key, { gen: generation, at: Date.now(), promise: Promise.resolve(value), done: true })
}

/** Something changed: the next read of anything goes to the server. */
export function resetShared() {
  generation++
  sharedMap.clear()
}

// ---------------------------------------------------------------------
// 2. Page cache
// ---------------------------------------------------------------------
const PREFIX = 'tradmak.cache.'
const MAX_PERSISTED_CHARS = 400_000
const memory = new Map<string, unknown>()
let cacheUser: string | null = null

const storageKey = (key: string) => `${PREFIX}${cacheUser}.${key}`

/** Called by the auth provider: cached data always belongs to the signed-in user. */
export function setCacheUser(userId: string | null) {
  if (userId === cacheUser) return
  memory.clear()
  resetShared()
  cacheUser = userId
}

export function readCache<T>(key: string, persist = false): T | undefined {
  if (!cacheUser) return undefined
  if (memory.has(key)) return memory.get(key) as T
  if (!persist) return undefined
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw === null) return undefined
    const value = JSON.parse(raw) as T
    memory.set(key, value)
    return value
  } catch {
    return undefined
  }
}

export function writeCache(key: string, value: unknown, persist = false) {
  if (!cacheUser) return
  memory.set(key, value)
  if (!persist) return
  try {
    const raw = JSON.stringify(value)
    if (raw.length <= MAX_PERSISTED_CHARS) localStorage.setItem(storageKey(key), raw)
  } catch {
    // Storage full or blocked: the in-memory copy still works.
  }
}

/** Sign-out: forget everything cached for this browser (memory and localStorage). */
export function clearCache() {
  memory.clear()
  resetShared()
  cacheUser = null
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k)
    }
  } catch {
    // ignore
  }
}
