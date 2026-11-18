import { useCallback, useState, type ReactNode } from 'react'
import { AppContext, type AppContextValue, type Toast } from './context'

/** UI state only (open task panel, toasts, refresh counter). All data comes from the API. */
export function AppProvider({ children }: { children: ReactNode }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [version, setVersion] = useState(0)

  const openTask = useCallback((id: string) => setSelectedTaskId(id), [])
  const closeTask = useCallback(() => setSelectedTaskId(null), [])
  const showToast = useCallback(
    (message: string, tone: Toast['tone'] = 'success') => setToast({ id: Date.now(), message, tone }),
    [],
  )
  const dismissToast = useCallback(() => setToast(null), [])
  const invalidate = useCallback(() => setVersion((v) => v + 1), [])

  const value: AppContextValue = {
    selectedTaskId,
    openTask,
    closeTask,
    toast,
    showToast,
    dismissToast,
    version,
    invalidate,
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
