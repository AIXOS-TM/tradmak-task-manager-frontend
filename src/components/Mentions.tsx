/**
 * @mentions for any textarea: type "@" and a list of people appears; pick one with the mouse,
 * ↑ ↓ + Enter / Tab, or keep typing to filter. The picked people are remembered so the message
 * can carry their ids (the database then notifies them).
 */
import { Fragment, useCallback, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import Avatar from './Avatar'

export interface MentionPerson {
  id: string
  name: string
  avatar_color?: string
  /** Shown next to the name (job title, role, ...). */
  hint?: string
}

/** Special entry: notify everyone in the channel. */
export const EVERYONE: MentionPerson = { id: '@everyone', name: 'everyone', hint: 'Notify everyone in this channel' }

const QUERY_RE = /(^|[\s(])@([^\s@]{0,30})$/u

export function useMentions({
  value,
  setValue,
  inputRef,
  people,
  allowEveryone = false,
}: {
  value: string
  setValue: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  people: MentionPerson[]
  allowEveryone?: boolean
}) {
  const [query, setQuery] = useState<{ text: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const [picked, setPicked] = useState<MentionPerson[]>([])

  const options = useMemo(() => {
    if (!query) return []
    const q = query.text.toLowerCase()
    const all = allowEveryone ? [EVERYONE, ...people] : people
    return all
      .filter((p) => !q || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q))
      .slice(0, 6)
  }, [query, people, allowEveryone])

  /** Call after every change / caret move: opens, filters or closes the list. */
  const sync = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const before = el.value.slice(0, el.selectionStart ?? el.value.length)
    const m = before.match(QUERY_RE)
    if (m) {
      setQuery({ text: m[2], start: before.length - m[2].length - 1 })
      setActive(0)
    } else setQuery(null)
  }, [inputRef])

  const pick = useCallback(
    (p: MentionPerson) => {
      const el = inputRef.current
      if (!el || !query) return
      const caret = el.selectionStart ?? value.length
      const insert = `@${p.name} `
      const next = value.slice(0, query.start) + insert + value.slice(caret)
      setValue(next)
      setPicked((list) => (list.some((x) => x.id === p.id) ? list : [...list, p]))
      setQuery(null)
      const pos = query.start + insert.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    },
    [inputRef, query, value, setValue],
  )

  /** Handles ↑ ↓ Enter Tab Esc while the list is open. Returns true when it used the key. */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!query || options.length === 0) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[Math.min(active, options.length - 1)])
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setQuery(null)
        return true
      }
      return false
    },
    [query, options, active, pick],
  )

  /** The people still mentioned in `text` (a name deleted from the text is dropped). */
  const resolve = useCallback(
    (text: string) => {
      const inText = picked.filter((p) => text.includes(`@${p.name}`))
      return { ids: inText.filter((p) => p !== EVERYONE && p.id !== EVERYONE.id).map((p) => p.id), everyone: allowEveryone && /(^|\s)@everyone\b/.test(text) }
    },
    [picked, allowEveryone],
  )

  const reset = useCallback(() => {
    setPicked([])
    setQuery(null)
  }, [])

  const popup =
    query && options.length > 0 ? (
      <ul className="mention-menu" role="listbox" aria-label="Mention someone">
        {options.map((p, i) => (
          <li key={p.id} role="option" aria-selected={i === active}>
            <button
              type="button"
              className={`mention-option ${i === active ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()} // keep the focus in the text box
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
            >
              {p.id === EVERYONE.id ? <span className="mention-at">@</span> : <Avatar user={{ name: p.name, avatar_color: p.avatar_color ?? '#8b92a3' }} size={22} />}
              <span className="truncate">{p.id === EVERYONE.id ? '@everyone' : p.name}</span>
              {p.hint && <span className="muted small truncate">{p.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    ) : null

  return { sync, onKeyDown, popup, resolve, reset, open: !!query && options.length > 0 }
}

/**
 * Text with @mentions highlighted (and links clickable). `names` are the mentioned people's
 * names; `mine` is the reader's own name (highlighted more strongly).
 */
export function MentionText({ text, names, mine, everyone }: { text: string; names: string[]; mine?: string; everyone?: boolean }) {
  const tokens = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length).map((n) => `@${n}`)
  if (everyone) tokens.push('@everyone')
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts: ReactNode[] = []
  const re = new RegExp(`(https?:\\/\\/[^\\s<]+${tokens.length ? '|' + tokens.map(escape).join('|') : ''})`, 'g')
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) parts.push(<Fragment key={i++}>{text.slice(last, at)}</Fragment>)
    const token = m[0]
    if (token.startsWith('@')) {
      const self = token === '@everyone' || (mine && token === `@${mine}`)
      parts.push(
        <span key={i++} className={`mention ${self ? 'mention-me' : ''}`}>
          {token}
        </span>,
      )
    } else {
      parts.push(
        <a key={i++} href={token} target="_blank" rel="noopener noreferrer">
          {token}
        </a>,
      )
    }
    last = at + token.length
  }
  if (last < text.length) parts.push(<Fragment key={i++}>{text.slice(last)}</Fragment>)
  return <>{parts}</>
}
