// Calls the ADA OpenAPI with a signed request. Business fields stay opaque here: the gateway checks where a
// parameter goes and how it is serialized, the web client owns what it means.
import { canonicalQuery, signRequest, type Credentials } from './acs3.ts'
import { API_VERSION, type ActionSpec, type Region } from './actions.ts'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'
const REQUEST_TIMEOUT_MS = 60_000
const STREAM_CONNECT_TIMEOUT_MS = 30_000

export class AdaApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(message)
    this.name = 'AdaApiError'
    this.code = code
    this.status = status
    if (requestId) this.requestId = requestId
  }
}

export interface ClientContext {
  credentials: Credentials
  region: Region
  /** Set only by trusted local configuration; see `resolveEndpointOverride`. */
  endpointOverride?: URL
}

export function publicEndpoint(region: Region): URL {
  return new URL(`https://ada.${region}.aliyuncs.com/`)
}

/**
 * `OPEN_ADA_ENDPOINT` exists for the mock server. It must not become a way to ship signed requests somewhere
 * unexpected, so it accepts https, or plain http on loopback only.
 */
export function resolveEndpointOverride(raw: string | undefined): URL | undefined {
  if (!raw) return undefined
  const url = new URL(raw)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('OPEN_ADA_ENDPOINT must use https, or http on a loopback address')
  }
  return url
}

/** Structured values are JSON encoded exactly once; `Params` carries style=json in the API metadata. */
function serialize(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function pick(names: readonly string[], params: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const name of names) {
    const value = params[name]
    if (value !== undefined && value !== null) picked[name] = serialize(value)
  }
  return picked
}

export function buildRequest(
  context: ClientContext,
  action: string,
  spec: ActionSpec,
  params: Record<string, unknown>,
): { url: string; init: RequestInit } {
  const endpoint = context.endpointOverride ?? publicEndpoint(context.region)
  const query = pick(spec.query, params)
  const form = pick(spec.form, params)
  // canonicalQuery produces RFC 3986 encoding, which is also a valid form body.
  const body = canonicalQuery(form)
  const signed = signRequest({
    method: spec.method,
    host: endpoint.host,
    action,
    version: API_VERSION,
    query,
    body,
    ...(body ? { contentType: FORM_CONTENT_TYPE } : {}),
    credentials: context.credentials,
  })
  const url = `${endpoint.origin}/${signed.queryString ? `?${signed.queryString}` : ''}`
  return { url, init: { method: spec.method, headers: signed.headers, ...(body ? { body } : {}) } }
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export async function errorFromResponse(response: Response): Promise<AdaApiError> {
  const text = await response.text().catch(() => '')
  let envelope: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') envelope = parsed as Record<string, unknown>
  } catch {
    // Non-JSON gateway errors fall through to the status based message.
  }
  return new AdaApiError(
    asText(envelope.Code) ?? asText(envelope.code) ?? `HTTP_${response.status}`,
    asText(envelope.Message) ?? asText(envelope.message) ?? `The ADA API returned HTTP ${response.status}.`,
    response.status,
    asText(envelope.RequestId) ?? response.headers.get('x-acs-request-id') ?? undefined,
  )
}

export async function callAction(
  context: ClientContext,
  action: string,
  spec: ActionSpec,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { url, init } = buildRequest(context, action, spec, params)
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw await errorFromResponse(response)
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AdaApiError('InvalidResponse', 'The ADA API returned a response that is not JSON.', 502)
  }
}

/** Opens an SSE action. Only the connection phase has a timeout, a long running turn must not be cut off. */
export async function openStream(
  context: ClientContext,
  action: string,
  spec: ActionSpec,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const { url, init } = buildRequest(context, action, spec, params)
  const connect = new AbortController()
  const timer = setTimeout(() => connect.abort(), STREAM_CONNECT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), accept: 'text/event-stream' },
      signal: AbortSignal.any([signal, connect.signal]),
    })
    if (!response.ok) throw await errorFromResponse(response)
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
      // POP can report a business failure as a JSON body on a 200 response.
      throw await errorFromResponse(response)
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}
