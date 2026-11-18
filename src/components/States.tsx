import type { ReactNode } from 'react'
import Icon, { type IconName } from './Icon'

/** Spinner + label, used while a page or section is loading. */
export function LoadingState({ label = 'Loading…', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`state ${compact ? 'state-compact' : ''}`} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </div>
  )
}

/** Error message with an optional Retry button. */
export function ErrorState({ message, onRetry, compact = false }: { message: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={`state state-error ${compact ? 'state-compact' : ''}`} role="alert">
      <Icon name="alert" size={compact ? 18 : 26} />
      <div>
        <strong>Couldn't load this</strong>
        <p className="muted small">{message}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

/** Friendly "nothing here yet" message with an optional action. */
export function EmptyState({
  title,
  text,
  icon = 'tasks',
  action,
  compact = false,
}: {
  title: string
  text?: string
  icon?: IconName
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`state state-empty ${compact ? 'state-compact' : ''}`}>
      <span className="state-icon">
        <Icon name={icon} size={compact ? 18 : 22} />
      </span>
      <strong>{title}</strong>
      {text && <p className="muted small">{text}</p>}
      {action}
    </div>
  )
}

/** Full-screen loader for app start / sign-in. */
export function FullPageLoader({ label }: { label: string }) {
  return (
    <div className="full-page-state">
      <span className="brand-mark">
        <Icon name="check" size={18} strokeWidth={3} />
      </span>
      <LoadingState label={label} />
    </div>
  )
}
