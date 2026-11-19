/**
 * Database rows (Supabase, "taskapp" schema) and how they map to the shapes the pages use (./types.ts).
 * This is the only file that knows how database columns differ from the app's field names:
 *   tasks.status   'pending'  <-> 'todo'
 *   projects.health           ->  status,   projects.end_date -> due_date
 *   members.role + workspaces.owner_id -> 'owner' | 'admin' | 'manager' | 'member'
 */
import type { ActionItem, Comment, MeetingSummary, Priority, Project, ProjectStatus, Task, TaskList, TaskSource, TaskStatus, User, WorkspaceRole } from './types'

export type DbMemberRole = 'admin' | 'manager' | 'member'
export type DbTaskStatus = 'pending' | 'in_progress' | 'done'

export interface ProfileRow {
  id: string
  name: string | null
  email: string | null
  role: DbMemberRole
  job_title: string | null
  avatar_color: string | null
  created_at: string
}

export interface WorkspaceRow {
  id: string
  name: string
  owner_id: string | null
  created_at: string
  // Added in migration 008 (missing on older databases).
  default_lists?: string[]
  allowed_domains?: string[]
}

export interface MemberRow {
  id: string
  workspace_id: string
  user_id: string
  role: DbMemberRole
  // Added in migration 005 (missing on older databases).
  status?: 'active' | 'deactivated'
  created_at?: string
}

export const isActiveMember = (m: Pick<MemberRow, 'status'>) => m.status !== 'deactivated'

export interface ProjectRow {
  id: string
  workspace_id: string
  name: string
  description: string
  health: ProjectStatus
  /** 'archived' hides the project from everyday views. */
  status?: 'active' | 'archived'
  /** Added in migration 007 (missing on older databases). */
  is_private?: boolean
  color: string
  owner_id: string | null
  end_date: string | null
  created_at: string
}

export interface ProjectMemberRow {
  project_id: string
  user_id: string
}

export interface TaskListRow {
  id: string
  project_id: string
  name: string
  position: number
}

export interface TaskRow {
  id: string
  list_id: string | null
  project_id: string | null
  title: string
  description: string
  assignee_id: string | null
  created_by: string | null
  source: TaskSource
  assigned_by: string | null
  assigned_by_name: string | null
  meeting_id: string | null
  due_date: string | null
  priority: Priority
  status: DbTaskStatus
  position: number
  created_at: string
  updated_at: string
}

export interface CommentRow {
  id: string
  task_id: string
  user_id: string | null
  body: string
  created_at: string
}

export interface MeetingRow {
  id: string
  workspace_id: string
  project_id: string | null
  title: string
  date: string | null
  started_at: string | null
  duration_min: number
  summary: string
  attendee_ids: string[] | null
  created_at: string
}

export interface ActionItemRow {
  id: string
  meeting_id: string
  task_id: string | null
  status: ActionItem['status']
  quote: string
  speaker_id: string | null
  recording_time: string
  confidence: number | string // numeric columns can come back as strings
  ai_note: string | null
  suggested_title: string
  suggested_description: string
  suggested_project_id: string | null
  suggested_list_id: string | null
  suggested_priority: Priority
  suggested_due_date: string | null
  created_at: string
}

// ---------- values ----------

export const toAppStatus = (s: DbTaskStatus): TaskStatus => (s === 'pending' ? 'todo' : s)
export const toDbStatus = (s: TaskStatus): DbTaskStatus => (s === 'todo' ? 'pending' : s)

/** The workspace owner (workspaces.owner_id) is "owner"; everyone else keeps their stored role. */
export const toWorkspaceRole = (dbRole: DbMemberRole, isOwner: boolean): WorkspaceRole => (isOwner ? 'owner' : dbRole)

const FALLBACK_COLORS = ['#4f46e5', '#db2777', '#0891b2', '#059669', '#d97706', '#7c3aed', '#e11d48', '#475569']

/** Stable colour for users without one. */
export function colorFor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ---------- row -> app ----------

export function toUser(r: ProfileRow): User {
  const email = r.email ?? ''
  return {
    id: r.id,
    name: r.name || email.split('@')[0] || 'Unknown',
    email,
    role: r.job_title || capitalize(r.role),
    avatar_color: r.avatar_color || colorFor(r.id),
    created_at: r.created_at,
  }
}

export type ProjectBase = Omit<Project, 'owner' | 'members' | 'task_count' | 'done_count' | 'open_count'>

export function toProject(r: ProjectRow): ProjectBase {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    name: r.name,
    description: r.description,
    status: r.health,
    color: r.color,
    owner_id: r.owner_id ?? '',
    due_date: r.end_date,
    created_at: r.created_at,
    archived: r.status === 'archived',
    is_private: r.is_private ?? false,
  }
}

export function toTaskList(r: TaskListRow): Omit<TaskList, 'task_count'> {
  return { id: r.id, project_id: r.project_id, name: r.name, position: r.position }
}

export type TaskBase = Omit<Task, 'assignee' | 'assigned_by_user' | 'assigned_by_name' | 'project' | 'list' | 'meeting' | 'comment_count'>

/** workspace_id isn't stored on tasks; it comes from the task's project (null for personal tasks). */
export function toTask(r: TaskRow, workspaceId: string | null): TaskBase {
  return {
    id: r.id,
    workspace_id: workspaceId,
    project_id: r.project_id,
    list_id: r.list_id,
    title: r.title,
    description: r.description,
    source: r.source,
    status: toAppStatus(r.status),
    priority: r.priority,
    assignee_id: r.assignee_id,
    assigned_by: r.assigned_by,
    created_by: r.created_by ?? r.assignee_id ?? '',
    meeting_id: r.meeting_id,
    due_date: r.due_date,
    position: r.position,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function toComment(r: CommentRow): Omit<Comment, 'author'> {
  return { id: r.id, task_id: r.task_id, author_id: r.user_id ?? '', body: r.body, created_at: r.created_at }
}

export type MeetingBase = Omit<MeetingSummary, 'project' | 'attendees' | 'action_item_count' | 'task_count' | 'needs_review_count'>

export function toMeeting(r: MeetingRow): MeetingBase {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    project_id: r.project_id,
    title: r.title,
    // Meetings created before migration 001 only have a date.
    started_at: r.started_at ?? (r.date ? `${r.date}T09:00:00.000Z` : r.created_at),
    duration_min: r.duration_min,
    summary: r.summary,
    attendee_ids: r.attendee_ids ?? [],
  }
}

export function toActionItem(r: ActionItemRow): Omit<ActionItem, 'speaker' | 'task'> {
  return {
    id: r.id,
    meeting_id: r.meeting_id,
    task_id: r.task_id,
    status: r.status,
    quote: r.quote,
    speaker_id: r.speaker_id ?? '',
    timestamp: r.recording_time,
    confidence: Number(r.confidence),
    ai_note: r.ai_note,
    suggested_title: r.suggested_title,
    suggested_description: r.suggested_description,
    suggested_project_id: r.suggested_project_id,
    suggested_list_id: r.suggested_list_id,
    suggested_priority: r.suggested_priority,
    suggested_due_date: r.suggested_due_date,
  }
}
