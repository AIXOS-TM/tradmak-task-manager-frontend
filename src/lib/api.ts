// The one place the frontend talks to the backend API.
// Every request carries the Supabase session token as "Authorization: Bearer <token>".
import { supabase } from './supabase'
import type {
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
  Workspace,
  AssignableRole,
} from './types'

export const API_URL = (import.meta.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '')

/** Fired on window when the backend says the session is no longer valid (401). */
export const AUTH_EXPIRED_EVENT = 'auth:expired'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!supabase) {
    throw new ApiError(0, 'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env.')
  }

  // getSession() returns the current session and refreshes the token if it has expired.
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: 'Please log in to continue.' }))
    throw new ApiError(401, 'You are not logged in.')
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, `Can't reach the server at ${API_URL}. Is the backend running?`)
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // not JSON; handled below
  }

  if (!res.ok) {
    const bodyError = json && typeof json === 'object' && 'error' in json ? (json as { error?: unknown }).error : undefined
    const message = typeof bodyError === 'string' && bodyError ? bodyError : `Request failed (${res.status} ${res.statusText})`
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: message }))
    }
    throw new ApiError(res.status, message)
  }
  return json as T
}

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString()
  return s ? `?${s}` : ''
}

export const api = {
  // Auth / profile
  me: () => request<{ user: User; workspaces: Workspace[] }>('GET', '/auth/me'),
  updateMe: (patch: { name?: string; role?: string }) => request<User>('PATCH', '/auth/me', patch),
  createWorkspace: (name: string) => request<Workspace>('POST', '/workspaces', { name }),

  // Team
  /** Team members. Pass a workspace id to get only that workspace's members. */
  users: (workspaceId?: string | null) => request<Member[]>('GET', `/users${q({ workspace_id: workspaceId ?? undefined })}`),
  addMember: (workspaceId: string, email: string, role: AssignableRole) =>
    request<Member>('POST', `/workspaces/${workspaceId}/members`, { email, role }),
  updateMemberRole: (workspaceId: string, userId: string, role: AssignableRole) =>
    request<Member>('PATCH', `/workspaces/${workspaceId}/members/${userId}`, { role }),
  removeMember: (workspaceId: string, userId: string) => request<void>('DELETE', `/workspaces/${workspaceId}/members/${userId}`),

  // Projects
  projects: () => request<Project[]>('GET', '/projects'),
  project: (id: string) => request<Project>('GET', `/projects/${id}`),
  projectLists: (id: string) => request<TaskList[]>('GET', `/projects/${id}/lists`),
  createProject: (body: {
    name: string
    workspace_id?: string
    description?: string
    color?: string
    status?: ProjectStatus
    due_date?: string | null
  }) => request<Project>('POST', '/projects', body),
  deleteProject: (id: string) => request<void>('DELETE', `/projects/${id}`),

  // Tasks
  myTasks: (source: TaskSource | 'all' = 'all') => request<Task[]>('GET', `/tasks/mine${q({ source })}`),
  projectTasks: (projectId: string) => request<Task[]>('GET', `/tasks${q({ project_id: projectId })}`),
  task: (id: string) => request<Task>('GET', `/tasks/${id}`),
  createTask: (body: {
    title: string
    project_id: string
    assignee_id?: string | null
    list_id?: string
    description?: string
    due_date?: string | null
    priority?: Priority
    status?: TaskStatus
  }) => request<Task>('POST', '/tasks', body),
  createPersonalTask: (body: { title: string; due_date?: string | null; priority?: Priority; description?: string }) =>
    request<Task>('POST', '/tasks/personal', body),
  updateTask: (id: string, patch: TaskPatch) => request<Task>('PATCH', `/tasks/${id}`, patch),
  deleteTask: (id: string) => request<void>('DELETE', `/tasks/${id}`),

  // Comments
  comments: (taskId: string) => request<Comment[]>('GET', `/tasks/${taskId}/comments`),
  addComment: (taskId: string, body: string) => request<Comment>('POST', `/tasks/${taskId}/comments`, { body }),

  // Meetings & AI review
  meetings: () => request<MeetingSummary[]>('GET', '/meetings'),
  meeting: (id: string) => request<MeetingDetail>('GET', `/meetings/${id}`),
  assignActionItemToMe: (id: string) => request<{ task: Task }>('POST', `/meetings/action-items/${id}/assign-to-me`),
  ignoreActionItem: (id: string) => request<unknown>('POST', `/meetings/action-items/${id}/ignore`),

  // Dashboard
  summary: () => request<DashboardSummary>('GET', '/dashboard/summary'),
  reviewItems: () => request<ReviewItem[]>('GET', '/dashboard/review-items'),
}

/** A readable message from anything thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}
