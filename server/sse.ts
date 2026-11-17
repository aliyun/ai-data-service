// SSE parsing and frame normalization for PromptAgentSession / LoadAgentSession.
// Upstream frames use `Jsonrpc`/`Id`/`Method`/`Params`/`Result`/`Error`, whose `any` values may arrive as JSON text.
// The browser receives one normalized lowerCamelCase shape.

export interface Frame {
  jsonrpc: '2.0'
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; errorCode?: string; message?: string }
  requestId?: string
}

function decodeAny(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function normalizeFrame(raw: unknown): Frame | undefined {
  const source = asObject(raw)
  if (!source) return undefined
  const read = (pascal: string, camel: string): unknown => source[pascal] ?? source[camel]
  const frame: Frame = { jsonrpc: '2.0' }
  const id = read('Id', 'id')
  if (typeof id === 'string' || typeof id === 'number') frame.id = id
  const method = read('Method', 'method')
  if (typeof method === 'string' && method) frame.method = method
  const params = asObject(decodeAny(read('Params', 'params')))
  if (params) frame.params = params
  const result = asObject(decodeAny(read('Result', 'result')))
  if (result) frame.result = result
  const error = asObject(decodeAny(read('Error', 'error')))
  if (error) frame.error = error
  const requestId = read('RequestId', 'requestId')
  if (typeof requestId === 'string' && requestId) frame.requestId = requestId
  return frame.method || frame.result || frame.error ? frame : undefined
}

/** Incremental SSE decoder. Accepts LF, CRLF and CR line endings, including a CRLF split across chunks. */
export class SseDecoder {
  private buffer = ''
  private readonly onData: (data: string) => void

  constructor(onData: (data: string) => void) {
    this.onData = onData
  }

  push(chunk: string): void {
    this.buffer += chunk
    this.drain(false)
  }

  end(): void {
    this.drain(true)
  }

  private drain(final: boolean): void {
    const held = !final && this.buffer.endsWith('\r') ? '\r' : ''
    const source = held ? this.buffer.slice(0, -1) : this.buffer
    const events = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n\n')
    const rest = final ? '' : (events.pop() ?? '')
    this.buffer = `${rest}${held}`
    for (const event of events) {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
        .join('\n')
      if (data) this.onData(data)
    }
  }
}
