// Product tour + "Getting started" checklist for new users.
// What each role sees, where it points, and what counts as done.
// Progress is remembered per user in this browser (localStorage); checklist items that match real
// work (a task finished, a project created…) are checked against the database instead.
import { useCallback, useEffect, useState } from 'react'
import { client } from './api'
import type { WorkspaceRole } from './types'

export type TourRole = 'member' | 'manager' | 'admin'

/** The highest role the user has in any organization. */
export function tourRoleOf(roles: WorkspaceRole[]): TourRole {
  if (roles.some((r) => r === 'owner' || r === 'admin')) return 'admin'
  if (roles.includes('manager')) return 'manager'
  return 'member'
}

export const ROLE_INTRO: Record<TourRole, { label: string; text: string }> = {
  member: {
    label: 'Team member',
    text: 'Your manager gives you tasks here. You see them in one list, update them as you go, and talk to your team, all in one place.',
  },
  manager: {
    label: 'Manager',
    text: 'You create projects, give tasks to your team, and turn meetings into tasks with AI. You can see who is busy and what is late.',
  },
  admin: {
    label: 'Admin',
    text: 'You run the organization: invite people, set their roles, and manage projects. You can also do everything a manager does.',
  },
}

export interface TourStep {
  id: string
  /** [data-tour="…"] to point at. No target (or not on screen) = a card in the middle. */
  target?: string
  /** Open this page first, so the user sees it behind the tip. */
  route?: string
  /** On phones, open the side menu so the menu item is visible. */
  inMenu?: boolean
  title: string
  body: string
  /** A short "try this" line under the text. */
  tip?: string
  roles?: TourRole[]
}

const ALL_STEPS: TourStep[] = [
  {
    id: 'my-work',
    target: 'nav-dashboard',
    route: '/dashboard',
    inMenu: true,
    title: 'My work: start your day here',
    body: 'Every task given to you, from every project, in one list. The counters show what is late, due today and coming up.',
    tip: 'Click a task to open it, change its status, or leave a comment.',
  },
  {
    id: 'personal',
    target: 'add-personal',
    route: '/dashboard',
    title: 'Your own to-dos',
    body: 'Add private to-dos that only you can see. Handy for small reminders that are not part of a project.',
  },
  {
    id: 'projects',
    target: 'nav-projects',
    route: '/projects',
    inMenu: true,
    title: 'Projects',
    body: 'Each project holds its tasks. Open one to see them as a list or as a board you can drag cards across.',
    roles: ['member'],
  },
  {
    id: 'projects-manage',
    target: 'new-project',
    route: '/projects',
    title: 'Create a project',
    body: 'Start a project, pick who is on it, then add tasks and give each one to a person with a due date.',
    tip: 'They get a notification as soon as you assign it.',
    roles: ['manager', 'admin'],
  },
  {
    id: 'meetings',
    target: 'nav-meetings',
    route: '/meetings',
    inMenu: true,
    title: 'Meetings become tasks',
    body: 'After a meeting, AI reads what was said and finds who promised to do what. If an item has no owner, you can take it with "Assign to me".',
    roles: ['member'],
  },
  {
    id: 'meetings-manage',
    target: 'add-meeting',
    route: '/meetings',
    title: 'Meetings become tasks',
    body: 'Click "Add meeting", paste the transcript (or upload the file from Meetily), and AI lists the action items. You check them, fix anything, and save: tasks go straight to the right people.',
    roles: ['manager', 'admin'],
  },
  {
    id: 'chat',
    target: 'nav-chat',
    route: '/chat',
    inMenu: true,
    title: 'Chat with your team',
    body: 'Channels for topics, direct messages for one person. Type @ and a name to get someone’s attention. You can send files and voice notes too.',
  },
  {
    id: 'people',
    target: 'nav-people',
    route: '/people',
    inMenu: true,
    title: 'People',
    body: 'Everyone in your organization, and what they are working on right now.',
    roles: ['member'],
  },
  {
    id: 'people-manage',
    target: 'nav-resources',
    route: '/resources',
    inMenu: true,
    title: 'Who has time?',
    body: 'Resources shows how busy each person is this week, so you give new work to someone who has room. People shows everyone and their open tasks.',
    roles: ['manager', 'admin'],
  },
  {
    id: 'clients',
    target: 'nav-clients',
    route: '/clients',
    inMenu: true,
    title: 'Clients',
    body: 'Keep your clients in one list and link each project to the client it is for.',
    roles: ['manager', 'admin'],
  },
  {
    id: 'admin',
    target: 'nav-admin',
    route: '/admin',
    inMenu: true,
    title: 'Admin: your organization',
    body: 'Invite people by email, choose their role (member, manager or admin), and manage projects and settings.',
    tip: 'Members do the work, managers hand it out, admins run the organization.',
    roles: ['admin'],
  },
  {
    id: 'search',
    target: 'search',
    title: 'Find any task',
    body: 'Type a few words to find one of your tasks quickly.',
  },
  {
    id: 'bell',
    target: 'bell',
    title: 'Notifications',
    body: 'New tasks, comments, @mentions and reminders for late work show up here. You can also turn on desktop notifications.',
  },
  {
    id: 'help',
    target: 'help',
    title: 'Help is always here',
    body: 'Play this tour again or open your "Getting started" checklist from this button any time.',
  },
]

export function tourSteps(role: TourRole): TourStep[] {
  return ALL_STEPS.filter((s) => !s.roles || s.roles.includes(role))
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export type ChecklistId = 'tour' | 'profile' | 'personal' | 'finish' | 'chat' | 'notify' | 'project' | 'assign' | 'meeting' | 'invite'

export interface ChecklistItem {
  id: ChecklistId
  title: string
  hint: string
  /** Where "Go" takes you. */
  to?: string
  roles?: TourRole[]
}

const ALL_ITEMS: ChecklistItem[] = [
  { id: 'tour', title: 'Take the quick tour', hint: 'One minute. Shows where everything is.' },
  { id: 'profile', title: 'Check your profile', hint: 'Make sure your name and job title are right so people know who you are.', to: '/settings' },
  { id: 'invite', title: 'Invite your team', hint: 'Admin → Invites. Send an email invite and choose their role.', to: '/admin?tab=invites', roles: ['admin'] },
  { id: 'project', title: 'Create your first project', hint: 'Projects → New project. Add the people who will work on it.', to: '/projects', roles: ['manager', 'admin'] },
  { id: 'assign', title: 'Give a task to someone', hint: 'Open a project, add a task, pick a person and a due date.', to: '/projects', roles: ['manager', 'admin'] },
  { id: 'meeting', title: 'Turn a meeting into tasks', hint: 'Meetings → Add meeting. Paste the transcript and let AI find the action items.', to: '/meetings/new', roles: ['manager', 'admin'] },
  { id: 'personal', title: 'Add a personal to-do', hint: 'My work → "Add personal task". Only you can see it.', to: '/dashboard', roles: ['member'] },
  { id: 'finish', title: 'Finish a task', hint: 'Open one of your tasks and mark it done. Your manager sees it right away.', to: '/dashboard', roles: ['member'] },
  { id: 'chat', title: 'Say hi in Chat', hint: 'Send your first message in a channel or to a teammate.', to: '/chat' },
  { id: 'notify', title: 'Turn on desktop notifications', hint: 'Bell icon → "Turn on desktop notifications", so you never miss a new task.' },
]

export function checklistItems(role: TourRole): ChecklistItem[] {
  return ALL_ITEMS.filter((i) => !i.roles || i.roles.includes(role))
}

/** Checks the database for the items that match real work. Missing tables (old migrations) just count as "not yet". */
export async function checkProgress(userId: string): Promise<Partial<Record<ChecklistId, boolean>>> {
  const db = client()
  const has = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    try {
      const r = await q
      return !r.error && (r.count ?? 0) > 0
    } catch {
      return false
    }
  }
  const head = { count: 'exact' as const, head: true }
  const [personal, finish, assign, project, meeting, chat, invite] = await Promise.all([
    has(db.from('tasks').select('id', head).eq('created_by', userId).eq('source', 'personal')),
    has(db.from('tasks').select('id', head).eq('assignee_id', userId).eq('status', 'done')),
    has(db.from('tasks').select('id', head).eq('assigned_by', userId).neq('assignee_id', userId)),
    has(db.from('projects').select('id', head).eq('owner_id', userId)),
    has(db.from('meetings').select('id', head)),
    has(db.from('messages').select('id', head).eq('user_id', userId)),
    has(db.from('invitations').select('id', head).eq('invited_by', userId)),
  ])
  return { personal, finish, assign, project, meeting, chat, invite }
}

// ---------------------------------------------------------------------------
// What this user has seen (this browser)
// ---------------------------------------------------------------------------

export interface OnboardingState {
  /** Saw the welcome card (started or skipped). */
  welcomed: boolean
  tourDone: boolean
  /** Checklist closed with "Hide". It can be opened again from Help. */
  checklistHidden: boolean
  /** Checklist panel open (vs. the small pill). */
  checklistOpen: boolean
  /** Items finished that the database can't tell us about. */
  done: ChecklistId[]
}

const EMPTY: OnboardingState = { welcomed: false, tourDone: false, checklistHidden: false, checklistOpen: false, done: [] }
const KEY = (userId: string) => `tt-onboarding:${userId}`
const CHANGED = 'tt-onboarding-changed'

function read(userId: string): OnboardingState {
  try {
    const raw = localStorage.getItem(KEY(userId))
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<OnboardingState>) } : EMPTY
  } catch {
    return EMPTY
  }
}

/** Per-user onboarding state, shared by every component that uses it. */
export function useOnboardingState(userId: string) {
  const [state, setState] = useState<OnboardingState>(() => read(userId))
  useEffect(() => {
    const sync = () => setState(read(userId))
    window.addEventListener(CHANGED, sync)
    return () => window.removeEventListener(CHANGED, sync)
  }, [userId])

  const update = useCallback(
    (patch: Partial<OnboardingState> | ((s: OnboardingState) => Partial<OnboardingState>)) => {
      const current = read(userId)
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
      try {
        localStorage.setItem(KEY(userId), JSON.stringify(next))
      } catch {
        // Private window / storage blocked: still works for this visit.
      }
      setState(next)
      window.dispatchEvent(new Event(CHANGED))
    },
    [userId],
  )

  const markDone = useCallback(
    (id: ChecklistId) => update((s) => (s.done.includes(id) ? {} : { done: [...s.done, id] })),
    [update],
  )

  return { state, update, markDone }
}
