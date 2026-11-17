// Pure view model of a conversation: turns session frames into renderable items. No I/O lives here.
import type { Frame } from '../../server/sse.ts'
import { asArray, asObject, asObjects, asText, type Json } from './wire.ts'

export interface ToolContent {
  text: string
}

export type ChatItem =
  | { type: 'user'; id: string; text: string }
  | { type: 'agent'; id: string; text: string }
  | { type: 'thought'; id: string; text: string }
  | {
      type: 'tool'
      id: string
      toolCallId: string
      title: string
      kind: string
      status: string
      rawInput: unknown
      output: string
    }
  | { type: 'plan'; id: string; entries: { content: string; status: string }[] }
  | { type: 'notice'; id: string; level: 'info' | 'error'; text: string; code?: string; requestId?: string }

export interface QuestionOption {
  label: string
  description: string
}

export interface Question {
  key: string
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

export interface InteractionOption {
  optionId: string
  name: string
  kind: string
}

export interface Interaction {
  requestId: string
  sessionId: string
  title: string
  rawInput: unknown
  options: InteractionOption[]
  questions: Question[]
}

export type Phase = 'loading' | 'idle' | 'running' | 'cancelling' | 'reconnecting' | 'lost'

export interface ChatView {
  phase: Phase
  items: ChatItem[]
  interactions: Interaction[]
  /** Text handed back to the composer when a Prompt was definitely rejected. */
  restoredDraft?: string
  /** Shown next to the composer right away; the history rebuild after a rejected Prompt can take a whole turn. */
  composerNotice?: string
  /** A delegated sub-task is still running; its result arrives later as a background turn. */
  waitingForDelegation?: boolean
  nextId: number
}

export const EMPTY_VIEW: ChatView = { phase: 'loading', items: [], interactions: [], nextId: 1 }

export interface Markers {
  offset: number
  eventEpoch: string
  promptId: string
}

/** Resume markers count only as a complete group; a partial group must not overwrite a saved one. */
export function readMarkers(frame: Frame): Markers | undefined {
  const meta = asObject(frame.params?._meta)
  const { offset, eventEpoch, promptId } = meta
  if (typeof offset !== 'number' || typeof eventEpoch !== 'string' || typeof promptId !== 'string') return undefined
  if (!eventEpoch || !promptId) return undefined
  return { offset, eventEpoch, promptId }
}

export function frameOffset(frame: Frame): number | undefined {
  const offset = asObject(frame.params?._meta).offset
  return typeof offset === 'number' ? offset : undefined
}

export function isHeartbeat(frame: Frame): boolean {
  return asObject(frame.params?._meta).waitForResponse === true
}

export function parseInteraction(data: Json): Interaction | undefined {
  const requestId = asText(data.requestId)
  if (!requestId) return undefined
  const toolCall = asObject(data.toolCall)
  const meta = asObject(toolCall._meta)
  const answerKeys = asArray(meta.qwenAnswerKeys)
  const rawInput = toolCall.rawInput
  const questions = asObjects(asObject(rawInput).questions).map((question, index): Question => {
    const notified = answerKeys[index]
    const key = typeof notified === 'string' && notified ? notified : asText(question.answerKey) || String(index)
    return {
      key,
      question: asText(question.question),
      header: asText(question.header),
      multiSelect: question.multiSelect === true,
      options: asObjects(question.options).map((option) => ({
        label: asText(option.label),
        description: asText(option.description),
      })),
    }
  })
  return {
    requestId,
    sessionId: asText(data.sessionId),
    title: asText(toolCall.title),
    rawInput,
    options: asObjects(data.options).map((option) => ({
      optionId: asText(option.optionId),
      name: asText(option.name) || asText(option.optionId),
      kind: asText(option.kind),
    })),
    questions,
  }
}

function toolOutput(update: Json): string | undefined {
  const blocks = asArray(update.content)
  const parts: string[] = []
  for (const raw of blocks) {
    const block = asObject(raw)
    const inner = asObject(block.content)
    const text = asText(inner.text) || asText(block.text)
    if (text) parts.push(text)
    else if (block.type === 'diff') parts.push(`已修改 ${asText(block.path)}`)
  }
  if (parts.length > 0) return parts.join('\n')
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2)
  }
  return undefined
}

function appendText(view: ChatView, type: 'user' | 'agent' | 'thought', text: string): ChatView {
  if (!text) return view
  const last = view.items.at(-1)
  if (last?.type === type) {
    return { ...view, items: [...view.items.slice(0, -1), { ...last, text: last.text + text }] }
  }
  return { ...view, items: [...view.items, { type, id: `item-${view.nextId}`, text }], nextId: view.nextId + 1 }
}

function applyTool(view: ChatView, update: Json): ChatView {
  const toolCallId = asText(update.toolCallId)
  if (!toolCallId) return view
  const output = toolOutput(update)
  const index = view.items.findIndex((item) => item.type === 'tool' && item.toolCallId === toolCallId)
  if (index >= 0) {
    const existing = view.items[index]
    if (existing?.type !== 'tool') return view
    const items = [...view.items]
    items[index] = {
      ...existing,
      title: asText(update.title) || existing.title,
      kind: asText(update.kind) || existing.kind,
      status: asText(update.status) || existing.status,
      rawInput: update.rawInput ?? existing.rawInput,
      output: output ?? existing.output,
    }
    return { ...view, items }
  }
  const item: ChatItem = {
    type: 'tool',
    id: `item-${view.nextId}`,
    toolCallId,
    title: asText(update.title) || toolCallId,
    kind: asText(update.kind),
    status: asText(update.status) || 'pending',
    rawInput: update.rawInput,
    output: output ?? '',
  }
  return { ...view, items: [...view.items, item], nextId: view.nextId + 1 }
}

function applyPlan(view: ChatView, update: Json): ChatView {
  const entries = asObjects(update.entries).map((entry) => ({
    content: asText(entry.content),
    status: asText(entry.status),
  }))
  const last = view.items.at(-1)
  if (last?.type === 'plan') {
    return { ...view, items: [...view.items.slice(0, -1), { ...last, entries }] }
  }
  return { ...view, items: [...view.items, { type: 'plan', id: `item-${view.nextId}`, entries }], nextId: view.nextId + 1 }
}

function removeInteraction(view: ChatView, requestId: string): ChatView {
  return { ...view, interactions: view.interactions.filter((item) => item.requestId !== requestId) }
}

/** Applies one notification frame. Unknown events are ignored: they must not affect the view or the turn state. */
export function applyFrame(view: ChatView, frame: Frame, options: { skipUserChunks?: boolean } = {}): ChatView {
  const params = frame.params ?? {}
  if (frame.method === 'session/update') {
    const update = asObject(params.update)
    const content = asObject(update.content)
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return appendText(view, 'agent', asText(content.text))
      case 'agent_thought_chunk':
        return appendText(view, 'thought', asText(content.text))
      case 'user_message_chunk':
        return options.skipUserChunks ? view : appendText(view, 'user', asText(content.text))
      case 'tool_call':
      case 'tool_call_update':
        return applyTool(view, update)
      case 'plan':
        return applyPlan(view, update)
      default:
        return view
    }
  }
  if (frame.method === '_qwen/notify') {
    if (params.kind === 'permission_request') {
      const interaction = parseInteraction(asObject(params.data))
      if (!interaction) return view
      // A resumed stream pushes pending interactions again; the latest notification replaces the earlier one.
      const others = view.interactions.filter((item) => item.requestId !== interaction.requestId)
      return { ...view, interactions: [...others, interaction] }
    }
    const update = asObject(params.update)
    if (update.sessionUpdate === '_qwen.permission_resolved') return removeInteraction(view, asText(update.requestId))
  }
  return view
}

export function addNotice(
  view: ChatView,
  notice: { level: 'info' | 'error'; text: string; code?: string; requestId?: string },
): ChatView {
  return { ...view, items: [...view.items, { type: 'notice', id: `item-${view.nextId}`, ...notice }], nextId: view.nextId + 1 }
}

export function addUserMessage(view: ChatView, text: string): ChatView {
  return { ...view, items: [...view.items, { type: 'user', id: `item-${view.nextId}`, text }], nextId: view.nextId + 1 }
}

export function resolveInteraction(view: ChatView, requestId: string): ChatView {
  return removeInteraction(view, requestId)
}

export type DisplayBlock =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'process'; id: string; items: Extract<ChatItem, { type: 'thought' | 'tool' | 'plan' }>[] }

/** Groups adjacent reasoning and tool steps into one collapsible process; messages and notices stay on the canvas. */
export function toDisplayBlocks(items: readonly ChatItem[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = []
  for (const item of items) {
    if (item.type === 'thought' || item.type === 'tool' || item.type === 'plan') {
      const last = blocks.at(-1)
      if (last?.kind === 'process') last.items.push(item)
      else blocks.push({ kind: 'process', id: item.id, items: [item] })
    } else {
      blocks.push({ kind: 'item', item })
    }
  }
  return blocks
}
