// Credential and region storage. Secrets live in process memory and in a git-ignored, owner-only `.env.local`.
// Nothing in this module returns a secret to the HTTP layer except through `credentials()`, which is only used for
// signing.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Credentials } from './acs3.ts'
import { isRegion, type Region } from './actions.ts'

const KEY_ID = 'ALIBABA_CLOUD_ACCESS_KEY_ID'
const KEY_SECRET = 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'
const SECURITY_TOKEN = 'ALIBABA_CLOUD_SECURITY_TOKEN'
const REGION = 'ADA_REGION'
const DEFAULT_REGION: Region = 'cn-hangzhou'

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match || line.trimStart().startsWith('#')) continue
    values[match[1] as string] = unquote(match[2] ?? '')
  }
  return values
}

/** Double-quoted values are JSON strings, which is how `persist` writes them, so every value round-trips. */
function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2 ? raw.slice(1, -1) : raw
}

/** Long enough to identify which key is in use; the secret is never shown in any form. */
export function maskKeyId(keyId: string): string {
  return keyId.length <= 8 ? '****' : `${keyId.slice(0, 4)}****${keyId.slice(-4)}`
}

export interface ConfigStatus {
  configured: boolean
  region: Region
  regions: readonly Region[]
  accessKeyIdMasked?: string
  /** `env` credentials come from the process environment and cannot be replaced from the UI. */
  source?: 'env' | 'file'
  usesSecurityToken: boolean
}

export interface ConfigInput {
  accessKeyId: string
  accessKeySecret: string
  securityToken?: string
  region: Region
}

export class ConfigStore {
  private readonly file: string
  private readonly env: NodeJS.ProcessEnv
  private fromFile: Record<string, string> = {}

  constructor(file: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = path.resolve(file)
    this.env = env
    if (existsSync(this.file)) this.fromFile = parseEnvFile(readFileSync(this.file, 'utf8'))
  }

  private get envHasCredentials(): boolean {
    return Boolean(this.env[KEY_ID] && this.env[KEY_SECRET])
  }

  credentials(): Credentials | undefined {
    const source = this.envHasCredentials ? this.env : this.fromFile
    const accessKeyId = source[KEY_ID]
    const accessKeySecret = source[KEY_SECRET]
    if (!accessKeyId || !accessKeySecret) return undefined
    const securityToken = source[SECURITY_TOKEN]
    return { accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}) }
  }

  region(): Region {
    const candidate = this.env[REGION] ?? this.fromFile[REGION]
    return isRegion(candidate) ? candidate : DEFAULT_REGION
  }

  status(regions: readonly Region[]): ConfigStatus {
    const credentials = this.credentials()
    return {
      configured: Boolean(credentials),
      region: this.region(),
      regions,
      usesSecurityToken: Boolean(credentials?.securityToken),
      ...(credentials
        ? {
            accessKeyIdMasked: maskKeyId(credentials.accessKeyId),
            source: this.envHasCredentials ? ('env' as const) : ('file' as const),
          }
        : {}),
    }
  }

  get managedByEnv(): boolean {
    return this.envHasCredentials
  }

  get regionManagedByEnv(): boolean {
    return Boolean(this.env[REGION])
  }

  saveCredentials(input: ConfigInput): void {
    const next: Record<string, string> = {
      ...this.fromFile,
      [KEY_ID]: input.accessKeyId,
      [KEY_SECRET]: input.accessKeySecret,
      [REGION]: input.region,
    }
    if (input.securityToken) next[SECURITY_TOKEN] = input.securityToken
    else delete next[SECURITY_TOKEN]
    this.persist(next)
  }

  saveRegion(region: Region): void {
    this.persist({ ...this.fromFile, [REGION]: region })
  }

  clearCredentials(): void {
    const next = { ...this.fromFile }
    delete next[KEY_ID]
    delete next[KEY_SECRET]
    delete next[SECURITY_TOKEN]
    this.persist(next)
  }

  /** Write-then-rename, so a crash cannot leave a half written secret file. */
  private persist(values: Record<string, string>): void {
    const text = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${text}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, this.file)
    this.fromFile = values
  }
}
