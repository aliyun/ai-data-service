// Plain JavaScript on purpose: it has to run on Node versions that cannot strip TypeScript types.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`OpenADA requires Node.js 22.18 or newer, but this is ${process.versions.node}.`)
  process.exit(1)
}
