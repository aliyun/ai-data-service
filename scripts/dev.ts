// Runs the gateway and the Vite dev server together. Open http://127.0.0.1:5173, or the port in OPEN_ADA_DEV_PORT.
import { spawn, type ChildProcess } from 'node:child_process'

const children: ChildProcess[] = []

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  child.on('exit', (code) => {
    for (const other of children) other.kill()
    process.exit(code ?? 0)
  })
  children.push(child)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill()
    process.exit(0)
  })
}

run(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', 'server/index.ts'], {
  OPEN_ADA_DEV_ORIGIN: `http://127.0.0.1:${process.env.OPEN_ADA_DEV_PORT ?? 5173}`,
})
run(process.execPath, ['node_modules/vite/bin/vite.js'])
