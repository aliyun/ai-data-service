// Alibaba Cloud V3 request signature (ACS3-HMAC-SHA256).
// Spec: https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
// The published SDK for Ada/2026-07-01 has no session or SSE operations, so requests are signed here.
import { createHash, createHmac, randomUUID } from 'node:crypto'

export const ALGORITHM = 'ACS3-HMAC-SHA256'

export interface Credentials {
  accessKeyId: string
  accessKeySecret: string
  securityToken?: string
}

export interface SignInput {
  method: 'GET' | 'POST'
  host: string
  action: string
  version: string
  query: Record<string, string>
  body: string
  contentType?: string
  credentials: Credentials
  /** Fixed values for the signature test vector; generated when omitted. */
  date?: string
  nonce?: string
}

export interface SignedRequest {
  queryString: string
  headers: Record<string, string>
}

/** RFC 3986 encoding: `encodeURIComponent` leaves `!'()*` unescaped, the canonical form must not. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function acsDate(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Rebuilds the signature from request parts. Also used by the mock server to verify requests. */
export function computeSignature(parts: {
  method: string
  query: string
  headers: Record<string, string>
  signedHeaders: string[]
  payloadHash: string
  secret: string
}): string {
  const canonicalHeaders = parts.signedHeaders
    .map((name) => `${name}:${(parts.headers[name] ?? '').trim()}\n`)
    .join('')
  const canonicalRequest = [
    parts.method,
    '/',
    parts.query,
    canonicalHeaders,
    parts.signedHeaders.join(';'),
    parts.payloadHash,
  ].join('\n')
  const stringToSign = `${ALGORITHM}\n${sha256Hex(canonicalRequest)}`
  return createHmac('sha256', parts.secret).update(stringToSign, 'utf8').digest('hex')
}

export function signRequest(input: SignInput): SignedRequest {
  const payloadHash = sha256Hex(input.body)
  const signable: Record<string, string> = {
    host: input.host,
    'x-acs-action': input.action,
    'x-acs-content-sha256': payloadHash,
    'x-acs-date': input.date ?? acsDate(),
    'x-acs-signature-nonce': input.nonce ?? randomUUID(),
    'x-acs-version': input.version,
  }
  if (input.credentials.securityToken) {
    signable['x-acs-security-token'] = input.credentials.securityToken
  }
  const signedHeaders = Object.keys(signable).sort()
  const queryString = canonicalQuery(input.query)
  const signature = computeSignature({
    method: input.method,
    query: queryString,
    headers: signable,
    signedHeaders,
    payloadHash,
    secret: input.credentials.accessKeySecret,
  })
  const headers: Record<string, string> = {
    ...signable,
    Authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId},` +
      `SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`,
  }
  if (input.contentType) headers['content-type'] = input.contentType
  return { queryString, headers }
}
