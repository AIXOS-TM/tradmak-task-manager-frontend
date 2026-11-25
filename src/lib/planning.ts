/**
 * Clients, People (capacity + time off) and Resources (workload) — database migration 013.
 * Same approach as ./api.ts: straight to Supabase, Row Level Security decides who may do what.
 */
import { ApiError, check, client, fetchByIds, hydrateProjects, hydrateTasks, listMembers, me, refOf } from './api'
import { shared } from './cache'
import type { ClientRow, ProfileRow, ProjectRow, TaskRow, TimeOffRow } from './rows'
import type { Client, ClientInput, ClientStatus, Project, TimeOff, TimeOffKind } from './types'
import { todayISO } from '../utils/format'

export const NEEDS_013 = 'This needs a database update: run database/migrations/013_clients_people_resources.sql in the Supabase SQL Editor.'

/** Turns "the database is missing a newer update" into a message that names migration 013. */
function explain013(err: unknown): never {
  if (err instanceof ApiError && /newer update/.test(err.message)) throw new ApiError(500, NEEDS_013)
  throw err
}

const CLIENT_COLUMNS: (keyof ClientInput)[] = ['name', 'contact_name', 'email', 'phone', 'website', 'address', 'notes', 'color']

function cleanClient(input: Partial<ClientInput>): Partial<ClientInput> {
  const out: Partial<ClientInput> = {}
  for (const k of CLIENT_COLUMNS) {
    const v = input[k]
    if (v !== undefined) out[k] = v.trim()
  }
  if (out.name !== undefined && !out.name) throw new ApiError(400, 'Give the client a name.')
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new ApiError(400, "That email address doesn't look right.")
  return out
}

function clientError(err: { code?: string } | null): void {
  if (err?.code === '23505') throw new ApiError(400, 'A client with this name already exists.')
}

async function loadClients(workspaceId: string): Promise<Client[]> {
  const db = client()
  const [rows, projects] = await Promise.all([
    db.from('clients').select('*').eq('workspace_id', workspaceId).order('name').then((r) => check<ClientRow[]>(r, 'load clients')),
    db.from('projects').select('id, client_id').eq('workspace_id', workspaceId).not('client_id', 'is', null).then((r) => check<Pick<ProjectRow, 'id' | 'client_id'>[]>(r, 'load projects')),
  ])
  const tasks = projects.length
    ? check<Pick<TaskRow, 'project_id' | 'status' | 'due_date'>[]>(
        await db.from('tasks').select('project_id, status, due_date').in('project_id', projects.map((p) => p.id)),
        'load project tasks',
      )
    : []
  const today = todayISO()
  return rows.map((r) => {
    const ids = new Set(projects.filter((p) => p.client_id === r.id).map((p) => p.id))
    const mine = tasks.filter((t) => t.project_id && ids.has(t.project_id))
    const open = mine.filter((t) => t.status !== 'done')
    return {
      id: r.id,
      workspace_id: r.workspace_id,
      name: r.name,
      contact_name: r.contact_name,
      email: r.email,
      phone: r.phone,
      website: r.website,
      address: r.address,
      notes: r.notes,
      color: r.color,
      status: r.status,
      created_at: r.created_at,
      project_count: ids.size,
      open_count: open.length,
      done_count: mine.length - open.length,
      overdue_count: open.filter((t) => t.due_date && t.due_date < today).length,
    }
  })
}

export { buildWorkload, loadLevel, type LoadLevel, type WorkloadCell, type WorkloadData, type WorkloadRow, type WorkloadTask } from './workload'
import type { WorkloadData } from './workload'

function toTimeOff(r: TimeOffRow, profiles: Map<string, ProfileRow>): TimeOff {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    user_id: r.user_id,
    start_date: r.start_date,
    end_date: r.end_date,
    kind: r.kind,
    note: r.note,
    user: refOf(profiles, r.user_id),
  }
}

export const TIME_OFF_LABELS: Record<TimeOffKind, string> = {
  vacation: 'Vacation',
  sick: 'Sick',
  holiday: 'Holiday',
  other: 'Other',
}

export const planning = {
  // ---------- Clients ----------

  /** Clients of an organization with their project and task counts. */
  clients(workspaceId: string): Promise<Client[]> {
    return shared(`clients:${workspaceId}`, () => loadClients(workspaceId)).catch(explain013)
  },

  /** One client and its projects. */
  async client(id: string): Promise<{ client: Client; projects: Project[] }> {
    const row = check<ClientRow | null>(await client().from('clients').select('*').eq('id', id).maybeSingle(), 'load this client')
    if (!row) throw new ApiError(404, 'Client not found')
    const [clients, projectRows] = await Promise.all([
      loadClients(row.workspace_id),
      client().from('projects').select('*').eq('client_id', id).order('created_at').then((r) => check<ProjectRow[]>(r, 'load projects')),
    ])
    const found = clients.find((c) => c.id === id)
    if (!found) throw new ApiError(404, 'Client not found')
    return { client: found, projects: await hydrateProjects(projectRows) }
  },

  async createClient(workspaceId: string, input: ClientInput): Promise<Client> {
    const fields = cleanClient(input)
    const res = await client()
      .from('clients')
      .insert({ ...fields, workspace_id: workspaceId })
      .select('id')
      .single()
    clientError(res.error)
    const row = check<{ id: string }>(res, 'add clients')
    return (await loadClients(workspaceId)).find((c) => c.id === row.id)!
  },

  async updateClient(id: string, patch: Partial<ClientInput> & { status?: ClientStatus }): Promise<void> {
    const fields: Record<string, unknown> = { ...cleanClient(patch) }
    if (patch.status) fields.status = patch.status
    const res = await client().from('clients').update(fields).eq('id', id).select('id')
    clientError(res.error)
    const rows = check<{ id: string }[]>(res, 'change clients')
    if (rows.length === 0) throw new ApiError(403, 'Only admins and managers can change clients.')
  },

  /** Admins only. Its projects stay, without a client. */
  async deleteClient(id: string): Promise<void> {
    const rows = check<{ id: string }[]>(await client().from('clients').delete().eq('id', id).select('id'), 'delete clients')
    if (rows.length === 0) throw new ApiError(403, 'Only admins can delete clients.')
  },

  // ---------- People ----------

  /** Working hours per day and working weekdays (admins). */
  async setCapacity(workspaceId: string, userId: string, hoursPerDay: number, workDays: number[]): Promise<void> {
    if (!(hoursPerDay >= 0 && hoursPerDay <= 24)) throw new ApiError(400, 'Hours per day must be between 0 and 24.')
    const res = await client()
      .from('members')
      .update({ hours_per_day: hoursPerDay, work_days: [...new Set(workDays)].sort() })
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .select('id')
    const rows = check<{ id: string }[]>(res, 'change working hours')
    if (rows.length === 0) throw new ApiError(403, 'Only admins can change working hours.')
  },

  /** Time off that overlaps from … to (inclusive). */
  async timeOff(workspaceId: string, from: string, to: string): Promise<TimeOff[]> {
    try {
      const rows = check<TimeOffRow[]>(
        await client().from('time_off').select('*').eq('workspace_id', workspaceId).lte('start_date', to).gte('end_date', from).order('start_date'),
        'load time off',
      )
      const profiles = await fetchByIds<ProfileRow>('profiles', rows.map((r) => r.user_id))
      return rows.map((r) => toTimeOff(r, profiles))
    } catch (err) {
      return explain013(err)
    }
  },

  async addTimeOff(workspaceId: string, userId: string, body: { start_date: string; end_date: string; kind: TimeOffKind; note?: string }): Promise<void> {
    if (!body.start_date || !body.end_date) throw new ApiError(400, 'Pick the first and last day.')
    if (body.end_date < body.start_date) throw new ApiError(400, 'The last day must be on or after the first day.')
    const res = await client()
      .from('time_off')
      .insert({ workspace_id: workspaceId, user_id: userId, start_date: body.start_date, end_date: body.end_date, kind: body.kind, note: (body.note ?? '').trim() })
    if (res.error?.code === '23514') throw new ApiError(400, 'Time off can be at most a year long.')
    try {
      check(res, 'add time off for this person')
    } catch (err) {
      explain013(err)
    }
  },

  async deleteTimeOff(id: string): Promise<void> {
    const rows = check<{ id: string }[]>(await client().from('time_off').delete().eq('id', id).select('id'), 'remove this time off')
    if (rows.length === 0) throw new ApiError(403, 'You can only remove your own time off (admins can remove anyone’s).')
  },

  // ---------- Resources ----------

  /** People, their open tasks and their time off — everything the workload grid needs. */
  async workload(workspaceId: string, from: string, to: string): Promise<WorkloadData> {
    await me()
    const db = client()
    const [members, projectRows, timeOff] = await Promise.all([
      listMembers([workspaceId]),
      db.from('projects').select('id, status').eq('workspace_id', workspaceId).then((r) => check<Pick<ProjectRow, 'id' | 'status'>[]>(r, 'load projects')),
      planning.timeOff(workspaceId, from, to),
    ])
    const ids = projectRows.filter((p) => p.status !== 'archived').map((p) => p.id)
    const rows = ids.length
      ? check<TaskRow[]>(
          await db.from('tasks').select('*').in('project_id', ids).neq('status', 'done').not('assignee_id', 'is', null),
          'load open tasks',
        )
      : []
    return { members: members.sort((a, b) => a.name.localeCompare(b.name)), tasks: await hydrateTasks(rows), timeOff }
  },
}
