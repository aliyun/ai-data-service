import { MessageSquare, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AgentAvatar, ConfirmDialog, Dialog, ErrorBanner, Field, Spinner, splitNames } from '../components/ui.tsx'
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  listSkills,
  updateAgent,
  type AgentDetail,
  type AgentInput,
  type AgentSummary,
  type SkillSummary,
} from '../lib/ada.ts'
import { errorText } from '../lib/api.ts'
import { navigate } from '../lib/route.ts'

type Tab = 'all' | 'official' | 'custom'
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'official', label: '官方' },
  { id: 'custom', label: '自定义' },
]

export function AgentsView() {
  const [agents, setAgents] = useState<AgentSummary[]>()
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<AgentDetail | 'new'>()
  const [viewing, setViewing] = useState<string>()
  const [removing, setRemoving] = useState<AgentDetail>()

  const refresh = useCallback(async () => {
    try {
      setAgents(await listAgents())
      setError('')
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (agents ?? []).filter((agent) => {
      if (tab === 'official' && !agent.official) return false
      if (tab === 'custom' && agent.official) return false
      return !keyword || `${agent.name} ${agent.displayName} ${agent.description}`.toLowerCase().includes(keyword)
    })
  }, [agents, tab, query])

  return (
    <div className="page">
      <div className="page-head">
        <h1>智能体</h1>
        <button type="button" className="button button-primary" onClick={() => setEditing('new')}><Plus size={16} />新建智能体</button>
      </div>
      <div className="toolbar">
        <div className="segmented" role="tablist">
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </div>
        <div className="search-box search-box-toolbar">
          <Search size={16} />
          <input value={query} placeholder="搜索智能体" aria-label="搜索智能体" onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {!agents && !error && <div className="page-loading"><Spinner /></div>}
      {agents && visible.length === 0 && <div className="empty">没有符合条件的智能体</div>}
      <div className="card-grid">
        {visible.map((agent) => (
          <article key={agent.name} className="card">
            <button type="button" className="card-main" onClick={() => setViewing(agent.name)}>
              <AgentAvatar name={agent.displayName || agent.name} size={44} />
              <span className="card-text">
                <span className="card-title">
                  <span className="truncate">{agent.displayName || agent.name}</span>
                  <span className={`badge${agent.official ? ' badge-official' : ''}`}>{agent.official ? '官方' : '自定义'}</span>
                </span>
                <span className="card-subtitle truncate">{agent.name}</span>
                <span className="card-description">{agent.description || '暂无描述'}</span>
              </span>
            </button>
            <button type="button" className="button button-small card-action" onClick={() => navigate({ name: 'chat', agent: agent.name })}>
              <MessageSquare size={14} />对话
            </button>
          </article>
        ))}
      </div>
      {viewing && (
        <AgentDetailDialog
          name={viewing}
          onClose={() => setViewing(undefined)}
          onEdit={(agent) => {
            setViewing(undefined)
            setEditing(agent)
          }}
          onDelete={(agent) => {
            setViewing(undefined)
            setRemoving(agent)
          }}
        />
      )}
      {editing && (
        <AgentEditor
          {...(editing === 'new' ? {} : { current: editing })}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            void refresh()
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="删除智能体"
          message={`确定删除“${removing.displayName || removing.name}”吗？删除后它不能再被查询、更新或运行。`}
          confirmLabel="删除"
          onCancel={() => setRemoving(undefined)}
          onConfirm={async () => {
            await deleteAgent(removing.name)
            setRemoving(undefined)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

/** Official agents report `system`; unknown values are shown as returned. */
const VISIBILITY_LABELS: Readonly<Record<string, string>> = {
  user: '仅自己可见',
  tenant: '租户内可见',
  system: '平台官方',
}

function DetailRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{values.length > 0 ? values.map((value) => <span key={value} className="chip">{value}</span>) : <span className="muted">未配置</span>}</dd>
    </div>
  )
}

function AgentDetailDialog({ name, onClose, onEdit, onDelete }: {
  name: string
  onClose: () => void
  onEdit: (agent: AgentDetail) => void
  onDelete: (agent: AgentDetail) => void
}) {
  const [agent, setAgent] = useState<AgentDetail>()
  const [error, setError] = useState('')
  useEffect(() => {
    getAgent(name).then(setAgent).catch((reason: unknown) => setError(errorText(reason)))
  }, [name])
  return (
    <Dialog title={agent?.displayName || name} onClose={onClose} wide>
      <div className="dialog-body">
        {error && <ErrorBanner message={error} />}
        {!agent && !error && <div className="page-loading"><Spinner /></div>}
        {agent && (
          <>
            {agent.description && <p className="dialog-message">{agent.description}</p>}
            <dl className="detail-list">
              <DetailRow label="名称" values={[agent.name]} />
              <DetailRow label="可见范围" values={[VISIBILITY_LABELS[agent.visibility] ?? agent.visibility]} />
              <DetailRow label="技能" values={agent.skills} />
              <DetailRow label="MCP Server" values={agent.mcpServers} />
              <DetailRow label="Connector" values={agent.connectors} />
              <DetailRow label="知识库" values={agent.knowledgeBase ? [agent.knowledgeBase] : []} />
            </dl>
            {agent.systemPrompt && (
              <>
                <h3 className="section-title">系统提示词</h3>
                <pre className="prompt-preview">{agent.systemPrompt}</pre>
              </>
            )}
          </>
        )}
      </div>
      <div className="dialog-actions">
        {agent?.canDelete && <button type="button" className="button button-danger-quiet" onClick={() => onDelete(agent)}><Trash2 size={14} />删除</button>}
        <span className="spacer" />
        {agent?.canModify && <button type="button" className="button" onClick={() => onEdit(agent)}><Pencil size={14} />编辑</button>}
        <button type="button" className="button button-primary" onClick={() => navigate({ name: 'chat', agent: name })}>发起对话</button>
      </div>
    </Dialog>
  )
}

function AgentEditor({ current, onClose, onSaved }: { current?: AgentDetail; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(current?.name ?? '')
  const [displayName, setDisplayName] = useState(current?.displayName ?? '')
  const [description, setDescription] = useState(current?.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(current?.systemPrompt ?? '')
  const [visibility, setVisibility] = useState(current?.visibility ?? 'user')
  const [skills, setSkills] = useState<string[]>(current?.skills ?? [])
  const [mcpServers, setMcpServers] = useState((current?.mcpServers ?? []).join(', '))
  const [connectors, setConnectors] = useState((current?.connectors ?? []).join(', '))
  const [knowledgeBase, setKnowledgeBase] = useState(current?.knowledgeBase ?? '')
  const [catalog, setCatalog] = useState<SkillSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    listSkills().then(setCatalog).catch(() => undefined)
  }, [])

  const nameValid = /^[A-Za-z0-9_-]{1,128}$/.test(name)
  // Bound skills stay listed even if the catalog cannot show them, so saving never drops one by accident.
  const skillOptions = [...new Set([...catalog.map((skill) => skill.name), ...skills])]

  async function save(): Promise<void> {
    setBusy(true)
    setError('')
    const input: AgentInput = {
      displayName: displayName.trim(),
      description: description.trim(),
      systemPrompt,
      visibility,
      skills,
      mcpServers: splitNames(mcpServers),
      connectors: splitNames(connectors),
      knowledgeBase: knowledgeBase.trim(),
    }
    try {
      if (current) await updateAgent(current, input)
      else await createAgent(name, input)
      onSaved()
    } catch (reason) {
      setError(errorText(reason))
      setBusy(false)
    }
  }

  return (
    <Dialog title={current ? `编辑 ${current.displayName || current.name}` : '新建智能体'} onClose={onClose} wide>
      <div className="dialog-body form">
        <Field label="名称" hint="创建后不可修改。只能使用英文字母、数字、下划线和连字符。">
          <input className="input" value={name} disabled={Boolean(current)} maxLength={128} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="展示名称"><input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Field label="描述"><input className="input" value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="系统提示词">
          <textarea className="input textarea" rows={6} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
        </Field>
        <fieldset className="field">
          <legend className="field-label">技能</legend>
          <div className="checkbox-grid">
            {skillOptions.map((skill) => (
              <label key={skill} className="checkbox">
                <input
                  type="checkbox"
                  checked={skills.includes(skill)}
                  onChange={(event) => setSkills(event.target.checked ? [...skills, skill] : skills.filter((item) => item !== skill))}
                />
                {skill}
              </label>
            ))}
            {skillOptions.length === 0 && <span className="muted">暂无可用技能</span>}
          </div>
        </fieldset>
        <Field label="MCP Server" hint="填写已注册的名称，多个用逗号分隔。保存时会替换全部引用。新建智能体默认带有平台工具集 ada-official，删除它后智能体将不能使用平台工具。">
          <input className="input" value={mcpServers} onChange={(event) => setMcpServers(event.target.value)} />
        </Field>
        <Field label="Connector" hint="填写可用的 Connector 名称，多个用逗号分隔。">
          <input className="input" value={connectors} onChange={(event) => setConnectors(event.target.value)} />
        </Field>
        <Field label="知识库" hint="每个智能体最多绑定一个知识库。">
          <input className="input" value={knowledgeBase} onChange={(event) => setKnowledgeBase(event.target.value)} />
        </Field>
        <Field label="可见范围">
          <select className="input" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            {visibility === 'system' && <option value="system" disabled>平台官方</option>}
            <option value="user">仅自己可见</option>
            <option value="tenant">租户内可见</option>
          </select>
        </Field>
        {error && <ErrorBanner message={error} />}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button type="button" className="button button-primary" disabled={busy || !nameValid} onClick={() => void save()}>
          {busy && <Spinner size="sm" />}保存
        </button>
      </div>
    </Dialog>
  )
}
