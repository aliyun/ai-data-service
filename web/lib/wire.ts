// Decoders for ADA API responses. Fields typed `any` in the API can arrive as JSON text, and the outer key casing
// differs between operations (`JsonRpcResponse.result` and `JsonRpcResponse.Result`), so readers accept both.
export type Json = Record<string, unknown>

export function decodeAny(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function asObject(value: unknown): Json {
  const decoded = decodeAny(value)
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? (decoded as Json) : {}
}

export function asArray(value: unknown): unknown[] {
  const decoded = decodeAny(value)
  return Array.isArray(decoded) ? decoded : []
}

export function asObjects(value: unknown): Json[] {
  return asArray(value).map(asObject)
}

export function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Reads a paging token. An empty token, including the JSON text `""`, means there are no more pages. */
export function pageToken(value: unknown): string | undefined {
  const decoded = decodeAny(value)
  return typeof decoded === 'string' && decoded !== '' ? decoded : undefined
}

export class RpcError extends Error {
  readonly code: string
  readonly requestId?: string

  constructor(code: string, message: string, requestId?: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    if (requestId) this.requestId = requestId
  }
}

/** Returns the business result of a JSON-RPC style operation, or throws its embedded error. */
export function rpcResult(response: unknown): Json {
  const envelope = asObject(response)
  const requestId = asText(envelope.RequestId) || undefined
  const rpc = asObject(envelope.JsonRpcResponse)
  const error = asObject(rpc.error ?? rpc.Error)
  if (Object.keys(error).length > 0) {
    throw new RpcError(
      asText(error.errorCode) || String(error.code ?? 'RpcError'),
      asText(error.message) || 'ADA 接口返回错误。',
      requestId,
    )
  }
  if (envelope.Success === false) {
    throw new RpcError(asText(envelope.Code) || 'OperationFailed', asText(envelope.Message) || '操作未成功。', requestId)
  }
  return asObject(rpc.result ?? rpc.Result)
}
