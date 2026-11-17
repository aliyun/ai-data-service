// A local stand-in for the ADA OpenAPI, used by `npm run demo` and the tests. It verifies ACS3 signatures and follows
// the documented wire format, including `any` values sent as JSON text. Prompt text selects a scenario:
//   审批 -> tool approval   提问 -> question   断流 -> dropped stream   失败 -> failed turn   慢 -> long, cancellable turn
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { canonicalQuery, computeSignature, sha256Hex } from '../server/acs3.ts'

export const MOCK_ACCESS_KEY_ID = 'mock-access-key-id'
export const MOCK_ACCESS_KEY_SECRET = 'mock-access-key-secret'

type Json = Record<string, unknown>

interface LoggedEvent {
  method: string
  params: Json
  offset: number
  promptId: string
}

interface Turn {
  promptId: string
  events: LoggedEvent[]
  stopReason?: string
  error?: Json
  pending?: Json
  waiting?: (reply: Json) => void
  cancelled: boolean
}

interface Session {
  sessionId: string
  agentName: string
  title: string
  createdAt: number
  updatedAt: number
  modelId: string
  thinkingLevel: string
  epoch: string
  offset: number
  history: { method: string; params: Json }[]
  turn?: Turn
  lastTurn?: Turn
  subscribers: Set<(event: LoggedEvent | { end: true; turn: Turn }) => void>
}

const THINKING_LEVELS = ['off', 'low', 'medium', 'high']
const MODELS = [
  { Id: 'text-model-standard', Object: 'model', Created: 1793491200, OwnedBy: 'mock', DisplayName: '标准文本模型', Capabilities: { InputModalities: ['text'] }, ThinkingLevels: THINKING_LEVELS, ThinkingLevel: 'off' },
  { Id: 'text-model-pro', Object: 'model', Created: 1793491300, OwnedBy: 'mock', DisplayName: '高级文本模型', Capabilities: { InputModalities: ['text'] }, ThinkingLevels: THINKING_LEVELS, ThinkingLevel: 'medium' },
]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Sample answer for ordinary prompts. All figures are made up. */
const DEMO_REPORT = [
  '## 最近 30 天订单概览',
  '',
  '订单量整体平稳增长，周末有明显高峰；转化率比上一周期提升 0.4 个百分点。',
  '',
  '| 指标 | 本期 | 环比 |',
  '| --- | --- | --- |',
  '| 订单量 | 12,408 | +6.2% |',
  '| 成交额 | ¥1,862,300 | +8.9% |',
  '| 转化率 | 3.6% | +0.4pp |',
  '',
  '**主要发现**',
  '',
  '1. 周六、周日的订单量比工作日平均高 27%。',
  '2. 新客贡献了 41% 的成交额，主要来自会员拉新渠道。',
  '3. 退款率稳定在 1.8%，没有异常波动。',
  '',
  '```sql',
  "SELECT date_trunc('day', created_at) AS day, count(*) AS orders",
  'FROM orders',
  "WHERE created_at >= current_date - interval '30 days'",
  'GROUP BY 1 ORDER BY 1;',
  '```',
  '',
].join('\n')

class ApiFailure extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function requestId(): string {
  return randomUUID().toUpperCase()
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export interface MockOptions {
  /** Delay between streamed chunks. */
  chunkDelayMs?: number
}

export function createMockAda(options: MockOptions = {}): Server {
  const chunkDelay = options.chunkDelayMs ?? 120
  const sessions = new Map<string, Session>()
  const clientTokens = new Map<string, string>()
  const agents = new Map<string, Json>([
    ['ada-assistant', {
      AgentId: 'agent_mock_official', Name: 'ada-assistant', DisplayName: 'Ada 助手', Description: '通用的数据智能助手，可以回答问题并分析数据。',
      SystemPrompt: '你是一名数据智能助手。', Tools: [], Skills: [{ name: 'data-analysis' }], KnowledgeBases: [], Visibility: 'tenant', Status: 'published',
      AgentVersion: 1, CreatedAt: 1788332400000, UpdatedAt: 1788332400000, CanModify: false, CanDelete: false, Official: true,
    }],
    ['data-analyst-agent', {
      AgentId: 'agent_mock_analyst', Name: 'data-analyst-agent', DisplayName: '数据分析专家', Description: '理解业务问题，查询数据并给出带图表的分析结论。',
      SystemPrompt: '你是一名数据分析专家。', Tools: [], Skills: [{ name: 'data-analysis' }, { name: 'sql-optimizer' }], KnowledgeBases: [], Visibility: 'tenant', Status: 'published',
      AgentVersion: 1, CreatedAt: 1788332400000, UpdatedAt: 1788332400000, CanModify: false, CanDelete: false, Official: true,
    }],
    ['data-governance-agent', {
      AgentId: 'agent_mock_governance', Name: 'data-governance-agent', DisplayName: '数据治理专家', Description: '盘点数据资产，检查数据质量与权限风险。',
      SystemPrompt: '你是一名数据治理专家。', Tools: [], Skills: [], KnowledgeBases: [], Visibility: 'tenant', Status: 'published',
      AgentVersion: 1, CreatedAt: 1788332400000, UpdatedAt: 1788332400000, CanModify: false, CanDelete: false, Official: true,
    }],
    ['code-review-agent', {
      AgentId: 'agent_mock_custom', Name: 'code-review-agent', DisplayName: 'CR 代码评审', Description: '分析代码变更并生成评审意见。',
      SystemPrompt: '请检查代码变更的正确性、安全性和可维护性。', Tools: [{ mcpServerName: 'code-repository-mcp' }], Skills: [{ name: 'code-review' }], KnowledgeBases: [], Visibility: 'user', Status: 'draft',
      AgentVersion: 2, CreatedAt: 1788332400000, UpdatedAt: 1788332700000, CanModify: true, CanDelete: true, Official: false,
    }],
    ['daily-report-agent', {
      AgentId: 'agent_mock_report', Name: 'daily-report-agent', DisplayName: '经营日报助手', Description: '每天汇总核心经营指标，生成可直接发送的日报。',
      SystemPrompt: '你负责生成经营日报。', Tools: [], Skills: [{ name: 'report-writer' }], KnowledgeBases: [], Visibility: 'user', Status: 'published',
      AgentVersion: 3, CreatedAt: 1788332400000, UpdatedAt: 1788332900000, CanModify: true, CanDelete: true, Official: false,
    }],
  ])
  const skills = new Map<string, Json>([
    ['data-analysis', {
      SkillId: 'skill_mock_official', Name: 'data-analysis', Description: '官方数据分析能力。', Visibility: 'tenant', Status: 'PUBLISHED',
      CreatedAt: 1760000000000, UpdatedAt: 1760000000000, Metadata: { skillMd: '# 数据分析\n\n分析表格并给出结论。' }, CanModify: false, CanDelete: false, Official: true,
    }],
    ['code-review', {
      SkillId: 'skill_mock_custom', Name: 'code-review', Description: '检查代码质量、安全风险和编码规范。', Visibility: 'user', Status: 'PUBLISHED',
      CreatedAt: 1760000000000, UpdatedAt: 1760000300000, Metadata: { skillMd: '# Code Review\n\n检查代码质量与安全风险。' }, CanModify: true, CanDelete: true, Official: false,
    }],
    ['sql-optimizer', {
      SkillId: 'skill_mock_sql', Name: 'sql-optimizer', Description: '分析慢 SQL 的执行计划，给出索引和改写建议。', Visibility: 'tenant', Status: 'PUBLISHED',
      CreatedAt: 1760000000000, UpdatedAt: 1760000000000, Metadata: { skillMd: '# SQL 优化\n\n读取执行计划，定位全表扫描和数据倾斜。' }, CanModify: false, CanDelete: false, Official: true,
    }],
    ['report-writer', {
      SkillId: 'skill_mock_report', Name: 'report-writer', Description: '把指标和结论整理成结构清晰的经营报告。', Visibility: 'user', Status: 'PUBLISHED',
      CreatedAt: 1760000000000, UpdatedAt: 1760000400000, Metadata: { skillMd: '# 报告撰写\n\n先写结论，再给数据和建议。' }, CanModify: true, CanDelete: true, Official: false,
    }],
  ])

  function getSession(params: Json): Session {
    const session = sessions.get(text(params.sessionId))
    if (!session) throw new ApiFailure(404, 'AgentSession.SessionNotFound', 'The specified agent session does not exist.')
    return session
  }

  function rpcParams(input: Json): Json {
    const params = parseJson(text(input.Params))
    if (!params || typeof params !== 'object') throw new ApiFailure(400, 'InvalidParameter', 'Params must be a JSON object.')
    return params as Json
  }

  function rpcResponse(input: Json, result: Json, extra: Json = { Success: true }): Json {
    return { RequestId: requestId(), ...extra, JsonRpcResponse: { jsonrpc: '2.0', id: input.Id, result } }
  }

  function emit(session: Session, turn: Turn, method: string, params: Json): void {
    session.offset += 1
    const event: LoggedEvent = { method, params, offset: session.offset, promptId: turn.promptId }
    turn.events.push(event)
    session.updatedAt = Date.now()
    for (const subscriber of session.subscribers) subscriber(event)
  }

  function update(session: Session, turn: Turn, payload: Json): void {
    emit(session, turn, 'session/update', { sessionId: session.sessionId, update: payload })
  }

  async function streamText(session: Session, turn: Turn, type: string, body: string): Promise<void> {
    for (const chunk of body.match(/[\s\S]{1,12}/g) ?? []) {
      if (turn.cancelled) return
      update(session, turn, { sessionUpdate: type, content: { type: 'text', text: chunk } })
      await sleep(chunkDelay)
    }
  }

  function askUser(session: Session, turn: Turn, data: Json): Promise<Json> {
    turn.pending = data
    emit(session, turn, '_qwen/notify', { kind: 'permission_request', data })
    return new Promise((resolve) => {
      turn.waiting = (reply) => {
        delete turn.pending
        delete turn.waiting
        emit(session, turn, '_qwen/notify', {
          sessionId: session.sessionId,
          update: { sessionUpdate: '_qwen.permission_resolved', requestId: data.requestId },
        })
        resolve(reply)
      }
    })
  }

  async function runScenario(session: Session, turn: Turn, prompt: string): Promise<void> {
    const id = session.sessionId
    if (prompt.includes('失败')) {
      await streamText(session, turn, 'agent_message_chunk', '正在处理……')
      turn.error = { code: -32603, errorCode: 'CLI_TURN_FAILED', message: '模拟的回合执行失败。' }
      return
    }
    await streamText(session, turn, 'agent_thought_chunk', '先确认用户的问题，再决定需要哪些步骤。')
    if (prompt.includes('审批')) {
      update(session, turn, { sessionUpdate: 'tool_call', toolCallId: 'tool-approval', title: '删除临时表', kind: 'execute', status: 'pending', rawInput: { sql: 'DROP TABLE tmp_orders' } })
      const reply = await askUser(session, turn, {
        sessionId: id,
        requestId: `permission-${randomUUID()}`,
        options: [
          { optionId: 'allow_once', name: '允许本次操作', kind: 'allow_once' },
          { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
        ],
        toolCall: { title: '删除临时表 tmp_orders', rawInput: { sql: 'DROP TABLE tmp_orders' } },
      })
      const outcome = reply.outcome as Json
      if (outcome.outcome === 'cancelled') {
        update(session, turn, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-approval', status: 'failed' })
        turn.stopReason = 'cancelled'
        return
      }
      const allowed = outcome.optionId === 'allow_once'
      update(session, turn, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-approval',
        status: allowed ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: allowed ? '已删除 1 张表' : '操作被拒绝' } }],
      })
      await streamText(session, turn, 'agent_message_chunk', allowed ? '临时表已删除。' : '操作已被拒绝，我没有修改任何数据。')
      turn.stopReason = 'end_turn'
      return
    }
    if (prompt.includes('提问')) {
      const reply = await askUser(session, turn, {
        sessionId: id,
        requestId: `question-${randomUUID()}`,
        options: [{ optionId: 'allow_once', name: '提交回答', kind: 'allow_once' }],
        toolCall: {
          title: '确认分析范围',
          _meta: { qwenInteractionKind: 'user_question', qwenAnswerKeys: ['0', '1'] },
          rawInput: {
            questions: [
              { question: '需要分析哪个时间范围？', header: '时间范围', options: [{ label: '最近 7 天', description: '适合看短期波动' }, { label: '最近 30 天', description: '适合看整体趋势' }] },
              { question: '要关注哪些指标？', header: '指标', multiSelect: true, options: [{ label: '订单量' }, { label: '销售额' }, { label: '客单价' }] },
            ],
          },
        },
      })
      const answers = (reply.answers ?? {}) as Json
      await streamText(session, turn, 'agent_message_chunk', `收到。时间范围：${text(answers['0'])}；指标：${text(answers['1'])}。`)
      turn.stopReason = 'end_turn'
      return
    }
    update(session, turn, { sessionUpdate: 'tool_call', toolCallId: 'tool-query', title: '查询订单表 orders', kind: 'search', status: 'in_progress', rawInput: { table: 'orders', range: 'last_30_days' } })
    await sleep(chunkDelay * 3)
    update(session, turn, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-query',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '返回 30 行' } }],
    })
    update(session, turn, { sessionUpdate: 'tool_call', toolCallId: 'tool-metrics', title: '汇总核心指标', kind: 'other', status: 'in_progress', rawInput: { metrics: ['orders', 'gmv', 'conversion'] } })
    await sleep(chunkDelay * 2)
    update(session, turn, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-metrics', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '已汇总 3 个指标' } }] })
    if (prompt.includes('慢')) {
      await streamText(session, turn, 'agent_message_chunk', '这是一段很长的回复，用来测试停止功能。'.repeat(40))
    } else {
      await streamText(session, turn, 'agent_message_chunk', DEMO_REPORT)
    }
    turn.stopReason = turn.cancelled ? 'cancelled' : 'end_turn'
  }

  function finishTurn(session: Session, turn: Turn): void {
    if (turn.cancelled) {
      delete turn.error
      turn.stopReason = 'cancelled'
    }
    for (const event of turn.events) {
      if (event.method === 'session/update') session.history.push({ method: event.method, params: event.params })
    }
    delete session.turn
    session.lastTurn = turn
    for (const subscriber of session.subscribers) subscriber({ end: true, turn })
  }

  function startTurn(session: Session, prompt: string): Turn {
    if (session.turn?.pending) throw new ApiFailure(409, 'AgentSession.PermissionPending', 'A tool call in the agent session is waiting for confirmation.')
    if (session.turn) throw new ApiFailure(409, 'AgentSession.SessionBusy', 'A turn is already running in the agent session.')
    const turn: Turn = { promptId: `prompt-${randomUUID()}`, events: [], cancelled: false }
    session.turn = turn
    session.history.push({ method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } } } })
    if (!session.title) session.title = prompt.slice(0, 24)
    session.updatedAt = Date.now()
    // Deferred so that the caller can subscribe before the first event is emitted.
    void sleep(0)
      .then(() => runScenario(session, turn, prompt))
      .catch(() => {
        turn.error = { code: -32603, errorCode: 'CLI_TURN_FAILED', message: 'Mock scenario failed.' }
      })
      .finally(() => finishTurn(session, turn))
    return turn
  }

  // ---- SSE ----

  function writeFrame(res: ServerResponse, frame: Json): void {
    res.write(`data: ${JSON.stringify(frame)}\r\n\r\n`)
  }

  function eventFrame(event: { method: string; params: Json }, meta?: Json): Json {
    const params = meta ? { ...event.params, _meta: meta } : event.params
    // Interaction payloads are `any` values and arrive as JSON text, which clients have to decode.
    return { Jsonrpc: '2.0', Method: event.method, Params: event.method === '_qwen/notify' ? JSON.stringify(params) : params }
  }

  function loggedFrame(session: Session, event: LoggedEvent): Json {
    return eventFrame(event, { offset: event.offset, eventEpoch: session.epoch, promptId: event.promptId })
  }

  function terminalFrame(id: unknown, turn: Turn): Json {
    if (turn.error) return { Jsonrpc: '2.0', Id: id, Error: turn.error }
    return { Jsonrpc: '2.0', Id: id, Result: { stopReason: turn.stopReason ?? 'end_turn' } }
  }

  function openSse(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-acs-request-id': requestId() })
    res.write(': connected\r\n\r\n')
  }

  function followTurn(session: Session, res: ServerResponse, id: unknown, dropAfter?: number): void {
    let sent = 0
    const heartbeat = setInterval(() => {
      writeFrame(res, { Jsonrpc: '2.0', Method: 'session/update', Params: { sessionId: session.sessionId, _meta: { waitForResponse: true } } })
    }, 5000)
    const subscriber = (event: LoggedEvent | { end: true; turn: Turn }): void => {
      if ('end' in event) {
        writeFrame(res, terminalFrame(id, event.turn))
        cleanup()
        res.end()
        return
      }
      writeFrame(res, loggedFrame(session, event))
      sent += 1
      if (dropAfter !== undefined && sent >= dropAfter) {
        cleanup()
        res.destroy()
      }
    }
    const cleanup = (): void => {
      clearInterval(heartbeat)
      session.subscribers.delete(subscriber)
    }
    session.subscribers.add(subscriber)
    res.once('close', cleanup)
  }

  function handlePrompt(input: Json, res: ServerResponse): void {
    const params = rpcParams(input)
    const session = getSession(params)
    const blocks = Array.isArray(params.prompt) ? (params.prompt as Json[]) : []
    const prompt = blocks.map((block) => text(block.text)).join('')
    if (!prompt.trim()) throw new ApiFailure(400, 'InvalidParameter', 'Params.prompt must contain text.')
    startTurn(session, prompt)
    openSse(res)
    followTurn(session, res, input.Id, prompt.includes('断流') ? 3 : undefined)
  }

  function handleLoad(input: Json, res: ServerResponse): void {
    const params = rpcParams(input)
    const session = getSession(params)
    const meta = (params._meta ?? {}) as Json
    if (meta.eventEpoch !== undefined && meta.eventEpoch !== session.epoch) {
      throw new ApiFailure(400, 'InvalidParameter', 'Meta.EventEpoch does not match. Reload the session.')
    }
    const begin = typeof meta.beginLogOffset === 'number' ? meta.beginLogOffset : undefined
    openSse(res)
    // Completed history is replayed without cursors, as documented.
    for (const event of session.history) writeFrame(res, eventFrame(event))
    const turn = session.turn
    if (turn) {
      for (const event of turn.events) {
        if (begin === undefined || event.offset > begin) writeFrame(res, loggedFrame(session, event))
      }
      if (turn.pending) writeFrame(res, eventFrame({ method: '_qwen/notify', params: { kind: 'permission_request', data: turn.pending } }))
      followTurn(session, res, input.Id)
      return
    }
    const last = session.lastTurn
    if (begin !== undefined && last && last.promptId === meta.promptId) {
      for (const event of last.events) {
        if (event.offset > begin) writeFrame(res, loggedFrame(session, event))
      }
      writeFrame(res, terminalFrame(input.Id, last))
    } else {
      writeFrame(res, { Jsonrpc: '2.0', Id: input.Id, Result: { stopReason: 'end_turn' } })
    }
    res.end()
  }

  // ---- Actions ----

  function listPage(items: Json[], input: Json, key: string): Json {
    const total = items.length
    const query = text(input.Q).toLowerCase()
    const filtered = items.filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query))
    return { [key]: filtered, Total: total, PageNumber: 1, PageSize: 20, MaxResults: 20, NextToken: '', RequestId: requestId() }
  }

  function agentSummary(agent: Json): Json {
    return {
      agentId: agent.AgentId, name: agent.Name, official: agent.Official, displayName: agent.DisplayName, description: agent.Description,
      tools: agent.Tools, skills: agent.Skills,
    }
  }

  function skillSummary(skill: Json): Json {
    return {
      skillId: skill.SkillId, name: skill.Name, official: skill.Official, description: skill.Description, visibility: skill.Visibility,
      status: skill.Status, createdAt: skill.CreatedAt, canModify: skill.CanModify, canDelete: skill.CanDelete,
    }
  }

  function handleAction(action: string, input: Json): Json {
    switch (action) {
      case 'ListModels':
        return { Models: MODELS, Total: MODELS.length, MaxResults: 20, NextToken: '', RequestId: requestId() }
      case 'ListAgents': {
        const page = listPage([...agents.values()], input, 'Agents')
        // Some items arrive as JSON text, as in the documentation's sample response.
        page.Agents = (page.Agents as Json[]).map((agent) => JSON.stringify(agentSummary(agent)))
        return page
      }
      case 'GetAgent': {
        const agent = agents.get(text(input.Name))
        if (!agent) throw new ApiFailure(404, 'Agent.NotFound', 'The specified Agent does not exist.')
        // Like the live service, GetAgent lists skills and knowledge bases by plain name, and official agents report `system`.
        const plainNames = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => text((item as Json).name)) : [])
        return {
          ...agent,
          ...(agent.Official ? { Visibility: 'system' } : {}),
          Tools: JSON.stringify(agent.Tools),
          Skills: plainNames(agent.Skills),
          KnowledgeBases: plainNames(agent.KnowledgeBases),
          RequestId: requestId(),
        }
      }
      case 'CreateAgent': {
        const name = text(input.Name)
        if (!/^[\w-]{1,128}$/.test(name)) throw new ApiFailure(400, 'InvalidParameter', 'The specified parameter is invalid.')
        if (agents.has(name)) throw new ApiFailure(409, 'Agent.AlreadyExists', 'An Agent with the specified name already exists.')
        const now = Date.now()
        agents.set(name, {
          AgentId: `agent_${randomBytes(8).toString('hex')}`, Name: name, DisplayName: text(input.DisplayName), Description: text(input.Description), SystemPrompt: text(input.SystemPrompt),
          Tools: parseJson(text(input.Tools) || '[]'), Skills: parseJson(text(input.Skills) || '[]'), KnowledgeBases: parseJson(text(input.KnowledgeBases) || '[]'),
          Visibility: text(input.Visibility) || 'user', Status: 'draft', AgentVersion: 1, CreatedAt: now, UpdatedAt: now, CanModify: true, CanDelete: true, Official: false,
        })
        return { AgentId: agents.get(name)?.AgentId, Name: name, UpdatedAt: now, Success: true, RequestId: requestId() }
      }
      case 'UpdateAgent': {
        const agent = agents.get(text(input.Name))
        if (!agent) throw new ApiFailure(404, 'Agent.NotFound', 'The specified Agent does not exist.')
        if (input.ExpectedVersion !== undefined && Number(input.ExpectedVersion) !== agent.AgentVersion) {
          throw new ApiFailure(409, 'Conflict.AgentChanged', 'The Agent was changed by another request.')
        }
        for (const field of ['DisplayName', 'Description', 'SystemPrompt', 'Visibility']) {
          if (input[field] !== undefined) agent[field] = input[field]
        }
        for (const field of ['Tools', 'Skills', 'KnowledgeBases']) {
          if (input[field] !== undefined) agent[field] = parseJson(text(input[field]))
        }
        agent.AgentVersion = Number(agent.AgentVersion) + 1
        agent.UpdatedAt = Date.now()
        return { AgentId: agent.AgentId, Name: agent.Name, UpdatedAt: agent.UpdatedAt, Success: true, RequestId: requestId() }
      }
      case 'DeleteAgent':
        if (!agents.delete(text(input.Name))) throw new ApiFailure(404, 'Agent.NotFound', 'The specified Agent does not exist.')
        return { Success: true, RequestId: requestId() }
      case 'ListSkills': {
        const page = listPage([...skills.values()], input, 'Skills')
        page.Skills = (page.Skills as Json[]).map((skill) => JSON.stringify(skillSummary(skill)))
        return page
      }
      case 'GetSkill': {
        const skill = skills.get(text(input.Name))
        if (!skill) throw new ApiFailure(404, 'Skill.NotFound', 'The specified Skill does not exist.')
        return { ...skill, Metadata: JSON.stringify(skill.Metadata), RequestId: requestId() }
      }
      case 'CreateSkill': {
        const name = text(input.Name)
        if (!/^[\w-]{1,64}$/.test(name)) throw new ApiFailure(400, 'InvalidParameter', 'The specified parameter is invalid.')
        if (skills.has(name)) throw new ApiFailure(409, 'Skill.AlreadyExists', 'A Skill with the specified name already exists.')
        const metadata = parseJson(text(input.Metadata)) as Json
        const sources = ['skillMd', 'transitId', 'bundleUrl'].filter((key) => metadata?.[key])
        if (sources.length !== 1) throw new ApiFailure(400, 'InvalidParameter', 'Metadata must contain exactly one content source.')
        const now = Date.now()
        skills.set(name, {
          SkillId: `skill_${randomBytes(8).toString('hex')}`, Name: name, Description: text(input.Description), Visibility: text(input.Visibility) || 'user', Status: 'PUBLISHED',
          CreatedAt: now, UpdatedAt: now, Metadata: metadata.bundleUrl ? { artifactId: 'artifact_mock' } : metadata, CanModify: true, CanDelete: true, Official: false,
        })
        return { SkillId: skills.get(name)?.SkillId, Name: name, UpdatedAt: now, Success: true, RequestId: requestId() }
      }
      case 'UpdateSkill': {
        const skill = skills.get(text(input.Name))
        if (!skill) throw new ApiFailure(404, 'Skill.NotFound', 'The specified Skill does not exist.')
        if (input.Description !== undefined) skill.Description = input.Description
        if (input.Visibility !== undefined) skill.Visibility = input.Visibility
        if (input.Metadata !== undefined) skill.Metadata = parseJson(text(input.Metadata))
        skill.UpdatedAt = Date.now()
        return { SkillId: skill.SkillId, Name: skill.Name, UpdatedAt: skill.UpdatedAt, Success: true, RequestId: requestId() }
      }
      case 'DeleteSkill':
        if (!skills.delete(text(input.Name))) throw new ApiFailure(404, 'Skill.NotFound', 'The specified Skill does not exist.')
        return { Success: true, RequestId: requestId() }
      case 'CreateAgentSession': {
        const params = rpcParams(input)
        const meta = (params._meta ?? {}) as Json
        const agentName = text((meta.agent as Json | undefined)?.agentName)
        if (!agents.has(agentName)) throw new ApiFailure(400, 'InvalidParameter', 'The specified agent is not available.')
        const token = text(params.clientToken)
        const existing = token ? clientTokens.get(token) : undefined
        if (existing) return rpcResponse(input, { sessionId: existing, attached: true })
        const sessionId = randomBytes(16).toString('hex')
        const now = Date.now()
        sessions.set(sessionId, {
          sessionId, agentName, title: '', createdAt: now, updatedAt: now, modelId: MODELS[0]!.Id, thinkingLevel: 'off', epoch: `epoch-${randomUUID()}`, offset: 0, history: [], subscribers: new Set(),
        })
        if (token) clientTokens.set(token, sessionId)
        return rpcResponse(input, { sessionId, attached: false })
      }
      case 'ListAgentSessions': {
        const params = rpcParams(input)
        const list = [...sessions.values()]
          .filter((session) => !params.AgentName || session.agentName === params.AgentName)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((session) => ({ sessionId: session.sessionId, title: session.title, agentName: session.agentName, createdAt: session.createdAt, updatedAt: session.updatedAt }))
        return { RequestId: requestId(), JsonRpcResponse: { Jsonrpc: '2.0', Id: input.Id, Result: { MaxResults: 50, NextToken: '', SessionList: JSON.stringify(list) } } }
      }
      case 'GetAgentSession': {
        const session = getSession(rpcParams(input))
        return rpcResponse(input, { sessionId: session.sessionId, title: session.title, displayName: '', agentName: session.agentName, createdAtMs: session.createdAt, lastMessageAtMs: session.updatedAt }, {})
      }
      case 'DeleteAgentSession': {
        const session = getSession(rpcParams(input))
        if (session.turn) throw new ApiFailure(409, 'AgentSession.SessionBusy', 'A turn is already running in the agent session.')
        sessions.delete(session.sessionId)
        return rpcResponse(input, { sessionId: session.sessionId })
      }
      case 'ReplyAgentSession': {
        const params = rpcParams(input)
        const session = getSession(params)
        const turn = session.turn
        if (!turn?.waiting || (turn.pending as Json | undefined)?.requestId !== params.permissionRequestId) {
          return rpcResponse(input, { accepted: false })
        }
        turn.waiting(params)
        return rpcResponse(input, { accepted: true })
      }
      case 'CancelAgentSession': {
        const params = rpcParams(input)
        const session = getSession(params)
        const turn = session.turn
        if (turn) {
          turn.cancelled = true
          turn.waiting?.({ outcome: { outcome: 'cancelled' } })
        }
        return rpcResponse(input, { sessionId: session.sessionId, removed: Boolean(turn) })
      }
      case 'GetAgentSessionModel': {
        const session = getSession(rpcParams(input))
        return rpcResponse(input, { modelId: session.modelId, thinkingLevel: session.thinkingLevel, thinkingLevels: THINKING_LEVELS }, {})
      }
      case 'SetAgentSessionModel': {
        const params = rpcParams(input)
        const session = getSession(params)
        if (session.turn) throw new ApiFailure(409, 'AgentSession.SessionBusy', 'A turn is already running in the agent session.')
        if (!MODELS.some((model) => model.Id === params.modelId)) throw new ApiFailure(400, 'InvalidParameter', 'The session does not support this model.')
        session.modelId = text(params.modelId)
        if (typeof params.thinkingLevel === 'string') session.thinkingLevel = params.thinkingLevel
        return rpcResponse(input, { modelId: session.modelId, thinkingLevel: session.thinkingLevel, thinkingLevels: THINKING_LEVELS })
      }
      default:
        throw new ApiFailure(404, 'InvalidAction.NotFound', `Specified api is not found: ${action}`)
    }
  }

  // ---- Transport ----

  function verifySignature(req: IncomingMessage, query: Record<string, string>, body: string): void {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[name] = value
    }
    const match = /^ACS3-HMAC-SHA256 Credential=([^,]+),SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? '')
    if (!match) throw new ApiFailure(400, 'UnsupportedSignatureVersion', 'Streaming and this mock require ACS3-HMAC-SHA256.')
    const [, keyId, signedHeaders, signature] = match as unknown as [string, string, string, string]
    if (keyId !== MOCK_ACCESS_KEY_ID) throw new ApiFailure(401, 'InvalidAccessKeyId.NotFound', 'Specified access key is not found.')
    if (headers['x-acs-content-sha256'] !== sha256Hex(body)) throw new ApiFailure(400, 'ContentSha256Mismatch', 'The payload hash does not match.')
    const expected = computeSignature({
      method: req.method ?? 'POST',
      query: canonicalQuery(query),
      headers,
      signedHeaders: signedHeaders.split(';'),
      payloadHash: sha256Hex(body),
      secret: MOCK_ACCESS_KEY_SECRET,
    })
    if (expected !== signature) throw new ApiFailure(403, 'SignatureDoesNotMatch', 'The request signature does not match.')
    if (headers['x-acs-version'] !== '2026-07-01') throw new ApiFailure(400, 'InvalidVersion', 'Specified version is not valid.')
  }

  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const url = new URL(req.url ?? '/', 'http://mock')
        const query = Object.fromEntries(url.searchParams)
        const body = Buffer.concat(chunks).toString('utf8')
        verifySignature(req, query, body)
        const input: Json = { ...query, ...Object.fromEntries(new URLSearchParams(body)) }
        const action = String(req.headers['x-acs-action'])
        if (action === 'PromptAgentSession') return handlePrompt(input, res)
        if (action === 'LoadAgentSession') return handleLoad(input, res)
        const result = handleAction(action, input)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        const failure = error instanceof ApiFailure ? error : new ApiFailure(500, 'InternalError', 'Internal server error.')
        if (res.headersSent) {
          res.destroy()
          return
        }
        const id = requestId()
        res.writeHead(failure.status, { 'content-type': 'application/json', 'x-acs-request-id': id })
        res.end(JSON.stringify({ Code: failure.code, Message: failure.message, RequestId: id }))
      }
    })
  })
}
