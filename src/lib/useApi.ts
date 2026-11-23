import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { useApp } from '../store/useApp'
import { errorMessage } from './api'
import { readCache, resetShared, writeCache } from './cache'

export interface ApiState<T> {
  data: T | undefined
  error: string | null
  /** True while a request is in flight (also during background refreshes, when data is kept). */
  loading: boolean
  reload: () => void
  /** Change the cached data locally (for optimistic updates like drag & drop). */
  setData: (update: (current: T | undefined) => T | undefined) => void
}

interface Result<T> {
  key: string
  depsKey: string
  data: T | undefined
  error: string | null
}

export interface ApiOptions {
  /**
   * Remember the last result under this name: when the page is opened again it shows at once
   * and is refreshed in the background. The deps are added to the name automatically.
   */
  cache?: string
  /** Also keep it across reloads (localStorage, per user, removed on sign-out). */
  persist?: boolean
}

/**
 * Loads data from the API and keeps loading / error / data state.
 * Refetches when `deps` change, when reload() is called, or after any invalidate() in the app.
 * Pass enabled=false to skip the request (e.g. when it isn't needed yet).
 * `deps` should be simple values (ids, strings).
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: DependencyList, enabled = true, options: ApiOptions = {}): ApiState<T> {
  const { version } = useApp()
  const [nonce, setNonce] = useState(0)
  // depsKey = what is being loaded (e.g. which project). key = one request; when it changes, a new request starts.
  const depsKey = deps.map(String).join('|')
  const key = `${version}|${nonce}|${depsKey}`
  const cacheKey = options.cache ? `${options.cache}|${depsKey}` : null
  const persist = !!options.persist
  // Start from what this page showed last time (if cached); it's refreshed right away.
  const [result, setResult] = useState<Result<T>>(() => ({
    key: '',
    depsKey,
    data: cacheKey && enabled ? readCache<T>(cacheKey, persist) : undefined,
    error: null,
  }))

  const fetcherRef = useRef(fetcher)
  useEffect(() => {
    fetcherRef.current = fetcher
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetcherRef.current().then(
      (data) => {
        if (cacheKey) writeCache(cacheKey, data, persist)
        if (!cancelled) setResult({ key, depsKey, data, error: null })
      },
      (err: unknown) => {
        // Keep the last good data for the same thing, so a failed refresh doesn't blank the page.
        if (!cancelled)
          setResult((prev) => ({
            key,
            depsKey,
            data: prev.depsKey === depsKey ? prev.data : cacheKey ? readCache<T>(cacheKey, persist) : undefined,
            error: errorMessage(err),
          }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, depsKey, enabled, cacheKey, persist])

  // An explicit reload always asks the server (never a shared / reused result).
  const reload = useCallback(() => {
    resetShared()
    setNonce((n) => n + 1)
  }, [])
  const setData = useCallback(
    (update: (current: T | undefined) => T | undefined) =>
      setResult((prev) => {
        const data = update(prev.data)
        if (cacheKey && prev.depsKey === depsKey) writeCache(cacheKey, data, persist)
        return { ...prev, data }
      }),
    [cacheKey, depsKey, persist],
  )

  // Switched to something else (e.g. another project): show its cached copy until it arrives.
  const current = result.depsKey === depsKey
  const cached = !current && cacheKey && enabled ? readCache<T>(cacheKey, persist) : undefined
  return {
    data: current ? result.data : cached,
    error: current ? result.error : null,
    loading: enabled && result.key !== key,
    reload,
    setData,
  }
}
