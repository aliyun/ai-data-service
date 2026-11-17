import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export function Composer({ value, onChange, onSend, onStop, canSend, running, placeholder, footer, variant }: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop?: () => void
  canSend: boolean
  running: boolean
  placeholder: string
  footer?: ReactNode
  variant: 'home' | 'session'
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [value])

  return (
    <div className={`composer composer-${variant}`}>
      <div className="composer-inner">
        <textarea
          ref={ref}
          rows={variant === 'home' ? 3 : 1}
          value={value}
          placeholder={placeholder}
          aria-label="输入消息"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canSend) onSend()
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-tools">{footer}</div>
          {running && onStop ? (
            <button type="button" className="send-button" aria-label="停止" onClick={onStop}><Square size={14} fill="currentColor" /></button>
          ) : (
            <button type="button" className="send-button" aria-label="发送" disabled={!canSend} onClick={onSend}><ArrowUp size={18} /></button>
          )}
        </div>
      </div>
    </div>
  )
}
