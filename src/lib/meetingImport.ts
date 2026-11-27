/**
 * Adding a meeting from a transcript (database migration 014 + the /api/extract-action-items function).
 *
 *   1. extractActionItems  → the server asks OpenAI for action items (nothing is saved yet)
 *   2. the manager reviews and edits them in the app
 *   3. saveMeeting         → one database call saves the meeting, creates tasks for items that
 *                            have an owner and leaves the rest in "needs review"
 */
import { ApiError, check, client, getTask } from './api'
import { supabase } from './supabase'
import type { Priority, Task } from './types'

export const NEEDS_014 = 'This needs a database update: run database/migrations/014_meeting_import.sql in the Supabase SQL Editor.'

export interface SuggestedItem {
  title: string
  description: string
  assignee_id: string | null
  owner_name: string
  speaker_id: string | null
  speaker_name: string
  quote: string
  timestamp: string
  due_date: string | null
  priority: Priority
  confidence: number
  note: string
}

export interface Extraction {
  summary: string
  items: SuggestedItem[]
  model: string
}

/** Thrown when the server has no OpenAI key yet; the page then lets people add items by hand. */
export class AiNotConfigured extends ApiError {}

export interface MeetingDraft {
  workspace_id: string
  title: string
  started_at: string
  duration_min: number
  project_id: string | null
  attendee_ids: string[]
  summary: string
  transcript: string
}

export interface DraftItem {
  title: string
  description: string
  assignee_id: string | null
  speaker_id: string | null
  quote: string
  timestamp: string
  confidence: number
  note: string
  project_id: string | null
  priority: Priority
  due_date: string | null
}

/** Turns "function does not exist" (migration 014 not run yet) into a clear message. */
function explain014(err: { code?: string; message?: string } | null): void {
  if (!err) return
  if (err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(err.message ?? '')) {
    throw new ApiError(500, NEEDS_014)
  }
}

export const meetingImport = {
  async extractActionItems(body: { workspace_id: string; transcript: string; title: string; meeting_date: string }): Promise<Extraction> {
    const token = (await supabase?.auth.getSession())?.data.session?.access_token
    if (!token) throw new ApiError(401, 'Your session has expired. Sign in again.')
    let res: Response
    try {
      res = await fetch('/api/extract-action-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    } catch {
      throw new ApiError(0, 'Could not reach the server. Check your internet connection.')
    }
    const data = (await res.json().catch(() => null)) as (Extraction & { error?: string; code?: string }) | null
    if (!res.ok || !data) {
      const message = data?.error ?? (res.status === 404 ? 'The AI service is not deployed yet.' : `The AI request failed (${res.status}).`)
      if (data?.code === 'ai_not_configured' || res.status === 404) throw new AiNotConfigured(res.status, message)
      throw new ApiError(res.status, message)
    }
    return data
  },

  async saveMeeting(meeting: MeetingDraft, items: DraftItem[]): Promise<string> {
    const { workspace_id, ...fields } = meeting
    const res = await client().rpc('save_meeting', { p_workspace_id: workspace_id, p_meeting: fields, p_items: items })
    explain014(res.error)
    return check<string>(res, 'save this meeting')
  },

  /** A manager gives a "needs review" item to anyone in the organization. */
  async assignActionItem(itemId: string, userId: string): Promise<Task> {
    const res = await client().rpc('assign_action_item', { p_item_id: itemId, p_assignee_id: userId })
    explain014(res.error)
    return getTask(check<string>(res, 'assign this item'))
  },

  /** Managers. Its action items go too; tasks made from it stay. */
  async deleteMeeting(id: string): Promise<void> {
    const rows = check<{ id: string }[]>(await client().from('meetings').delete().eq('id', id).select('id'), 'delete meetings')
    if (rows.length === 0) throw new ApiError(403, 'Only admins and managers can delete meetings.')
  },

  async transcript(id: string): Promise<string> {
    const row = check<{ transcript: string | null } | null>(
      await client().from('meetings').select('transcript').eq('id', id).maybeSingle(),
      'load the transcript',
    )
    return row?.transcript ?? ''
  },
}

const MAX_FILE_BYTES = 3 * 1024 * 1024

/**
 * Reads an exported transcript (.txt, .md, .srt, .vtt or .json) as plain text.
 * Subtitle files keep their timestamps; JSON exports are flattened to "[time] speaker: text" lines.
 */
export async function readTranscriptFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new ApiError(400, 'That file is too big (at most 3 MB of text).')
  const raw = await file.text()
  const name = file.name.toLowerCase()
  if (name.endsWith('.json')) return flattenJson(raw)
  if (name.endsWith('.srt') || name.endsWith('.vtt')) return flattenSubtitles(raw)
  return raw.replace(/\r\n/g, '\n').trim()
}

function flattenSubtitles(raw: string): string {
  const lines: string[] = []
  let time = ''
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim()
    if (!t || t === 'WEBVTT' || /^\d+$/.test(t) || /^(NOTE|STYLE)\b/.test(t)) continue
    const cue = /^(\d{1,2}:)?(\d{1,2}:\d{2})[.,]\d{1,3}\s*-->/.exec(t)
    if (cue) {
      time = `${cue[1] ?? ''}${cue[2]}`
      continue
    }
    // WebVTT voice tags: "<v Ali>text" → "Ali: text"; other tags (<i>, <c.x>) are dropped.
    const said = t.replace(/^<v(?:\.[^\s>]*)?\s+([^>]+)>/, '$1: ').replace(/<[^>]+>/g, '').trim()
    if (!said) continue
    lines.push(time ? `[${time}] ${said}` : said)
    time = ''
  }
  return lines.join('\n')
}

function flattenJson(raw: string): string {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return raw.trim()
  }
  const segments: string[] = []
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit)
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    const said = o.text ?? o.transcript ?? o.content
    if (typeof said === 'string' && said.trim()) {
      const who = o.speaker ?? o.speaker_name ?? o.name
      const at = o.timestamp ?? o.start ?? o.audio_start_time ?? o.time
      const time = typeof at === 'number' ? secondsToClock(at) : typeof at === 'string' ? at : ''
      segments.push(`${time ? `[${time}] ` : ''}${typeof who === 'string' && who ? `${who}: ` : ''}${said.trim()}`)
      return
    }
    Object.values(o).forEach(visit)
  }
  visit(data)
  return segments.length ? segments.join('\n') : raw.trim()
}

function secondsToClock(s: number): string {
  const total = Math.max(0, Math.floor(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
