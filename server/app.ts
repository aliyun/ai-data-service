// HTTP layer of the local gateway: request guards, static assets, configuration and the ADA proxy.
import { timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import path from 'node:path'
import { REGIONS, getAction, isRegion } from './actions.ts'
import { AdaApiError, callAction, openStream, type ClientContext } from './ada-client.ts'
import type { ConfigStore } from './config.ts'
import { SseDecoder, normalizeFrame } from './sse.ts'

const MAX_BODY_BYTES = 1024 * 1024
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Agent output is untrusted. Blocking remote images stops markdown from leaking data through image URLs.
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export interface AppOptions {
  config: ConfigStore
  staticDir: string
  port: number
  endpointOverride?: URL
  /** Extra origins that may call the API, used only by the Vite dev server. */
  devOrigins?: readonly string[]
  /** https origins the gateway is published under when it runs remotely, for example on Function Compute. */
  publicOrigins?: readonly string[]
  /** When set, every `/api/` request must carry `Authorization: Bearer <token>`. Required off loopback. */
  accessToken?: string
}

class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (error instanceof AdaApiError) {
    sendJson(res, error.status, { code: error.code, message: error.message, requestId: error.requestId })
  } else if (error instanceof HttpError) {
    sendJson(res, error.status, { code: error.code, message: error.message })
  } else if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    sendJson(res, 504, { code: 'UpstreamTimeout', message: '请求 ADA 接口超时，结果未知。' })
  } else {
    // Lower level errors can carry request details, so only a fixed message leaves the process.
    console.error('[open-ada] request failed:', error instanceof Error ? error.name : 'unknown error')
    sendJson(res, 502, { code: 'UpstreamUnavailable', message: '无法连接 ADA 接口，请检查网络。' })
  }
}

/**
 * DNS rebinding and cross-site request protection. The gateway signs requests with the user's AccessKey, so any
 * web page must be unable to reach it: the Host must be this loopback server, and browsers always attach an Origin
 * to the POST requests that matter here.
 */
export function isAllowedRequest(
  headers: IncomingMessage['headers'],
  method: string,
  port: number,
  devOrigins: readonly string[] = [],
  publicOrigins: readonly string[] = [],
): boolean {
  const allowedOrigins = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].map((host) => `http://${host}`))
  for (const origin of [...devOrigins, ...publicOrigins]) allowedOrigins.add(new URL(origin).origin)
  const allowedHosts = new Set([...allowedOrigins].map((origin) => new URL(origin).host))
  if (!headers.host || !allowedHosts.has(headers.host)) return false
  const origin = headers.origin
  if (origin !== undefined) return allowedOrigins.has(origin)
  // Same-origin GETs may omit Origin; a non-GET without it does not come from a page we serve.
  return method === 'GET' || method === 'HEAD'
}

/** Constant-time comparison, so response timing does not reveal how much of a guessed token was right. */
export function hasAccessToken(headers: IncomingMessage['headers'], token: string): boolean {
  const match = /^Bearer (.+)$/.exec(headers.authorization ?? '')
  if (!match) return false
  const given = Buffer.from(match[1] as string)
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // A JSON content type forces a CORS preflight on cross-origin requests, which this server never answers.
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UnsupportedMediaType', 'Content-Type must be application/json.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PayloadTooLarge', 'The request body is too large.')
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  } catch {
    throw new HttpError(400, 'InvalidJson', 'The request body is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'InvalidJson', 'The request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'InvalidParameter', `${field} is required.`)
  return value.trim()
}

function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): void {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname)
  } catch {
    throw new HttpError(400, 'InvalidPath', 'The request path is invalid.')
  }
  const root = path.resolve(staticDir)
  const candidate = path.resolve(root, `.${pathname}`)
  const insideRoot = candidate === root || candidate.startsWith(`${root}${path.sep}`)
  const asset = insideRoot && existsSync(candidate) && statSync(candidate).isFile() ? candidate : path.join(root, 'index.html')
  if (!existsSync(asset)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Web assets are missing. Run `npm run build` first.\n')
    return
  }
  const immutable = asset.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'content-type': MIME[path.extname(asset)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  createReadStream(asset).pipe(res)
}

export function createApp(options: AppOptions): Server {
  const { config, staticDir, port, endpointOverride, devOrigins = [], publicOrigins = [], accessToken } = options

  function context(): ClientContext {
    const credentials = config.credentials()
    if (!credentials) throw new HttpError(401, 'NotConfigured', '尚未配置阿里云 AccessKey。')
    return { credentials, region: config.region(), ...(endpointOverride ? { endpointOverride } : {}) }
  }

  async function handleSetup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (config.managedByEnv) {
      throw new HttpError(409, 'ManagedByEnvironment', '当前凭证来自环境变量，请修改环境变量后重启。')
    }
    const body = await readJson(req)
    const accessKeyId = requiredText(body, 'accessKeyId')
    const accessKeySecret = requiredText(body, 'accessKeySecret')
    const securityToken = typeof body.securityToken === 'string' ? body.securityToken.trim() : ''
    if (!isRegion(body.region)) throw new HttpError(400, 'InvalidParameter', '不支持的地域。')
    const credentials = { accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}) }
    // Verify before saving, so a mistyped key cannot replace a working one.
    const probe: ClientContext = {
      credentials,
      region: body.region,
      ...(endpointOverride ? { endpointOverride } : {}),
    }
    await callAction(probe, 'ListModels', getAction('ListModels')!, { ModelType: 'text', MaxResults: 1 })
    config.saveCredentials({ accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}), region: body.region })
    sendJson(res, 200, config.status(REGIONS))
  }

  async function handleRegion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (config.regionManagedByEnv) {
      throw new HttpError(409, 'ManagedByEnvironment', '当前地域来自环境变量 ADA_REGION。')
    }
    const body = await readJson(req)
    if (!isRegion(body.region)) throw new HttpError(400, 'InvalidParameter', '不支持的地域。')
    config.saveRegion(body.region)
    sendJson(res, 200, config.status(REGIONS))
  }

  async function handleCall(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
    const spec = getAction(action)
    if (!spec || spec.stream) throw new HttpError(404, 'UnknownAction', '不支持的接口。')
    const params = await readJson(req)
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    sendJson(res, 200, await callAction(context(), action, spec, params, abort.signal))
  }

  async function handleStream(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
    const spec = getAction(action)
    if (!spec?.stream) throw new HttpError(404, 'UnknownAction', '不支持的接口。')
    const params = await readJson(req)
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    const upstream = await openStream(context(), action, spec, params, abort.signal)
    const requestId = upstream.headers.get('x-acs-request-id')
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    })
    res.write(': connected\n\n')
    const decoder = new SseDecoder((data) => {
      let raw: unknown
      try {
        raw = JSON.parse(data)
      } catch {
        return
      }
      const frame = normalizeFrame(raw)
      if (frame) res.write(`data: ${JSON.stringify(frame)}\n\n`)
    })
    const text = new TextDecoder()
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        decoder.push(text.decode(chunk, { stream: true }))
      }
      decoder.end()
    } catch (error) {
      // The browser treats a stream end without a terminal frame as "result unknown" and resumes with Load.
      if (!abort.signal.aborted) console.error('[open-ada] upstream stream ended:', error instanceof Error ? error.name : 'unknown')
    }
    res.end()
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    if (!isAllowedRequest(req.headers, method, port, devOrigins, publicOrigins)) {
      throw new HttpError(403, 'ForbiddenOrigin', '只允许从本服务的页面访问。')
    }
    const pathname = new URL(req.url ?? '/', 'http://local').pathname
    // Static assets hold no secrets; everything under /api/ can spend the account's money.
    if (accessToken && pathname.startsWith('/api/') && !hasAccessToken(req.headers, accessToken)) {
      throw new HttpError(401, 'Unauthorized', '需要访问令牌。')
    }
    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'MethodNotAllowed', 'Method not allowed.')
      return serveStatic(req, res, staticDir)
    }
    if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, config.status(REGIONS))
    if (method !== 'POST') throw new HttpError(405, 'MethodNotAllowed', 'Method not allowed.')
    if (pathname === '/api/config/credentials') return handleSetup(req, res)
    if (pathname === '/api/config/region') return handleRegion(req, res)
    if (pathname === '/api/config/clear') {
      if (config.managedByEnv) throw new HttpError(409, 'ManagedByEnvironment', '当前凭证来自环境变量，无法在页面清除。')
      await readJson(req)
      config.clearCredentials()
      return sendJson(res, 200, config.status(REGIONS))
    }
    const stream = /^\/api\/ada\/([A-Za-z]+)\/stream$/.exec(pathname)
    if (stream) return handleStream(req, res, stream[1] as string)
    const call = /^\/api\/ada\/([A-Za-z]+)$/.exec(pathname)
    if (call) return handleCall(req, res, call[1] as string)
    throw new HttpError(404, 'NotFound', 'Not found.')
  }

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => sendError(res, error))
  })
}
