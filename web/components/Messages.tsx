import { AlertCircle, CheckCircle2, ChevronRight, CircleDashed, Info, ListTree, Loader2, ScanSearch, Search, Terminal, Wrench, XCircle } from 'lucide-react'
import { useState } from 'react'
import type { ChatItem, DisplayBlock } from '../lib/session-state.ts'
import { MarkdownText } from './ui.tsx'

type ProcessItem = Extract<DisplayBlock, { kind: 'process' }>['items'][number]

function toolIcon(kind: string) {
  if (kind === 'search') return <Search size={14} />
  if (kind === 'execute') return <Terminal size={14} />
  return <Wrench size={14} />
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 size={14} className="status-ok" aria-label="已完成" />
  if (status === 'failed') return <XCircle size={14} className="status-failed" aria-label="失败" />
  if (status === 'in_progress') return <Loader2 size={14} className="spinner" aria-label="进行中" />
  return <CircleDashed size={14} className="status-pending" aria-label="等待中" />
}

function ToolRow({ item }: { item: Extract<ChatItem, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const hasDetail = item.rawInput !== undefined || Boolean(item.output)
  return (
    <div className="process-row">
      <button type="button" className="process-row-head" aria-expanded={open} disabled={!hasDetail} onClick={() => setOpen(!open)}>
        {toolIcon(item.kind)}
        <span className="process-row-title">{item.title}</span>
        <StatusIcon status={item.status} />
      </button>
      {open && (
        <div className="tool-detail">
          {item.rawInput !== undefined && <pre>{JSON.stringify(item.rawInput, null, 2)}</pre>}
          {item.output && <pre>{item.output}</pre>}
        </div>
      )}
    </div>
  )
}

function ThoughtRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="process-row">
      <button type="button" className="process-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ScanSearch size={14} />
        <span className="process-row-title">思考过程</span>
      </button>
      {open && <div className="thought-text">{text}</div>}
    </div>
  )
}

function processTitle(items: readonly ProcessItem[], active: boolean): string {
  const tools = items.filter((item) => item.type === 'tool')
  const prefix = active ? '处理中' : '已处理'
  return tools.length > 0 ? `${prefix} · ${tools.length} 个步骤` : active ? '正在分析' : '已分析'
}

function ProcessBlock({ items, active }: { items: readonly ProcessItem[]; active: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean>()
  // Follows the turn until the user decides: open while running, collapsed once settled.
  const open = userOpen ?? active
  const failed = items.some((item) => item.type === 'tool' && item.status === 'failed')
  return (
    <div className="process">
      <button type="button" className="process-head" aria-expanded={open} onClick={() => setUserOpen(!open)}>
        <ListTree size={14} />
        <span>{processTitle(items, active)}</span>
        {failed && <span className="status-failed process-failed">含失败步骤</span>}
        <ChevronRight size={14} className={`chevron${open ? ' chevron-open' : ''}`} />
      </button>
      {open && (
        <div className="process-body">
          {items.map((item) => {
            if (item.type === 'tool') return <ToolRow key={item.id} item={item} />
            if (item.type === 'thought') return <ThoughtRow key={item.id} text={item.text} />
            return (
              <ol className="plan" key={item.id}>
                {item.entries.map((entry, index) => (
                  <li key={index} className={`plan-${entry.status}`}>{entry.content}</li>
                ))}
              </ol>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Notice({ item }: { item: Extract<ChatItem, { type: 'notice' }> }) {
  return (
    <div className={`notice notice-${item.level}`} role={item.level === 'error' ? 'alert' : 'status'}>
      {item.level === 'error' ? <AlertCircle size={14} /> : <Info size={14} />}
      <div>
        <div>{item.text}</div>
        {(item.code || item.requestId) && (
          <div className="notice-meta">{[item.code, item.requestId && `RequestId: ${item.requestId}`].filter(Boolean).join(' · ')}</div>
        )}
      </div>
    </div>
  )
}

export function MessageBlock({ block, active }: { block: DisplayBlock; active: boolean }) {
  if (block.kind === 'process') return <ProcessBlock items={block.items} active={active} />
  const { item } = block
  switch (item.type) {
    case 'user':
      return <div className="user-message"><div className="user-bubble">{item.text}</div></div>
    case 'agent':
      return <MarkdownText text={item.text} />
    case 'notice':
      return <Notice item={item} />
    default:
      return null
  }
}
