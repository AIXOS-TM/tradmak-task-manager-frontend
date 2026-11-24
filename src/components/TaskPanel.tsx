import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, errorMessage, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_COMMENT } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { Attachment, Priority, Task, TaskPatch, TaskStatus } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useCurrentUser } from '../store/useApp'
import { formatDue, formatShortDate, timeAgo } from '../utils/format'
import { PRIORITY_LABELS, PRIORITY_ORDER, STATUS_LABELS, STATUS_ORDER } from '../utils/labels'
import { AttachmentList, PendingFiles } from './Attachments'
import Avatar from './Avatar'
import { DueDate } from './Badges'
import Icon from './Icon'
import { MentionText, useMentions } from './Mentions'
import { notifications } from '../lib/notifications'
import { ErrorState, LoadingState } from './States'

/** Slide-in panel for the selected task. Rendered once in the layout. */
export default function TaskPanel() {
  const { selectedTaskId, closeTask } = useApp()

  useEffect(() => {
    if (!selectedTaskId) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeTask()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedTaskId, closeTask])

  if (!selectedTaskId) return null
  // key resets drafts when switching tasks
  return <TaskPanelShell key={selectedTaskId} taskId={selectedTaskId} />
}

function TaskPanelShell({ taskId }: { taskId: string }) {
  const { closeTask } = useApp()
  const task = useApi(() => api.task(taskId), [taskId], true, { cache: 'task' })

  return (
    <>
      <div className="panel-backdrop" onClick={closeTask} />
      <aside className="task-panel" role="dialog" aria-modal="true" aria-label={task.data?.title ?? 'Task'}>
        {task.data ? (
          <TaskPanelContent task={task.data} onSaved={(t) => task.setData(() => t)} />
        ) : (
          <>
            <header className="panel-header">
              <span />
              <button type="button" className="icon-btn" onClick={closeTask} aria-label="Close task">
                <Icon name="x" />
              </button>
            </header>
            <div className="panel-body">
              {task.error ? <ErrorState message={task.error} onRetry={task.reload} /> : <LoadingState label="Loading task…" />}
            </div>
          </>
        )}
      </aside>
    </>
  )
}

function TaskPanelContent({ task, onSaved }: { task: Task; onSaved: (task: Task) => void }) {
  const { closeTask, showToast, invalidate } = useApp()
  const currentUser = useCurrentUser()
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const commentBox = useRef<HTMLTextAreaElement>(null)
  const [posting, setPosting] = useState(false)
  const [saving, setSaving] = useState(false)

  const isPersonal = task.source === 'personal'
  const perms = usePermissions()
  const canEdit = perms.canEditTask(task)
  const canAssign = perms.canAssignTask(task)
  const canDelete = perms.canDeleteTask(task)
  const comments = useApi(() => api.comments(task.id), [task.id])
  // Opening a task marks its notifications (assigned, comments, mentions) as read.
  useEffect(() => {
    void notifications.markReadFor({ taskId: task.id }).catch(() => {})
  }, [task.id])
  // People who can be assigned: members of this task's workspace (only for admins/managers).
  // (Also the people you can @mention in a comment.)
  const members = useApi(() => api.users(task.workspace_id), [task.workspace_id], !!task.workspace_id)
  const mentions = useMentions({
    value: draft,
    setValue: setDraft,
    inputRef: commentBox,
    people: (members.data ?? []).filter((m) => m.id !== currentUser.id).map((m) => ({ id: m.id, name: m.name, avatar_color: m.avatar_color, hint: m.role })),
  })
  const locked = saving || !canEdit

  const save = async (patch: TaskPatch) => {
    setSaving(true)
    try {
      onSaved(await api.updateTask(task.id, patch))
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  /** Adds picked / dropped / pasted files, skipping ones that are too big or over the limit. */
  const addFiles = (incoming: FileList | File[]) => {
    const list = Array.from(incoming)
    if (list.length === 0) return
    const tooBig = list.filter((f) => f.size > MAX_ATTACHMENT_BYTES)
    const ok = list.filter((f) => f.size <= MAX_ATTACHMENT_BYTES && f.size > 0)
    const room = MAX_ATTACHMENTS_PER_COMMENT - files.length
    if (tooBig.length) showToast(`${tooBig.map((f) => f.name).join(', ')}: larger than 10 MB`, 'error')
    else if (ok.length > room) showToast(`You can attach up to ${MAX_ATTACHMENTS_PER_COMMENT} files per comment`, 'error')
    setFiles((current) => [...current, ...ok.slice(0, Math.max(0, room))])
  }

  // Screenshots pasted into the comment box become attachments.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.files)
    if (pasted.length) {
      e.preventDefault()
      addFiles(pasted.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${Date.now()}-${i + 1}.png`, { type: f.type }))))
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const submitComment = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = draft.trim()
    if ((!text && files.length === 0) || posting) return
    setPosting(true)
    try {
      await api.addComment(task.id, text, files, mentions.resolve(text).ids)
      setDraft('')
      setFiles([])
      mentions.reset()
    } catch (err) {
      // 207: the comment was posted but some files failed; clear the box and say which.
      if (err instanceof ApiError && err.status === 207) {
        setDraft('')
        setFiles([])
      }
      showToast(errorMessage(err), 'error')
    } finally {
      comments.reload()
      invalidate()
      setPosting(false)
    }
  }

  // Uploader, admins/managers of the task's organization, or the owner of a personal task.
  const canDeleteAttachment = (a: Attachment) =>
    a.uploaded_by === currentUser.id || (isPersonal ? task.assignee_id === currentUser.id : perms.canManageWork(task.workspace_id))

  const onDraftKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submitComment()
    }
  }

  const deleteTask = async () => {
    if (!window.confirm(`Delete "${task.title}"? This can't be undone.`)) return
    try {
      await api.deleteTask(task.id)
      showToast('Task deleted')
      closeTask()
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
    }
  }

  const assignedByName =
    task.assigned_by_user?.id === currentUser.id ? 'You' : (task.assigned_by_name ?? task.assigned_by_user?.name ?? '—')

  return (
    <>
      <header className="panel-header">
        {isPersonal ? (
          <div className="panel-crumbs">
            <span className="personal-tag">
              <Icon name="lock" size={12} /> Personal task
            </span>
            <span className="small">Only you can see this</span>
          </div>
        ) : (
          <div className="panel-crumbs">
            <span className="dot" style={{ background: task.project?.color }} />
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                closeTask()
                navigate(`/projects/${task.project_id}`)
              }}
            >
              {task.project?.name}
            </button>
            {task.list && (
              <>
                <Icon name="chevronRight" size={14} />
                <span>{task.list.name}</span>
              </>
            )}
          </div>
        )}
        <button type="button" className="icon-btn" onClick={closeTask} aria-label="Close task">
          <Icon name="x" />
        </button>
      </header>

      <div className="panel-body">
        <h2 className="panel-title">{task.title}</h2>
        {!canEdit && (
          <p className="panel-readonly">
            <Icon name="lock" size={13} /> View only. This task belongs to someone else; an admin or manager can change it. You can still comment.
          </p>
        )}

        <dl className="detail-grid">
          <dt>Status</dt>
          <dd>
            <select
              className={`pill-select status-${task.status}`}
              value={task.status}
              disabled={locked}
              onChange={(e) => void save({ status: e.target.value as TaskStatus })}
              aria-label="Status"
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </dd>

          <dt>Assignee</dt>
          {isPersonal ? (
            <dd className="with-avatar">
              <Avatar user={currentUser} size={24} />
              <span>You</span>
            </dd>
          ) : !canAssign ? (
            <dd className="with-avatar" title="Only admins and managers can assign tasks to other people">
              <Avatar user={task.assignee} size={24} />
              <span>{task.assignee?.id === currentUser.id ? 'You' : (task.assignee?.name ?? 'Unassigned')}</span>
            </dd>
          ) : (
            <dd className="with-avatar">
              <Avatar user={task.assignee} size={24} />
              <select
                className="plain-select"
                value={task.assignee_id ?? ''}
                disabled={saving || members.loading}
                onChange={(e) => void save({ assignee_id: e.target.value || null })}
                aria-label="Assignee"
              >
                <option value="">Unassigned</option>
                {/* Keep the current assignee selectable even before the member list loads. */}
                {task.assignee && !members.data?.some((m) => m.id === task.assignee_id) && (
                  <option value={task.assignee.id}>{task.assignee.name}</option>
                )}
                {members.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.id === currentUser.id ? ' (you)' : ''}
                  </option>
                ))}
              </select>
            </dd>
          )}

          <dt>Due date</dt>
          <dd className="with-avatar">
            <input
              type="date"
              className="plain-select"
              value={task.due_date ?? ''}
              disabled={locked}
              onChange={(e) => void save({ due_date: e.target.value || null })}
              aria-label="Due date"
            />
            <DueDate date={task.due_date} done={task.status === 'done'} />
          </dd>

          <dt>Priority</dt>
          <dd>
            <select
              className={`pill-select priority-${task.priority}`}
              value={task.priority}
              disabled={locked}
              onChange={(e) => void save({ priority: e.target.value as Priority })}
              aria-label="Priority"
            >
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </dd>

          {!isPersonal && (
            <>
              <dt>Assigned by</dt>
              <dd className="with-avatar">
                <Avatar user={task.assigned_by_user} size={24} />
                <span>{assignedByName}</span>
              </dd>
            </>
          )}

          <dt>Source</dt>
          <dd>
            {isPersonal ? (
              <span className="muted">Created by you for yourself</span>
            ) : task.meeting ? (
              <button
                type="button"
                className="meeting-chip"
                onClick={() => {
                  closeTask()
                  navigate(`/meetings/${task.meeting!.id}`)
                }}
              >
                <Icon name="mic" size={14} />
                {task.meeting.title}
                <span className="muted">· {formatShortDate(task.meeting.started_at)}</span>
              </button>
            ) : (
              <span className="muted">Created manually</span>
            )}
          </dd>
        </dl>

        <section className="panel-section">
          <h3>Description</h3>
          {task.description ? <p className="description">{task.description}</p> : <p className="muted small">No description yet.</p>}
        </section>

        <section className="panel-section">
          <h3>
            Comments <span className="count-pill">{comments.data?.length ?? task.comment_count}</span>
          </h3>
          {comments.error ? (
            <ErrorState message={comments.error} onRetry={comments.reload} compact />
          ) : !comments.data ? (
            <LoadingState label="Loading comments…" compact />
          ) : comments.data.length === 0 ? (
            <p className="muted small">No comments yet. Start the conversation.</p>
          ) : (
            <ul className="comment-list">
              {comments.data.map((c) => (
                <li key={c.id} className="comment">
                  <Avatar user={c.author} size={30} />
                  <div className="comment-body">
                    <div className="comment-head">
                      <strong>{c.author?.name ?? 'Deleted user'}</strong>
                      <span className="muted small">{timeAgo(c.created_at)}</span>
                    </div>
                    {c.body && (
                      <p>
                        <MentionText text={c.body} names={c.mentioned.map((u) => u.name)} mine={currentUser.name} />
                      </p>
                    )}
                    <AttachmentList
                      attachments={c.attachments}
                      canDelete={canDeleteAttachment}
                      onChanged={() => comments.reload()}
                      onError={(m) => showToast(m, 'error')}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form className="comment-form" onSubmit={submitComment}>
            <Avatar user={currentUser} size={30} />
            <div
              className={`comment-input ${dragging ? 'is-dragging' : ''}`}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault()
                  setDragging(true)
                }
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {mentions.popup}
              <textarea
                ref={commentBox}
                rows={2}
                placeholder="Write a comment… type @ to mention someone"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  mentions.sync()
                }}
                onClick={mentions.sync}
                onBlur={() => window.setTimeout(mentions.sync, 150)}
                onKeyDown={onDraftKey}
                onPaste={onPaste}
                disabled={posting}
                aria-label="Write a comment"
              />
              <PendingFiles files={files} onRemove={(i) => setFiles((f) => f.filter((_, j) => j !== i))} />
              <div className="comment-actions">
                <button
                  type="button"
                  className="icon-btn attach-btn"
                  onClick={() => fileInput.current?.click()}
                  disabled={posting || files.length >= MAX_ATTACHMENTS_PER_COMMENT}
                  aria-label="Attach files"
                  title="Attach files (up to 5, 10 MB each)"
                >
                  <Icon name="paperclip" size={17} />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files)
                    e.target.value = '' // allow picking the same file again
                  }}
                />
                <span className="muted small hide-sm">Enter to send · Shift + Enter for a new line</span>
                <button type="submit" className="btn btn-primary btn-sm" disabled={(!draft.trim() && files.length === 0) || posting}>
                  {posting ? (files.length ? 'Uploading…' : 'Sending…') : 'Comment'}
                </button>
              </div>
            </div>
          </form>
        </section>
      </div>

      <footer className="panel-footer muted small">
        <Icon name="clock" size={14} />
        {task.due_date ? `Due ${formatDue(task.due_date).toLowerCase()}` : 'No due date'} · {task.status === 'done' ? 'Completed' : 'Open'}
        {canDelete && (
          <button type="button" className="link-btn link-danger small panel-delete" onClick={() => void deleteTask()}>
            Delete task
          </button>
        )}
      </footer>
    </>
  )
}
