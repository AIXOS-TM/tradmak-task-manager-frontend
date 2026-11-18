// Shapes returned by the backend API (see backend/src/types.ts). Field names are snake_case,
// exactly as the API sends them.

export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'todo' | 'in_progress' | 'done'
/** assigned = given by a lead/teammate; personal = created by the user for themselves. */
export type TaskSource = 'assigned' | 'personal'
export type ProjectStatus = 'on_track' | 'at_risk' | 'on_hold' | 'completed'
export type WorkspaceRole = 'owner' | 'admin' | 'manager' | 'member'
/** Roles an admin can give someone (owner comes from creating the workspace). */
export type AssignableRole = 'admin' | 'manager' | 'member'
export type ActionItemStatus = 'linked' | 'needs_review' | 'assigned' | 'ignored'

export interface UserRef {
  id: string
  name: string
  avatar_color: string
}

export interface User extends UserRef {
  email: string
  /** Job title, e.g. "Team Manager". */
  role: string
  created_at: string
}

export interface Workspace {
  id: string
  name: string
  created_at: string
  member_role: WorkspaceRole
}

export interface Member extends User {
  member_role: WorkspaceRole
  task_count: number
  open_count: number
  done_count: number
}

export interface Project {
  id: string
  workspace_id: string
  name: string
  description: string
  status: ProjectStatus
  color: string
  owner_id: string
  due_date: string | null
  created_at: string
  members: UserRef[]
  task_count: number
  done_count: number
  open_count: number
}

export interface TaskList {
  id: string
  project_id: string
  name: string
  position: number
  task_count: number
}

export interface Task {
  id: string
  workspace_id: string | null
  project_id: string | null
  list_id: string | null
  title: string
  description: string
  source: TaskSource
  status: TaskStatus
  priority: Priority
  assignee_id: string | null
  assigned_by: string | null
  created_by: string
  meeting_id: string | null
  due_date: string | null
  position: number
  created_at: string
  updated_at: string
  assignee: UserRef | null
  assigned_by_user: UserRef | null
  assigned_by_name: string | null
  project: { id: string; name: string; color: string } | null
  list: { id: string; name: string } | null
  meeting: { id: string; title: string; started_at: string } | null
  comment_count: number
}

export interface Comment {
  id: string
  task_id: string
  author_id: string
  body: string
  created_at: string
  author: UserRef | null
}

export interface ActionItem {
  id: string
  meeting_id: string
  task_id: string | null
  status: ActionItemStatus
  quote: string
  speaker_id: string
  timestamp: string
  confidence: number
  ai_note: string | null
  suggested_title: string
  suggested_description: string
  suggested_project_id: string | null
  suggested_list_id: string | null
  suggested_priority: Priority
  suggested_due_date: string | null
  speaker: UserRef | null
  task: Task | null
}

export interface ReviewItem extends ActionItem {
  meeting: { id: string; title: string; started_at: string; workspace_id: string }
}

export interface MeetingSummary {
  id: string
  workspace_id: string
  project_id: string | null
  title: string
  started_at: string
  duration_min: number
  summary: string
  attendee_ids: string[]
  project: { id: string; name: string; color: string } | null
  attendees: UserRef[]
  action_item_count: number
  task_count: number
  needs_review_count: number
}

export interface MeetingDetail extends MeetingSummary {
  action_items: ActionItem[]
}

export interface DashboardSummary {
  today: number
  overdue: number
  open: number
  in_progress: number
  done: number
  assigned: number
  personal: number
  needsReview: number
}

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'due_date' | 'assignee_id' | 'list_id' | 'position'>
>
