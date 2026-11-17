// Typed ADA operations used by the views.
import { ApiError, callAda, rpcBody } from './api.ts'
import { asArray, asObject, asObjects, asOptionalNumber, asText, pageToken, rpcResult, type Json } from './wire.ts'

// ListSkills returns at most 35 items per page whatever MaxResults asks for, so a small cap would silently hide part
// of the catalog. This only guards against a paging token that never ends.
const MAX_PAGES = 100

async function listAll(action: string, key: string, params: object = {}): Promise<Json[]> {
  const items: Json[] = []
  let token: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await callAda(action, { ...params, MaxResults: 100, ...(token ? { NextToken: token } : {}) })
    items.push(...asObjects(response[key]))
    token = pageToken(response.NextToken)
    if (!token) break
  }
  return items
}

function names(value: unknown, field: string): string[] {
  return asObjects(value).map((item) => asText(item[field])).filter(Boolean)
}

/** Skill and knowledge base references. GetAgent returns them as plain names, requests use `{ name }` objects. */
export function referenceNames(value: unknown): string[] {
  return asArray(value)
    .map((item) => {
      if (typeof item === 'string' && !item.trimStart().startsWith('{')) return item
      return asText(asObject(item).name)
    })
    .filter(Boolean)
}

// ---- Agents ----

export interface AgentSummary {
  name: string
  displayName: string
  description: string
  official: boolean
}

export interface AgentDetail extends AgentSummary {
  systemPrompt: string
  mcpServers: string[]
  connectors: string[]
  skills: string[]
  knowledgeBase: string
  visibility: string
  version?: number
  canModify: boolean
  canDelete: boolean
  rawTools: unknown[]
}

export async function listAgents(): Promise<AgentSummary[]> {
  const agents = await listAll('ListAgents', 'Agents')
  return agents
    .map((agent) => ({
      name: asText(agent.name),
      displayName: asText(agent.displayName),
      description: asText(agent.description),
      official: agent.official === true,
    }))
    .filter((agent) => agent.name)
}

export async function getAgent(name: string): Promise<AgentDetail> {
  const agent = await callAda('GetAgent', { Name: name })
  const version = asOptionalNumber(agent.AgentVersion)
  return {
    name: asText(agent.Name) || name,
    displayName: asText(agent.DisplayName),
    description: asText(agent.Description),
    official: agent.Official === true,
    systemPrompt: asText(agent.SystemPrompt),
    mcpServers: names(agent.Tools, 'mcpServerName'),
    connectors: names(agent.Tools, 'connectorName'),
    skills: referenceNames(agent.Skills),
    knowledgeBase: referenceNames(agent.KnowledgeBases)[0] ?? '',
    visibility: asText(agent.Visibility) || 'user',
    canModify: agent.CanModify === true,
    canDelete: agent.CanDelete === true,
    rawTools: asArray(agent.Tools),
    ...(version !== undefined ? { version } : {}),
  }
}

export interface AgentInput {
  displayName: string
  description: string
  systemPrompt: string
  mcpServers: string[]
  connectors: string[]
  skills: string[]
  knowledgeBase: string
  visibility: string
}

function toolsOf(input: Pick<AgentInput, 'mcpServers' | 'connectors'>): Json[] {
  return [
    ...input.mcpServers.map((mcpServerName) => ({ mcpServerName })),
    ...input.connectors.map((connectorName) => ({ connectorName })),
  ]
}

export async function createAgent(name: string, input: AgentInput): Promise<void> {
  await callAda('CreateAgent', {
    Name: name,
    DisplayName: input.displayName,
    Description: input.description,
    SystemPrompt: input.systemPrompt,
    Tools: toolsOf(input),
    Skills: input.skills.map((skill) => ({ name: skill })),
    KnowledgeBases: input.knowledgeBase ? [{ name: input.knowledgeBase }] : [],
    Visibility: input.visibility,
  })
}

/** Tools replaces every reference when sent, so references that stay keep their saved fields, such as `items`. */
export function toolsForUpdate(rawTools: readonly unknown[], input: Pick<AgentInput, 'mcpServers' | 'connectors'>): Json[] {
  const saved = rawTools.map(asObject)
  return toolsOf(input).map((tool) => {
    const field = 'mcpServerName' in tool ? 'mcpServerName' : 'connectorName'
    return saved.find((entry) => entry[field] === tool[field]) ?? tool
  })
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Only changed fields are sent, so an edit to one field cannot disturb the others. */
export async function updateAgent(current: AgentDetail, input: AgentInput): Promise<void> {
  const toolsChanged = !sameList(current.mcpServers, input.mcpServers) || !sameList(current.connectors, input.connectors)
  await callAda('UpdateAgent', {
    Name: current.name,
    ...(current.version !== undefined ? { ExpectedVersion: current.version } : {}),
    ...(input.displayName !== current.displayName ? { DisplayName: input.displayName } : {}),
    ...(input.description !== current.description ? { Description: input.description } : {}),
    ...(input.systemPrompt !== current.systemPrompt ? { SystemPrompt: input.systemPrompt } : {}),
    ...(input.visibility !== current.visibility ? { Visibility: input.visibility } : {}),
    ...(toolsChanged ? { Tools: toolsForUpdate(current.rawTools, input) } : {}),
    ...(!sameList(current.skills, input.skills) ? { Skills: input.skills.map((name) => ({ name })) } : {}),
    ...(input.knowledgeBase !== current.knowledgeBase
      ? { KnowledgeBases: input.knowledgeBase ? [{ name: input.knowledgeBase }] : [] }
      : {}),
  })
}

export async function deleteAgent(name: string): Promise<void> {
  await callAda('DeleteAgent', { Name: name })
}

// ---- Skills ----

export interface SkillSummary {
  name: string
  description: string
  official: boolean
  visibility: string
  status: string
  canModify: boolean
  canDelete: boolean
}

export interface SkillDetail extends SkillSummary {
  skillMd: string
  downloadUrl: string
  /** Saved Metadata fields other than the content source, such as `iconUrl`. */
  extraMetadata: Json
}

const SKILL_CONTENT_FIELDS: readonly string[] = ['skillMd', 'transitId', 'bundleUrl', 'artifactId']

export function skillExtraMetadata(metadata: Json): Json {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !SKILL_CONTENT_FIELDS.includes(key)))
}

export async function listSkills(): Promise<SkillSummary[]> {
  const skills = await listAll('ListSkills', 'Skills')
  return skills
    .map((skill) => ({
      name: asText(skill.name),
      description: asText(skill.description),
      official: skill.official === true,
      visibility: asText(skill.visibility),
      status: asText(skill.status),
      canModify: skill.canModify === true,
      canDelete: skill.canDelete === true,
    }))
    .filter((skill) => skill.name)
}

export async function getSkill(name: string): Promise<SkillDetail> {
  const skill = await callAda('GetSkill', { Name: name, Network: 'public' })
  const metadata = asObject(skill.Metadata)
  return {
    name: asText(skill.Name) || name,
    description: asText(skill.Description),
    official: skill.Official === true,
    visibility: asText(skill.Visibility) || 'user',
    status: asText(skill.Status),
    canModify: skill.CanModify === true,
    canDelete: skill.CanDelete === true,
    skillMd: asText(metadata.skillMd),
    downloadUrl: asText(skill.DownloadUrl),
    extraMetadata: skillExtraMetadata(metadata),
  }
}

export type SkillSource = { skillMd: string } | { bundleUrl: string }

export async function createSkill(input: { name: string; description: string; visibility: string; source: SkillSource }): Promise<void> {
  await callAda('CreateSkill', { Name: input.name, Description: input.description, Visibility: input.visibility, Metadata: input.source })
}

/**
 * Metadata is replaced as a whole when sent. `source` is omitted when the content is unchanged, and `extraMetadata`
 * carries the saved fields that a content change must keep.
 */
export async function updateSkill(name: string, input: { description?: string; visibility?: string; source?: SkillSource; extraMetadata?: Json }): Promise<void> {
  await callAda('UpdateSkill', {
    Name: name,
    ...(input.description !== undefined ? { Description: input.description } : {}),
    ...(input.visibility !== undefined ? { Visibility: input.visibility } : {}),
    ...(input.source ? { Metadata: { ...input.extraMetadata, ...input.source } } : {}),
  })
}

export async function deleteSkill(name: string): Promise<void> {
  await callAda('DeleteSkill', { Name: name })
}

// ---- Models ----

export interface ModelInfo {
  id: string
  displayName: string
}

export interface SessionModel {
  modelId: string
  thinkingLevel: string
  thinkingLevels: string[]
}

export async function listModels(): Promise<ModelInfo[]> {
  const models = await listAll('ListModels', 'Models', { ModelType: 'text' })
  return models.map((model) => ({ id: asText(model.Id), displayName: asText(model.DisplayName) || asText(model.Id) })).filter((model) => model.id)
}

function sessionModel(result: Json): SessionModel {
  return {
    modelId: asText(result.modelId ?? result.ModelId),
    thinkingLevel: asText(result.thinkingLevel ?? result.ThinkingLevel),
    thinkingLevels: asArray(result.thinkingLevels ?? result.ThinkingLevels).map(asText).filter(Boolean),
  }
}

export async function getSessionModel(sessionId: string): Promise<SessionModel> {
  return sessionModel(rpcResult(await callAda('GetAgentSessionModel', rpcBody({ sessionId }))))
}

export async function setSessionModel(sessionId: string, modelId: string, thinkingLevel?: string): Promise<SessionModel> {
  return sessionModel(rpcResult(await callAda('SetAgentSessionModel', rpcBody({ sessionId, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) }))))
}

// ---- Sessions ----

export interface SessionSummary {
  sessionId: string
  title: string
  agentName: string
  updatedAt: number
}

export async function listSessions(nextToken?: string): Promise<{ sessions: SessionSummary[]; nextToken?: string }> {
  const result = rpcResult(await callAda('ListAgentSessions', rpcBody({ MaxResults: 50, ...(nextToken ? { NextToken: nextToken } : {}) })))
  const token = pageToken(result.NextToken)
  return {
    sessions: asObjects(result.SessionList)
      .map((session) => ({
        sessionId: asText(session.sessionId),
        title: asText(session.title),
        agentName: asText(session.agentName),
        updatedAt: asOptionalNumber(session.updatedAt) ?? 0,
      }))
      .filter((session) => session.sessionId),
    ...(token ? { nextToken: token } : {}),
  }
}

export async function getSession(sessionId: string): Promise<SessionSummary> {
  const result = rpcResult(await callAda('GetAgentSession', rpcBody({ sessionId })))
  return {
    sessionId,
    title: asText(result.title),
    agentName: asText(result.agentName),
    updatedAt: asOptionalNumber(result.lastMessageAtMs) ?? 0,
  }
}

/** Retries an unknown creation result with the same clientToken, so a retry cannot create a second session. */
export async function createSession(agentName: string, approvalMode: 'default' | 'yolo'): Promise<string> {
  const clientToken = crypto.randomUUID()
  const params = { clientToken, _meta: { agent: { agentName }, initialConfigOptions: { approvalMode } } }
  let response: Record<string, unknown>
  try {
    response = await callAda('CreateAgentSession', rpcBody(params))
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'AgentSession.CreateResultUnknown') throw error
    response = await callAda('CreateAgentSession', rpcBody(params))
  }
  const result = rpcResult(response)
  const sessionId = asText(result.sessionId ?? result.SessionId)
  if (!sessionId) throw new Error('创建会话的响应中没有会话 ID。')
  return sessionId
}

export async function deleteSession(sessionId: string): Promise<void> {
  rpcResult(await callAda('DeleteAgentSession', rpcBody({ sessionId })))
}
