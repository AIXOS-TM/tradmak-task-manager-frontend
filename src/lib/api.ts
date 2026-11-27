/**
 * The one place the frontend reads and writes data.
 *
 * Everything goes straight to Supabase with the browser client (anon key + the user's session,
 * schema "taskapp"). Row Level Security (database/migrations/002) decides what each user may see
 * and change; the checks in this file only turn "not allowed" into friendly messages.
 * Two actions use database functions from database/migrations/003 (add member by email,
 * assign a meeting item to me).
 *
 * Related rows (people, projects, lists, meetings, comment counts) are loaded in small batched
 * queries and joined here, so nothing depends on foreign-key names.
 */
import type { PostgrestError } from '@supabase/supabase-js'
import { seedShared, shared } from './cache'
import {
  isActiveMember,
  toActionItem,
  toComment,
  toDbStatus,
  toMeeting,
  toProject,
  toTask,
  toTaskList,
  toUser,
  toWorkspaceRole,
  type ActionItemRow,
  type ClientRow,
  type CommentRow,
  type MeetingRow,
  type MemberRow,
  type ProfileRow,
  type ProjectMemberRow,
  type ProjectRow,
  type TaskListRow,
  type TaskRow,
  type WorkspaceRow,
} from './rows'
import { createMailerClient, supabase } from './supabase'
import type {
  Attachment,
  WorkspaceSettings,
  AdminProject,
  ActionItem,
  ActivityCategory,
  ActivityEntry,
  ActivityPage,
  AdminMember,
  AdminOverview,
  AssignableRole,
  Comment,
  DashboardSummary,
  Invitation,
  InviteResult,
  JoinedWorkspace,
  MemberStatus,
  MeetingDetail,
  MeetingSummary,
  Member,
  Priority,
  Project,
  ProjectStatus,
  ReviewItem,
  Task,
  TaskList,
  TaskPatch,
  TaskSource,
  TaskStatus,
  User,
  UserRef,
  Workspace,
  WorkspaceRole,
} from './types'

/** Fired on window when the session is no longer valid; AuthProvider then signs out. */
export const AUTH_EXPIRED_EVENT = 'auth:expired'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const WORK_MANAGERS: WorkspaceRole[] = ['owner', 'admin', 'manager']
const MEMBER_ADMINS: WorkspaceRole[] = ['owner', 'admin']
const NOT_MANAGER_ASSIGN = 'Only workspace admins and managers can assign tasks to other people.'

// =====================================================================
// Plumbing
// =====================================================================

export function client() {
  if (!supabase) {
    throw new ApiError(0, 'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env.')
  }
  return supabase
}

function sessionExpired(message = 'Your session has expired. Please log in again.'): ApiError {
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: message }))
  return new ApiError(401, message)
}

/** The signed-in user's id (getSession also refreshes an expired token). */
export async function me(): Promise<string> {
  const { data } = await client().auth.getSession()
  const id = data.session?.user.id
  if (!id) throw sessionExpired('Please log in to continue.')
  return id
}

export function toApiError(err: PostgrestError, what: string): ApiError {
  const msg = err.message ?? ''
  if (err.code === 'PGRST301' || err.code === 'PGRST303' || /jwt/i.test(msg)) return sessionExpired()
  if (err.code === '42501') {
    // RLS refusals are technical; messages raised by our own SQL functions are already readable.
    return new ApiError(403, /row-level security|permission denied/i.test(msg) ? `You don't have permission to ${what}.` : msg)
  }
  if (err.code === 'P0001') return new ApiError(400, msg) // raised by a taskapp function
  if (/tasks_start_before_due/.test(msg)) return new ApiError(400, 'The start date must be on or before the due date.')
  if (err.code === '23514' && !/violates check constraint/i.test(msg)) return new ApiError(400, msg) // raised by a taskapp trigger
  if (err.code === 'PGRST202' || err.code === 'PGRST204' || err.code === 'PGRST205' || err.code === '42P01' || err.code === '42703') {
    return new ApiError(500, 'The database is missing a newer update. Run the latest files in database/migrations in the Supabase SQL Editor.')
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return new ApiError(0, "Can't reach Supabase. Check your internet connection.")
  return new ApiError(500, `Couldn't ${what}: ${msg}`)
}

interface QueryResult {
  data: unknown
  error: PostgrestError | null
}

/** Unwraps a Supabase result, turning errors into ApiError. */
export function check<T>(res: QueryResult, what: string): T {
  if (res.error) throw toApiError(res.error, what)
  return res.data as T
}

const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))]
const notFound = (what: string) => new ApiError(404, `${what} not found`)
const forbidden = (message: string) => new ApiError(403, message)
const nowIso = () => new Date().toISOString()

/** Loads rows by id into a Map. Skips the query when there's nothing to load. */
export async function fetchByIds<T extends { id: string }>(table: string, ids: (string | null | undefined)[]): Promise<Map<string, T>> {
  const wanted = unique(ids)
  if (wanted.length === 0) return new Map()
  const rows = check<T[]>(await client().from(table).select('*').in('id', wanted), `load ${table}`)
  return new Map(rows.map((r) => [r.id, r]))
}

export function refOf(profiles: Map<string, ProfileRow>, id: string | null): UserRef | null {
  const p = id ? profiles.get(id) : undefined
  if (!p) return null
  const u = toUser(p)
  return { id: u.id, name: u.name, avatar_color: u.avatar_color }
}

/** Unfinished first, then by due date (no date last). */
function byStatusThenDue(a: Task, b: Task) {
  const ad = a.status === 'done' ? 1 : 0
  const bd = b.status === 'done' ? 1 : 0
  if (ad !== bd) return ad - bd
  return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
}

// =====================================================================
// Hydration (row -> what the pages show)
// =====================================================================

async function commentCounts(taskIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (taskIds.length === 0) return counts
  const rows = check<{ task_id: string }[]>(await client().from('comments').select('task_id').in('task_id', taskIds), 'count comments')
  for (const r of rows) counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1)
  return counts
}

export async function hydrateTasks(rows: TaskRow[]): Promise<Task[]> {
  if (rows.length === 0) return []
  const [profiles, projects, lists, meetings, counts] = await Promise.all([
    fetchByIds<ProfileRow>('profiles', rows.flatMap((r) => [r.assignee_id, r.assigned_by])),
    fetchByIds<ProjectRow>('projects', rows.map((r) => r.project_id)),
    fetchByIds<TaskListRow>('task_lists', rows.map((r) => r.list_id)),
    fetchByIds<MeetingRow>('meetings', rows.map((r) => r.meeting_id)),
    commentCounts(rows.map((r) => r.id)),
  ])
  return rows.map((r) => {
    const project = r.project_id ? projects.get(r.project_id) : undefined
    const list = r.list_id ? lists.get(r.list_id) : undefined
    const meeting = r.meeting_id ? meetings.get(r.meeting_id) : undefined
    const assignedBy = refOf(profiles, r.assigned_by)
    return {
      ...toTask(r, project?.workspace_id ?? null),
      assignee: refOf(profiles, r.assignee_id),
      assigned_by_user: assignedBy,
      assigned_by_name: r.assigned_by_name ?? assignedBy?.name ?? null,
      project: project ? { id: project.id, name: project.name, color: project.color } : null,
      list: list ? { id: list.id, name: list.name } : null,
      meeting: meeting ? { id: meeting.id, title: meeting.title, started_at: toMeeting(meeting).started_at } : null,
      comment_count: counts.get(r.id) ?? 0,
    }
  })
}

/** A project row, optionally with its members already embedded (select '*, project_members(*)'). */
type ProjectRowWithMembers = ProjectRow & { project_members?: ProjectMemberRow[] }

export async function hydrateProjects(rows: ProjectRowWithMembers[]): Promise<Project[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const db = client()
  const embedded = rows.every((r) => Array.isArray(r.project_members))
  const memberRows = embedded
    ? rows.flatMap((r) => r.project_members ?? [])
    : check<ProjectMemberRow[]>(await db.from('project_members').select('*').in('project_id', ids), 'load project members')
  // Task counts and people load at the same time.
  const [taskRows, profiles, clients] = await Promise.all([
    db.from('tasks').select('project_id, status').in('project_id', ids).then((r) => check<Pick<TaskRow, 'project_id' | 'status'>[]>(r, 'count project tasks')),
    fetchByIds<ProfileRow>('profiles', [...memberRows.map((m) => m.user_id), ...rows.map((r) => r.owner_id)]),
    fetchByIds<ClientRow>('clients', rows.map((r) => r.client_id)).catch(() => new Map<string, ClientRow>()),
  ])
  return rows.map((r) => {
    const projectTasks = taskRows.filter((t) => t.project_id === r.id)
    const done = projectTasks.filter((t) => t.status === 'done').length
    const c = r.client_id ? clients.get(r.client_id) : undefined
    return {
      ...toProject(r),
      client: c ? { id: c.id, name: c.name, color: c.color } : null,
      owner: refOf(profiles, r.owner_id),
      members: memberRows
        .filter((m) => m.project_id === r.id)
        .map((m) => refOf(profiles, m.user_id))
        .filter((u): u is UserRef => u !== null),
      task_count: projectTasks.length,
      done_count: done,
      open_count: projectTasks.length - done,
    }
  })
}

/** Everything but the transcript, which can be long; it's loaded only when someone opens it. */
const MEETING_COLUMNS = 'id, workspace_id, project_id, title, date, started_at, duration_min, summary, attendee_ids, created_at'

async function summarizeMeetings(rows: MeetingRow[]): Promise<MeetingSummary[]> {
  if (rows.length === 0) return []
  const meetings = rows.map(toMeeting)
  const [items, projects, profiles] = await Promise.all([
    client()
      .from('action_items')
      .select('meeting_id, task_id, status')
      .in('meeting_id', meetings.map((m) => m.id))
      .then((r) => check<Pick<ActionItemRow, 'meeting_id' | 'task_id' | 'status'>[]>(r, 'load action items')),
    fetchByIds<ProjectRow>('projects', meetings.map((m) => m.project_id)),
    fetchByIds<ProfileRow>('profiles', meetings.flatMap((m) => m.attendee_ids)),
  ])
  return meetings.map((m) => {
    const mine = items.filter((a) => a.meeting_id === m.id)
    const project = m.project_id ? projects.get(m.project_id) : undefined
    return {
      ...m,
      project: project ? { id: project.id, name: project.name, color: project.color } : null,
      attendees: m.attendee_ids.map((id) => refOf(profiles, id)).filter((u): u is UserRef => u !== null),
      action_item_count: mine.length,
      task_count: mine.filter((a) => a.task_id !== null).length,
      needs_review_count: mine.filter((a) => a.status === 'needs_review').length,
    }
  })
}

async function hydrateActionItems(rows: ActionItemRow[]): Promise<ActionItem[]> {
  if (rows.length === 0) return []
  const [profiles, taskRows] = await Promise.all([
    fetchByIds<ProfileRow>('profiles', rows.map((r) => r.speaker_id)),
    fetchByIds<TaskRow>('tasks', rows.map((r) => r.task_id)),
  ])
  const tasks = new Map((await hydrateTasks([...taskRows.values()])).map((t) => [t.id, t]))
  return rows.map((r) => ({
    ...toActionItem(r),
    speaker: refOf(profiles, r.speaker_id),
    task: r.task_id ? (tasks.get(r.task_id) ?? null) : null,
  }))
}

// =====================================================================
// Workspaces, roles & members
// =====================================================================

async function myWorkspaces(userId: string): Promise<Workspace[]> {
  // One round trip: memberships with their organization embedded (falls back to two queries).
  const embedded = await client().from('members').select('*, workspaces(*)').eq('user_id', userId)
  let members: MemberRow[]
  let workspaces: Map<string, WorkspaceRow>
  if (!embedded.error) {
    const rows = (embedded.data as (MemberRow & { workspaces: WorkspaceRow | null })[]).filter(isActiveMember)
    members = rows
    workspaces = new Map(rows.filter((r) => r.workspaces).map((r) => [r.workspace_id, r.workspaces!]))
  } else {
    members = check<MemberRow[]>(await client().from('members').select('*').eq('user_id', userId), 'load your workspaces').filter(isActiveMember)
    workspaces = await fetchByIds<WorkspaceRow>('workspaces', members.map((m) => m.workspace_id))
  }
  return members
    .map((m): Workspace | null => {
      const ws = workspaces.get(m.workspace_id)
      return ws ? { id: ws.id, name: ws.name, created_at: ws.created_at, member_role: toWorkspaceRole(m.role, ws.owner_id === userId) } : null
    })
    .filter((w): w is Workspace => w !== null)
}

/** Which organizations I'm in. Asked by almost every page, so it is reused for a minute (reset after any change). */
function myWorkspaceIds(userId: string): Promise<string[]> {
  return shared(
    `workspace-ids:${userId}`,
    async () => {
      const rows = check<MemberRow[]>(await client().from('members').select('*').eq('user_id', userId), 'load your workspaces')
      return rows.filter(isActiveMember).map((r) => r.workspace_id)
    },
    60_000,
  )
}

async function workspaceOwnerId(workspaceId: string): Promise<string | null> {
  const ws = check<{ owner_id: string | null } | null>(
    await client().from('workspaces').select('owner_id').eq('id', workspaceId).maybeSingle(),
    'load workspace',
  )
  return ws?.owner_id ?? null
}

/** The user's role in a workspace, or null if they aren't a member. */
async function roleIn(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const [member, ownerId] = await Promise.all([
    client()
      .from('members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()
      .then((r) => check<{ role: MemberRow['role'] } | null>(r, 'load your role')),
    workspaceOwnerId(workspaceId),
  ])
  return member ? toWorkspaceRole(member.role, ownerId === userId) : null
}

async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const rows = check<MemberRow[]>(
    await client().from('members').select('*').eq('workspace_id', workspaceId).eq('user_id', userId).limit(1),
    'check membership',
  )
  return rows.some(isActiveMember)
}

/**
 * Members of the given workspaces, with counts of tasks ASSIGNED to them (personal tasks stay private).
 * Deactivated members are left out unless includeDeactivated is set (Admin page).
 */
export async function listMembers(workspaceIds: string[], { includeDeactivated = false } = {}): Promise<Member[]> {
  if (workspaceIds.length === 0) return []
  const db = client()
  const [members, workspaces, projectRows] = await Promise.all([
    db.from('members').select('*').in('workspace_id', workspaceIds).then((r) => check<MemberRow[]>(r, 'load members')),
    fetchByIds<WorkspaceRow>('workspaces', workspaceIds),
    db.from('projects').select('id').in('workspace_id', workspaceIds).then((r) => check<{ id: string }[]>(r, 'load projects')),
  ])
  const projectIds = projectRows.map((p) => p.id)
  const [profiles, taskRows] = await Promise.all([
    fetchByIds<ProfileRow>('profiles', members.map((m) => m.user_id)),
    projectIds.length
      ? db
          .from('tasks')
          .select('assignee_id, status')
          .eq('source', 'assigned')
          .in('project_id', projectIds)
          .then((r) => check<Pick<TaskRow, 'assignee_id' | 'status'>[]>(r, 'count member tasks'))
      : Promise.resolve([] as Pick<TaskRow, 'assignee_id' | 'status'>[]),
  ])

  const seen = new Map<string, Member>()
  for (const m of members) {
    const profile = profiles.get(m.user_id)
    if (!profile || seen.has(m.user_id)) continue
    if (!includeDeactivated && !isActiveMember(m)) continue
    const isOwner = workspaceIds.some((id) => workspaces.get(id)?.owner_id === m.user_id)
    const assigned = taskRows.filter((t) => t.assignee_id === m.user_id)
    const done = assigned.filter((t) => t.status === 'done').length
    seen.set(m.user_id, {
      ...toUser(profile),
      member_role: toWorkspaceRole(m.role, isOwner),
      status: isOwner || isActiveMember(m) ? 'active' : 'deactivated',
      joined_at: m.created_at ?? null,
      task_count: assigned.length,
      done_count: done,
      open_count: assigned.length - done,
      hours_per_day: m.hours_per_day === undefined ? 8 : Number(m.hours_per_day),
      work_days: m.work_days ?? [1, 2, 3, 4, 5],
    })
  }
  return [...seen.values()]
}

async function memberView(workspaceId: string, userId: string): Promise<Member> {
  const member = (await listMembers([workspaceId], { includeDeactivated: true })).find((m) => m.id === userId)
  if (!member) throw notFound('Member')
  return member
}

/** Admins can't change the owner, or themselves (so nobody locks themselves out). */
async function assertCanChangeMember(workspaceId: string, userId: string) {
  const uid = await me()
  if (!MEMBER_ADMINS.includes((await roleIn(workspaceId, uid)) ?? 'member')) throw forbidden('Only workspace admins can manage members.')
  if ((await workspaceOwnerId(workspaceId)) === userId) throw new ApiError(400, "The workspace owner's role can't be changed or removed.")
  if (userId === uid) throw new ApiError(400, "You can't change or remove your own membership. Ask another admin.")
}

// =====================================================================
// Projects & lists
// =====================================================================

/** Projects in all my organizations (shared: the sidebar and the Projects page ask together). */
async function loadProjects(uid: string, includeArchived: boolean): Promise<Project[]> {
  const ids = await myWorkspaceIds(uid)
  if (ids.length === 0) return []
  // Members come embedded in the same request (falls back to a separate query if that isn't possible).
  let res = await client().from('projects').select('*, project_members(*)').in('workspace_id', ids).order('created_at')
  if (res.error && res.error.code !== '42501') res = await client().from('projects').select('*').in('workspace_id', ids).order('created_at')
  const rows = check<ProjectRowWithMembers[]>(res, 'load projects')
  return hydrateProjects(includeArchived ? rows : rows.filter((r) => r.status !== 'archived'))
}

async function getProject(id: string): Promise<Project> {
  const row = check<ProjectRow | null>(await client().from('projects').select('*').eq('id', id).maybeSingle(), 'load project')
  if (!row) throw notFound('Project')
  return (await hydrateProjects([row]))[0]
}

async function listTaskLists(projectId: string): Promise<TaskList[]> {
  const db = client()
  const [lists, taskRows] = await Promise.all([
    db.from('task_lists').select('*').eq('project_id', projectId).order('position').then((r) => check<TaskListRow[]>(r, 'load task lists')),
    db.from('tasks').select('list_id').eq('project_id', projectId).then((r) => check<{ list_id: string | null }[]>(r, 'count list tasks')),
  ])
  return lists.map((l) => ({ ...toTaskList(l), task_count: taskRows.filter((t) => t.list_id === l.id).length }))
}

// =====================================================================
// Tasks
// =====================================================================

/** My tasks. The sidebar, the bell and the dashboard ask at the same time: they share one request. */
function listTasksForAssignee(userId: string, source?: TaskSource): Promise<Task[]> {
  return shared(`my-tasks:${userId}:${source ?? 'all'}`, () => loadTasksForAssignee(userId, source))
}

async function loadTasksForAssignee(userId: string, source?: TaskSource): Promise<Task[]> {
  let query = client().from('tasks').select('*').eq('assignee_id', userId)
  if (source) query = query.eq('source', source)
  const rows = check<TaskRow[]>(await query, 'load your tasks')
  return (await hydrateTasks(rows)).sort(byStatusThenDue)
}

export async function getTask(id: string): Promise<Task> {
  const row = check<TaskRow | null>(await client().from('tasks').select('*').eq('id', id).maybeSingle(), 'load task')
  if (!row) throw notFound('Task')
  return (await hydrateTasks([row]))[0]
}

/**
 * Tasks in the same board column: same project + status, or (for personal tasks)
 * the same person's personal tasks + status. In position order.
 */
async function loadColumn(t: Pick<TaskRow, 'source' | 'project_id' | 'assignee_id' | 'status'>): Promise<TaskRow[]> {
  let query = client().from('tasks').select('*').eq('status', t.status).eq('source', t.source)
  if (t.source === 'personal') {
    query = t.assignee_id ? query.eq('assignee_id', t.assignee_id) : query.is('assignee_id', null)
  } else {
    query = t.project_id ? query.eq('project_id', t.project_id) : query.is('project_id', null)
  }
  return check<TaskRow[]>(await query.order('position'), 'load board column')
}

/**
 * Writes position = index for every task whose position changed.
 * RLS may skip rows the user can't edit (e.g. a member's teammates' cards); that only
 * leaves gaps in the numbering, the order stays correct.
 */
async function savePositions(column: TaskRow[]): Promise<void> {
  const changed = column.map((t, i) => ({ t, i })).filter(({ t, i }) => t.position !== i)
  await Promise.all(
    changed.map(async ({ t, i }) => {
      check(await client().from('tasks').update({ position: i }).eq('id', t.id), 'reorder tasks')
      t.position = i
    }),
  )
}

type NewTaskRow = Omit<TaskRow, 'id' | 'position' | 'created_at' | 'updated_at' | 'assigned_by_name'>

async function insertTask(input: NewTaskRow): Promise<Task> {
  const column = await loadColumn(input)
  const assignedBy = input.assigned_by ? (await fetchByIds<ProfileRow>('profiles', [input.assigned_by])).get(input.assigned_by) : undefined
  const row = check<TaskRow>(
    await client()
      .from('tasks')
      .insert({ ...input, assigned_by_name: assignedBy ? toUser(assignedBy).name : null, position: column.length }) // bottom of its column
      .select('*')
      .single(),
    'create this task',
  )
  return (await hydrateTasks([row]))[0]
}

// =====================================================================
// Meetings & AI action items
// =====================================================================

function listReviewItems(workspaceIds: string[]): Promise<ReviewItem[]> {
  if (workspaceIds.length === 0) return Promise.resolve([])
  return shared(`review:${workspaceIds.join(',')}`, () => loadReviewItems(workspaceIds))
}

async function loadReviewItems(workspaceIds: string[]): Promise<ReviewItem[]> {
  const meetingRows = check<MeetingRow[]>(await client().from('meetings').select('*').in('workspace_id', workspaceIds), 'load meetings')
  if (meetingRows.length === 0) return []
  const meetings = new Map(meetingRows.map((m) => [m.id, toMeeting(m)]))
  const rows = check<ActionItemRow[]>(
    await client().from('action_items').select('*').eq('status', 'needs_review').in('meeting_id', [...meetings.keys()]),
    'load review items',
  )
  return (await hydrateActionItems(rows))
    .map((a) => {
      const m = meetings.get(a.meeting_id)!
      return { ...a, meeting: { id: m.id, title: m.title, started_at: m.started_at, workspace_id: m.workspace_id } }
    })
    .sort((x, y) => y.meeting.started_at.localeCompare(x.meeting.started_at))
}

// =====================================================================
// Organization admin: invitations
// =====================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE_DAYS = 7

interface InvitationRow {
  id: string
  workspace_id: string
  email: string
  role: AssignableRole
  status: Invitation['status']
  invited_by: string | null
  created_at: string
  expires_at: string
}

/**
 * Emails a magic link (Supabase creates the account if it doesn't exist). The link opens
 * /welcome, where the app accepts the invite. Returns an error message, or null when sent.
 */
async function sendInviteEmail(email: string): Promise<string | null> {
  const mailer = createMailerClient()
  if (!mailer) return 'Supabase is not configured.'
  const { error } = await mailer.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${window.location.origin}/welcome`,
      // Only stored for brand-new accounts: tells the app to show the Welcome form.
      data: { invited: true, app: 'taskapp' },
    },
  })
  if (!error) return null
  const msg = error.message ?? ''
  if (/rate limit|security purposes|too many/i.test(msg)) return 'Too many emails were sent just now. Wait a minute, then press Resend.'
  if (/signups? not allowed|signup.*disabled/i.test(msg)) return "New sign-ups are turned off on the Supabase server, so new people can't be invited."
  if (/sending|smtp|mail/i.test(msg)) return "The email couldn't be sent. Check the SMTP settings on the Supabase server."
  return msg
}

function inviteExpiry() {
  return new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

const isoDay = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`

// =====================================================================
// Activity log
// =====================================================================

interface ActivityRow {
  id: number
  workspace_id: string
  actor_id: string | null
  action: string
  entity_type: ActivityEntry['entity_type']
  entity_id: string | null
  entity_name: string | null
  project_id: string | null
  target_user_id: string | null
  details: Record<string, unknown>
  created_at: string
}

/** Which entity types each filter on the Activity tab shows (null = everything). */
const ACTIVITY_TYPES: Record<ActivityCategory, ActivityEntry['entity_type'][] | null> = {
  all: null,
  tasks: ['task', 'ai_item'],
  projects: ['project'],
  people: ['member', 'invite'],
  organization: ['organization'],
}

// =====================================================================
// Organization settings & CSV export
// =====================================================================

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const CSV_STATUS: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done' }

/**
 * Builds a CSV file. Cells that start with = + - @ get a leading apostrophe so a spreadsheet
 * never runs them as formulas (CSV injection). Starts with a BOM so Excel reads UTF-8 correctly.
 */
function toCsv(header: string[], rows: string[][]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')
}

// =====================================================================
// Comment attachments (Supabase Storage, private bucket; database/migrations/009)
// =====================================================================

export const ATTACHMENT_BUCKET = 'taskapp-attachments'
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_COMMENT = 5
/** How long a download link works. */
const ATTACHMENT_LINK_SECONDS = 60 * 60

interface AttachmentRow {
  id: string
  comment_id: string
  task_id: string
  uploaded_by: string | null
  file_name: string
  storage_path: string
  mime_type: string
  size_bytes: number
  created_at: string
}

/** Keeps file names readable but safe as a storage path. */
function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-100)
  return cleaned.replace(/^[.-]+/, '') || 'file'
}

/** Attachments of the given tasks, grouped by comment, with signed download links. */
async function loadAttachments(taskIds: string[]): Promise<Map<string, Attachment[]>> {
  const byComment = new Map<string, Attachment[]>()
  if (taskIds.length === 0) return byComment
  const res = await client().from('comment_attachments').select('*').in('task_id', taskIds).order('created_at')
  if (res.error) return byComment // table missing before migration 009: comments just show without files
  const rows = (res.data ?? []) as AttachmentRow[]
  if (rows.length === 0) return byComment

  const signed = await client()
    .storage.from(ATTACHMENT_BUCKET)
    .createSignedUrls(rows.map((r) => r.storage_path), ATTACHMENT_LINK_SECONDS)
  const urls = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]))

  for (const r of rows) {
    const list = byComment.get(r.comment_id) ?? []
    list.push({
      id: r.id,
      comment_id: r.comment_id,
      file_name: r.file_name,
      mime_type: r.mime_type,
      size_bytes: Number(r.size_bytes),
      storage_path: r.storage_path,
      uploaded_by: r.uploaded_by,
      url: urls.get(r.storage_path) ?? null,
    })
    byComment.set(r.comment_id, list)
  }
  return byComment
}

/** Storage paths of every file attached to these tasks (collected before the tasks are deleted). */
async function attachmentPaths(taskIds: string[]): Promise<string[]> {
  if (taskIds.length === 0) return []
  const res = await client().from('comment_attachments').select('storage_path').in('task_id', taskIds)
  return res.error ? [] : ((res.data ?? []) as { storage_path: string }[]).map((r) => r.storage_path)
}

/** Best effort: removes files whose task is gone. A leftover file is harmless, so errors are ignored. */
async function removeFiles(paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    await client().storage.from(ATTACHMENT_BUCKET).remove(paths.slice(i, i + 100))
  }
}

function checkAttachment(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} is larger than 10 MB.`
  if (file.size === 0) return `${file.name} is empty.`
  return null
}

function uploadErrorMessage(file: File, message: string): string {
  if (/mime|type.*not supported|invalid.*type/i.test(message)) return `${file.name}: this file type isn't allowed.`
  if (/size|too large|exceed/i.test(message)) return `${file.name} is larger than 10 MB.`
  if (/bucket not found/i.test(message)) return 'Attachments need a database update. Run database/migrations/009_comment_attachments.sql in the Supabase SQL Editor.'
  return `${file.name}: ${message}`
}

// =====================================================================
// Public API used by the pages
// =====================================================================

export const api = {
  // ---------- Auth / profile ----------

  async me(): Promise<{ user: User; workspaces: Workspace[] }> {
    const uid = await me()
    const [res, workspaces] = await Promise.all([client().from('profiles').select('*').eq('id', uid).maybeSingle(), myWorkspaces(uid)])
    // Pages ask "which organizations am I in?" next: answer from here instead of asking the server again.
    seedShared(`workspace-ids:${uid}`, workspaces.map((w) => w.id))
    const row = check<ProfileRow | null>(res, 'load your profile')
    if (!row) throw new ApiError(404, 'Your profile was not found. Ask an admin to check the taskapp signup trigger.')
    return { user: toUser(row), workspaces }
  },

  /** "role" is the job title shown in the UI. */
  async updateMe(patch: { name?: string; role?: string }): Promise<User> {
    const uid = await me()
    const fields: Partial<ProfileRow> = {}
    if (patch.name !== undefined) fields.name = patch.name.trim()
    if (patch.role !== undefined) fields.job_title = patch.role.trim() || null
    const row = check<ProfileRow>(
      await client().from('profiles').update(fields).eq('id', uid).select('*').single(),
      'update your profile',
    )
    return toUser(row)
  },

  /** A new workspace owned by the current user (used right after signup). */
  async createWorkspace(name: string): Promise<Workspace> {
    const uid = await me()
    const ws = check<WorkspaceRow>(
      await client().from('workspaces').insert({ name, owner_id: uid }).select('*').single(),
      'create a workspace',
    )
    check(await client().from('members').insert({ workspace_id: ws.id, user_id: uid, role: 'admin' }), 'join your new workspace')
    return { id: ws.id, name: ws.name, created_at: ws.created_at, member_role: 'owner' }
  },

  // ---------- Team ----------

  /** Team members. Pass a workspace id to get only that workspace's members. */
  async users(workspaceId?: string | null): Promise<Member[]> {
    const ids = workspaceId ? [workspaceId] : await myWorkspaceIds(await me())
    return listMembers(ids)
  },

  async updateMemberRole(workspaceId: string, userId: string, role: AssignableRole): Promise<Member> {
    await assertCanChangeMember(workspaceId, userId)
    const rows = check<{ id: string }[]>(
      await client().from('members').update({ role }).eq('workspace_id', workspaceId).eq('user_id', userId).select('id'),
      'change roles',
    )
    if (rows.length === 0) throw forbidden('Only workspace admins can change roles.')
    return memberView(workspaceId, userId)
  },

  /** Removes someone from the workspace and its projects. Their tasks stay and can be reassigned. */
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await assertCanChangeMember(workspaceId, userId)
    const db = client()
    const projects = check<{ id: string }[]>(await db.from('projects').select('id').eq('workspace_id', workspaceId), 'load projects')
    if (projects.length) {
      check(
        await db.from('project_members').delete().eq('user_id', userId).in('project_id', projects.map((p) => p.id)),
        'remove them from projects',
      )
    }
    const rows = check<{ id: string }[]>(
      await db.from('members').delete().eq('workspace_id', workspaceId).eq('user_id', userId).select('id'),
      'remove members',
    )
    if (rows.length === 0) throw forbidden('Only workspace admins can remove members.')
  },

  // ---------- Projects ----------

  /** Projects in all my organizations. Archived ones are left out unless asked for. */
  async projects({ includeArchived = false } = {}): Promise<Project[]> {
    const uid = await me()
    return shared(`projects:${uid}:${includeArchived}`, () => loadProjects(uid, includeArchived))
  },

  project: (id: string) => getProject(id),

  projectLists: (id: string) => listTaskLists(id),

  /** workspace_id defaults to the first workspace where the user may create projects. The creator becomes the owner. */
  async createProject(body: {
    name: string
    workspace_id?: string
    description?: string
    color?: string
    status?: ProjectStatus
    start_date?: string | null
    due_date?: string | null
    client_id?: string | null
  }): Promise<Project> {
    const uid = await me()
    let workspaceId = body.workspace_id
    if (workspaceId) {
      if (!WORK_MANAGERS.includes((await roleIn(workspaceId, uid)) ?? 'member')) {
        throw forbidden('Only workspace admins and managers can create projects.')
      }
    } else {
      workspaceId = (await myWorkspaces(uid)).find((w) => WORK_MANAGERS.includes(w.member_role))?.id
      if (!workspaceId) throw forbidden('Only workspace admins and managers can create projects.')
    }

    const db = client()
    // The id is made here and the insert asks for nothing back: the "who can see a project" rule
    // (migration 007) looks the project up by id, and a row isn't visible to that lookup inside
    // its own INSERT statement, so INSERT … RETURNING would be refused. We read it back afterwards.
    const projectId = crypto.randomUUID()
    check(
      await db.from('projects').insert({
        id: projectId,
        workspace_id: workspaceId,
        name: body.name.trim(),
        description: body.description ?? '',
        color: body.color ?? '#4f46e5',
        health: body.status ?? 'on_track',
        end_date: body.due_date ?? null,
        owner_id: uid,
        // Only sent when set, so creating projects keeps working before migration 013.
        ...(body.start_date ? { start_date: body.start_date } : {}),
        ...(body.client_id ? { client_id: body.client_id } : {}),
      }),
      'create projects',
    )
    check(await db.from('project_members').insert({ project_id: projectId, user_id: uid }), 'add you to the project')
    // Every new project starts with the organization's default lists (Admin → Settings), or "General".
    const ws = check<WorkspaceRow | null>(await db.from('workspaces').select('*').eq('id', workspaceId).maybeSingle(), 'load the organization')
    const listNames = ws?.default_lists?.length ? ws.default_lists : ['General']
    check(
      await db.from('task_lists').insert(listNames.map((name, position) => ({ project_id: projectId, name, position }))),
      'create the default lists',
    )
    return getProject(projectId)
  },

  /** Admins/owners only. Its lists, tasks and comments go with it. */
  async deleteProject(id: string): Promise<void> {
    const taskIds = check<{ id: string }[]>(await client().from('tasks').select('id').eq('project_id', id), 'load project tasks').map((t) => t.id)
    const files = await attachmentPaths(taskIds)
    const rows = check<{ id: string }[]>(await client().from('projects').delete().eq('id', id).select('id'), 'delete projects')
    if (rows.length === 0) throw forbidden('Only workspace admins can delete projects.')
    await removeFiles(files)
  },

  // ---------- Tasks ----------

  /** The "My tasks" dashboard: tasks assigned to me (assigned, personal or both). */
  async myTasks(source: TaskSource | 'all' = 'all'): Promise<Task[]> {
    return listTasksForAssignee(await me(), source === 'all' ? undefined : source)
  },

  /** A project's tasks, ordered for the board (status, then position). */
  async projectTasks(projectId: string): Promise<Task[]> {
    const rows = check<TaskRow[]>(await client().from('tasks').select('*').eq('project_id', projectId), 'load project tasks')
    const order: Record<TaskStatus, number> = { todo: 0, in_progress: 1, done: 2 }
    return (await hydrateTasks(rows)).sort((a, b) => order[a.status] - order[b.status] || a.position - b.position)
  },

  task: (id: string) => getTask(id),

  /** A project task. Admins/managers can assign anyone (or nobody); members only themselves. */
  async createTask(body: {
    title: string
    project_id: string
    assignee_id?: string | null
    list_id?: string
    description?: string
    due_date?: string | null
    start_date?: string | null
    estimate_minutes?: number | null
    priority?: Priority
    status?: TaskStatus
  }): Promise<Task> {
    const uid = await me()
    const project = await getProject(body.project_id)
    const manager = WORK_MANAGERS.includes((await roleIn(project.workspace_id, uid)) ?? 'member')

    const assigneeId = body.assignee_id === undefined ? (manager ? null : uid) : body.assignee_id
    if (!manager && assigneeId !== uid) throw forbidden(NOT_MANAGER_ASSIGN)
    if (assigneeId && !(await isWorkspaceMember(project.workspace_id, assigneeId))) {
      throw new ApiError(400, "That person isn't a member of this project's workspace.")
    }

    let listId = body.list_id
    if (!listId) {
      listId = (await listTaskLists(project.id))[0]?.id
      if (!listId) throw new ApiError(400, 'This project has no task lists.')
    }

    return insertTask({
      project_id: project.id,
      list_id: listId,
      title: body.title.trim(),
      description: body.description ?? '',
      source: 'assigned',
      status: toDbStatus(body.status ?? 'todo'),
      priority: body.priority ?? 'medium',
      assignee_id: assigneeId,
      assigned_by: uid,
      created_by: uid,
      meeting_id: null,
      due_date: body.due_date ?? null,
      // Only sent when set, so creating tasks keeps working before migration 013.
      ...(body.start_date ? { start_date: body.start_date } : {}),
      ...(body.estimate_minutes ? { estimate_minutes: body.estimate_minutes } : {}),
    })
  },

  /** A private to-do: no project, always assigned to the current user. */
  async createPersonalTask(body: { title: string; due_date?: string | null; priority?: Priority; description?: string }): Promise<Task> {
    const uid = await me()
    return insertTask({
      project_id: null,
      list_id: null,
      title: body.title.trim(),
      description: body.description ?? '',
      source: 'personal',
      status: 'pending',
      priority: body.priority ?? 'medium',
      assignee_id: uid,
      assigned_by: null,
      created_by: uid,
      meeting_id: null,
      due_date: body.due_date ?? null,
    })
  },

  /**
   * Updates a task. Drag & drop sends { status, position } (position = index in the target column, 0 = top);
   * the task moves to that spot and both columns are renumbered.
   */
  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    const uid = await me()
    const db = client()
    const before = check<TaskRow | null>(await db.from('tasks').select('*').eq('id', id).maybeSingle(), 'load task')
    if (!before) throw notFound('Task')

    if (before.source === 'personal') {
      if (patch.assignee_id !== undefined || patch.list_id !== undefined) {
        throw new ApiError(400, 'Personal tasks always belong to you and have no list.')
      }
    } else if (before.project_id) {
      const project = await getProject(before.project_id)
      const manager = WORK_MANAGERS.includes((await roleIn(project.workspace_id, uid)) ?? 'member')
      const own = before.assignee_id === uid || before.created_by === uid
      if (!manager && !own) throw forbidden('You can only change tasks that are yours. Ask an admin or manager to change this one.')
      if (!manager && patch.assignee_id !== undefined && patch.assignee_id !== uid) throw forbidden(NOT_MANAGER_ASSIGN)
      if (patch.assignee_id && !(await isWorkspaceMember(project.workspace_id, patch.assignee_id))) {
        throw new ApiError(400, "That person isn't a member of this project's workspace.")
      }
    }

    const { position, status, ...rest } = patch
    const fields: Partial<TaskRow> = { ...rest, updated_at: nowIso() }
    if (status) fields.status = toDbStatus(status)

    const after = check<TaskRow | null>(await db.from('tasks').update(fields).eq('id', id).select('*').maybeSingle(), 'change this task')
    if (!after) throw forbidden("You don't have permission to change this task.")

    // A task's column is its project (or owner, for personal tasks) + status.
    const columnChanged = after.status !== before.status
    if (position !== undefined || columnChanged) {
      if (columnChanged) await savePositions((await loadColumn(before)).filter((t) => t.id !== id))
      const target = (await loadColumn(after)).filter((t) => t.id !== id)
      const index = Math.max(0, Math.min(position ?? target.length, target.length))
      target.splice(index, 0, after)
      await savePositions(target)
    }
    return getTask(id)
  },

  async deleteTask(id: string): Promise<void> {
    const db = client()
    const row = check<TaskRow | null>(await db.from('tasks').select('*').eq('id', id).maybeSingle(), 'load task')
    if (!row) throw notFound('Task')
    const files = await attachmentPaths([id])
    // Comments and subtasks cascade in the database; action items lose their link.
    const deleted = check<{ id: string }[]>(await db.from('tasks').delete().eq('id', id).select('id'), 'delete this task')
    if (deleted.length === 0) throw forbidden('You can only delete tasks you created.')
    await Promise.all([savePositions(await loadColumn(row)), removeFiles(files)])
  },

  // ---------- Comments ----------

  async comments(taskId: string): Promise<Comment[]> {
    const rows = check<CommentRow[]>(
      await client().from('comments').select('*').eq('task_id', taskId).order('created_at'),
      'load comments',
    )
    const [profiles, files] = await Promise.all([
      fetchByIds<ProfileRow>('profiles', rows.flatMap((r) => [r.user_id, ...(r.mentions ?? [])])),
      loadAttachments([taskId]),
    ])
    return rows.map((r) => ({
      ...toComment(r),
      author: refOf(profiles, r.user_id),
      attachments: files.get(r.id) ?? [],
      mentioned: (r.mentions ?? []).map((id) => refOf(profiles, id)).filter((u): u is UserRef => u !== null),
    }))
  },

  /**
   * Posts a comment, optionally with files (up to 5, 10 MB each). The text can be empty when files
   * are attached. If some files fail to upload, the comment is still posted and the error says which.
   */
  /** `mentions`: ids of @mentioned people (they get a notification, migration 012). */
  async addComment(taskId: string, body: string, files: File[] = [], mentions: string[] = []): Promise<Comment> {
    const uid = await me()
    const text = body.trim()
    if (!text && files.length === 0) throw new ApiError(400, 'Write something or attach a file.')
    if (files.length > MAX_ATTACHMENTS_PER_COMMENT) throw new ApiError(400, `Attach at most ${MAX_ATTACHMENTS_PER_COMMENT} files per comment.`)
    const tooBig = files.map(checkAttachment).find(Boolean)
    if (tooBig) throw new ApiError(400, tooBig)

    const ids = [...new Set(mentions)]
    // "mentions" is left out when empty, so plain comments also work before migration 012.
    const res = await client()
      .from('comments')
      .insert({ task_id: taskId, user_id: uid, body: text, ...(ids.length ? { mentions: ids } : {}) })
      .select('*')
      .single()
    if (res.error && ids.length && /mentions/.test(res.error.message)) {
      throw new ApiError(500, '@mentions need a database update. Run database/migrations/012_notifications.sql in the Supabase SQL Editor.')
    }
    const row = check<CommentRow>(res, 'comment on this task')

    const failed: string[] = []
    for (const file of files) {
      const path = `${taskId}/${row.id}/${crypto.randomUUID().slice(0, 8)}-${safeFileName(file.name)}`
      const contentType = file.type || 'application/octet-stream'
      const up = await client().storage.from(ATTACHMENT_BUCKET).upload(path, file, { contentType, upsert: false })
      if (up.error) {
        failed.push(uploadErrorMessage(file, up.error.message))
        continue
      }
      const rec = await client().from('comment_attachments').insert({
        comment_id: row.id,
        task_id: taskId,
        uploaded_by: uid,
        file_name: file.name.slice(0, 255),
        storage_path: path,
        mime_type: contentType,
        size_bytes: file.size,
      })
      if (rec.error) {
        await client().storage.from(ATTACHMENT_BUCKET).remove([path]) // don't leave an unlisted file behind
        failed.push(uploadErrorMessage(file, toApiError(rec.error, 'attach files').message))
      }
    }
    if (failed.length) throw new ApiError(207, `Comment posted, but some files weren't attached. ${failed.join(' ')}`)

    const [profiles, attached] = await Promise.all([fetchByIds<ProfileRow>('profiles', [uid, ...ids]), loadAttachments([taskId])])
    return {
      ...toComment(row),
      author: refOf(profiles, uid),
      attachments: attached.get(row.id) ?? [],
      mentioned: ids.map((id) => refOf(profiles, id)).filter((u): u is UserRef => u !== null),
    }
  },

  /** Removes one attachment (uploader, project admins/managers, or the owner of a personal task). */
  async deleteAttachment(attachment: Attachment): Promise<void> {
    const rows = check<{ id: string }[]>(
      await client().from('comment_attachments').delete().eq('id', attachment.id).select('id'),
      'remove this file',
    )
    if (rows.length === 0) throw forbidden('Only the person who uploaded it, or an admin or manager, can remove this file.')
    await removeFiles([attachment.storage_path])
  },

  // ---------- Meetings & AI review ----------

  /** Newest first, with attendees and action item counts. */
  async meetings(): Promise<MeetingSummary[]> {
    const ids = await myWorkspaceIds(await me())
    if (ids.length === 0) return []
    const rows = check<MeetingRow[]>(await client().from('meetings').select(MEETING_COLUMNS).in('workspace_id', ids), 'load meetings')
    return (await summarizeMeetings(rows)).sort((a, b) => b.started_at.localeCompare(a.started_at))
  },

  async meeting(id: string): Promise<MeetingDetail> {
    const db = client()
    const row = check<MeetingRow | null>(await db.from('meetings').select(MEETING_COLUMNS).eq('id', id).maybeSingle(), 'load meeting')
    if (!row) throw notFound('Meeting')
    const [summary, items] = await Promise.all([
      summarizeMeetings([row]),
      db
        .from('action_items')
        .select('*')
        .eq('meeting_id', id)
        .order('created_at')
        .then((r) => check<ActionItemRow[]>(r, 'load action items')),
    ])
    return { ...summary[0], action_items: await hydrateActionItems(items) }
  },

  /** "Assign to me" in the AI review panel (database function from migration 003). */
  async assignActionItemToMe(id: string): Promise<{ task: Task }> {
    const taskId = check<string>(await client().rpc('assign_action_item_to_me', { p_item_id: id }), 'take this item')
    return { task: await getTask(taskId) }
  },

  /** "Ignore" in the AI review panel. Admins and managers only. */
  async ignoreActionItem(id: string): Promise<void> {
    const db = client()
    const item = check<{ status: string } | null>(await db.from('action_items').select('status').eq('id', id).maybeSingle(), 'load action item')
    if (!item) throw notFound('Action item')
    if (item.status !== 'needs_review') throw new ApiError(409, `This action item was already handled (status: ${item.status}).`)
    const rows = check<{ id: string }[]>(
      await db.from('action_items').update({ status: 'ignored' }).eq('id', id).select('id'),
      'dismiss AI suggestions',
    )
    if (rows.length === 0) throw forbidden('Only workspace admins and managers can dismiss AI suggestions.')
  },

  // ---------- Organization admin ----------

  /** Renames an organization (owner and admins). */
  async renameWorkspace(id: string, name: string): Promise<void> {
    const rows = check<{ id: string }[]>(
      await client().from('workspaces').update({ name: name.trim() }).eq('id', id).select('id'),
      'rename the organization',
    )
    if (rows.length === 0) throw forbidden('Only organization admins can rename it.')
  },

  /** Open (pending) invitations of one organization, newest first. Admins only. */
  async invitations(workspaceId: string): Promise<Invitation[]> {
    const rows = check<InvitationRow[]>(
      await client()
        .from('invitations')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
      'load invitations',
    )
    const profiles = await fetchByIds<ProfileRow>('profiles', rows.map((r) => r.invited_by))
    return rows.map((r) => ({ ...r, invited_by: refOf(profiles, r.invited_by) }))
  },

  /**
   * Invites people by email: saves an invitation for each address and emails them a magic link.
   * Works for new people and for people who already have an account.
   */
  async invite(workspaceId: string, emails: string[], role: AssignableRole): Promise<InviteResult> {
    const uid = await me()
    const result: InviteResult = { sent: [], failed: [] }
    const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
    const existing = new Map((await listMembers([workspaceId], { includeDeactivated: true })).map((m) => [m.email.toLowerCase(), m]))

    // The database enforces allowed domains too; checking here gives a clear message per address.
    const domains = (await api.workspaceSettings(workspaceId).catch(() => null))?.allowed_domains ?? []

    for (const email of wanted) {
      if (!EMAIL_RE.test(email)) {
        result.failed.push({ email, error: 'Not a valid email address.' })
        continue
      }
      if (domains.length && !domains.includes(email.split('@')[1])) {
        result.failed.push({ email, error: `Only ${domains.map((d) => '@' + d).join(', ')} addresses can be invited (Admin → Settings).` })
        continue
      }
      const member = existing.get(email)
      if (member) {
        result.failed.push({
          email,
          error: member.status === 'deactivated' ? 'Deactivated member. Reactivate them in the Members tab.' : 'Already a member of this organization.',
        })
        continue
      }
      const res = await client()
        .from('invitations')
        .insert({ workspace_id: workspaceId, email, role, invited_by: uid, expires_at: inviteExpiry() })
      if (res.error) {
        result.failed.push({
          email,
          error: res.error.code === '23505' ? 'Already invited. Use Resend in the list below.' : toApiError(res.error, 'invite people').message,
        })
        continue
      }
      const mailError = await sendInviteEmail(email)
      if (mailError) result.failed.push({ email, error: `Invite saved, but the email failed: ${mailError}` })
      else result.sent.push(email)
    }
    return result
  },

  /** Sends the magic link again and gives the invite a fresh expiry date. */
  async resendInvite(invitation: Invitation): Promise<void> {
    const rows = check<{ id: string }[]>(
      await client()
        .from('invitations')
        .update({ expires_at: inviteExpiry(), created_at: nowIso() })
        .eq('id', invitation.id)
        .select('id'),
      'resend invitations',
    )
    if (rows.length === 0) throw forbidden('Only organization admins can resend invitations.')
    const mailError = await sendInviteEmail(invitation.email)
    if (mailError) throw new ApiError(502, mailError)
  },

  async cancelInvite(id: string): Promise<void> {
    const rows = check<{ id: string }[]>(
      await client().from('invitations').update({ status: 'cancelled' }).eq('id', id).select('id'),
      'cancel invitations',
    )
    if (rows.length === 0) throw forbidden('Only organization admins can cancel invitations.')
  },

  /** Joins every organization that invited the signed-in user's email. Safe to call on every sign-in. */
  async acceptInvitations(): Promise<JoinedWorkspace[]> {
    const res = await client().rpc('accept_my_invitations')
    if (res.error?.code === 'PGRST202') {
      console.warn('Invitations are not set up yet: run database/migrations/004_admin_invites.sql')
      return []
    }
    return check<JoinedWorkspace[] | null>(res, 'accept your invitations') ?? []
  },

  /** Numbers and team workload for the Admin page. */
  async adminOverview(workspaceId: string): Promise<AdminOverview> {
    const db = client()
    const [members, projectRows, invites] = await Promise.all([
      listMembers([workspaceId]),
      db.from('projects').select('id').eq('workspace_id', workspaceId).then((r) => check<{ id: string }[]>(r, 'load projects')),
      // Before migration 004 the table doesn't exist: just show 0.
      db
        .from('invitations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .then((r) => (r.error ? [] : (r.data as { id: string }[]))),
    ])
    const projectIds = projectRows.map((p) => p.id)
    const tasks = projectIds.length
      ? check<Pick<TaskRow, 'assignee_id' | 'status' | 'due_date'>[]>(
          await db.from('tasks').select('assignee_id, status, due_date').eq('source', 'assigned').in('project_id', projectIds),
          'load tasks',
        )
      : []

    const d = new Date()
    const today = isoDay(d)
    const weekEnd = isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7))
    const isOpen = (t: { status: string }) => t.status !== 'done'
    const isOverdue = (t: { status: string; due_date: string | null }) => isOpen(t) && !!t.due_date && t.due_date < today

    const roles: Record<WorkspaceRole, number> = { owner: 0, admin: 0, manager: 0, member: 0 }
    for (const m of members) roles[m.member_role]++
    const open = tasks.filter(isOpen)

    return {
      members: members.length,
      roles,
      projects: projectIds.length,
      open: open.length,
      overdue: open.filter(isOverdue).length,
      done: tasks.length - open.length,
      due_this_week: open.filter((t) => !!t.due_date && t.due_date >= today && t.due_date <= weekEnd).length,
      pending_invites: invites.length,
      workload: members
        .map((user) => {
          const mine = tasks.filter((t) => t.assignee_id === user.id)
          return { user, open: mine.filter(isOpen).length, overdue: mine.filter(isOverdue).length, done: mine.filter((t) => !isOpen(t)).length }
        })
        .sort((a, b) => b.overdue - a.overdue || b.open - a.open),
    }
  },

  // ---------- Admin: members ----------

  /** Everyone in the organization (deactivated too), with workload, joined date and last sign-in. */
  async adminMembers(workspaceId: string): Promise<AdminMember[]> {
    const db = client()
    const [members, projectRows, activity] = await Promise.all([
      listMembers([workspaceId], { includeDeactivated: true }),
      db.from('projects').select('id').eq('workspace_id', workspaceId).then((r) => check<{ id: string }[]>(r, 'load projects')),
      // Needs migration 005; without it "last active" just stays empty.
      db
        .rpc('workspace_member_activity', { p_workspace_id: workspaceId })
        .then((r) => (r.error ? [] : ((r.data ?? []) as { user_id: string; last_sign_in_at: string | null }[]))),
    ])
    const projectIds = projectRows.map((p) => p.id)
    const tasks = projectIds.length
      ? check<Pick<TaskRow, 'assignee_id' | 'status' | 'due_date'>[]>(
          await db.from('tasks').select('assignee_id, status, due_date').eq('source', 'assigned').in('project_id', projectIds),
          'load tasks',
        )
      : []
    const today = isoDay(new Date())
    const lastSeen = new Map(activity.map((a) => [a.user_id, a.last_sign_in_at]))
    const rank: Record<WorkspaceRole, number> = { owner: 0, admin: 1, manager: 2, member: 3 }

    return members
      .map((m) => {
        const mine = tasks.filter((t) => t.assignee_id === m.id)
        const open = mine.filter((t) => t.status !== 'done')
        return {
          ...m,
          open: open.length,
          overdue: open.filter((t) => !!t.due_date && t.due_date < today).length,
          done: mine.length - open.length,
          last_sign_in_at: lastSeen.get(m.id) ?? null,
        }
      })
      .sort(
        (a, b) =>
          Number(a.status === 'deactivated') - Number(b.status === 'deactivated') ||
          rank[a.member_role] - rank[b.member_role] ||
          a.name.localeCompare(b.name),
      )
  },

  /**
   * Deactivate: they can't open this organization any more (their account, other organizations
   * and task history stay). Reactivate: let them back in with the same role.
   */
  async setMemberStatus(workspaceId: string, userId: string, status: MemberStatus): Promise<void> {
    await assertCanChangeMember(workspaceId, userId)
    const res = await client()
      .from('members')
      .update({ status, deactivated_at: status === 'deactivated' ? nowIso() : null })
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .select('id')
    if (res.error && /status|deactivated_at/.test(res.error.message)) {
      throw new ApiError(500, 'Deactivating needs a database update. Run database/migrations/005_member_management.sql in the Supabase SQL Editor.')
    }
    const rows = check<{ id: string }[]>(res, 'change member status')
    if (rows.length === 0) throw forbidden('Only workspace admins can deactivate members.')
  },

  /** Moves someone's unfinished project tasks in this organization to another active member. Returns how many moved. */
  async reassignOpenTasks(workspaceId: string, fromUserId: string, toUserId: string): Promise<number> {
    const uid = await me()
    if (fromUserId === toUserId) throw new ApiError(400, 'Pick a different person to take over the tasks.')
    if (!WORK_MANAGERS.includes((await roleIn(workspaceId, uid)) ?? 'member')) {
      throw forbidden('Only workspace admins and managers can reassign tasks.')
    }
    if (!(await isWorkspaceMember(workspaceId, toUserId))) throw new ApiError(400, 'That person is not an active member of this organization.')

    const db = client()
    const projectIds = check<{ id: string }[]>(await db.from('projects').select('id').eq('workspace_id', workspaceId), 'load projects').map(
      (p) => p.id,
    )
    if (projectIds.length === 0) return 0
    const myProfile = (await fetchByIds<ProfileRow>('profiles', [uid])).get(uid)
    const moved = check<{ id: string }[]>(
      await db
        .from('tasks')
        .update({
          assignee_id: toUserId,
          assigned_by: uid,
          assigned_by_name: myProfile ? toUser(myProfile).name : null,
          updated_at: nowIso(),
        })
        .eq('assignee_id', fromUserId)
        .eq('source', 'assigned')
        .in('status', ['pending', 'in_progress'])
        .in('project_id', projectIds)
        .select('id'),
      'reassign tasks',
    )
    return moved.length
  },

  /** Emails a "reset your password" link (opens /reset-password). Works without being signed in. */
  async sendPasswordReset(email: string): Promise<void> {
    const mailer = createMailerClient()
    if (!mailer) throw new ApiError(0, 'Supabase is not configured.')
    const { error } = await mailer.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (!error) return
    const msg = error.message ?? ''
    if (/rate limit|security purposes|too many/i.test(msg)) throw new ApiError(429, 'Too many emails were sent just now. Wait a minute and try again.')
    if (/sending|smtp|mail/i.test(msg)) throw new ApiError(502, "The email couldn't be sent. Check the SMTP settings on the Supabase server.")
    throw new ApiError(400, msg)
  },

  // ---------- Admin: projects ----------

  /** Every project of the organization you can see (archived and private too), with progress and overdue counts. */
  async adminProjects(workspaceId: string): Promise<AdminProject[]> {
    const db = client()
    const rows = check<ProjectRow[]>(
      await db.from('projects').select('*').eq('workspace_id', workspaceId).order('created_at'),
      'load projects',
    )
    if (rows.length === 0) return []
    const [projects, tasks] = await Promise.all([
      hydrateProjects(rows),
      db
        .from('tasks')
        .select('project_id, status, due_date')
        .in('project_id', rows.map((r) => r.id))
        .then((r) => check<Pick<TaskRow, 'project_id' | 'status' | 'due_date'>[]>(r, 'load project tasks')),
    ])
    const today = isoDay(new Date())
    return projects
      .map((p) => ({
        ...p,
        overdue_count: tasks.filter((t) => t.project_id === p.id && t.status !== 'done' && !!t.due_date && t.due_date < today).length,
        progress: p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0,
      }))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
  },

  /** Archive / restore, make private / visible to everyone, or hand the project to a new owner. */
  async updateProjectAdmin(id: string, patch: { archived?: boolean; is_private?: boolean; owner_id?: string }): Promise<void> {
    const db = client()
    const fields: Record<string, unknown> = {}
    if (patch.archived !== undefined) fields.status = patch.archived ? 'archived' : 'active'
    if (patch.is_private !== undefined) fields.is_private = patch.is_private
    if (patch.owner_id !== undefined) fields.owner_id = patch.owner_id

    const res = await db.from('projects').update(fields).eq('id', id).select('id')
    if (res.error && /is_private/.test(res.error.message)) {
      throw new ApiError(500, 'Private projects need a database update. Run database/migrations/007_project_admin.sql in the Supabase SQL Editor.')
    }
    const rows = check<{ id: string }[]>(res, 'change this project')
    if (rows.length === 0) throw forbidden('Only admins and managers who can see this project can change it.')

    // The owner is always one of the project's members.
    if (patch.owner_id) {
      const existing = check<ProjectMemberRow[]>(
        await db.from('project_members').select('*').eq('project_id', id).eq('user_id', patch.owner_id),
        'load project members',
      )
      if (existing.length === 0) check(await db.from('project_members').insert({ project_id: id, user_id: patch.owner_id }), 'add the new owner to the project')
    }
  },

  /** Client and dates of a project (admins / managers). */
  async updateProjectDetails(id: string, patch: { client_id?: string | null; start_date?: string | null; due_date?: string | null }): Promise<void> {
    const fields: Record<string, unknown> = {}
    if (patch.client_id !== undefined) fields.client_id = patch.client_id
    if (patch.start_date !== undefined) fields.start_date = patch.start_date
    if (patch.due_date !== undefined) fields.end_date = patch.due_date
    const res = await client().from('projects').update(fields).eq('id', id).select('id')
    if (res.error?.code === '23514' && /end_date|start_date/.test(res.error.message)) throw new ApiError(400, 'The end date must be on or after the start date.')
    const rows = check<{ id: string }[]>(res, 'change this project')
    if (rows.length === 0) throw forbidden('Only admins and managers can change projects.')
  },

  /** Sets exactly who is on the project (adds the missing people, removes the rest). */
  async setProjectMembers(id: string, userIds: string[]): Promise<void> {
    const db = client()
    const project = check<ProjectRow | null>(await db.from('projects').select('*').eq('id', id).maybeSingle(), 'load project')
    if (!project) throw notFound('Project')
    const wanted = new Set(userIds)
    if (project.owner_id) wanted.add(project.owner_id) // the owner can't be taken off their own project
    const current = new Set(
      check<ProjectMemberRow[]>(await db.from('project_members').select('*').eq('project_id', id), 'load project members').map((m) => m.user_id),
    )
    const add = [...wanted].filter((u) => !current.has(u))
    const remove = [...current].filter((u) => !wanted.has(u))
    if (add.length) check(await db.from('project_members').insert(add.map((user_id) => ({ project_id: id, user_id }))), 'add people to the project')
    if (remove.length) check(await db.from('project_members').delete().eq('project_id', id).in('user_id', remove), 'remove people from the project')
  },

  // ---------- Admin: organization settings ----------

  /** Default lists, allowed email domains and owner (defaults before migration 008). */
  async workspaceSettings(workspaceId: string): Promise<WorkspaceSettings> {
    const row = check<WorkspaceRow | null>(await client().from('workspaces').select('*').eq('id', workspaceId).maybeSingle(), 'load settings')
    if (!row) throw notFound('Organization')
    return {
      default_lists: row.default_lists?.length ? row.default_lists : ['General'],
      allowed_domains: row.allowed_domains ?? [],
      owner_id: row.owner_id,
    }
  },

  async updateWorkspaceSettings(workspaceId: string, patch: { default_lists?: string[]; allowed_domains?: string[] }): Promise<void> {
    const fields: Record<string, unknown> = {}
    if (patch.default_lists) {
      const lists = [...new Set(patch.default_lists.map((l) => l.trim()).filter(Boolean))]
      if (lists.length === 0) throw new ApiError(400, 'Keep at least one list.')
      if (lists.length > 12) throw new ApiError(400, 'Use at most 12 lists.')
      fields.default_lists = lists
    }
    if (patch.allowed_domains) {
      const domains = [...new Set(patch.allowed_domains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))]
      const bad = domains.find((d) => !DOMAIN_RE.test(d))
      if (bad) throw new ApiError(400, `"${bad}" doesn't look like an email domain (e.g. tradmak.com).`)
      if (domains.length > 20) throw new ApiError(400, 'Use at most 20 domains.')
      fields.allowed_domains = domains
    }
    const res = await client().from('workspaces').update(fields).eq('id', workspaceId).select('id')
    if (res.error && /default_lists|allowed_domains/.test(res.error.message)) {
      throw new ApiError(500, 'These settings need a database update. Run database/migrations/008_org_settings.sql in the Supabase SQL Editor.')
    }
    const rows = check<{ id: string }[]>(res, 'save the settings')
    if (rows.length === 0) throw forbidden('Only organization admins can change settings.')
  },

  /** Owner only: hand the organization to another active member. You stay on as an admin. */
  async transferOwnership(workspaceId: string, newOwnerId: string): Promise<void> {
    check(await client().rpc('transfer_ownership', { p_workspace_id: workspaceId, p_new_owner: newOwnerId }), 'transfer ownership')
  },

  /** Owner only. Deletes the organization with all its projects, tasks, meetings and history. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const rows = check<{ id: string }[]>(await client().from('workspaces').delete().eq('id', workspaceId).select('id'), 'delete the organization')
    if (rows.length === 0) throw forbidden('Only the owner can delete the organization.')
  },

  /** Admins (not the owner) can leave an organization. */
  async leaveWorkspace(workspaceId: string): Promise<void> {
    const uid = await me()
    if ((await workspaceOwnerId(workspaceId)) === uid) throw new ApiError(400, 'The owner can’t leave. Transfer ownership first.')
    const rows = check<{ id: string }[]>(
      await client().from('members').delete().eq('workspace_id', workspaceId).eq('user_id', uid).select('id'),
      'leave the organization',
    )
    if (rows.length === 0) throw forbidden("You couldn't leave this organization. Ask one of its admins to remove you.")
  },

  /** All project tasks of the organization as CSV (opens in Excel / Google Sheets). */
  async exportTasksCsv(workspaceId: string): Promise<string> {
    const db = client()
    const projectIds = check<{ id: string }[]>(await db.from('projects').select('id').eq('workspace_id', workspaceId), 'load projects').map((p) => p.id)
    const rows = projectIds.length
      ? check<TaskRow[]>(await db.from('tasks').select('*').in('project_id', projectIds).order('created_at'), 'load tasks')
      : []
    const tasks = await hydrateTasks(rows)
    const emails = new Map((await listMembers([workspaceId], { includeDeactivated: true })).map((m) => [m.id, m.email]))
    return toCsv(
      ['Project', 'List', 'Title', 'Description', 'Status', 'Priority', 'Assignee', 'Assignee email', 'Assigned by', 'Due date', 'Created', 'Last updated', 'From meeting'],
      tasks.map((t) => [
        t.project?.name ?? '',
        t.list?.name ?? '',
        t.title,
        t.description,
        CSV_STATUS[t.status],
        t.priority,
        t.assignee?.name ?? '',
        t.assignee_id ? (emails.get(t.assignee_id) ?? '') : '',
        t.assigned_by_name ?? '',
        t.due_date ?? '',
        t.created_at.slice(0, 10),
        t.updated_at.slice(0, 10),
        t.meeting?.title ?? '',
      ]),
    )
  },

  /** Everyone in the organization as CSV. */
  async exportMembersCsv(workspaceId: string): Promise<string> {
    const members = await api.adminMembers(workspaceId)
    return toCsv(
      ['Name', 'Email', 'Role', 'Status', 'Job title', 'Joined', 'Last active', 'Open tasks', 'Overdue tasks', 'Done tasks'],
      members.map((m) => [
        m.name,
        m.email,
        m.member_role,
        m.status,
        m.role,
        m.joined_at?.slice(0, 10) ?? '',
        m.last_sign_in_at?.slice(0, 10) ?? '',
        String(m.open),
        String(m.overdue),
        String(m.done),
      ]),
    )
  },

  // ---------- Admin: activity log ----------

  /**
   * The organization's activity log, newest first, in pages of `limit`. Owners/admins only
   * (database/migrations/006). Filter by person and/or category; pass `before` from the previous page.
   */
  async activity(
    workspaceId: string,
    opts: { actorId?: string | null; category?: ActivityCategory; before?: number | null; limit?: number } = {},
  ): Promise<ActivityPage> {
    const limit = opts.limit ?? 50
    let query = client().from('activity_log').select('*').eq('workspace_id', workspaceId)
    if (opts.actorId) query = query.eq('actor_id', opts.actorId)
    const types = ACTIVITY_TYPES[opts.category ?? 'all']
    if (types) query = query.in('entity_type', types)
    if (opts.before) query = query.lt('id', opts.before)
    const rows = check<ActivityRow[]>(await query.order('id', { ascending: false }).limit(limit + 1), 'load the activity log')

    const page = rows.slice(0, limit)
    const fromUserId = (r: ActivityRow) => (typeof r.details.from_user === 'string' ? r.details.from_user : null)
    const [profiles, projects] = await Promise.all([
      fetchByIds<ProfileRow>('profiles', page.flatMap((r) => [r.actor_id, r.target_user_id, fromUserId(r)])),
      fetchByIds<ProjectRow>('projects', page.map((r) => r.project_id)),
    ])
    return {
      entries: page.map((r) => {
        const project = r.project_id ? projects.get(r.project_id) : undefined
        return {
          id: r.id,
          action: r.action,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          entity_name: r.entity_name,
          details: r.details ?? {},
          created_at: r.created_at,
          actor: refOf(profiles, r.actor_id),
          target: refOf(profiles, r.target_user_id),
          from_user: refOf(profiles, fromUserId(r)),
          project: project ? { id: project.id, name: project.name, color: project.color } : null,
        }
      }),
      next: rows.length > limit ? page[page.length - 1].id : null,
    }
  },

  // ---------- Dashboard ----------

  /** Numbers for the "My tasks" cards and tabs. */
  async summary(): Promise<DashboardSummary> {
    const uid = await me()
    const [mine, review] = await Promise.all([listTasksForAssignee(uid), myWorkspaceIds(uid).then(listReviewItems)])
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const open = mine.filter((t) => t.status !== 'done')
    return {
      today: open.filter((t) => t.due_date === today).length,
      overdue: open.filter((t) => t.due_date !== null && t.due_date < today).length,
      open: open.length,
      in_progress: open.filter((t) => t.status === 'in_progress').length,
      done: mine.length - open.length,
      assigned: mine.filter((t) => t.source === 'assigned').length,
      personal: mine.filter((t) => t.source === 'personal').length,
      needsReview: review.length,
    }
  },

  /** The "AI review" panel: meeting action items whose owner is unclear. */
  async reviewItems(): Promise<ReviewItem[]> {
    return listReviewItems(await myWorkspaceIds(await me()))
  },
}

/** A readable message from anything thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}
