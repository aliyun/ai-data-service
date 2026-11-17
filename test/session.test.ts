import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Frame } from '../server/sse.ts'
import { referenceNames, skillExtraMetadata, toolsForUpdate } from '../web/lib/ada.ts'
import { SessionController, type HttpFailure, type SessionTransport } from '../web/lib/session-controller.ts'
import { EMPTY_VIEW, applyFrame, parseInteraction, readMarkers, toDisplayBlocks, type ChatItem } from '../web/lib/session-state.ts'
import { parseRoute } from '../web/lib/route.ts'
import { pageToken, rpcResult } from '../web/lib/wire.ts'

type Call = { action: string; params: Record<string, unknown>; id: string }
type Script = (call: Call, emit: (frame: Frame) => void, signal: AbortSignal) => Promise<void> | void

function chunk(text: string, meta?: Record<string, unknown>): Frame {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, ...(meta ? { _meta: meta } : {}) },
  }
}

function userChunk(text: string): Frame {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } } }
}

const meta = (offset: number) => ({ offset, eventEpoch: 'e1', promptId: 'p1' })
const end = (id: string, stopReason = 'end_turn'): Frame => ({ jsonrpc: '2.0', id, result: { stopReason } })

function httpFailure(status: number, code: string): HttpFailure {
  return Object.assign(new Error(code), { status, code })
}

class FakeTransport implements SessionTransport {
  readonly calls: Call[] = []
  readonly rpcCalls: { action: string; body: { Params: Record<string, unknown> } }[] = []
  rpcResult: Record<string, unknown> = {}
  private count = 0
  private readonly scripts: Script[]

  constructor(scripts: Script[]) {
    this.scripts = scripts
  }

  async stream(action: string, body: object, signal: AbortSignal, onFrame: (frame: Frame) => void): Promise<void> {
    const { Id, Params } = body as { Id: string; Params: Record<string, unknown> }
    const call = { action, params: Params, id: Id }
    this.calls.push(call)
    const script = this.scripts.shift()
    if (!script) throw new Error(`Unexpected stream call: ${action}`)
    await script(call, onFrame, signal)
  }

  async rpc(action: string, body: object): Promise<Record<string, unknown>> {
    this.rpcCalls.push({ action, body: body as { Params: Record<string, unknown> } })
    return this.rpcResult
  }

  newId(): string {
    this.count += 1
    return `id-${this.count}`
  }

  async sleep(): Promise<void> {}
}

async function settled(controller: SessionController): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    if (!['running', 'loading', 'reconnecting', 'cancelling'].includes(controller.getView().phase)) return
  }
  throw new Error(`Did not settle: ${controller.getView().phase}`)
}

function texts(items: readonly ChatItem[]): string[] {
  return items.flatMap((item) => (item.type === 'user' || item.type === 'agent' ? [`${item.type}:${item.text}`] : []))
}

function notices(items: readonly ChatItem[]): string[] {
  return items.flatMap((item) => (item.type === 'notice' ? [item.text] : []))
}

test('a prompt sends documented field names and finishes on the matching terminal frame', async () => {
  const transport = new FakeTransport([
    (call, emit) => {
      emit(chunk('你好', meta(1)))
      emit(chunk('世界', meta(2)))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(transport.calls[0]?.params, { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] })
  assert.equal(transport.calls[0]?.action, 'PromptAgentSession')
  assert.deepEqual(texts(controller.getView().items), ['user:hi', 'agent:你好世界'])
  assert.equal(controller.getView().phase, 'idle')
  assert.deepEqual(notices(controller.getView().items), [])
})

test('a terminal frame for another call does not end the turn', async () => {
  const transport = new FakeTransport([
    (call, emit) => {
      emit(end('someone-else'))
      emit(chunk('仍在继续', meta(1)))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(texts(controller.getView().items), ['user:hi', 'agent:仍在继续'])
})

test('a dropped stream resumes with all markers, never resends the prompt, and does not duplicate text', async () => {
  const transport = new FakeTransport([
    (_call, emit) => {
      emit(chunk('前半', meta(1)))
      emit(chunk('段', meta(2)))
    },
    (call, emit) => {
      emit(userChunk('hi'))
      emit(chunk('旧历史，没有游标'))
      emit(chunk('段', meta(2)))
      emit(chunk('后半段', meta(3)))
      emit(end(call.id))
    },
    (call, emit) => {
      emit(userChunk('hi'))
      emit(chunk('前半段后半段'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(transport.calls.map((call) => call.action), ['PromptAgentSession', 'LoadAgentSession', 'LoadAgentSession'])
  assert.deepEqual(transport.calls[1]?.params, {
    sessionId: 's',
    _meta: { isReload: true, beginLogOffset: 2, eventEpoch: 'e1', promptId: 'p1' },
  })
  // The last step is a plain Load, which rebuilds the view from the server.
  assert.deepEqual(transport.calls[2]?.params, { sessionId: 's' })
  assert.deepEqual(texts(controller.getView().items), ['user:hi', 'agent:前半段后半段'])
})

test('while resuming, a frame at or below the cursor is not applied twice', async () => {
  let duringResume: string[] = []
  const transport = new FakeTransport([
    (_call, emit) => {
      emit(chunk('A', meta(1)))
    },
    (call, emit) => {
      emit(chunk('A', meta(1)))
      emit(chunk('B', meta(2)))
      duringResume = texts(controller.getView().items)
      emit(end(call.id))
    },
    (call, emit) => emit(end(call.id)),
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(duringResume, ['user:hi', 'agent:AB'])
})

test('without markers a drop falls back to a plain Load and reports the result as unknown', async () => {
  const transport = new FakeTransport([
    () => {
      throw new Error('network down')
    },
    (call, emit) => {
      emit(userChunk('hi'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(transport.calls[1]?.params, { sessionId: 's' })
  assert.equal(notices(controller.getView().items).length, 1)
  assert.match(notices(controller.getView().items)[0] ?? '', /未能确认/)
})

test('a plain Load ending in end_turn does not claim a turn succeeded, and shows history', async () => {
  const transport = new FakeTransport([
    (call, emit) => {
      emit(userChunk('旧问题'))
      emit(chunk('旧回答'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.open()
  await settled(controller)
  assert.deepEqual(texts(controller.getView().items), ['user:旧问题', 'agent:旧回答'])
  assert.deepEqual(notices(controller.getView().items), [])
  assert.equal(controller.getView().phase, 'idle')
})

test('CLI_STREAM_FAILED resumes instead of reporting a failed turn', async () => {
  const transport = new FakeTransport([
    (call, emit) => {
      emit(chunk('A', meta(1)))
      emit({ jsonrpc: '2.0', id: call.id, error: { code: -32603, errorCode: 'CLI_STREAM_FAILED', message: 'interrupted' } })
    },
    (call, emit) => {
      emit(chunk('B', meta(2)))
      emit(end(call.id))
    },
    (call, emit) => {
      emit(chunk('AB'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(notices(controller.getView().items), [])
  assert.equal((transport.calls[1]?.params._meta as { beginLogOffset: number }).beginLogOffset, 1)
})

test('CLI_RELOAD_REQUIRED discards the markers and rebuilds the view', async () => {
  const transport = new FakeTransport([
    (_call, emit) => emit(chunk('旧世代', meta(1))),
    (call, emit) => emit({ jsonrpc: '2.0', id: call.id, error: { code: -32603, errorCode: 'CLI_RELOAD_REQUIRED', message: 'reload' } }),
    (call, emit) => {
      emit(chunk('新内容'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(transport.calls[2]?.params, { sessionId: 's' })
  assert.deepEqual(texts(controller.getView().items), ['agent:新内容'])
})

test('a rejected epoch on resume rebuilds with a plain Load', async () => {
  const transport = new FakeTransport([
    (_call, emit) => emit(chunk('A', meta(1))),
    () => {
      throw httpFailure(400, 'InvalidParameter')
    },
    (call, emit) => emit(end(call.id)),
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.deepEqual(transport.calls[2]?.params, { sessionId: 's' })
  assert.equal(controller.getView().phase, 'idle')
})

test('a definite rejection hands the text back without resending', async () => {
  const transport = new FakeTransport([
    () => {
      throw httpFailure(403, 'Forbidden')
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hello')
  await settled(controller)
  const view = controller.getView()
  assert.equal(view.restoredDraft, 'hello')
  assert.deepEqual(texts(view.items), [])
  assert.equal(transport.calls.length, 1)
  assert.equal(view.phase, 'idle')
})

test('a busy session is not treated as a lost message: it attaches through Load and says so right away', async () => {
  let duringRunningTurn: { notice?: string; draft?: string } = {}
  const transport = new FakeTransport([
    () => {
      throw httpFailure(409, 'AgentSession.SessionBusy')
    },
    (call, emit) => {
      // The other client's turn is still running while this Load is attached.
      emit(chunk('另一边的输出', meta(3)))
      const view = controller.getView()
      duringRunningTurn = { ...(view.composerNotice ? { notice: view.composerNotice } : {}), ...(view.restoredDraft ? { draft: view.restoredDraft } : {}) }
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hello')
  await settled(controller)
  assert.equal(transport.calls[1]?.action, 'LoadAgentSession')
  assert.match(duringRunningTurn.notice ?? '', /消息未发送/)
  assert.equal(duringRunningTurn.draft, 'hello', 'the unsent text goes back to the composer')
  controller.prompt('hello again')
  assert.equal(controller.getView().composerNotice, undefined, 'a new prompt clears the notice')
})

test('editing tools keeps saved fields on references that stay', () => {
  const tools = toolsForUpdate(
    [{ mcpServerName: 'kept', kind: 'allowlist', items: ['read'] }, { mcpServerName: 'removed' }, '{"connectorName":"conn"}'],
    { mcpServers: ['kept', 'added'], connectors: ['conn'] },
  )
  assert.deepEqual(tools, [
    { mcpServerName: 'kept', kind: 'allowlist', items: ['read'] },
    { mcpServerName: 'added' },
    { connectorName: 'conn' },
  ])
})

test('a prompt that drops before its first frame does not resume the previous turn, and keeps the text', async () => {
  const transport = new FakeTransport([
    (call, emit) => {
      emit(userChunk('第一条'))
      emit(chunk('第一条的回复', meta(5)))
      emit(end(call.id))
    },
    () => {
      throw new Error('network down')
    },
    (call, emit) => {
      emit(userChunk('第一条'))
      emit(chunk('第一条的回复'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.open()
  await settled(controller)
  controller.prompt('第二条')
  await settled(controller)
  // A plain Load, not a resume of promptId p1.
  assert.deepEqual(transport.calls[2]?.params, { sessionId: 's' })
  const view = controller.getView()
  assert.equal(view.restoredDraft, '第二条')
  assert.equal(view.phase, 'idle')
  assert.ok(notices(view.items).some((text) => text.includes('未能确认')))
  assert.ok(notices(view.items).some((text) => text.includes('放回输入框')))
})

test('a prompt whose result was unknown but is in the rebuilt history is not handed back', async () => {
  const transport = new FakeTransport([
    () => {
      throw new Error('network down')
    },
    (call, emit) => {
      emit(userChunk('hi'))
      emit(chunk('回复'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.equal(controller.getView().restoredDraft, undefined)
  assert.ok(!notices(controller.getView().items).some((text) => text.includes('放回输入框')))
})

test('a stream that goes silent is treated as dropped and resumed', async () => {
  const silent: Script = (_call, emit, signal) => {
    emit(chunk('A', meta(1)))
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  const transport = new FakeTransport([
    silent,
    (call, emit) => {
      emit(chunk('B', meta(2)))
      emit(end(call.id))
    },
    (call, emit) => {
      emit(chunk('AB'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport, undefined, { idleTimeoutMs: 20 })
  controller.prompt('hi')
  for (let i = 0; i < 100 && transport.calls.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  await settled(controller)
  assert.deepEqual(transport.calls.map((call) => call.action), ['PromptAgentSession', 'LoadAgentSession', 'LoadAgentSession'])
  assert.equal((transport.calls[1]?.params._meta as { beginLogOffset: number }).beginLogOffset, 1)
  assert.equal(controller.getView().phase, 'idle')
})

function toolFrame(update: Record<string, unknown>): Frame {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } }
}

test('after a delegation the history is reloaded quietly until the sub-task result arrives', async () => {
  const dispatched = (emit: (frame: Frame) => void): void => {
    emit(userChunk('派发'))
    emit(toolFrame({ sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'delegate', status: 'completed' }))
    emit(chunk('已派发，稍后转述。'))
  }
  const transport = new FakeTransport([
    (call, emit) => {
      emit(toolFrame({ sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'delegate', status: 'completed', _meta: meta(1) }))
      emit(chunk('已派发，稍后转述。', meta(2)))
      emit(end(call.id))
    },
    (call, emit) => {
      dispatched(emit)
      emit(end(call.id))
    },
    (call, emit) => {
      dispatched(emit)
      emit(toolFrame({ sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read_result', status: 'completed' }))
      emit(chunk('专家的回答。'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('派发')
  for (let i = 0; i < 200 && transport.calls.length < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))
  await settled(controller)
  for (let i = 0; i < 50 && controller.getView().waitingForDelegation; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(transport.calls.slice(1).map((call) => call.params), [{ sessionId: 's' }, { sessionId: 's' }])
  assert.deepEqual(texts(controller.getView().items), ['user:派发', 'agent:已派发，稍后转述。', 'agent:专家的回答。'])
  assert.equal(controller.getView().waitingForDelegation, undefined)
})

test('a turn that ends removes approval cards it left behind', async () => {
  const transport = new FakeTransport([
    (call, emit) => {
      emit(permissionFrame('perm-stale'))
      emit(end(call.id, 'cancelled'))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.equal(controller.getView().interactions.length, 0)
})

test('a malformed session link does not throw', () => {
  assert.deepEqual(parseRoute('#/chat/%E0%A4%A'), { name: 'chat', sessionId: '%E0%A4%A' })
  assert.deepEqual(parseRoute('#/chat/a%20b'), { name: 'chat', sessionId: 'a b' })
})

test('skill references accept the plain names GetAgent returns and the documented objects', () => {
  assert.deepEqual(referenceNames(['ada-agent-federation-skill']), ['ada-agent-federation-skill'])
  assert.deepEqual(referenceNames('["a","b"]'), ['a', 'b'])
  assert.deepEqual(referenceNames([{ name: 'c' }, '{"name":"d"}', '', null]), ['c', 'd'])
})

test('replacing skill content keeps metadata that is not a content source', () => {
  assert.deepEqual(
    skillExtraMetadata({ skillMd: 'x', artifactId: 'a', transitId: 't', bundleUrl: 'b', iconUrl: 'https://example.com/i.png' }),
    { iconUrl: 'https://example.com/i.png' },
  )
})

test('a failed turn surfaces its error code', async () => {
  const transport = new FakeTransport([
    (call, emit) => emit({ jsonrpc: '2.0', id: call.id, error: { code: -32603, errorCode: 'CLI_TURN_FAILED', message: '执行失败' } }),
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  const notice = controller.getView().items.find((item) => item.type === 'notice')
  assert.equal(notice?.type === 'notice' ? notice.code : '', 'CLI_TURN_FAILED')
})

test('reconnection stops after the retry limit and leaves the turn state unknown', async () => {
  const drop: Script = () => undefined
  const transport = new FakeTransport([drop, drop, drop, drop, drop, drop, drop])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await settled(controller)
  assert.equal(controller.getView().phase, 'lost')
  assert.equal(transport.calls.filter((call) => call.action === 'PromptAgentSession').length, 1)
})

test('cancel sends the real promptId and waits for the stream to report the outcome', async () => {
  let finish: () => void = () => undefined
  const hold = new Promise<void>((resolve) => { finish = resolve })
  const transport = new FakeTransport([
    async (call, emit) => {
      emit(chunk('A', meta(1)))
      await hold
      emit(end(call.id, 'cancelled'))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await new Promise((resolve) => setImmediate(resolve))
  await controller.cancel()
  assert.deepEqual(transport.rpcCalls[0]?.body.Params, { sessionId: 's', _meta: { promptId: 'p1' } })
  assert.equal(controller.getView().phase, 'cancelling')
  finish()
  await settled(controller)
  assert.equal(controller.getView().phase, 'idle')
  assert.match(notices(controller.getView().items)[0] ?? '', /已停止/)
})

function permissionFrame(requestId: string): Frame {
  return {
    jsonrpc: '2.0',
    method: '_qwen/notify',
    params: {
      kind: 'permission_request',
      data: {
        sessionId: 's',
        requestId,
        options: [{ optionId: 'allow_once', name: '允许', kind: 'allow_once' }],
        toolCall: { title: '确认', rawInput: { sql: 'x' } },
      },
    },
  }
}

test('approval replies use the notified ids and a rejected reply never switches decision', async () => {
  let finish: () => void = () => undefined
  const hold = new Promise<void>((resolve) => { finish = resolve })
  const transport = new FakeTransport([
    async (call, emit) => {
      emit(permissionFrame('perm-1'))
      await hold
      emit(end(call.id))
    },
    (call, emit) => {
      emit(permissionFrame('perm-1'))
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getView().interactions.length, 1)

  transport.rpcResult = { accepted: false }
  await controller.reply({ requestId: 'perm-1', outcome: { outcome: 'selected', optionId: 'allow_once' } })
  assert.equal(transport.rpcCalls.length, 1)
  assert.deepEqual(transport.rpcCalls[0]?.body.Params, {
    sessionId: 's',
    permissionRequestId: 'perm-1',
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  })
  finish()
  await settled(controller)
  assert.equal(controller.getView().interactions.length, 1, 'the interaction stays pending')
  assert.equal(transport.rpcCalls.length, 1, 'no automatic second reply')
})

test('an accepted reply removes the card and answers reach the API as a string map', async () => {
  let finish: () => void = () => undefined
  const hold = new Promise<void>((resolve) => { finish = resolve })
  const transport = new FakeTransport([
    async (call, emit) => {
      emit(permissionFrame('q-1'))
      await hold
      emit(end(call.id))
    },
  ])
  const controller = new SessionController('s', transport)
  controller.prompt('hi')
  await new Promise((resolve) => setImmediate(resolve))
  transport.rpcResult = { accepted: true }
  await controller.reply({ requestId: 'q-1', outcome: { outcome: 'selected', optionId: 'allow_once' }, answers: { '0': '仅分析' } })
  assert.deepEqual(transport.rpcCalls[0]?.body.Params.answers, { '0': '仅分析' })
  assert.equal(controller.getView().interactions.length, 0)
  finish()
  await settled(controller)
})

test('permission_resolved from another client removes the pending card', () => {
  let view = applyFrame(EMPTY_VIEW, permissionFrame('perm-9'))
  assert.equal(view.interactions.length, 1)
  view = applyFrame(view, permissionFrame('perm-9'))
  assert.equal(view.interactions.length, 1, 'a re-pushed interaction is not duplicated')
  view = applyFrame(view, {
    jsonrpc: '2.0',
    method: '_qwen/notify',
    params: { sessionId: 's', update: { sessionUpdate: '_qwen.permission_resolved', requestId: 'perm-9' } },
  })
  assert.equal(view.interactions.length, 0)
})

test('answer keys prefer the notification, then the question, then the index', () => {
  const interaction = parseInteraction({
    requestId: 'q',
    sessionId: 's',
    options: [],
    toolCall: {
      _meta: { qwenAnswerKeys: ['k0'] },
      rawInput: { questions: [{ question: 'a' }, { question: 'b', answerKey: 'k1' }, { question: 'c' }] },
    },
  })
  assert.deepEqual(interaction?.questions.map((question) => question.key), ['k0', 'k1', '2'])
})

test('incomplete resume markers do not overwrite a complete group', () => {
  assert.equal(readMarkers({ jsonrpc: '2.0', params: { _meta: { offset: 5 } } }), undefined)
  assert.deepEqual(readMarkers({ jsonrpc: '2.0', params: { _meta: meta(5) } }), meta(5))
})

test('tool updates merge by id and unknown events are ignored', () => {
  const tool = (update: Record<string, unknown>): Frame => ({ jsonrpc: '2.0', method: 'session/update', params: { update } })
  let view = applyFrame(EMPTY_VIEW, tool({ sessionUpdate: 'tool_call', toolCallId: 't', title: '查询', status: 'in_progress' }))
  view = applyFrame(view, tool({ sessionUpdate: 'future_event', anything: true }))
  view = applyFrame(view, tool({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'boom' } }] }))
  assert.equal(view.items.length, 1)
  const item = view.items[0]
  assert.equal(item?.type === 'tool' ? item.status : '', 'failed')
  assert.equal(item?.type === 'tool' ? item.output : '', 'boom')
  assert.equal(item?.type === 'tool' ? item.title : '', '查询')
})

test('process blocks group adjacent steps and text splits them', () => {
  const blocks = toDisplayBlocks([
    { type: 'thought', id: '1', text: 't' },
    { type: 'tool', id: '2', toolCallId: 'a', title: 'x', kind: '', status: 'completed', rawInput: undefined, output: '' },
    { type: 'agent', id: '3', text: 'm' },
    { type: 'thought', id: '4', text: 't' },
  ])
  assert.deepEqual(blocks.map((block) => block.kind), ['process', 'item', 'process'])
})

test('rpc results accept both documented casings and JSON text', () => {
  assert.deepEqual(rpcResult({ JsonRpcResponse: { result: { a: 1 } } }), { a: 1 })
  assert.deepEqual(rpcResult({ JsonRpcResponse: { Result: { a: 1 } } }), { a: 1 })
  assert.deepEqual(rpcResult({ JsonRpcResponse: '{"result":{"a":1}}' }), { a: 1 })
  assert.throws(() => rpcResult({ JsonRpcResponse: { error: { code: -1, message: 'bad' } } }), /bad/)
  assert.throws(() => rpcResult({ Success: false, JsonRpcResponse: {} }))
})

test('page tokens treat empty values, including the JSON text "", as the end', () => {
  assert.equal(pageToken(''), undefined)
  assert.equal(pageToken('""'), undefined)
  assert.equal(pageToken(undefined), undefined)
  assert.equal(pageToken('abc'), 'abc')
})
