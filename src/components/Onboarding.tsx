// New-user help: a welcome card, a step-by-step product tour (different for members, managers
// and admins), a "Getting started" checklist, and a Help button to bring either back.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  checklistItems,
  checkProgress,
  ROLE_INTRO,
  tourRoleOf,
  tourSteps,
  useOnboardingState,
  type ChecklistId,
  type ChecklistItem,
  type TourRole,
} from '../lib/onboarding'
import { desktopEnabled, desktopSupported, enableDesktop } from '../lib/notifications'
import { useApi } from '../lib/useApi'
import { useApp, useAuth, useCurrentUser } from '../store/useApp'
import Icon from './Icon'
import '../styles/tour.css'

const START_TOUR = 'tt-start-tour'
const OPEN_CHECKLIST = 'tt-open-checklist'
/** Below this width the side menu slides in (see layout.css). */
const MENU_BREAKPOINT = 960

function startTour() {
  window.dispatchEvent(new Event(START_TOUR))
}

function useTourRole(): TourRole {
  const { workspaces } = useAuth()
  return tourRoleOf(workspaces.map((w) => w.member_role))
}

/** Everything new-user related. Rendered once, inside the app layout. */
export default function Onboarding({ setNavOpen }: { setNavOpen: (open: boolean) => void }) {
  const user = useCurrentUser()
  const role = useTourRole()
  const { state, update, markDone } = useOnboardingState(user.id)
  const [touring, setTouring] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const start = () => setTouring(true)
    const open = () => update({ checklistHidden: false, checklistOpen: true })
    window.addEventListener(START_TOUR, start)
    window.addEventListener(OPEN_CHECKLIST, open)
    return () => {
      window.removeEventListener(START_TOUR, start)
      window.removeEventListener(OPEN_CHECKLIST, open)
    }
  }, [update])

  // Opening Settings is how you "check your profile".
  useEffect(() => {
    if (location.pathname === '/settings') markDone('profile')
  }, [location.pathname, markDone])

  const finishTour = (completed: boolean) => {
    setTouring(false)
    setNavOpen(false)
    if (completed) {
      markDone('tour')
      update({ welcomed: true, tourDone: true, checklistHidden: false, checklistOpen: true })
    } else {
      update({ welcomed: true })
    }
  }

  // The new-meeting page has its own unsaved-work warning; don't start anything on top of it.
  const quietPage = location.pathname === '/meetings/new'
  const showWelcome = !state.welcomed && !touring && !quietPage

  return (
    <>
      {showWelcome && (
        <WelcomeCard
          name={user.name}
          role={role}
          onStart={() => {
            update({ welcomed: true })
            setTouring(true)
          }}
          onSkip={() => update({ welcomed: true, checklistOpen: true })}
        />
      )}
      {touring && <Tour role={role} setNavOpen={setNavOpen} onEnd={finishTour} />}
      {!touring && !showWelcome && !state.checklistHidden && (
        <Checklist
          role={role}
          userId={user.id}
          done={state.done}
          open={state.checklistOpen}
          setOpen={(o) => update({ checklistOpen: o })}
          onHide={() => update({ checklistHidden: true, checklistOpen: false })}
          onStartTour={() => setTouring(true)}
          markDone={markDone}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Welcome card
// ---------------------------------------------------------------------------

const ROLE_POINTS: Record<TourRole, string[]> = {
  member: ['See all your tasks in one place', 'Update a task and your manager sees it', 'Chat with your team'],
  manager: ['Create projects and give out tasks', 'Turn meetings into tasks with AI', 'See who is busy and what is late'],
  admin: ['Invite your team and set roles', 'Create projects and give out tasks', 'Turn meetings into tasks with AI'],
}

function WelcomeCard({ name, role, onStart, onSkip }: { name: string; role: TourRole; onStart: () => void; onSkip: () => void }) {
  const startRef = useRef<HTMLButtonElement>(null)
  useEffect(() => startRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onSkip()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onSkip])

  return (
    <div className="tour-layer tour-dim">
      <div className="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <div className="welcome-art" aria-hidden="true">
          <span className="welcome-mark">
            <Icon name="check" size={26} strokeWidth={3} />
          </span>
        </div>
        <p className="welcome-eyebrow">Welcome to Tradmak Tasks</p>
        <h2 id="welcome-title">Hi {name.split(' ')[0] || 'there'}, glad you’re here!</h2>
        <span className="welcome-role">
          <Icon name="user" size={13} /> You’re {role === 'admin' ? 'an' : 'a'} {ROLE_INTRO[role].label.toLowerCase()}
        </span>
        <p className="welcome-text">{ROLE_INTRO[role].text}</p>
        <ul className="welcome-points">
          {ROLE_POINTS[role].map((p) => (
            <li key={p}>
              <Icon name="checkCircle" size={16} /> {p}
            </li>
          ))}
        </ul>
        <div className="welcome-actions">
          <button ref={startRef} type="button" className="btn btn-primary" onClick={onStart}>
            <Icon name="compass" size={16} /> Show me around
          </button>
          <button type="button" className="btn btn-ghost" onClick={onSkip}>
            Skip, I’ll explore
          </button>
        </div>
        <p className="welcome-foot">Takes about a minute. You can replay it any time from the <Icon name="help" size={13} /> button at the top.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The tour
// ---------------------------------------------------------------------------

interface Box {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 6
const GAP = 14
const CARD_W = 340

/** Finds a visible element for a step; waits a little for the page to draw it. */
function useTarget(target: string | undefined, stepKey: string): Box | null | 'waiting' {
  const [found, setFound] = useState<{ key: string; box: Box | null }>({ key: '', box: null })
  const key = `${target}|${stepKey}`

  useLayoutEffect(() => {
    if (!target) return
    const setBox = (box: Box | null) => setFound({ key, box })
    let el: Element | null = null
    let tries = 0
    let raf = 0
    let timer = 0
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth
    }
    const measure = () => {
      if (!el) return
      const r = el.getBoundingClientRect()
      setBox({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
    }
    const onMove = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    const find = () => {
      const found = [...document.querySelectorAll(`[data-tour="${target}"]`)].find(visible) ?? null
      if (found) {
        el = found
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        // The side menu slides in on phones; measure after it has moved.
        timer = window.setTimeout(measure, 260)
        measure()
      } else if (tries++ < 25) {
        timer = window.setTimeout(find, 100)
      } else {
        setBox(null)
      }
    }
    find()
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [target, key])

  if (!target) return null
  return found.key === key ? found.box : 'waiting'
}

/** Where the tip card goes: beside the highlighted thing, or a bottom sheet on phones. */
function cardPosition(box: Box | null, cardH: number): React.CSSProperties | undefined {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!box) return undefined // CSS: centered card
  if (vw < 600) {
    // Phones: a sheet at the bottom (CSS), or at the top when the highlighted thing is down there.
    return box.top + box.height > vh - cardH - 24 ? { top: 12, bottom: 'auto' } : undefined
  }
  const w = Math.min(CARD_W, vw - 32)
  const clampTop = (t: number) => Math.max(16, Math.min(t, vh - cardH - 16))
  const clampLeft = (l: number) => Math.max(16, Math.min(l, vw - w - 16))
  // Right of it (side menu items)
  if (box.left + box.width + GAP + w <= vw - 16) return { top: clampTop(box.top + box.height / 2 - cardH / 2), left: box.left + box.width + GAP, width: w }
  // Below it
  if (box.top + box.height + GAP + cardH <= vh - 16) return { top: box.top + box.height + GAP, left: clampLeft(box.left + box.width - w), width: w }
  // Above it
  if (box.top - GAP - cardH >= 16) return { top: box.top - GAP - cardH, left: clampLeft(box.left + box.width - w), width: w }
  // Left of it
  return { top: clampTop(box.top), left: Math.max(16, box.left - GAP - w), width: w }
}

function Tour({ role, setNavOpen, onEnd }: { role: TourRole; setNavOpen: (open: boolean) => void; onEnd: (completed: boolean) => void }) {
  const steps = useMemo(() => tourSteps(role), [role])
  const [i, setI] = useState(0)
  const step = steps[i]
  const navigate = useNavigate()
  const location = useLocation()
  const cardRef = useRef<HTMLDivElement>(null)
  const [cardH, setCardH] = useState(220)
  const last = i === steps.length - 1

  // Show the page behind the tip, and slide the menu in on phones when the step is about it.
  useEffect(() => {
    if (step.route && location.pathname !== step.route) navigate(step.route)
    setNavOpen(!!step.inMenu && window.innerWidth <= MENU_BREAKPOINT)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i])

  const box = useTarget(step.target, `${i}`)

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight)
  }, [i, box])
  // Focus the card once it is placed (it is hidden while the page draws the highlighted item).
  const placed = box !== 'waiting'
  useEffect(() => {
    if (placed) cardRef.current?.focus({ preventScroll: true })
  }, [i, placed])

  const next = useCallback(() => (last ? onEnd(true) : setI((n) => n + 1)), [last, onEnd])
  const back = useCallback(() => setI((n) => Math.max(0, n - 1)), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEnd(false)
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') back()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [next, back, onEnd])

  const spot = box && box !== 'waiting' ? box : null
  const style = box === 'waiting' ? { visibility: 'hidden' as const } : cardPosition(spot, cardH)

  return (
    <div className={`tour-layer ${spot ? '' : 'tour-dim'}`} onClick={(e) => e.stopPropagation()}>
      {spot && <div className="tour-spot" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} aria-hidden="true" />}
      <div
        ref={cardRef}
        className={`tour-card ${spot ? 'is-anchored' : 'is-center'}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
      >
        <div className="tour-top">
          <span className="tour-count">
            Step {i + 1} of {steps.length}
          </span>
          <button type="button" className="icon-btn tour-close" onClick={() => onEnd(false)} aria-label="Close the tour">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="tour-progress" aria-hidden="true">
          <span style={{ width: `${((i + 1) / steps.length) * 100}%` }} />
        </div>
        <h3 id="tour-title">{step.title}</h3>
        <p id="tour-body">{step.body}</p>
        {step.tip && (
          <p className="tour-tip">
            <Icon name="sparkles" size={14} /> {step.tip}
          </p>
        )}
        <div className="tour-actions">
          {i > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={back}>
              <Icon name="chevronLeft" size={15} /> Back
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEnd(false)}>
              Skip tour
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={next}>
            {last ? 'Finish' : 'Next'} {!last && <Icon name="chevronRight" size={15} />}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Getting started checklist
// ---------------------------------------------------------------------------

function Checklist({
  role,
  userId,
  done,
  open,
  setOpen,
  onHide,
  onStartTour,
  markDone,
}: {
  role: TourRole
  userId: string
  done: ChecklistId[]
  open: boolean
  setOpen: (open: boolean) => void
  onHide: () => void
  onStartTour: () => void
  markDone: (id: ChecklistId) => void
}) {
  const items = checklistItems(role)
  const location = useLocation()
  const navigate = useNavigate()
  const { showToast } = useApp()
  const progress = useApi(() => checkProgress(userId), [userId], true, { cache: 'onboarding-progress', persist: true })
  const reload = progress.reload
  // Things change as people use the app: look again when they move to another page.
  const firstPath = useRef(true)
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false
      return
    }
    reload()
  }, [location.pathname, reload])

  const isDone = (id: ChecklistId) => done.includes(id) || !!progress.data?.[id] || (id === 'notify' && desktopEnabled())
  const count = items.filter((it) => isDone(it.id)).length
  const all = count === items.length
  const pct = Math.round((count / items.length) * 100)

  const go = async (it: ChecklistItem) => {
    if (it.id === 'tour') {
      setOpen(false)
      onStartTour()
      return
    }
    if (it.id === 'notify') {
      if (!desktopSupported()) {
        showToast("This browser doesn't support desktop notifications.", 'error')
        return
      }
      const r = await enableDesktop()
      if (r === 'granted') {
        markDone('notify')
        showToast('Desktop notifications are on')
      } else if (r === 'denied') showToast('Notifications are blocked for this site. Allow them from the icon in the address bar.', 'error')
      return
    }
    if (it.to) {
      navigate(it.to)
      if (window.innerWidth < 600) setOpen(false)
    }
  }

  // The chat composer sits at the bottom of the screen on phones; keep out of its way.
  if (!open && window.innerWidth < 600 && location.pathname.startsWith('/chat')) return null

  if (!open) {
    return (
      <button type="button" className="checklist-pill" onClick={() => setOpen(true)} aria-label={`Getting started: ${count} of ${items.length} done`}>
        <ProgressRing pct={pct} />
        <span className="checklist-pill-text">
          <strong>Getting started</strong>
          <span>
            {count} of {items.length} done
          </span>
        </span>
      </button>
    )
  }

  return (
    <section className="checklist-panel" aria-labelledby="checklist-title">
      <header className="checklist-head">
        <div>
          <h3 id="checklist-title">{all ? 'You’re all set!' : 'Getting started'}</h3>
          <p>{all ? 'You know your way around Tradmak Tasks.' : `${count} of ${items.length} done. Each step takes a minute.`}</p>
        </div>
        <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Minimize checklist">
          <Icon name="chevronRight" size={16} className="checklist-min" />
        </button>
      </header>
      <div className="checklist-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol className="checklist-items">
        {items.map((it) => {
          const d = isDone(it.id)
          return (
            <li key={it.id} className={d ? 'is-done' : ''}>
              <span className="checklist-check" aria-hidden="true">
                {d && <Icon name="check" size={13} strokeWidth={3} />}
              </span>
              <div className="checklist-text">
                <span className="checklist-title">
                  {it.title}
                  {d && <span className="sr-only"> (done)</span>}
                </span>
                {!d && <span className="checklist-hint">{it.hint}</span>}
              </div>
              {!d && (it.to || it.id === 'tour' || it.id === 'notify') && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void go(it)}>
                  {it.id === 'tour' ? 'Start' : it.id === 'notify' ? 'Turn on' : 'Go'}
                </button>
              )}
            </li>
          )
        })}
      </ol>
      <footer className="checklist-foot">
        {all ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onHide}>
            Close checklist
          </button>
        ) : (
          <button type="button" className="link-btn small" onClick={onHide}>
            Hide checklist
          </button>
        )}
        <span className="muted small">Bring it back from the <Icon name="help" size={12} /> button.</span>
      </footer>
    </section>
  )
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 14
  const c = 2 * Math.PI * r
  return (
    <svg className="checklist-ring" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r={r} className="ring-track" />
      <circle cx="18" cy="18" r={r} className="ring-fill" strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} />
      <text x="18" y="22" textAnchor="middle">
        {pct}%
      </text>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Help button (top bar)
// ---------------------------------------------------------------------------

export function HelpMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="notif" ref={ref} data-tour="help">
      <button type="button" className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="Help" aria-expanded={open} title="Help">
        <Icon name="help" />
      </button>
      {open && (
        <div className="dropdown help-menu">
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              setOpen(false)
              startTour()
            }}
          >
            <Icon name="compass" size={16} />
            <span>
              <strong>Take the tour</strong>
              <span className="muted small">See where everything is, step by step</span>
            </span>
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              setOpen(false)
              window.dispatchEvent(new Event(OPEN_CHECKLIST))
            }}
          >
            <Icon name="checkCircle" size={16} />
            <span>
              <strong>Getting started checklist</strong>
              <span className="muted small">Your first steps, with a link to each</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
