// Browser side of the gateway. All requests go to the gateway that served this page, which holds the AccessKey.
import type { ConfigStatus } from '../../server/config.ts'
import type { Frame } from '../../server/sse.ts'
import type { SessionTransport } from './session-controller.ts'
import { rpcResult } from './wire.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (requestId) this.requestId = requestId
  }
}

async function failure(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string; requestId?: string }
  return new ApiError(response.status, body.code ?? `HTTP_${response.status}`, body.message ?? `请求失败（HTTP ${response.status}）。`, body.requestId)
}

const TOKEN_KEY = 'open-ada.access-token'

/** A gateway published remotely guards its API with an access token; a local one ignores the header. */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const send = (): Promise<Response> => {
    const token = localStorage.getItem(TOKEN_KEY)
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetch(path, { ...init, headers })
  }
  let response = await send()
  if (response.status === 401 && (await response.clone().json().catch(() => ({})) as { code?: string }).code === 'Unauthorized') {
    const token = window.prompt('请输入访问令牌')?.trim()
    if (token) {
      localStorage.setItem(TOKEN_KEY, token)
      response = await send()
    }
  }
  if (!response.ok) throw await failure(response)
  return response
}

function post(path: string, body: object, signal?: AbortSignal): Promise<Response> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
}

export async function callAda(action: string, params: object = {}): Promise<Record<string, unknown>> {
  const response = await post(`/api/ada/${action}`, params)
  return (await response.json()) as Record<string, unknown>
}

export function rpcBody(params: object): { Jsonrpc: string; Id: string; Params: object } {
  return { Jsonrpc: '2.0', Id: crypto.randomUUID(), Params: params }
}

export async function getConfig(): Promise<ConfigStatus> {
  return (await (await request('/api/config')).json()) as ConfigStatus
}

export async function saveCredentials(input: { accessKeyId: string; accessKeySecret: string; securityToken?: string; region: string }): Promise<ConfigStatus> {
  return (await (await post('/api/config/credentials', input)).json()) as ConfigStatus
}

export async function saveRegion(region: string): Promise<ConfigStatus> {
  return (await (await post('/api/config/region', { region })).json()) as ConfigStatus
}

export async function clearCredentials(): Promise<ConfigStatus> {
  return (await (await post('/api/config/clear', {})).json()) as ConfigStatus
}

async function readFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal, onFrame: (frame: Frame) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const stop = (): void => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', stop, { once: true })
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      // The gateway always writes LF-delimited events with a single data line.
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        if (event.startsWith('data: ')) onFrame(JSON.parse(event.slice(6)) as Frame)
      }
    }
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

export const browserTransport: SessionTransport = {
  async stream(action, body, signal, onFrame) {
    try {
      const response = await post(`/api/ada/${action}/stream`, body, signal)
      if (!response.body) return
      await readFrames(response.body, signal, onFrame)
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
  },
  async rpc(action, body) {
    return rpcResult(await callAda(action, body))
  },
  newId: () => crypto.randomUUID(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    }),
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId ? `${error.message}（${error.code}，RequestId: ${error.requestId}）` : `${error.message}（${error.code}）`
  }
  return error instanceof Error ? error.message : '发生未知错误。'
}
