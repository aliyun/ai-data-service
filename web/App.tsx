import { Bot, MessageSquarePlus, Settings, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ConfigStatus } from '../server/config.ts'
import { deleteSession, listSessions, type SessionSummary } from './lib/ada.ts'
import { errorText, getConfig, saveRegion } from './lib/api.ts'
import { disposeAllControllers, disposeController } from './lib/controllers.ts'
import { navigate, useRoute } from './lib/route.ts'
import { ConfirmDialog, ErrorBanner, Spinner } from './components/ui.tsx'
import { AgentsView } from './views/AgentsView.tsx'
import { ChatView } from './views/ChatView.tsx'
import { SettingsView } from './views/SettingsView.tsx'
import { SkillsView } from './views/SkillsView.tsx'

const REGION_NAMES: Readonly<Record<string, string>> = {
  'cn-hangzhou': '华东1（杭州）',
  'cn-shanghai': '华东2（上海）',
  'cn-beijing': '华北2（北京）',
}

export function App() {
  const [config, setConfig] = useState<ConfigStatus>()
  const [error, setError] = useState('')

  useEffect(() => {
    getConfig().then(setConfig).catch((reason: unknown) => setError(errorText(reason)))
  }, [])

  if (error) return <div className="center-page"><ErrorBanner message={error} /></div>
  if (!config) return <div className="center-page"><Spinner /></div>
  if (!config.configured) {
    return (
      <div className="setup-page">
        <SettingsView config={config} onChange={setConfig} firstRun />
      </div>
    )
  }
  return <Shell config={config} onConfig={setConfig} />
}

function Shell({ config, onConfig }: { config: ConfigStatus; onConfig: (config: ConfigStatus) => void }) {
  const route = useRoute()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [nextToken, setNextToken] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionSummary>()
  // Region changes remount everything below: agents and sessions belong to one region.
  const [regionError, setRegionError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const page = await listSessions()
      setSessions(page.sessions)
      setNextToken(page.nextToken)
      setListError('')
    } catch (reason) {
      setListError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh, config.region])

  async function loadMore(): Promise<void> {
    if (!nextToken) return
    try {
      const page = await listSessions(nextToken)
      setSessions((current) => [...current, ...page.sessions])
      setNextToken(page.nextToken)
    } catch (reason) {
      setListError(errorText(reason))
    }
  }

  async function changeRegion(region: string): Promise<void> {
    try {
      const next = await saveRegion(region)
      disposeAllControllers()
      onConfig(next)
      setRegionError('')
      navigate({ name: 'chat' })
    } catch (reason) {
      setRegionError(errorText(reason))
    }
  }

  async function confirmDelete(session: SessionSummary): Promise<void> {
    await deleteSession(session.sessionId)
    disposeController(session.sessionId)
    setSessions((current) => current.filter((item) => item.sessionId !== session.sessionId))
    if (route.name === 'chat' && route.sessionId === session.sessionId) navigate({ name: 'chat' })
  }

  const nav = [
    { label: '新任务', icon: MessageSquarePlus, active: route.name === 'chat' && !route.sessionId, go: () => navigate({ name: 'chat' }) },
    { label: '智能体', icon: Bot, active: route.name === 'agents', go: () => navigate({ name: 'agents' }) },
    { label: '技能', icon: Sparkles, active: route.name === 'skills', go: () => navigate({ name: 'skills' }) },
  ]

  return (
    <div className="shell">
      <header className="app-header">
        <a className="brand" href="#/chat">
          <img src="/favicon.svg" alt="" />
          <span>OpenADA</span>
        </a>
        <div className="header-right">
          <label className="region-select">
            <span className="sr-only">地域</span>
            <select value={config.region} onChange={(event) => void changeRegion(event.target.value)} aria-label="地域">
              {config.regions.map((region) => (
                <option key={region} value={region}>{REGION_NAMES[region] ?? region}</option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <div className="app-body">
        <aside className="sidebar">
          <nav className="nav-group">
            {nav.map(({ label, icon: Icon, active, go }) => (
              <button key={label} type="button" className={`nav-item${active ? ' active' : ''}`} onClick={go}>
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
          <div className="history">
            <div className="history-title">历史会话</div>
            {loading && <div className="history-empty"><Spinner size="sm" /></div>}
            {listError && <div className="history-empty error-text">{listError}</div>}
            {!loading && !listError && sessions.length === 0 && <div className="history-empty">还没有会话</div>}
            {sessions.map((session) => (
              <div key={session.sessionId} className={`history-item${route.name === 'chat' && route.sessionId === session.sessionId ? ' active' : ''}`}>
                <button type="button" className="history-link" title={session.title || '未命名会话'} onClick={() => navigate({ name: 'chat', sessionId: session.sessionId })}>
                  {session.title || '未命名会话'}
                </button>
                <button type="button" className="icon-button history-delete" aria-label={`删除会话 ${session.title || '未命名会话'}`} onClick={() => setPendingDelete(session)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {nextToken && <button type="button" className="link-button history-more" onClick={() => void loadMore()}>加载更多</button>}
          </div>
          <div className="sidebar-footer">
            <button type="button" className={`nav-item${route.name === 'settings' ? ' active' : ''}`} onClick={() => navigate({ name: 'settings' })}>
              <Settings size={16} />
              设置
            </button>
          </div>
        </aside>
        <main className="content" key={config.region}>
          {regionError && <ErrorBanner message={regionError} />}
          {route.name === 'chat' && (
            <ChatView
              {...(route.sessionId ? { sessionId: route.sessionId } : {})}
              {...(route.agent ? { initialAgent: route.agent } : {})}
              onSessionsChanged={refresh}
            />
          )}
          {route.name === 'agents' && <AgentsView />}
          {route.name === 'skills' && <SkillsView />}
          {route.name === 'settings' && <SettingsView config={config} onChange={onConfig} />}
        </main>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title="删除会话"
          message={`确定删除“${pendingDelete.title || '未命名会话'}”吗？执行中的会话需要先停止。已经发生的外部操作不会被撤销。`}
          confirmLabel="删除"
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={async () => {
            await confirmDelete(pendingDelete)
            setPendingDelete(undefined)
          }}
        />
      )}
    </div>
  )
}
