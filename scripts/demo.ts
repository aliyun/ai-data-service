// Try the product without an AccessKey: the gateway talks to the bundled mock ADA service, with throwaway credentials.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MOCK_ACCESS_KEY_ID, MOCK_ACCESS_KEY_SECRET, createMockAda } from './mock-ada.ts'

const mockPort = Number(process.env.OPEN_ADA_MOCK_PORT ?? 8788)

if (!existsSync('dist/index.html')) {
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const mock = createMockAda()
mock.listen(mockPort, '127.0.0.1', () => {
  console.log(`\n  Mock ADA service: http://127.0.0.1:${mockPort}`)
  console.log('  This is DEMO mode. Nothing is sent to Alibaba Cloud.')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPEN_ADA_ENDPOINT: `http://127.0.0.1:${mockPort}/`,
    OPEN_ADA_ENV_FILE: path.join(mkdtempSync(path.join(tmpdir(), 'open-ada-demo-')), '.env.local'),
    ALIBABA_CLOUD_ACCESS_KEY_ID: MOCK_ACCESS_KEY_ID,
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: MOCK_ACCESS_KEY_SECRET,
  }
  delete env.ALIBABA_CLOUD_SECURITY_TOKEN
  const gateway = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], { stdio: 'inherit', env })
  gateway.on('exit', (code) => process.exit(code ?? 0))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      gateway.kill()
      process.exit(0)
    })
  }
})
