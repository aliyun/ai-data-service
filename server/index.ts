import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEndpointOverride } from './ada-client.ts'
import { createApp } from './app.ts'
import { ConfigStore } from './config.ts'

// The gateway holds an AccessKey, so it listens on loopback unless an access token guards the API.
const HOST = process.env.OPEN_ADA_HOST ?? '127.0.0.1'
const LOOPBACK = ['127.0.0.1', 'localhost', '::1']
const MIN_TOKEN_LENGTH = 32
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.OPEN_ADA_PORT ?? 8787)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('OPEN_ADA_PORT must be a valid port number.')
  process.exit(1)
}

const accessToken = process.env.OPEN_ADA_ACCESS_TOKEN || undefined
if (accessToken && accessToken.length < MIN_TOKEN_LENGTH) {
  console.error(`OPEN_ADA_ACCESS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`)
  process.exit(1)
}
if (!LOOPBACK.includes(HOST) && !accessToken) {
  console.error('OPEN_ADA_HOST is not a loopback address. Set OPEN_ADA_ACCESS_TOKEN to protect the API.')
  process.exit(1)
}

const publicOrigins = (process.env.OPEN_ADA_PUBLIC_ORIGIN ?? '').split(',').map((value) => value.trim()).filter(Boolean)
for (const origin of publicOrigins) {
  if (new URL(origin).protocol !== 'https:') {
    console.error('OPEN_ADA_PUBLIC_ORIGIN must use https.')
    process.exit(1)
  }
}

const endpointOverride = resolveEndpointOverride(process.env.OPEN_ADA_ENDPOINT)
const devOrigins = process.env.OPEN_ADA_DEV_ORIGIN ? [process.env.OPEN_ADA_DEV_ORIGIN] : []
const config = new ConfigStore(process.env.OPEN_ADA_ENV_FILE ?? path.join(ROOT, '.env.local'))

const server = createApp({
  config,
  staticDir: path.join(ROOT, 'dist'),
  port,
  devOrigins,
  publicOrigins,
  ...(accessToken ? { accessToken } : {}),
  ...(endpointOverride ? { endpointOverride } : {}),
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is in use. Set OPEN_ADA_PORT to another port.`
      : `Could not start OpenADA: ${error.message}`,
  )
  process.exit(1)
})

server.listen(port, HOST, () => {
  console.log(`\n  OpenADA is running at http://${HOST}:${port}\n`)
  if (endpointOverride) console.log(`  ADA endpoint override: ${endpointOverride.origin}\n`)
  if (!config.credentials()) console.log('  Open the page above and enter your AccessKey to get started.\n')
})
