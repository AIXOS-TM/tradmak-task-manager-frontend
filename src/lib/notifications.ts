/**
 * Notifications (database/migrations/012): written by database triggers when something happens
 * to you (task assigned, comment, @mention, direct message, added to a channel / project).
 * The bell reads them, they arrive live through Supabase Realtime, and while the tab is in the
 * background the browser can show them as desktop notifications.
 */
import { useEffect, useRef } from 'react'
import { check, client, fetchByIds, me, refOf } from './api'
import type { ProfileRow } from './rows'
import { supabase } from './supabase'
import type { UserRef } from './types'

export type NotificationKind =
  | 'task_assigned'
  | 'task_completed'
  | 'task_comment'
  | 'comment_mention'
  | 'chat_mention'
  | 'direct_message'
  | 'channel_added'
  | 'project_added'

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string
  /** In-app path, e.g. /chat/<id> or /dashboard?task=<id> */
  link: string
  task_id: string | null
  channel_id: string | null
  read_at: string | null
  created_at: string
  actor: UserRef | null
}

interface NotificationRow extends Omit<AppNotification, 'actor'> {
  actor_id: string | null
}

const PAGE = 40

/** Fired in this tab when notifications were marked read elsewhere (the bell reloads). */
export const NOTIFICATIONS_CHANGED = 'tradmak:notifications-changed'
const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

/** True when the notifications table doesn't exist yet (migration 012 not run). */
const missing = (code?: string) => code === 'PGRST205' || code === '42P01'

export const notifications = {
  /** Latest notifications, newest first. Empty (not an error) before migration 012. */
  async list(): Promise<AppNotification[]> {
    const uid = await me()
    const res = await client().from('notifications').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(PAGE)
    if (res.error && missing(res.error.code)) return []
    const rows = check<NotificationRow[]>(res, 'load notifications')
    const profiles = await fetchByIds<ProfileRow>('profiles', rows.map((r) => r.actor_id))
    return rows.map(({ actor_id, ...r }) => ({ ...r, actor: refOf(profiles, actor_id) }))
  },

  async markRead(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await client().from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids).is('read_at', null)
  },

  async markAllRead(): Promise<void> {
    const uid = await me()
    await client().from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', uid).is('read_at', null)
  },

  /** Opening a chat or a task marks its notifications read (best effort; fine before migration 012). */
  async markReadFor(target: { channelId?: string; taskId?: string }): Promise<void> {
    const uid = await me()
    let q = client().from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', uid).is('read_at', null)
    if (target.channelId) q = q.eq('channel_id', target.channelId)
    else if (target.taskId) q = q.eq('task_id', target.taskId)
    else return
    const res = await q.select('id')
    if (!res.error && (res.data ?? []).length > 0) changed()
  },

  async clearAll(): Promise<void> {
    const uid = await me()
    await client().from('notifications').delete().eq('user_id', uid)
  },
}

// ---------------------------------------------------------------------
// Desktop notifications (browser)
// ---------------------------------------------------------------------
const DESKTOP_KEY = 'tradmak.desktopNotifications'

export function desktopSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/** On when the browser allows it and the person didn't switch it off here. */
export function desktopEnabled(): boolean {
  if (!desktopSupported() || Notification.permission !== 'granted') return false
  try {
    return localStorage.getItem(DESKTOP_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Asks the browser for permission (must be called from a click). Returns the result. */
export async function enableDesktop(): Promise<NotificationPermission | 'unsupported'> {
  if (!desktopSupported()) return 'unsupported'
  const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  try {
    localStorage.setItem(DESKTOP_KEY, result === 'granted' ? 'on' : 'off')
  } catch {
    // ignore
  }
  return result
}

export function disableDesktop() {
  try {
    localStorage.setItem(DESKTOP_KEY, 'off')
  } catch {
    // ignore
  }
}

function showDesktop(n: Pick<AppNotification, 'id' | 'title' | 'body' | 'link'>, open: (link: string) => void) {
  if (!desktopEnabled() || document.visibilityState === 'visible') return
  try {
    const shown = new Notification(n.title, { body: n.body, tag: n.id, icon: '/favicon.svg' })
    shown.onclick = () => {
      window.focus()
      open(n.link)
      shown.close()
    }
  } catch {
    // Some browsers only allow notifications from a service worker: the bell still has it.
  }
}

/**
 * Live notifications for the signed-in user: calls onNew for each new one (and shows a desktop
 * notification when the tab is in the background). Falls back to polling without Realtime.
 */
export function useNotificationUpdates(
  userId: string | null,
  onNew: (n: Pick<AppNotification, 'id' | 'kind' | 'title' | 'body' | 'link'> | null) => void,
  open: (link: string) => void,
  pollMs = 30000,
) {
  const cb = useRef({ onNew, open })
  useEffect(() => {
    cb.current = { onNew, open }
  })

  useEffect(() => {
    if (!supabase || !userId) return
    let live = false
    const sub = supabase
      .channel(`notifications-${userId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'taskapp', table: 'notifications', filter: `user_id=eq.${userId}` }, (payload) => {
        const row = payload.new as NotificationRow
        cb.current.onNew(row)
        showDesktop(row, cb.current.open)
      })
      .subscribe((status) => {
        live = status === 'SUBSCRIBED'
      })
    const timer = window.setInterval(() => {
      if (!live && document.visibilityState === 'visible') cb.current.onNew(null)
    }, pollMs)
    return () => {
      window.clearInterval(timer)
      void supabase?.removeChannel(sub)
    }
  }, [userId, pollMs])
}
