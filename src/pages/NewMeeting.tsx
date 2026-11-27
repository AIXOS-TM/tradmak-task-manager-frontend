import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { api, errorMessage } from '../lib/api'
import { AiNotConfigured, meetingImport, readTranscriptFile, type DraftItem, type SuggestedItem } from '../lib/meetingImport'
import { usePermissions } from '../lib/permissions'
import type { Priority } from '../lib/types'
import { useApi } from '../lib/useApi'
import { useApp, useCurrentUser } from '../store/useApp'
import { PRIORITY_LABELS, PRIORITY_ORDER } from '../utils/labels'
import { NoAccess } from './Clients'
import '../styles/meetings.css'

interface Row extends DraftItem {
  key: number
  owner_name: string
  speaker_name: string
  /** Came from the AI (shows the quote and how sure it was) or was added by hand. */
  fromAi: boolean
}

let nextKey = 1

function nowLocal(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function blankRow(projectId: string | null): Row {
  return {
    key: nextKey++,
    title: '',
    description: '',
    assignee_id: null,
    speaker_id: null,
    quote: '',
    timestamp: '',
    confidence: 1,
    note: '',
    project_id: projectId,
    priority: 'medium',
    due_date: null,
    owner_name: '',
    speaker_name: '',
    fromAi: false,
  }
}

function fromSuggestion(s: SuggestedItem, projectId: string | null): Row {
  return { ...s, key: nextKey++, project_id: projectId, fromAi: true }
}

/**
 * /meetings/new — paste (or upload) a meeting transcript, let AI find the action items,
 * review them, then save: items with an owner become tasks, the rest wait in review.
 */
export default function NewMeeting() {
  const { projectWorkspaces } = usePermissions()
  if (projectWorkspaces.length === 0) return <NoAccess what="adding meetings" />
  return <NewMeetingForm />
}

function NewMeetingForm() {
  const navigate = useNavigate()
  const currentUser = useCurrentUser()
  const { showToast, invalidate } = useApp()
  const { projectWorkspaces } = usePermissions()

  const [step, setStep] = useState<'details' | 'review'>('details')
  const [workspaceId, setWorkspaceId] = useState(projectWorkspaces[0].id)
  const [title, setTitle] = useState('')
  const [startedAt, setStartedAt] = useState(nowLocal)
  const [duration, setDuration] = useState('')
  const [projectId, setProjectId] = useState('')
  const [attendees, setAttendees] = useState<Set<string>>(() => new Set([currentUser.id]))
  const [transcript, setTranscript] = useState('')
  const [summary, setSummary] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [aiUsed, setAiUsed] = useState(false)
  const [busy, setBusy] = useState<'reading' | 'extracting' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const saved = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const members = useApi(() => api.users(workspaceId), [workspaceId])
  const projects = useApi(() => api.projects(), [], true, { cache: 'projects' })
  const people = useMemo(() => (members.data ?? []).filter((m) => m.status !== 'deactivated').sort((a, b) => a.name.localeCompare(b.name)), [members.data])
  const workspaceProjects = useMemo(
    () => (projects.data ?? []).filter((p) => p.workspace_id === workspaceId && !p.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [projects.data, workspaceId],
  )

  // Don't lose a pasted transcript by closing the tab.
  const dirty = transcript.trim() !== '' || rows.length > 0
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      if (saved.current) return
      e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const changeWorkspace = (id: string) => {
    setWorkspaceId(id)
    setProjectId('')
    setAttendees(new Set([currentUser.id]))
    setRows((r) => r.map((row) => ({ ...row, assignee_id: null, speaker_id: null, project_id: null })))
  }

  const toggleAttendee = (id: string) =>
    setAttendees((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy('reading')
    setError(null)
    try {
      const textFromFile = await readTranscriptFile(file)
      if (!textFromFile) throw new Error('That file is empty.')
      setTranscript(textFromFile)
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const checkDetails = (): boolean => {
    if (!title.trim()) {
      setError('Give the meeting a title.')
      return false
    }
    if (!startedAt || Number.isNaN(new Date(startedAt).getTime())) {
      setError('Pick when the meeting happened.')
      return false
    }
    const minutes = duration.trim() ? Number(duration) : 0
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      setError('Duration should be a number of minutes (0–1440).')
      return false
    }
    return true
  }

  const extract = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)
    setNotice(null)
    if (!checkDetails()) return
    if (transcript.trim().length < 20) {
      setError('Paste the meeting transcript first (or upload the file).')
      return
    }
    setBusy('extracting')
    try {
      const result = await meetingImport.extractActionItems({
        workspace_id: workspaceId,
        transcript,
        title: title.trim(),
        meeting_date: startedAt.slice(0, 10),
      })
      setSummary(result.summary)
      setRows(result.items.map((s) => fromSuggestion(s, projectId || null)))
      setAiUsed(true)
      // People the AI saw speaking count as attendees.
      setAttendees((prev) => {
        const next = new Set(prev)
        for (const s of result.items) {
          if (s.speaker_id) next.add(s.speaker_id)
          if (s.assignee_id) next.add(s.assignee_id)
        }
        return next
      })
      if (result.items.length === 0) setNotice("The AI didn't find any action items. You can add them yourself below.")
      setStep('review')
    } catch (err) {
      if (err instanceof AiNotConfigured) {
        setNotice(`${err.message}`)
        startManual()
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setBusy(null)
    }
  }

  const startManual = () => {
    setError(null)
    if (!checkDetails()) return
    setAiUsed(false)
    setRows((r) => (r.length ? r : [blankRow(projectId || null)]))
    setStep('review')
  }

  const update = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const remove = (key: number) => setRows((all) => all.filter((r) => r.key !== key))

  const toAssign = rows.filter((r) => r.assignee_id).length
  const toReview = rows.length - toAssign

  const save = async () => {
    setError(null)
    if (!checkDetails()) {
      setStep('details')
      return
    }
    if (rows.some((r) => !r.title.trim())) {
      setError('Every action item needs a title (or remove the empty ones).')
      return
    }
    if (rows.some((r) => r.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.due_date))) {
      setError('One of the due dates is not a valid date.')
      return
    }
    setBusy('saving')
    try {
      const id = await meetingImport.saveMeeting(
        {
          workspace_id: workspaceId,
          title: title.trim(),
          started_at: new Date(startedAt).toISOString(),
          duration_min: duration.trim() ? Math.round(Number(duration)) : 0,
          project_id: projectId || null,
          attendee_ids: [...attendees],
          summary: summary.trim(),
          transcript: transcript.trim(),
        },
        rows.map((r) => ({
          title: r.title.trim(),
          description: r.description.trim(),
          assignee_id: r.assignee_id,
          speaker_id: r.speaker_id,
          quote: r.quote,
          timestamp: r.timestamp,
          confidence: r.fromAi ? r.confidence : 1,
          note: r.assignee_id ? '' : r.note || 'Nobody was picked for this yet.',
          project_id: r.project_id,
          priority: r.priority,
          due_date: r.due_date || null,
        })),
      )
      saved.current = true
      invalidate()
      showToast(
        rows.length === 0
          ? 'Meeting saved'
          : `Meeting saved · ${toAssign} task${toAssign === 1 ? '' : 's'} created${toReview ? ` · ${toReview} to review` : ''}`,
      )
      navigate(`/meetings/${id}`)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  const workspaceName = projectWorkspaces.find((w) => w.id === workspaceId)?.name

  return (
    <div className="page new-meeting">
      <Link to="/meetings" className="back-link">
        <Icon name="chevronLeft" size={16} /> Meetings
      </Link>
      <div className="page-header">
        <div>
          <h1>Add a meeting</h1>
          <p className="muted">Paste the transcript from Meetily (or any recorder). AI finds who agreed to do what, you check it, and the tasks are created.</p>
        </div>
      </div>

      <ol className="nm-steps" aria-label="Steps">
        <li className={step === 'details' ? 'active' : 'done'}>
          <span>1</span> Meeting &amp; transcript
        </li>
        <li className={step === 'review' ? 'active' : ''}>
          <span>2</span> Review action items
        </li>
      </ol>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="form-info">{notice}</p>}

      {step === 'details' ? (
        <form className="card nm-card" onSubmit={extract}>
          {projectWorkspaces.length > 1 && (
            <label className="field">
              <span>Organization</span>
              <select id="nm-workspace" className="input" value={workspaceId} onChange={(e) => changeWorkspace(e.target.value)}>
                {projectWorkspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>Title</span>
            <input id="nm-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly sales sync" maxLength={200} required autoFocus />
          </label>

          <div className="modal-row modal-row-even nm-row-3">
            <label className="field">
              <span>When</span>
              <input id="nm-when" className="input" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} required />
            </label>
            <label className="field">
              <span>Duration (minutes)</span>
              <input id="nm-duration" className="input" type="number" min={0} max={1440} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="e.g. 45" />
            </label>
            <label className="field">
              <span>Project (optional)</span>
              <select id="nm-project" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {workspaceProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field">
            <span>Who was there</span>
            {members.error ? (
              <small className="text-danger">{members.error}</small>
            ) : !members.data ? (
              <small className="muted">Loading team…</small>
            ) : (
              <div className="nm-people" role="group" aria-label="Attendees">
                {people.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`nm-person ${attendees.has(m.id) ? 'on' : ''}`}
                    aria-pressed={attendees.has(m.id)}
                    onClick={() => toggleAttendee(m.id)}
                  >
                    {attendees.has(m.id) && <Icon name="check" size={12} />}
                    {m.name}
                    {m.id === currentUser.id ? ' (you)' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <div className="nm-transcript-head">
              <span>Transcript</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
                <Icon name="paperclip" size={14} /> {busy === 'reading' ? 'Reading…' : 'Upload file'}
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                accept=".txt,.md,.srt,.vtt,.json,text/plain,text/markdown,application/json"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </div>
            <textarea
              id="nm-transcript"
              className="input textarea nm-transcript"
              rows={14}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder={'Paste the transcript here, for example:\n[00:12:48] Ali: Main Friday tak pricing sheet update kar dunga.\n[00:13:05] Sara: Okay, aur client ko email main bhej dungi.'}
              spellCheck={false}
            />
            <small className="muted">
              {transcript.length.toLocaleString('en-US')} characters · .txt, .md, .srt, .vtt or .json · the transcript is saved with the meeting so everyone in {workspaceName ?? 'the organization'} can read it.
            </small>
          </div>

          <div className="nm-actions">
            <button type="button" className="btn btn-ghost" onClick={startManual} disabled={busy !== null}>
              Skip AI, add items myself
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>
              <Icon name="sparkles" size={16} /> {busy === 'extracting' ? 'Reading the transcript…' : 'Find action items with AI'}
            </button>
          </div>
          {busy === 'extracting' && <p className="muted small nm-wait">This usually takes 10–40 seconds for an hour-long meeting.</p>}
        </form>
      ) : (
        <div className="nm-review">
          <div className="card nm-card">
            <div className="nm-review-meta">
              <div>
                <strong>{title}</strong>
                <div className="muted small">
                  {new Date(startedAt).toLocaleString()} {duration ? `· ${duration} min` : ''} · {attendees.size} {attendees.size === 1 ? 'person' : 'people'}
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep('details')} disabled={busy !== null}>
                <Icon name="edit" size={14} /> Edit details
              </button>
            </div>
            <label className="field">
              <span>{aiUsed ? 'Summary (written by AI — edit freely)' : 'Summary (optional)'}</span>
              <textarea id="nm-summary" className="input textarea" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={5000} placeholder="What was decided in this meeting?" />
            </label>
          </div>

          <div className="action-items-head">
            <h3>
              <Icon name="sparkles" size={16} /> Action items
            </h3>
            <span className="muted small">
              {rows.length} item{rows.length === 1 ? '' : 's'}
            </span>
          </div>

          {rows.length === 0 && <div className="card nm-empty muted">No action items. Add one, or save the meeting without any.</div>}

          <ul className="nm-items">
            {rows.map((r, index) => (
              <ItemEditor
                key={r.key}
                row={r}
                index={index}
                people={people}
                projects={workspaceProjects}
                onChange={(patch) => update(r.key, patch)}
                onRemove={() => remove(r.key)}
              />
            ))}
          </ul>

          <button type="button" className="btn btn-secondary btn-sm nm-add" onClick={() => setRows((all) => [...all, blankRow(projectId || null)])}>
            <Icon name="plus" size={14} /> Add item
          </button>

          <div className="card nm-footer">
            <p className="small">
              <strong>{toAssign}</strong> task{toAssign === 1 ? '' : 's'} will be created and assigned
              {toReview > 0 && (
                <>
                  {' '}
                  · <strong>{toReview}</strong> without an owner will wait in review
                </>
              )}
              .
            </p>
            <div className="nm-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setStep('details')} disabled={busy !== null}>
                Back
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy !== null}>
                {busy === 'saving' ? 'Saving…' : 'Save meeting'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface EditorProps {
  row: Row
  index: number
  people: { id: string; name: string }[]
  projects: { id: string; name: string }[]
  onChange: (patch: Partial<Row>) => void
  onRemove: () => void
}

function ItemEditor({ row, index, people, projects, onChange, onRemove }: EditorProps) {
  const pct = Math.round(row.confidence * 100)
  const id = `nm-item-${row.key}`
  const speaker = people.find((p) => p.id === row.speaker_id)?.name ?? row.speaker_name
  return (
    <li className={`card nm-item ${row.assignee_id ? '' : 'needs-review'}`}>
      <div className="nm-item-top">
        <label className="field nm-item-title">
          <span className="sr-only">Title of item {index + 1}</span>
          <input id={`${id}-title`} className="input" value={row.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="What needs to be done?" maxLength={200} />
        </label>
        {row.fromAi && (
          <span className={`confidence ${row.confidence < 0.7 ? 'low' : ''}`} title="How sure the AI is about this item">
            <span className="confidence-bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="small">{pct}% sure</span>
          </span>
        )}
        <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Remove item ${index + 1}`} title="Remove">
          <Icon name="trash" size={16} />
        </button>
      </div>

      <div className="nm-item-grid">
        <label className="field">
          <span>Assign to</span>
          <select id={`${id}-assignee`} className="input" value={row.assignee_id ?? ''} onChange={(e) => onChange({ assignee_id: e.target.value || null })}>
            <option value="">Nobody yet (review later)</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!row.assignee_id && row.owner_name && <small className="muted">Said in the meeting: “{row.owner_name}”</small>}
        </label>
        <label className="field">
          <span>Due date</span>
          <input id={`${id}-due`} className="input" type="date" value={row.due_date ?? ''} onChange={(e) => onChange({ due_date: e.target.value || null })} />
        </label>
        <label className="field">
          <span>Priority</span>
          <select id={`${id}-priority`} className="input" value={row.priority} onChange={(e) => onChange({ priority: e.target.value as Priority })}>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Project</span>
          <select id={`${id}-project`} className="input" value={row.project_id ?? ''} onChange={(e) => onChange({ project_id: e.target.value || null })}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>Details</span>
        <textarea id={`${id}-desc`} className="input textarea" rows={2} value={row.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="Optional context" />
      </label>

      {row.quote && (
        <blockquote className="quote">
          “{row.quote}”
          <cite>
            {speaker || 'Unknown speaker'}
            {row.timestamp && ` · at ${row.timestamp}`}
          </cite>
        </blockquote>
      )}
      {!row.assignee_id && row.note && <div className="review-reason small">{row.note}</div>}
    </li>
  )
}
