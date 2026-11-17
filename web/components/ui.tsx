import { AlertCircle, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { errorText } from '../lib/api.ts'

export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return <Loader2 className="spinner" size={size === 'sm' ? 14 : 20} aria-label="加载中" />
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="banner banner-error" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
    </div>
  )
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog ref={ref} className={`dialog${wide ? ' dialog-wide' : ''}`} onCancel={(event) => { event.preventDefault(); onClose() }}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </div>
      {children}
    </dialog>
  )
}

export function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: {
  title: string
  message: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
    } catch (reason) {
      setError(errorText(reason))
      setBusy(false)
    }
  }
  return (
    <Dialog title={title} onClose={onCancel}>
      <div className="dialog-body">
        <p className="dialog-message">{message}</p>
        {error && <ErrorBanner message={error} />}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onCancel}>取消</button>
        <button type="button" className="button button-danger" disabled={busy} onClick={() => void run()}>
          {busy && <Spinner size="sm" />}{confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

/** Agent output is untrusted: raw HTML stays disabled and images render as links, so nothing loads on its own. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          img: ({ src, alt }) => (typeof src === 'string' ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a> : null),
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}

export function AgentAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const letter = name.trim().charAt(0).toUpperCase() || 'A'
  return <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{letter}</span>
}

export function splitNames(value: string): string[] {
  return [...new Set(value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))]
}
