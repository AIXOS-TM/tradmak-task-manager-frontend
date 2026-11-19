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
import {
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
import { supabase } from './supabase'
import type {
  ActionItem,
  AssignableRole,
  Comment,
  DashboardSummary,
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

function client() {
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
async function me(): Promise<string> {
  const { data } = await client().auth.getSession()
  const id = data.session?.user.id
  if (!id) throw sessionExpired('Please log in to continue.')
  return id
}

function toApiError(err: PostgrestError, what: string): ApiError {
  const msg = err.message ?? ''
  if (err.code === 'PGRST301' || err.code === 'PGRST303' || /jwt/i.test(msg)) return sessionExpired()
  if (err.code === '42501') {
    // RLS refusals are technical; messages raised by our own SQL functions are already readable.
    return new ApiError(403, /row-level security|permission denied/i.test(msg) ? `You don't have permission to ${what}.` : msg)
  }
  if (err.code === 'P0001') return new ApiError(400, msg) // raised by a taskapp function
  if (err.code === 'PGRST202') {
    return new ApiError(500, `A database function is missing. Run database/migrations/003_frontend_rpc.sql in the Supabase SQL Editor.`)
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return new ApiError(0, "Can't reach Supabase. Check your internet connection.")
  return new ApiError(500, `Couldn't ${what}: ${msg}`)
}

interface QueryResult {
  data: unknown
  error: PostgrestError | null
}

/** Unwraps a Supabase result, turning errors into ApiError. */
function check<T>(res: QueryResult, what: string): T {
  if (res.error) throw toApiError(res.error, what)
  return res.data as T
}

const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))]
const notFound = (what: string) => new ApiError(404, `${what} not found`)
const forbidden = (message: string) => new ApiError(403, message)
const nowIso = () => new Date().toISOString()

/** Loads rows by id into a Map. Skips the query when there's nothing to load. */
async function fetchByIds<T extends { id: string }>(table: string, ids: (string | null | undefined)[]): Promise<Map<string, T>> {
  const wanted = unique(ids)
  if (wanted.length === 0) return new Map()
  const rows = check<T[]>(await client().from(table).select('*').in('id', wanted), `load ${table}`)
  return new Map(rows.map((r) => [r.id, r]))
}

function refOf(profiles: Map<string, ProfileRow>, id: string | null): UserRef | null {
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

async function hydrateTasks(rows: TaskRow[]): Promise<Task[]> {
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

async function hydrateProjects(rows: ProjectRow[]): Promise<Project[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const db = client()
  const [memberRows, taskRows] = await Promise.all([
    db.from('project_members').select('*').in('project_id', ids).then((r) => check<ProjectMemberRow[]>(r, 'load project members')),
    db.from('tasks').select('project_id, status').in('project_id', ids).then((r) => check<Pick<TaskRow, 'project_id' | 'status'>[]>(r, 'count project tasks')),
  ])
  const profiles = await fetchByIds<ProfileRow>('profiles', memberRows.map((m) => m.user_id))
  return rows.map((r) => {
    const projectTasks = taskRows.filter((t) => t.project_id === r.id)
    const done = projectTasks.filter((t) => t.status === 'done').length
    return {
      ...toProject(r),
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
  const members = check<MemberRow[]>(await client().from('members').select('*').eq('user_id', userId), 'load your workspaces')
  const workspaces = await fetchByIds<WorkspaceRow>('workspaces', members.map((m) => m.workspace_id))
  return members
    .map((m): Workspace | null => {
      const ws = workspaces.get(m.workspace_id)
      return ws ? { id: ws.id, name: ws.name, created_at: ws.created_at, member_role: toWorkspaceRole(m.role, ws.owner_id === userId) } : null
    })
    .filter((w): w is Workspace => w !== null)
}

async function myWorkspaceIds(userId: string): Promise<string[]> {
  const rows = check<{ workspace_id: string }[]>(
    await client().from('members').select('workspace_id').eq('user_id', userId),
    'load your workspaces',
  )
  return rows.map((r) => r.workspace_id)
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
  const rows = check<{ id: string }[]>(
    await client().from('members').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).limit(1),
    'check membership',
  )
  return rows.length > 0
}

/** Members of the given workspaces, with counts of tasks ASSIGNED to them (personal tasks stay private). */
async function listMembers(workspaceIds: string[]): Promise<Member[]> {
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
    const isOwner = workspaceIds.some((id) => workspaces.get(id)?.owner_id === m.user_id)
    const assigned = taskRows.filter((t) => t.assignee_id === m.user_id)
    const done = assigned.filter((t) => t.status === 'done').length
    seen.set(m.user_id, {
      ...toUser(profile),
      member_role: toWorkspaceRole(m.role, isOwner),
      task_count: assigned.length,
      done_count: done,
      open_count: assigned.length - done,
    })
  }
  return [...seen.values()]
}

async function memberView(workspaceId: string, userId: string): Promise<Member> {
  const member = (await listMembers([workspaceId])).find((m) => m.id === userId)
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

async function listTasksForAssignee(userId: string, source?: TaskSource): Promise<Task[]> {
  let query = client().from('tasks').select('*').eq('assignee_id', userId)
  if (source) query = query.eq('source', source)
  const rows = check<TaskRow[]>(await query, 'load your tasks')
  return (await hydrateTasks(rows)).sort(byStatusThenDue)
}

async function getTask(id: string): Promise<Task> {
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

async function listReviewItems(workspaceIds: string[]): Promise<ReviewItem[]> {
  if (workspaceIds.length === 0) return []
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
// Public API used by the pages
// =====================================================================

export const api = {
  // ---------- Auth / profile ----------

  async me(): Promise<{ user: User; workspaces: Workspace[] }> {
    const uid = await me()
    const row = check<ProfileRow | null>(await client().from('profiles').select('*').eq('id', uid).maybeSingle(), 'load your profile')
    if (!row) throw new ApiError(404, 'Your profile was not found. Ask an admin to check the taskapp signup trigger.')
    return { user: toUser(row), workspaces: await myWorkspaces(uid) }
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

  /** The person must already have an account (they sign up first). */
  async addMember(workspaceId: string, email: string, role: AssignableRole): Promise<Member> {
    const userId = check<string>(
      await client().rpc('add_member_by_email', { p_workspace_id: workspaceId, p_email: email.trim().toLowerCase(), p_role: role }),
      'add members',
    )
    return memberView(workspaceId, userId)
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

  async projects(): Promise<Project[]> {
    const ids = await myWorkspaceIds(await me())
    if (ids.length === 0) return []
    const rows = check<ProjectRow[]>(
      await client().from('projects').select('*').in('workspace_id', ids).order('created_at'),
      'load projects',
    )
    return hydrateProjects(rows)
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
    due_date?: string | null
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
    const row = check<ProjectRow>(
      await db
        .from('projects')
        .insert({
          workspace_id: workspaceId,
          name: body.name.trim(),
          description: body.description ?? '',
          color: body.color ?? '#4f46e5',
          health: body.status ?? 'on_track',
          end_date: body.due_date ?? null,
          owner_id: uid,
        })
        .select('*')
        .single(),
      'create projects',
    )
    check(await db.from('project_members').insert({ project_id: row.id, user_id: uid }), 'add you to the project')
    // Every new project starts with one list so tasks have somewhere to go.
    check(await db.from('task_lists').insert({ project_id: row.id, name: 'General', position: 0 }), 'create the default list')
    return (await hydrateProjects([row]))[0]
  },

  /** Admins/owners only. Its lists, tasks and comments go with it. */
  async deleteProject(id: string): Promise<void> {
    const rows = check<{ id: string }[]>(await client().from('projects').delete().eq('id', id).select('id'), 'delete projects')
    if (rows.length === 0) throw forbidden('Only workspace admins can delete projects.')
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
    // Comments and subtasks cascade in the database; action items lose their link.
    const deleted = check<{ id: string }[]>(await db.from('tasks').delete().eq('id', id).select('id'), 'delete this task')
    if (deleted.length === 0) throw forbidden('You can only delete tasks you created.')
    await savePositions(await loadColumn(row))
  },

  // ---------- Comments ----------

  async comments(taskId: string): Promise<Comment[]> {
    const rows = check<CommentRow[]>(
      await client().from('comments').select('*').eq('task_id', taskId).order('created_at'),
      'load comments',
    )
    const profiles = await fetchByIds<ProfileRow>('profiles', rows.map((r) => r.user_id))
    return rows.map((r) => ({ ...toComment(r), author: refOf(profiles, r.user_id) }))
  },

  async addComment(taskId: string, body: string): Promise<Comment> {
    const uid = await me()
    const row = check<CommentRow>(
      await client().from('comments').insert({ task_id: taskId, user_id: uid, body: body.trim() }).select('*').single(),
      'comment on this task',
    )
    const profiles = await fetchByIds<ProfileRow>('profiles', [uid])
    return { ...toComment(row), author: refOf(profiles, uid) }
  },

  // ---------- Meetings & AI review ----------

  /** Newest first, with attendees and action item counts. */
  async meetings(): Promise<MeetingSummary[]> {
    const ids = await myWorkspaceIds(await me())
    if (ids.length === 0) return []
    const rows = check<MeetingRow[]>(await client().from('meetings').select('*').in('workspace_id', ids), 'load meetings')
    return (await summarizeMeetings(rows)).sort((a, b) => b.started_at.localeCompare(a.started_at))
  },

  async meeting(id: string): Promise<MeetingDetail> {
    const db = client()
    const row = check<MeetingRow | null>(await db.from('meetings').select('*').eq('id', id).maybeSingle(), 'load meeting')
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
