import { useState } from 'react'
import { api, errorMessage } from '../lib/api'
import type { Attachment } from '../lib/types'
import Icon from './Icon'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const isImage = (mime: string) => mime.startsWith('image/')

/** Files attached to a comment: image thumbnails and file chips that open / download the file. */
export function AttachmentList({
  attachments,
  canDelete,
  onChanged,
  onError,
}: {
  attachments: Attachment[]
  canDelete: (a: Attachment) => boolean
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  if (attachments.length === 0) return null

  const remove = async (a: Attachment) => {
    if (!window.confirm(`Remove ${a.file_name}?`)) return
    setBusy(a.id)
    try {
      await api.deleteAttachment(a)
      onChanged()
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const images = attachments.filter((a) => isImage(a.mime_type) && a.url)
  const files = attachments.filter((a) => !images.includes(a))

  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className="attachment-images">
          {images.map((a) => (
            <div key={a.id} className="attachment-thumb">
              <a href={a.url!} target="_blank" rel="noopener noreferrer" title={`${a.file_name} · ${formatBytes(a.size_bytes)}`}>
                <img src={a.url!} alt={a.file_name} loading="lazy" />
              </a>
              {canDelete(a) && (
                <button type="button" className="attachment-remove" onClick={() => void remove(a)} disabled={busy === a.id} aria-label={`Remove ${a.file_name}`}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {files.map((a) => (
        <div key={a.id} className="attachment-file">
          <span className="attachment-icon">
            <Icon name="file" size={16} />
          </span>
          <div className="attachment-meta">
            {a.url ? (
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="truncate">
                {a.file_name}
              </a>
            ) : (
              <span className="truncate">{a.file_name}</span>
            )}
            <span className="muted small">{formatBytes(a.size_bytes)}</span>
          </div>
          {a.url && (
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label={`Open ${a.file_name}`}>
              <Icon name="download" size={15} />
            </a>
          )}
          {canDelete(a) && (
            <button type="button" className="icon-btn" onClick={() => void remove(a)} disabled={busy === a.id} aria-label={`Remove ${a.file_name}`}>
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** Files picked for a comment that hasn't been sent yet. */
export function PendingFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (files.length === 0) return null
  return (
    <ul className="pending-files">
      {files.map((f, i) => (
        <li key={`${f.name}-${f.size}-${i}`} className="pending-file">
          <Icon name={f.type.startsWith('image/') ? 'paperclip' : 'file'} size={13} />
          <span className="truncate">{f.name}</span>
          <span className="muted">{formatBytes(f.size)}</span>
          <button type="button" className="pending-remove" onClick={() => onRemove(i)} aria-label={`Don't attach ${f.name}`}>
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
    </ul>
  )
}
