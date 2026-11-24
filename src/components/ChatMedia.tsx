/**
 * Files and voice notes in team chat: showing them in a message, the voice-note player and
 * the microphone recorder used by the message box.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_VOICE_MS, type ChatAttachment, type VoiceNote } from '../lib/chat'
import { formatBytes } from './Attachments'
import Icon from './Icon'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The files of one message: images as thumbnails, voice notes / audio as a player, the rest as file chips. */
export function ChatAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) return null
  const images = attachments.filter((a) => a.type.startsWith('image/') && a.url)
  const audio = attachments.filter((a) => a.voice || a.type.startsWith('audio/'))
  const videos = attachments.filter((a) => a.type.startsWith('video/') && a.url)
  const files = attachments.filter((a) => !images.includes(a) && !audio.includes(a) && !videos.includes(a))

  return (
    <div className="attachments chat-msg-files">
      {images.length > 0 && (
        <div className="attachment-images">
          {images.map((a) => (
            <div key={a.path} className="attachment-thumb">
              <a href={a.url!} target="_blank" rel="noopener noreferrer" title={`${a.name} · ${formatBytes(a.size)}`}>
                <img src={a.url!} alt={a.name} loading="lazy" />
              </a>
            </div>
          ))}
        </div>
      )}
      {audio.map((a) => (
        <VoicePlayer key={a.path} attachment={a} />
      ))}
      {videos.map((a) => (
        <video key={a.path} className="chat-video" src={a.url!} controls preload="metadata" />
      ))}
      {files.map((a) => (
        <div key={a.path} className="attachment-file">
          <span className="attachment-icon">
            <Icon name="file" size={16} />
          </span>
          <div className="attachment-meta">
            {a.url ? (
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="truncate">
                {a.name}
              </a>
            ) : (
              <span className="truncate">{a.name}</span>
            )}
            <span className="muted small">{formatBytes(a.size)}</span>
          </div>
          {a.url && (
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label={`Open ${a.name}`}>
              <Icon name="download" size={15} />
            </a>
          )}
        </div>
      ))}
    </div>
  )
}

/** Play / pause, a seek bar and the time. Uses the recorded length when the file doesn't say. */
export function VoicePlayer({ attachment: a }: { attachment: ChatAttachment }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState((a.duration_ms ?? 0) / 1000)
  const [failed, setFailed] = useState(false)

  const toggle = () => {
    const el = audio.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setFailed(true))
    else el.pause()
  }

  if (!a.url) return <div className="voice-note muted small">{a.voice ? 'Voice message' : a.name} (unavailable)</div>

  return (
    <div className={`voice-note ${playing ? 'is-playing' : ''}`}>
      <button type="button" className="voice-play" onClick={toggle} aria-label={playing ? 'Pause voice message' : 'Play voice message'} disabled={failed}>
        <Icon name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <input
        type="range"
        className="voice-seek"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(current, duration || 1)}
        onChange={(e) => {
          const el = audio.current
          if (el) el.currentTime = Number(e.target.value)
          setCurrent(Number(e.target.value))
        }}
        aria-label="Position in voice message"
        style={{ ['--progress' as string]: `${duration ? (Math.min(current, duration) / duration) * 100 : 0}%` }}
      />
      <span className="voice-time small">
        {failed ? "Can't play in this browser" : playing || current > 0 ? formatDuration(current * 1000) : formatDuration(duration * 1000)}
      </span>
      {!a.voice && <span className="muted small truncate voice-name">{a.name}</span>}
      <a href={a.url} target="_blank" rel="noopener noreferrer" className="icon-btn voice-download" aria-label={`Download ${a.voice ? 'voice message' : a.name}`}>
        <Icon name="download" size={14} />
      </a>
      <audio
        ref={audio}
        src={a.url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setDuration(d)
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setCurrent(0)
        }}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------

const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow it from the icon in the address bar, then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.'
  if (name === 'NotReadableError') return 'The microphone is being used by another app.'
  return "Couldn't start recording."
}

export type RecorderState = 'idle' | 'starting' | 'recording'

/**
 * Records a voice note with the browser's MediaRecorder.
 * stop(true) hands the note to onDone; stop(false) throws it away. Stops by itself at MAX_VOICE_MS.
 */
export function useVoiceRecorder(onDone: (note: VoiceNote) => void, onError: (message: string) => void) {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number; timer: number; keep: boolean } | null>(null)
  const done = useRef(onDone)
  const fail = useRef(onError)
  useEffect(() => {
    done.current = onDone
    fail.current = onError
  })

  const stop = useCallback((keep: boolean) => {
    const r = rec.current
    if (!r) return
    r.keep = keep
    window.clearInterval(r.timer)
    if (r.recorder.state !== 'inactive') r.recorder.stop()
    else r.stream.getTracks().forEach((t) => t.stop())
  }, [])

  const start = useCallback(async () => {
    if (rec.current) return
    if (typeof window.MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      fail.current("This browser can't record audio.")
      return
    }
    setState('starting')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (err) {
      setState('idle')
      fail.current(micErrorMessage(err))
      return
    }
    const mimeType = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined)
    const r = { recorder, stream, chunks: [] as Blob[], startedAt: Date.now(), timer: 0, keep: false }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) r.chunks.push(e.data)
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      const durationMs = Date.now() - r.startedAt
      rec.current = null
      setState('idle')
      setElapsed(0)
      if (!r.keep) return
      if (durationMs < 800 || r.chunks.length === 0) {
        fail.current('That voice message was too short.')
        return
      }
      done.current({ blob: new Blob(r.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }), durationMs })
    }
    r.timer = window.setInterval(() => {
      const ms = Date.now() - r.startedAt
      setElapsed(ms)
      if (ms >= MAX_VOICE_MS) stop(true)
    }, 200)
    rec.current = r
    recorder.start(250)
    setElapsed(0)
    setState('recording')
  }, [stop])

  // Leaving the conversation while recording: discard it and release the microphone.
  useEffect(() => () => stop(false), [stop])

  return { state, elapsed, start, stop }
}
