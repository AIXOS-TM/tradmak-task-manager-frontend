// Shapes the pages work with (built from Supabase rows in ./rows.ts). Field names are snake_case,
// matching the database columns.

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

export type MemberStatus = 'active' | 'deactivated'

export interface Member extends User {
  member_role: WorkspaceRole
  /** Deactivated members keep their account but can't open this organization. */
  status: MemberStatus
  /** When they joined this organization (null before migration 005). */
  joined_at: string | null
  task_count: number
  open_count: number
  done_count: number
  /** Working hours per working day (migration 013; 8 before it). */
  hours_per_day: number
  /** Working weekdays, ISO numbers 1 = Mon … 7 = Sun (migration 013; Mon–Fri before it). */
  work_days: number[]
}

export type ClientStatus = 'active' | 'archived'

/** A company we do work for (migration 013). Projects can belong to one. */
export interface Client {
  id: string
  workspace_id: string
  name: string
  contact_name: string
  email: string
  phone: string
  website: string
  address: string
  notes: string
  color: string
  status: ClientStatus
  created_at: string
  project_count: number
  /** Open / done / late tasks across the client's projects. */
  open_count: number
  done_count: number
  overdue_count: number
}

export type ClientInput = Pick<Client, 'name' | 'contact_name' | 'email' | 'phone' | 'website' | 'address' | 'notes' | 'color'>

export type TimeOffKind = 'vacation' | 'sick' | 'holiday' | 'other'

export interface TimeOff {
  id: string
  workspace_id: string
  user_id: string
  start_date: string
  end_date: string
  kind: TimeOffKind
  note: string
  user: UserRef | null
}

export interface Project {
  id: string
  workspace_id: string
  name: string
  description: string
  status: ProjectStatus
  color: string
  owner_id: string
  /** Start of the project (shown on the Resources timeline). */
  start_date: string | null
  due_date: string | null
  created_at: string
  /** The client it's for (migration 013). */
  client_id: string | null
  client: { id: string; name: string; color: string } | null
  /** Archived projects are hidden from the sidebar and Projects page (Admin → Projects can restore them). */
  archived: boolean
  /** Only admins, the owner and the project's members can see a private project. */
  is_private: boolean
  owner: UserRef | null
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
  /** When work starts (migration 013). */
  start_date: string | null
  due_date: string | null
  /** Expected effort in minutes (migration 013). */
  estimate_minutes: number | null
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
  /** Can be empty when the comment is only attachments. */
  body: string
  created_at: string
  author: UserRef | null
  attachments: Attachment[]
  /** People @mentioned in it (migration 012). */
  mentioned: UserRef[]
}

/** A file attached to a comment (stored privately in Supabase Storage). */
export interface Attachment {
  id: string
  comment_id: string
  file_name: string
  mime_type: string
  size_bytes: number
  /** Where the file lives in the bucket (used to delete it). */
  storage_path: string
  uploaded_by: string | null
  /** Short-lived signed link to open / download it (null if it couldn't be made). */
  url: string | null
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
  Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'due_date' | 'start_date' | 'estimate_minutes' | 'assignee_id' | 'list_id' | 'position'>
>

// ---------- Organization admin ----------

export type InvitationStatus = 'pending' | 'accepted' | 'cancelled'

export interface Invitation {
  id: string
  workspace_id: string
  email: string
  role: AssignableRole
  status: InvitationStatus
  invited_by: UserRef | null
  created_at: string
  expires_at: string
}

/** Result of sending invites: who got an email and who didn't (with the reason). */
export interface InviteResult {
  sent: string[]
  failed: { email: string; error: string }[]
}

/** An organization someone just joined by accepting an invite. */
export interface JoinedWorkspace {
  workspace_id: string
  workspace_name: string
  role: AssignableRole
}

export interface WorkloadRow {
  user: Member
  open: number
  overdue: number
  done: number
}

/** Admin → Settings. */
export interface WorkspaceSettings {
  /** Lists every new project starts with. */
  default_lists: string[]
  /** Only these email domains can be invited; empty = anyone. */
  allowed_domains: string[]
  owner_id: string | null
}

/** A row in the Admin page's Projects tab. */
export interface AdminProject extends Project {
  overdue_count: number
  /** 0–100, done / all tasks. */
  progress: number
}

/** A row in the Admin page's Members tab. */
export interface AdminMember extends Member {
  open: number
  overdue: number
  done: number
  /** Last sign-in (null if never, or before migration 005). */
  last_sign_in_at: string | null
}

export interface AdminOverview {
  members: number
  roles: Record<WorkspaceRole, number>
  projects: number
  open: number
  overdue: number
  done: number
  due_this_week: number
  pending_invites: number
  workload: WorkloadRow[]
}

// ---------- Activity log ----------

/** Filter groups on the Activity tab. */
export type ActivityCategory = 'all' | 'tasks' | 'projects' | 'people' | 'organization'

export interface ActivityEntry {
  id: number
  /** e.g. 'task.status_changed', 'member.role_changed' */
  action: string
  entity_type: 'task' | 'project' | 'member' | 'invite' | 'organization' | 'ai_item'
  entity_id: string | null
  /** Title / name when it happened (still readable after a delete). */
  entity_name: string | null
  details: Record<string, unknown>
  created_at: string
  actor: UserRef | null
  /** The person it was about (new assignee, member whose role changed, …). */
  target: UserRef | null
  /** Previous assignee, for 'task.reassigned'. */
  from_user: UserRef | null
  project: { id: string; name: string; color: string } | null
}

export interface ActivityPage {
  entries: ActivityEntry[]
  /** Pass as `before` to load older entries; null when there are no more. */
  next: number | null
}
