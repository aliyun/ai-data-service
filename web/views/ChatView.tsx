import { ChevronDown, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Composer } from '../components/Composer.tsx'
import { InteractionCard } from '../components/InteractionCard.tsx'
import { MessageBlock } from '../components/Messages.tsx'
import { AgentAvatar, Dialog, ErrorBanner, Spinner } from '../components/ui.tsx'
import {
  createSession,
  getSession,
  getSessionModel,
  listAgents,
  listModels,
  setSessionModel,
  type AgentSummary,
  type ModelInfo,
  type SessionModel,
} from '../lib/ada.ts'
import { errorText } from '../lib/api.ts'
import { getController } from '../lib/controllers.ts'
import { navigate } from '../lib/route.ts'
import { toDisplayBlocks } from '../lib/session-state.ts'

export function ChatView({ sessionId, initialAgent, onSessionsChanged }: {
  sessionId?: string
  initialAgent?: string
  onSessionsChanged: () => Promise<void>
}) {
  return sessionId
    ? <Conversation key={sessionId} sessionId={sessionId} onSessionsChanged={onSessionsChanged} />
    : <Welcome {...(initialAgent ? { initialAgent } : {})} onSessionsChanged={onSessionsChanged} />
}

function greeting(now = new Date()): string {
  const hour = now.getHours()
  if (hour >= 5 && hour < 11) return '早上好'
  if (hour >= 11 && hour < 13) return '中午好'
  if (hour >= 13 && hour < 18) return '下午好'
  return '晚上好'
}

function agentLabel(agent: AgentSummary | undefined): string {
  return agent?.displayName || agent?.name || ''
}

function greetingLine(name: string): string {
  if (!name) return greeting()
  // A space separates 是 from a Latin name, a CJK name follows directly.
  return `${greeting()}， 我是${/^[A-Za-z]/.test(name) ? ' ' : ''}${name}`
}

function Welcome({ initialAgent, onSessionsChanged }: { initialAgent?: string; onSessionsChanged: () => Promise<void> }) {
  const [agents, setAgents] = useState<AgentSummary[]>()
  const [models, setModels] = useState<ModelInfo[]>([])
  const [agentName, setAgentName] = useState(initialAgent ?? '')
  const [modelId, setModelId] = useState('')
  const [approvalMode, setApprovalMode] = useState<'default' | 'yolo'>('default')
  const [picking, setPicking] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    listAgents()
      .then((list) => {
        if (!live) return
        setAgents(list)
        setAgentName((current) => current || list.find((agent) => agent.official)?.name || list[0]?.name || '')
      })
      .catch((reason: unknown) => live && setError(errorText(reason)))
    // The model catalog is optional here: without it, the session keeps its default model.
    listModels().then((list) => live && setModels(list)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const agent = agents?.find((item) => item.name === agentName)

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || !agentName || sending) return
    setSending(true)
    setError('')
    try {
      const sessionId = await createSession(agentName, approvalMode)
      // A rejected model must not silently run the message on another model, so it stops before the Prompt.
      if (modelId) await setSessionModel(sessionId, modelId)
      const controller = getController(sessionId, () => void onSessionsChanged())
      controller.prompt(text)
      navigate({ name: 'chat', sessionId })
      void onSessionsChanged()
    } catch (reason) {
      setError(errorText(reason))
      setSending(false)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-stage">
        <div className="welcome-avatar"><AgentAvatar name={agentLabel(agent) || 'A'} size={38} /></div>
        <h1 className="welcome-title">{greetingLine(agentLabel(agent))}</h1>
        <p className="welcome-subtitle">多智能体协同完成复杂数据任务</p>
        <button type="button" className="agent-switch" disabled={!agents?.length} onClick={() => setPicking(true)}>
          切换智能体
          <ChevronDown size={14} />
        </button>
        <Composer
          variant="home"
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          canSend={Boolean(draft.trim() && agentName && !sending)}
          running={false}
          placeholder="想问点什么？"
          footer={
            <>
              {models.length > 0 && (
                <select className="pill-select" aria-label="模型" value={modelId} onChange={(event) => setModelId(event.target.value)}>
                  <option value="">默认模型</option>
                  {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                </select>
              )}
              <select className="pill-select" aria-label="审批模式" value={approvalMode} onChange={(event) => setApprovalMode(event.target.value as 'default' | 'yolo')}>
                <option value="default">操作前询问</option>
                <option value="yolo">自动批准操作</option>
              </select>
            </>
          }
        />
        {approvalMode === 'yolo' && <p className="welcome-warning">自动批准后，智能体可以不经确认执行受支持的操作。请只在信任当前任务时使用。</p>}
        {sending && <div className="welcome-status"><Spinner size="sm" />正在创建会话…</div>}
        {error && <ErrorBanner message={error} />}
      </div>
      {picking && agents && (
        <AgentPicker
          agents={agents}
          selected={agentName}
          onSelect={(name) => {
            setAgentName(name)
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}

function AgentPicker({ agents, selected, onSelect, onClose }: {
  agents: AgentSummary[]
  selected: string
  onSelect: (name: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return agents.filter((agent) => !keyword || `${agent.name} ${agent.displayName} ${agent.description}`.toLowerCase().includes(keyword))
  }, [agents, query])
  return (
    <Dialog title="选择智能体" onClose={onClose}>
      <div className="dialog-body">
        <div className="search-box">
          <Search size={16} />
          <input value={query} placeholder="搜索智能体" aria-label="搜索智能体" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="picker-list">
          {filtered.map((agent) => (
            <button key={agent.name} type="button" className={`picker-item${agent.name === selected ? ' selected' : ''}`} onClick={() => onSelect(agent.name)}>
              <AgentAvatar name={agentLabel(agent)} />
              <span className="picker-text">
                <span className="picker-name">{agentLabel(agent)}</span>
                <span className="picker-description">{agent.description || agent.name}</span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && <div className="empty">没有匹配的智能体</div>}
        </div>
      </div>
    </Dialog>
  )
}

function Conversation({ sessionId, onSessionsChanged }: { sessionId: string; onSessionsChanged: () => Promise<void> }) {
  const controller = useMemo(() => getController(sessionId, () => void onSessionsChanged()), [sessionId, onSessionsChanged])
  const view = useSyncExternalStore(controller.subscribe, controller.getView)
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState<SessionModel>()
  const [modelError, setModelError] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    // Opening a session that is already running here (for example right after creating it) must not reload it.
    if (controller.getView().phase === 'loading' || controller.getView().phase === 'idle') controller.open()
  }, [controller])

  const running = view.phase === 'running' || view.phase === 'cancelling' || view.phase === 'reconnecting'
  const idle = view.phase === 'idle'

  useEffect(() => {
    let live = true
    getSession(sessionId).then((session) => live && setTitle(session.title)).catch(() => undefined)
    getSessionModel(sessionId).then((value) => live && setModel(value)).catch(() => undefined)
    listModels().then((list) => live && setModels(list)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [sessionId, idle])

  useEffect(() => {
    if (view.restoredDraft) setDraft(view.restoredDraft)
  }, [view.restoredDraft])

  useEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [view.items, view.interactions])

  const blocks = useMemo(() => toDisplayBlocks(view.items), [view.items])
  const lastBlock = blocks.at(-1)
  const awaitingInput = view.interactions.length > 0

  function send(): void {
    const text = draft.trim()
    if (!text || !idle || awaitingInput) return
    pinned.current = true
    setDraft('')
    controller.prompt(text)
  }

  async function changeModel(modelId: string, thinkingLevel?: string): Promise<void> {
    setModelError('')
    try {
      setModel(await setSessionModel(sessionId, modelId, thinkingLevel))
    } catch (reason) {
      setModelError(errorText(reason))
      // A failed change may still have applied part of the request, so read the effective value back.
      getSessionModel(sessionId).then(setModel).catch(() => undefined)
    }
  }

  // The session may report an effective id that is absent from the catalog, so it stays selectable.
  const modelOptions = model && !models.some((item) => item.id === model.modelId)
    ? [{ id: model.modelId, displayName: model.modelId }, ...models]
    : models

  return (
    <div className="conversation">
      <div className="conversation-head">
        <h1>{title || '会话'}</h1>
      </div>
      <div
        className="conversation-scroll"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
        <div className="conversation-column">
          {view.phase === 'loading' && view.items.length === 0 && <div className="conversation-loading"><Spinner /></div>}
          {blocks.map((block) => (
            <MessageBlock
              key={block.kind === 'process' ? block.id : block.item.id}
              block={block}
              active={running && block === lastBlock}
            />
          ))}
          {view.interactions.map((interaction) => (
            <InteractionCard key={interaction.requestId} interaction={interaction} onReply={(reply) => controller.reply(reply)} />
          ))}
          {running && !awaitingInput && lastBlock?.kind !== 'process' && (
            <div className="turn-status"><Spinner size="sm" />{statusText(view.phase)}</div>
          )}
          {view.phase === 'reconnecting' && lastBlock?.kind === 'process' && (
            <div className="turn-status"><Spinner size="sm" />{statusText(view.phase)}</div>
          )}
          {view.waitingForDelegation && idle && (
            <div className="turn-status"><Spinner size="sm" />任务已派发给其他智能体，结果回来后会自动显示…</div>
          )}
          {view.phase === 'lost' && (
            <div className="turn-status">
              <button type="button" className="button" onClick={() => controller.reconnect()}><RefreshCw size={14} />重新连接</button>
            </div>
          )}
        </div>
      </div>
      <div className="conversation-composer">
        {modelError && <ErrorBanner message={modelError} />}
        {view.composerNotice && <div className="banner banner-info" role="status">{view.composerNotice}</div>}
        <Composer
          variant="session"
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={() => void controller.cancel()}
          canSend={Boolean(draft.trim()) && idle && !awaitingInput}
          running={running}
          placeholder={awaitingInput ? '请先处理上方的确认' : '想问点什么？'}
          footer={
            model && modelOptions.length > 0 ? (
              <>
                <select className="pill-select" aria-label="模型" disabled={!idle} value={model.modelId} onChange={(event) => void changeModel(event.target.value)}>
                  {modelOptions.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                </select>
                {model.thinkingLevels.length > 0 && (
                  <select className="pill-select" aria-label="思考强度" disabled={!idle} value={model.thinkingLevel} onChange={(event) => void changeModel(model.modelId, event.target.value)}>
                    {model.thinkingLevels.map((level) => <option key={level} value={level}>思考：{level}</option>)}
                  </select>
                )}
              </>
            ) : null
          }
        />
        <p className="composer-note">以上内容由 AI 生成</p>
      </div>
    </div>
  )
}

function statusText(phase: string): string {
  if (phase === 'cancelling') return '正在停止…'
  if (phase === 'reconnecting') return '连接中断，正在恢复读取…'
  return '处理中…'
}
