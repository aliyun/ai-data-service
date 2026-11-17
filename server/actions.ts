// The browser can only reach the actions listed here, and only with the listed parameters. This keeps the
// local gateway from turning into a general purpose signing service for the configured AccessKey.
// Parameter placement follows the public metadata:
// https://api.aliyun.com/meta/v1/products/Ada/versions/2026-07-01/api-docs.json
export const API_VERSION = '2026-07-01'

export const REGIONS = ['cn-hangzhou', 'cn-shanghai', 'cn-beijing'] as const
export type Region = (typeof REGIONS)[number]

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value)
}

export interface ActionSpec {
  method: 'GET' | 'POST'
  query: readonly string[]
  form: readonly string[]
  stream?: true
}

const RPC = ['Jsonrpc', 'Id', 'Params'] as const
const AGENT_FIELDS = ['DisplayName', 'Description', 'SystemPrompt', 'Tools', 'Skills', 'KnowledgeBases', 'Visibility'] as const
const LIST_FILTERS = ['MaxResults', 'NextToken', 'PageNumber', 'PageSize', 'CreatorId', 'Q', 'Visibility', 'Scope'] as const

const rpcForm: ActionSpec = { method: 'POST', query: [], form: RPC }
const rpcQuery: ActionSpec = { method: 'POST', query: RPC, form: [] }
const rpcStream: ActionSpec = { method: 'POST', query: [], form: RPC, stream: true }

export const ACTIONS: Readonly<Record<string, ActionSpec>> = {
  CreateAgent: { method: 'POST', query: [], form: ['Name', ...AGENT_FIELDS] },
  GetAgent: { method: 'POST', query: ['Name'], form: [] },
  ListAgents: { method: 'POST', query: [...LIST_FILTERS, 'RequiredRuntime'], form: [] },
  UpdateAgent: { method: 'POST', query: ['Name'], form: ['ExpectedVersion', ...AGENT_FIELDS] },
  DeleteAgent: { method: 'POST', query: ['Name'], form: [] },

  CreateAgentSession: rpcForm,
  ListAgentSessions: rpcForm,
  GetAgentSession: rpcQuery,
  DeleteAgentSession: rpcForm,
  PromptAgentSession: rpcStream,
  LoadAgentSession: rpcStream,
  ReplyAgentSession: rpcForm,
  CancelAgentSession: rpcForm,

  ListModels: { method: 'POST', query: ['MaxResults', 'NextToken', 'PageNumber', 'PageSize', 'ModelType'], form: [] },
  GetAgentSessionModel: rpcQuery,
  SetAgentSessionModel: rpcForm,

  CreateSkill: { method: 'POST', query: [], form: ['Name', 'Description', 'Metadata', 'Visibility'] },
  GetSkill: { method: 'POST', query: ['Name', 'SkillVersion', 'Network'], form: [] },
  ListSkills: { method: 'POST', query: LIST_FILTERS, form: [] },
  UpdateSkill: { method: 'POST', query: ['Name'], form: ['ExpectedVersion', 'Description', 'Metadata', 'Visibility'] },
  DeleteSkill: { method: 'POST', query: ['Name'], form: [] },
}

export function getAction(name: string): ActionSpec | undefined {
  return Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined
}
