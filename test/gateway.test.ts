import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { MOCK_ACCESS_KEY_ID, MOCK_ACCESS_KEY_SECRET, createMockAda } from '../scripts/mock-ada.ts'
import { ACTIONS, getAction } from '../server/actions.ts'
import { resolveEndpointOverride } from '../server/ada-client.ts'
import { createApp, isAllowedRequest } from '../server/app.ts'
import { ConfigStore, maskKeyId, parseEnvFile } from '../server/config.ts'
import { SseDecoder, normalizeFrame, type Frame } from '../server/sse.ts'

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function reservePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createMockAda()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

let mock: Server
let gateway: Server
let port: number
let envFile: string

before(async () => {
  mock = createMockAda({ chunkDelayMs: 1 })
  const mockPort = await listen(mock)
  envFile = path.join(mkdtempSync(path.join(tmpdir(), 'open-ada-test-')), '.env.local')
  port = await reservePort()
  gateway = createApp({
    config: new ConfigStore(envFile, {}),
    staticDir: tmpdir(),
    port,
    endpointOverride: new URL(`http://127.0.0.1:${mockPort}/`),
  })
  await listen(gateway, port)
})

after(() => {
  gateway.closeAllConnections()
  mock.closeAllConnections()
  gateway.close()
  mock.close()
})

function post(pathname: string, body: object, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...headers },
    body: JSON.stringify(body),
  })
}

async function readFrames(response: Response): Promise<Frame[]> {
  const frames: Frame[] = []
  const decoder = new SseDecoder((data) => frames.push(JSON.parse(data) as Frame))
  decoder.push(await response.text())
  decoder.end()
  return frames
}

test('rejects cross-site requests and DNS rebinding', () => {
  const host = 'localhost:8787'
  assert.equal(isAllowedRequest({ host, origin: 'http://localhost:8787' }, 'POST', 8787), true)
  assert.equal(isAllowedRequest({ host, origin: 'https://evil.example' }, 'POST', 8787), false)
  assert.equal(isAllowedRequest({ host: 'evil.example:8787', origin: 'http://evil.example:8787' }, 'POST', 8787), false)
  assert.equal(isAllowedRequest({ host: 'evil.example:8787' }, 'GET', 8787), false)
  assert.equal(isAllowedRequest({ host }, 'POST', 8787), false)
  assert.equal(isAllowedRequest({ host }, 'GET', 8787), true)
  assert.equal(isAllowedRequest({ host, origin: 'null' }, 'POST', 8787), false)
})

test('a foreign origin cannot reach the gateway', async () => {
  const response = await post('/api/ada/ListAgents', {}, { origin: 'https://evil.example' })
  assert.equal(response.status, 403)
})

test('requires a JSON content type, which forces a CORS preflight', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/ada/ListAgents`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: `http://127.0.0.1:${port}` },
    body: '{}',
  })
  assert.notEqual(response.status, 200)
})

test('only allowlisted actions are reachable', async () => {
  assert.equal((await post('/api/ada/CreateTransitUploadPolicy', {})).status, 404)
  assert.equal((await post('/api/ada/constructor', {})).status, 404)
  assert.equal(getAction('__proto__'), undefined)
  assert.equal(getAction('toString'), undefined)
})

test('the allowlist covers the Agent, Session, Model and Skill operations', () => {
  assert.equal(Object.keys(ACTIONS).length, 21)
})

test('reports a missing configuration before any upstream call', async () => {
  const response = await post('/api/ada/ListAgents', {})
  assert.equal(response.status, 401)
  assert.equal(((await response.json()) as { code: string }).code, 'NotConfigured')
})

test('does not save credentials that fail verification', async () => {
  const response = await post('/api/config/credentials', { accessKeyId: MOCK_ACCESS_KEY_ID, accessKeySecret: 'wrong', region: 'cn-hangzhou' })
  assert.equal(response.status, 403)
  const config = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as { configured: boolean }
  assert.equal(config.configured, false)
})

test('saves verified credentials owner-only and never returns the secret', async () => {
  const response = await post('/api/config/credentials', { accessKeyId: MOCK_ACCESS_KEY_ID, accessKeySecret: MOCK_ACCESS_KEY_SECRET, region: 'cn-shanghai' })
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.ok(!body.includes(MOCK_ACCESS_KEY_SECRET))
  assert.ok(!body.includes(MOCK_ACCESS_KEY_ID))
  assert.equal(statSync(envFile).mode & 0o777, 0o600)
  assert.deepEqual(parseEnvFile(readFileSync(envFile, 'utf8')).ADA_REGION, 'cn-shanghai')
  const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).text()
  assert.ok(!config.includes(MOCK_ACCESS_KEY_SECRET))
})

test('signed requests pass the mock verification and structured values arrive once encoded', async () => {
  const created = await post('/api/ada/CreateAgent', { Name: 'sig-test', Skills: [{ name: '中文 skill' }], Tools: [{ mcpServerName: 'a b' }] })
  assert.equal(created.status, 200)
  const agent = (await (await post('/api/ada/GetAgent', { Name: 'sig-test' })).json()) as { Skills: string[]; Tools: string }
  assert.deepEqual(agent.Skills, ['中文 skill'])
  assert.deepEqual(JSON.parse(agent.Tools), [{ mcpServerName: 'a b' }])
})

test('upstream errors keep their code and request id', async () => {
  const response = await post('/api/ada/GetAgent', { Name: 'missing' })
  assert.equal(response.status, 404)
  const body = (await response.json()) as { code: string; requestId?: string }
  assert.equal(body.code, 'Agent.NotFound')
  assert.ok(body.requestId)
})

test('parameters outside the action definition are not forwarded', async () => {
  // The mock would reject a mistaken signature; the extra field must simply be dropped.
  const response = await post('/api/ada/ListModels', { ModelType: 'text', Evil: 'x' })
  assert.equal(response.status, 200)
})

test('streams a prompt with normalized frames and a matching terminal Id', async () => {
  const created = (await (await post('/api/ada/CreateAgentSession', {
    Jsonrpc: '2.0',
    Id: 'c1',
    Params: { clientToken: 'token-1', _meta: { agent: { agentName: 'ada-assistant' } } },
  })).json()) as { JsonRpcResponse: { result: { sessionId: string } } }
  const sessionId = created.JsonRpcResponse.result.sessionId
  const stream = await post('/api/ada/PromptAgentSession/stream', {
    Jsonrpc: '2.0',
    Id: 'p1',
    Params: { sessionId, prompt: [{ type: 'text', text: '你好' }] },
  })
  assert.equal(stream.status, 200)
  const frames = await readFrames(stream)
  const terminal = frames.at(-1)
  assert.equal(terminal?.id, 'p1')
  assert.equal(terminal?.result?.stopReason, 'end_turn')
  assert.ok(frames.some((frame) => (frame.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'agent_message_chunk'))
})

test('the first event of a turn reaches the stream, and a failed turn ends with its error', async () => {
  const created = (await (await post('/api/ada/CreateAgentSession', {
    Jsonrpc: '2.0',
    Id: 'c2',
    Params: { clientToken: 'token-2', _meta: { agent: { agentName: 'ada-assistant' } } },
  })).json()) as { JsonRpcResponse: { result: { sessionId: string } } }
  const stream = await post('/api/ada/PromptAgentSession/stream', {
    Jsonrpc: '2.0',
    Id: 'p2',
    Params: { sessionId: created.JsonRpcResponse.result.sessionId, prompt: [{ type: 'text', text: '失败' }] },
  })
  const frames = await readFrames(stream)
  const first = frames[0]?.params?.update as { content?: { text?: string } } | undefined
  assert.equal(first?.content?.text, '正在处理……')
  assert.equal(frames.at(-1)?.error?.errorCode, 'CLI_TURN_FAILED')
})

test('a stream action cannot be called through the JSON route', async () => {
  assert.equal((await post('/api/ada/PromptAgentSession', {})).status, 404)
})

test('decodes SSE with CRLF split across chunks', () => {
  const seen: string[] = []
  const decoder = new SseDecoder((data) => seen.push(data))
  decoder.push(': connected\r\n\r\ndata: {"a":1}\r')
  decoder.push('\n\r\ndata: {"b"')
  decoder.push(':2}\n\n')
  decoder.end()
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}'])
})

test('normalizes frames whose any fields arrive as JSON text', () => {
  const frame = normalizeFrame({ RequestId: 'r', Jsonrpc: '2.0', Id: 'x', Method: 'session/update', Params: '{"sessionId":"s"}' })
  assert.deepEqual(frame, { jsonrpc: '2.0', id: 'x', method: 'session/update', params: { sessionId: 's' }, requestId: 'r' })
  assert.equal(normalizeFrame({ Jsonrpc: '2.0' }), undefined)
  assert.equal(normalizeFrame('text'), undefined)
})

test('endpoint overrides cannot send signed requests over plain http to another host', () => {
  assert.throws(() => resolveEndpointOverride('http://evil.example/'))
  assert.ok(resolveEndpointOverride('http://127.0.0.1:9/'))
  assert.ok(resolveEndpointOverride('https://ada.example/'))
  assert.equal(resolveEndpointOverride(undefined), undefined)
})

test('env file parsing and key masking', () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x\'\n'), { A: '1', B: 'two words', C: 'x' })
  const tricky = 'a"b\\c+/='
  assert.equal(parseEnvFile(`T=${JSON.stringify(tricky)}\n`).T, tricky)
  assert.equal(maskKeyId('LTAI1234567890abcd'), 'LTAI****abcd')
  assert.equal(maskKeyId('short'), '****')
})
