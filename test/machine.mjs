/**
 * One machine, in its own process, for `test/two-machines.mjs`.
 *
 * Boots the real host half against a fresh `DSH_HOME`, serves `/_dsh/lan/*` on
 * an ephemeral local port and prints a single line of JSON once it is ready.
 * Nothing here is used by the plugin itself.
 *
 * Env: LAN_TEST_HOME, LAN_TEST_ROLE, LAN_TEST_PORT, LAN_TEST_TOKEN,
 *      LAN_TEST_MACHINE_ID, LAN_TEST_NAME, LAN_TEST_HUB_HOST, LAN_TEST_HUB_PORT,
 *      LAN_TEST_SESSION_ID
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'

const home = process.env.LAN_TEST_HOME
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'
delete process.env.DSH_PROFILE_DIR

function frame(objects) {
  const text = objects.map(function (object) { return JSON.stringify(object) }).join('\n') + '\n'
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

const sessionId = process.env.LAN_TEST_SESSION_ID || 'session-11111111-2222-3333-4444-555555555555'
const cwd = path.join(home, 'work')
await fs.mkdir(cwd, { recursive: true })
await fs.writeFile(path.join(cwd, 'owned-by-' + (process.env.LAN_TEST_MACHINE_ID || 'x') + '.txt'), 'hello', 'utf8')

const sessionDir = path.join(home, 'sessions', '--w--', sessionId)
await fs.mkdir(sessionDir, { recursive: true })
await fs.writeFile(
  path.join(sessionDir, 'session.v4.jsonl.zstd'),
  Buffer.concat([
    frame([{ type: 'session', version: 4, id: sessionId, createdAt: Date.now() - 10000, cwd }]),
    frame([
      { type: 'user/message', seq: 1, time: Date.now() - 9000, data: { content: [{ type: 'text', text: '在 ' + (process.env.LAN_TEST_NAME || '') + ' 上提问' }] } },
      {
        type: 'assistant/message',
        seq: 2,
        time: Date.now() - 8000,
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '思考过程：先查一下。' },
              { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"echo hi"}' },
              { type: 'text', text: '最终答案。' }
            ]
          }
        }
      },
      { type: 'tool/result', seq: 3, time: Date.now() - 7000, data: { message: { toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'session/title', seq: 4, time: Date.now() - 6000, data: { title: (process.env.LAN_TEST_NAME || '') + ' 的会话' } }
    ])
  ])
)

await fs.writeFile(
  path.join(home, 'MEMORY.md'),
  '- MEMORY-MARKER-' + String(process.env.LAN_TEST_MACHINE_ID || 'machine').toUpperCase() + '\n',
  'utf8'
)

const config = await import('../lib/config.js')
await config.load()
await config.update({
  role: process.env.LAN_TEST_ROLE || 'hub',
  port: Number(process.env.LAN_TEST_PORT || 47890),
  token: process.env.LAN_TEST_TOKEN,
  machineId: process.env.LAN_TEST_MACHINE_ID,
  machineName: process.env.LAN_TEST_NAME,
  hubHost: process.env.LAN_TEST_HUB_HOST || '127.0.0.1',
  hubPort: Number(process.env.LAN_TEST_HUB_PORT || 47890),
  discovery: false,
  autoSync: true,
  pushIntervalMs: 700,
  pullIntervalMs: 700
})

const cleanups = []
let handler = null
const fakeCtx = {
  get() {
    return null
  },
  on() {
    return function () {}
  },
  effect(fn) {
    const result = fn()
    cleanups.push(result)
    return function () {
      if (typeof result === 'function') result()
    }
  },
  webServer: {
    register(def) {
      handler = def.handler
      return function () {}
    }
  }
}

const plugin = await import('../index.js')
plugin.apply(fakeCtx)

const server = http.createServer(function (req, res) {
  if (!handler) {
    res.statusCode = 503
    res.end('not ready')
    return
  }
  handler(req, res)
})
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
const localPort = server.address().port

async function shutdown() {
  for (const cleanup of cleanups) {
    try {
      if (typeof cleanup === 'function') cleanup()
    } catch (err) {
      /* ignore */
    }
  }
  await new Promise(function (resolve) { server.close(resolve) })
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.stdout.write(JSON.stringify({ ready: true, localPort, home, machineId: process.env.LAN_TEST_MACHINE_ID }) + '\n')
