// Checks this client against the real ADA OpenAPI with your own credentials.
//   npm run smoke                      read-only checks
//   npm run smoke -- --chat <agent>    also creates a session, sends one message, then deletes the session
//   npm run smoke -- --write           also creates a temporary Skill and Agent, reads them back, then deletes them
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAction } from '../server/actions.ts'
import { AdaApiError, callAction, openStream, resolveEndpointOverride, type ClientContext } from '../server/ada-client.ts'
import { ConfigStore } from '../server/config.ts'
import { SseDecoder, normalizeFrame, type Frame } from '../server/sse.ts'
import { referenceNames } from '../web/lib/ada.ts'
import { asArray, asObject, asObjects, rpcResult } from '../web/lib/wire.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = new ConfigStore(process.env.OPEN_ADA_ENV_FILE ?? path.join(ROOT, '.env.local'))
const credentials = config.credentials()
if (!credentials) {
  console.error('No credentials found. Set ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET, or configure them on the setup page.')
  process.exit(2)
}
const endpointOverride = resolveEndpointOverride(process.env.OPEN_ADA_ENDPOINT)
const context: ClientContext = { credentials, region: config.region(), ...(endpointOverride ? { endpointOverride } : {}) }
let failed = 0

async function call(action: string, params: Record<string, unknown>): Promise<unknown> {
  const spec = getAction(action)
  if (!spec) throw new Error(`Unknown action ${action}`)
  return callAction(context, action, spec, params)
}

async function check(label: string, run: () => Promise<string>): Promise<void> {
  try {
    console.log(`  ok    ${label}: ${await run()}`)
  } catch (error) {
    failed += 1
    const detail = error instanceof AdaApiError ? `${error.code}: ${error.message} (RequestId ${error.requestId ?? 'n/a'})` : error instanceof Error ? error.message : 'unknown error'
    console.log(`  FAIL  ${label}: ${detail}`)
  }
}

function rpcBody(params: object): Record<string, unknown> {
  return { Jsonrpc: '2.0', Id: randomUUID(), Params: params }
}

async function chat(agentName: string): Promise<void> {
  let sessionId = ''
  await check('CreateAgentSession', async () => {
    const result = rpcResult(await call('CreateAgentSession', rpcBody({ clientToken: randomUUID(), _meta: { agent: { agentName } } })))
    sessionId = String(result.sessionId ?? result.SessionId ?? '')
    if (!sessionId) throw new Error('The response has no sessionId.')
    return 'session created'
  })
  if (!sessionId) return

  await check('GetAgentSessionModel', async () => {
    const result = rpcResult(await call('GetAgentSessionModel', rpcBody({ sessionId })))
    return `modelId=${String(result.modelId ?? result.ModelId)}`
  })

  await check('PromptAgentSession (SSE)', async () => {
    const body = rpcBody({ sessionId, prompt: [{ type: 'text', text: '你好，请用一句话介绍你自己。' }] })
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 180_000)
    const stream = await openStream(context, 'PromptAgentSession', getAction('PromptAgentSession')!, body, abort.signal)
    const frames: Frame[] = []
    const decoder = new SseDecoder((data) => {
      const frame = normalizeFrame(JSON.parse(data))
      if (frame) frames.push(frame)
    })
    const text = new TextDecoder()
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) decoder.push(text.decode(chunk, { stream: true }))
    decoder.end()
    clearTimeout(timeout)
    const terminal = frames.find((frame) => frame.result || frame.error)
    if (!terminal) throw new Error(`The stream ended without a terminal frame after ${frames.length} frames.`)
    if (terminal.error) throw new Error(`${terminal.error.errorCode ?? terminal.error.code}: ${terminal.error.message}`)
    const reply = frames
      .filter((frame) => asObject(frame.params?.update).sessionUpdate === 'agent_message_chunk')
      .map((frame) => String(asObject(asObject(frame.params?.update).content).text ?? ''))
      .join('')
    const markers = frames.some((frame) => asObject(frame.params?._meta).offset !== undefined)
    return `${frames.length} frames, stopReason=${String(terminal.result?.stopReason)}, resume markers=${markers}, ${reply.length} reply chars`
  })

  await check('DeleteAgentSession', async () => {
    rpcResult(await call('DeleteAgentSession', rpcBody({ sessionId })))
    return 'session deleted'
  })
}

/** Structured fields are the part most likely to differ from the documentation, so they are read back. */
async function writes(): Promise<void> {
  const suffix = randomUUID().slice(0, 8)
  const skillName = `open-ada-smoke-${suffix}`
  const agentName = `open-ada-smoke-${suffix}`
  const skillMd = '# OpenADA smoke test\n\nTemporary skill, safe to delete.'
  let skillCreated = false
  let agentCreated = false

  await check('CreateSkill', async () => {
    await call('CreateSkill', { Name: skillName, Description: 'OpenADA smoke test', Metadata: { skillMd } })
    skillCreated = true
    return skillName
  })
  if (skillCreated) {
    await check('GetSkill read back', async () => {
      const skill = await call('GetSkill', { Name: skillName }) as Record<string, unknown>
      if (asObject(skill.Metadata).skillMd !== skillMd) throw new Error('Metadata.skillMd did not round-trip.')
      return 'Metadata matches'
    })
    await check('CreateAgent', async () => {
      await call('CreateAgent', { Name: agentName, Description: 'OpenADA smoke test', Skills: [{ name: skillName }] })
      agentCreated = true
      return agentName
    })
  }
  if (agentCreated) {
    await check('GetAgent read back', async () => {
      const agent = await call('GetAgent', { Name: agentName }) as Record<string, unknown>
      if (referenceNames(agent.Skills)[0] !== skillName) throw new Error('Skills did not round-trip.')
      return 'Skills match'
    })
    await check('DeleteAgent', async () => {
      await call('DeleteAgent', { Name: agentName })
      return 'deleted'
    })
  }
  if (skillCreated) {
    await check('DeleteSkill', async () => {
      await call('DeleteSkill', { Name: skillName })
      return 'deleted'
    })
  }
}

console.log(`\nOpenADA smoke test, region ${context.region}\n`)
await check('ListModels', async () => {
  const models = asObjects((await call('ListModels', { ModelType: 'text', MaxResults: 20 }) as Record<string, unknown>).Models)
  if (models.length === 0) throw new Error('No visible models.')
  return `${models.length} models, first Id=${String(models[0]?.Id)}`
})
await check('ListAgents', async () => {
  const agents = asObjects((await call('ListAgents', { MaxResults: 20 }) as Record<string, unknown>).Agents)
  if (agents.length > 0 && !agents[0]?.name) throw new Error('Agent items have no `name` field.')
  return `${agents.length} agents, first name=${String(agents[0]?.name)}`
})
await check('ListSkills', async () => {
  const skills = asObjects((await call('ListSkills', { MaxResults: 20 }) as Record<string, unknown>).Skills)
  return `${skills.length} skills`
})
await check('ListAgentSessions', async () => {
  const result = rpcResult(await call('ListAgentSessions', rpcBody({ MaxResults: 5 })))
  return `${asArray(result.SessionList).length} sessions`
})

const chatFlag = process.argv.indexOf('--chat')
if (chatFlag >= 0) {
  const agentName = process.argv[chatFlag + 1]
  if (!agentName) {
    console.error('Usage: npm run smoke -- --chat <agent-name>')
    process.exit(2)
  }
  await chat(agentName)
}
if (process.argv.includes('--write')) await writes()

console.log(failed ? `\n${failed} check(s) failed.\n` : '\nAll checks passed.\n')
process.exit(failed ? 1 : 0)
