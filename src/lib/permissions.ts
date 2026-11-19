// Who may do what, so the UI only shows what the user is allowed to do.
// The database enforces the same rules with Row Level Security; this file just hides buttons.
import { useAuth } from '../store/useApp'
import type { Task, WorkspaceRole } from './types'

const WORK_MANAGERS: WorkspaceRole[] = ['owner', 'admin', 'manager']
const MEMBER_ADMINS: WorkspaceRole[] = ['owner', 'admin']

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
}

export function usePermissions() {
  const { workspaces, user } = useAuth()

  const roleIn = (workspaceId: string | null | undefined): WorkspaceRole | null =>
    workspaces.find((w) => w.id === workspaceId)?.member_role ?? null

  /** Assign work to others, edit/delete anyone's tasks, create projects, dismiss AI suggestions. */
  const canManageWork = (workspaceId: string | null | undefined) => WORK_MANAGERS.includes(roleIn(workspaceId) as WorkspaceRole)
  /** Add/remove members, change roles, delete projects. */
  const canManageMembers = (workspaceId: string | null | undefined) => MEMBER_ADMINS.includes(roleIn(workspaceId) as WorkspaceRole)

  const isMine = (task: Task) => task.assignee_id === user?.id || task.created_by === user?.id

  return {
    roleIn,
    canManageWork,
    canManageMembers,
    /** Workspaces where the user may create projects. */
    projectWorkspaces: workspaces.filter((w) => WORK_MANAGERS.includes(w.member_role)),
    canEditTask: (task: Task) => task.source === 'personal' || canManageWork(task.workspace_id) || isMine(task),
    canAssignTask: (task: Task) => task.source !== 'personal' && canManageWork(task.workspace_id),
    canDeleteTask: (task: Task) => task.source === 'personal' || canManageWork(task.workspace_id) || task.created_by === user?.id,
  }
}
