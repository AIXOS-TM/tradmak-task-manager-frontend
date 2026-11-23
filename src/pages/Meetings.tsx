import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Avatar, { AvatarStack } from '../components/Avatar'
import { DueDate, StatusBadge } from '../components/Badges'
import Icon from '../components/Icon'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { api, errorMessage } from '../lib/api'
import { usePermissions } from '../lib/permissions'
import type { ActionItem } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp } from '../store/useApp'
import { formatDateTime } from '../utils/format'
import '../styles/meetings.css'

export default function Meetings() {
  const { meetingId } = useParams()
  const meetings = useApi(() => api.meetings(), [], true, { cache: 'meetings', persist: true })

  const list = meetings.data ?? []
  // No id in the URL: show the newest meeting (desktop) or just the list (mobile).
  const selectedId = meetingId ?? list[0]?.id

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Meetings</h1>
          <p className="muted">AI listens to your meetings and turns what people commit to into tasks.</p>
        </div>
      </div>

      {meetings.error && !meetings.data ? (
        <div className="card">
          <ErrorState message={meetings.error} onRetry={meetings.reload} />
        </div>
      ) : !meetings.data ? (
        <div className="card">
          <LoadingState label="Loading meetings…" />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState icon="mic" title="No meetings yet" text="Meetings and the action items AI finds in them will appear here." />
        </div>
      ) : (
        <div className={`meetings-layout ${meetingId ? 'has-selection' : ''}`}>
          <section className="meeting-list" aria-label="Recent meetings">
            {list.map((m) => (
              <Link key={m.id} to={`/meetings/${m.id}`} className={`card meeting-item ${selectedId === m.id ? 'active' : ''}`}>
                <div className="meeting-item-top">
                  <span className="meeting-icon">
                    <Icon name="mic" size={16} />
                  </span>
                  <div className="meeting-item-body">
                    <h2>{m.title}</h2>
                    <div className="muted small">
                      {formatDateTime(m.started_at)} · {m.duration_min} min
                    </div>
                  </div>
                </div>
                <div className="meeting-item-foot">
                  <AvatarStack users={m.attendees} max={4} size={22} />
                  <span className="meeting-item-tags">
                    {m.project && (
                      <span className="chip chip-sm">
                        <span className="dot" style={{ background: m.project.color }} />
                        {m.project.name}
                      </span>
                    )}
                    <span className="chip chip-sm" title="Action items found by AI">
                      <Icon name="sparkles" size={12} /> {m.action_item_count}
                    </span>
                    {m.needs_review_count > 0 && <span className="chip chip-sm chip-warn">{m.needs_review_count} need review</span>}
                  </span>
                </div>
              </Link>
            ))}
          </section>

          {selectedId && <MeetingDetail key={selectedId} meetingId={selectedId} />}
        </div>
      )}
    </div>
  )
}

function MeetingDetail({ meetingId }: { meetingId: string }) {
  const meeting = useApi(() => api.meeting(meetingId), [meetingId], true, { cache: 'meeting' })

  if (meeting.error && !meeting.data) {
    return (
      <section className="meeting-detail">
        <Link to="/meetings" className="back-link">
          <Icon name="chevronLeft" size={16} /> All meetings
        </Link>
        <div className="card">
          <ErrorState message={meeting.error} onRetry={meeting.reload} />
        </div>
      </section>
    )
  }
  if (!meeting.data) {
    return (
      <section className="meeting-detail">
        <div className="card">
          <LoadingState label="Loading meeting…" />
        </div>
      </section>
    )
  }

  const m = meeting.data
  return (
    <section className="meeting-detail" aria-label={m.title}>
      <Link to="/meetings" className="back-link">
        <Icon name="chevronLeft" size={16} /> All meetings
      </Link>

      <div className="card meeting-head">
        <h2>{m.title}</h2>
        <div className="meeting-meta">
          <span>
            <Icon name="calendar" size={14} /> {formatDateTime(m.started_at)}
          </span>
          {m.duration_min > 0 && (
            <span>
              <Icon name="clock" size={14} /> {m.duration_min} min
            </span>
          )}
          {m.project && (
            <Link to={`/projects/${m.project.id}`} className="chip">
              <span className="dot" style={{ background: m.project.color }} />
              {m.project.name}
            </Link>
          )}
        </div>
        {m.attendees.length > 0 && (
          <div className="attendees">
            {m.attendees.map((u) => (
              <span key={u.id} className="attendee">
                <Avatar user={u} size={24} />
                {u.name}
              </span>
            ))}
          </div>
        )}
        {m.summary && (
          <div className="ai-summary">
            <div className="ai-summary-label">
              <Icon name="sparkles" size={14} /> AI summary
            </div>
            <p>{m.summary}</p>
          </div>
        )}
      </div>

      <div className="action-items-head">
        <h3>
          <Icon name="sparkles" size={16} /> Action items found by AI
        </h3>
        <span className="muted small">{m.action_items.length} items</span>
      </div>

      {m.action_items.length === 0 ? (
        <div className="card">
          <EmptyState icon="sparkles" title="No action items" text="The AI didn't find any commitments in this meeting." compact />
        </div>
      ) : (
        <ul className="action-items">
          {m.action_items.map((a) => (
            <ActionItemCard key={a.id} item={a} workspaceId={m.workspace_id} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ActionItemCard({ item, workspaceId }: { item: ActionItem; workspaceId: string }) {
  const { openTask, showToast, invalidate } = useApp()
  const canIgnore = usePermissions().canManageWork(workspaceId)
  const [busy, setBusy] = useState(false)
  const task = item.task
  const title = task?.title ?? item.suggested_title
  const confidencePct = Math.round(item.confidence * 100)

  const resolve = async (action: 'assign' | 'ignore') => {
    setBusy(true)
    try {
      if (action === 'assign') {
        await api.assignActionItemToMe(item.id)
        showToast(`"${item.suggested_title}" was added to your tasks`)
      } else {
        await api.ignoreActionItem(item.id)
        showToast('Suggestion ignored')
      }
      invalidate()
    } catch (err) {
      showToast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <li className={`card action-item ${item.status === 'needs_review' ? 'needs-review' : ''} ${item.status === 'ignored' ? 'is-ignored' : ''}`}>
      <div className="action-item-main">
        <div className="action-item-title">
          <span className="action-task">{title}</span>
          {task && <StatusBadge status={task.status} />}
        </div>

        <div className="action-assignee">
          <span className="muted small">Assigned to</span>
          {task?.assignee ? (
            <span className="with-avatar">
              <Avatar user={task.assignee} size={22} />
              <strong>{task.assignee.name}</strong>
            </span>
          ) : item.status === 'ignored' ? (
            <span className="muted">Ignored</span>
          ) : (
            <span className="unassigned">
              <Icon name="alert" size={14} /> No clear owner
            </span>
          )}
          {task && <DueDate date={task.due_date} done={task.status === 'done'} />}
        </div>

        <blockquote className="quote">
          “{item.quote}”
          <cite>
            {item.speaker?.name ?? 'Unknown speaker'}
            {item.timestamp && ` · at ${item.timestamp}`}
          </cite>
        </blockquote>
        {item.status === 'needs_review' && item.ai_note && <div className="review-reason small">{item.ai_note}</div>}
      </div>

      <div className="action-item-side">
        <div className={`confidence ${item.confidence < 0.7 ? 'low' : ''}`} title="How sure the AI is about this item">
          <span className="confidence-bar">
            <span style={{ width: `${confidencePct}%` }} />
          </span>
          <span className="small">{confidencePct}% sure</span>
        </div>
        {task ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => openTask(task.id)}>
            Open task <Icon name="arrowRight" size={14} />
          </button>
        ) : item.status === 'needs_review' ? (
          <div className="action-buttons">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void resolve('assign')}>
              Assign to me
            </button>
            {canIgnore && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolve('ignore')}>
                Ignore
              </button>
            )}
          </div>
        ) : null}
      </div>
    </li>
  )
}
