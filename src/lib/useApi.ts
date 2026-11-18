import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { useApp } from '../store/useApp'
import { errorMessage } from './api'

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

/**
 * Loads data from the API and keeps loading / error / data state.
 * Refetches when `deps` change, when reload() is called, or after any invalidate() in the app.
 * Pass enabled=false to skip the request (e.g. when it isn't needed yet).
 * `deps` should be simple values (ids, strings).
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: DependencyList, enabled = true): ApiState<T> {
  const { version } = useApp()
  const [nonce, setNonce] = useState(0)
  const [result, setResult] = useState<Result<T>>({ key: '', depsKey: '', data: undefined, error: null })

  // depsKey = what is being loaded (e.g. which project). key = one request; when it changes, a new request starts.
  const depsKey = deps.map(String).join('|')
  const key = `${version}|${nonce}|${depsKey}`

  const fetcherRef = useRef(fetcher)
  useEffect(() => {
    fetcherRef.current = fetcher
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetcherRef.current().then(
      (data) => {
        if (!cancelled) setResult({ key, depsKey, data, error: null })
      },
      (err: unknown) => {
        // Keep the last good data for the same thing, so a failed refresh doesn't blank the page.
        if (!cancelled)
          setResult((prev) => ({ key, depsKey, data: prev.depsKey === depsKey ? prev.data : undefined, error: errorMessage(err) }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, depsKey, enabled])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback(
    (update: (current: T | undefined) => T | undefined) => setResult((prev) => ({ ...prev, data: update(prev.data) })),
    [],
  )

  // Data loaded for a different id (e.g. the previous project) is never shown.
  const current = result.depsKey === depsKey
  return {
    data: current ? result.data : undefined,
    error: current ? result.error : null,
    loading: enabled && result.key !== key,
    reload,
    setData,
  }
}
