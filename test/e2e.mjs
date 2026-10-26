/**
 * dsh-lan-bridge — end-to-end test without DSH.
 *
 * Boots the real host half (`apply`) against a fake cordis context, then drives
 * both surfaces:
 *
 *   · the local one at `/_dsh/lan/*` (what the panel calls), and
 *   · the LAN one on 127.0.0.1:47888 (what the other machine calls),
 *
 * acting as a second machine through `createPeer`. Nothing outside a temp
 * directory is written.
 *
 *   node test/e2e.mjs
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const PORT = 47888
const LOCAL_PORT = 47999
const TOKEN = 'e2e-token-0123456789abcdef'

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-bridge-e2e-'))
process.env.DSH_HOME = tempHome
process.env.DSH_PROFILE = 'desktop'
delete process.env.DSH_PROFILE_DIR

const steps = []
async function step(label, fn) {
  try {
    await fn()
    steps.push({ label, ok: true })
    console.log('ok   ' + label)
  } catch (err) {
    steps.push({ label, ok: false, message: String((err && err.stack) || err) })
    console.log('FAIL ' + label)
    console.log('     ' + String((err && err.message) || err))
    throw err
  }
}

// A session to export, written in the real on-disk shape.
function frame(events) {
  const text = events.map(function (event) { return JSON.stringify(event) }).join('\n') + '\n'
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}
const sessionId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const header = { type: 'session', version: 4, id: sessionId, createdAt: Date.now() - 30000, cwd: tempHome }
const events = [
  { type: 'turn/start', seq: 1, time: Date.now() - 29000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: Date.now() - 28000, data: { content: [{ type: 'text', text: '两台机器怎么连' }] } },
  {
    type: 'assistant/message',
    seq: 3,
    time: Date.now() - 27000,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先解释角色，再说端口。' },
          { type: 'text', text: '一台做主机，另一台做成员。' },
          { type: 'tool-call', id: 'call_x', name: 'pwsh', arguments: '{"command":"ipconfig"}' }
        ]
      }
    }
  },
  { type: 'tool/result', seq: 4, time: Date.now() - 26000, data: { message: { toolCallId: 'call_x', isError: false, content: [{ type: 'text', text: '192.168.1.23' }] } } },
  { type: 'session/title', seq: 5, time: Date.now() - 25000, data: { title: '两台机器怎么连' } }
]
const dir = path.join(tempHome, 'sessions', '--x--', sessionId)
await fs.mkdir(dir, { recursive: true })
await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame([header]), frame(events)]))

const config = await import('../lib/config.js')
await config.load()
await config.update({
  role: 'hub',
  port: PORT,
  discovery: false,
  token: TOKEN,
  autoSync: true,
  pushIntervalMs: 2000,
  pullIntervalMs: 2000
})

// ------------------------------------------------------------ fake cordis

const cleanups = []
let localHandler = null
const attachedSessions = []
let registryMode = 'ok'
const fakeCtx = {
  get(name) {
    if (name !== 'workspaceRegistry') return null
    if (registryMode === 'throw') {
      return {
        resolveByPath() {
          throw new Error('no such workspace')
        }
      }
    }
    return {
      async resolveByPath(target) {
        return {
          async attachSession(id) {
            attachedSessions.push({ path: target, id })
          }
        }
      }
    }
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
      localHandler = def.handler
      return function () {}
    }
  }
}

const plugin = await import('../index.js')
plugin.apply(fakeCtx)

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 12000)
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(function (r) { setTimeout(r, 120) })
  }
  throw new Error('timed out waiting for ' + label)
}

// A tiny server standing in for the DSH web server.
const localServer = http.createServer(function (req, res) {
  if (!localHandler) {
    res.statusCode = 503
    res.end('not ready')
    return
  }
  localHandler(req, res)
})

await new Promise(function (resolve) { localServer.listen(LOCAL_PORT, '127.0.0.1', resolve) })

async function get(p) {
  const response = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/_dsh/lan' + p)
  const body = await response.json()
  return body
}
async function post(p, payload) {
  const response = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/_dsh/lan' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  return response.json()
}

let machineId = ''
let storeRootId = ''

try {
  await step('boot: hub starts listening and exports local history', async function () {
    await waitFor(async function () {
      try {
        const status = await get('/status')
        return status.ok === true && status.lan.listening === true
      } catch (err) {
        return false
      }
    }, 'hub listening')
    await waitFor(async function () {
      const body = await get('/conversations')
      return body.ok && body.conversations.length > 0
    }, 'conversations exported')
    const status = await get('/status')
    machineId = status.identity.machineId
    assert.equal(status.identity.role, 'hub')
    assert.equal(status.token, TOKEN)
    assert.ok(status.lan.url.startsWith('http://'), 'lan.url should be a URL')
    assert.ok(status.lan.url.endsWith(':' + PORT))
    assert.ok(status.roots.length >= 1, 'the session cwd becomes a shared root')
  })

  await step('conversations: list and open keep chain of thought and tool output', async function () {
    const list = await get('/conversations')
    const row = list.conversations.find(function (item) { return item.sessionId === sessionId })
    assert.ok(row, 'the exported session should be listed')
    assert.equal(row.mine, true)
    const body = await get('/conversation?machine=' + encodeURIComponent(row.machineId) + '&id=' + encodeURIComponent(sessionId))
    assert.equal(body.ok, true)
    const items = body.conversation.items
    const assistant = items.find(function (item) { return item.t === 'assistant' })
    assert.deepEqual(assistant.blocks.map(function (b) { return b.k }), ['reasoning', 'text', 'tool-call'])
    const toolResult = items.find(function (item) { return item.t === 'tool-result' })
    assert.equal(toolResult.text, '192.168.1.23')
  })

  await step('fork: write a runnable session into a local workspace', async function () {
    const forkModule = await import('../lib/fork.js')
    const spaces = await get('/workspaces')
    assert.equal(spaces.ok, true)
    assert.ok(spaces.workspaces.length >= 1, 'workspace list should not be empty')
    assert.ok(
      spaces.workspaces.every(function (row) { return typeof row.key === 'string' && typeof row.cwd === 'string' }),
      '每个工作区都要有 key 与 cwd'
    )
    const list = await get('/conversations')
    const row = list.conversations.find(function (item) { return item.sessionId === sessionId })
    const body = await post('/fork', { machine: row.machineId, id: sessionId })
    assert.equal(body.ok, true)
    assert.ok(body.fork.sessionId.startsWith('session-'), 'fork 应该是一条新会话')
    assert.equal(body.fork.cwd, tempHome)
    assert.equal(body.fork.turns, 1)
    const bytes = await fs.readFile(body.fork.file)
    const first = forkModule.frameEnd(bytes, 0)
    const second = forkModule.frameEnd(bytes, first)
    assert.ok(first > 0, 'header 帧应成帧')
    assert.equal(second, bytes.length, '正文应正好是一个帧')
    const newHeader = JSON.parse(zlib.zstdDecompressSync(bytes.subarray(0, first)).toString('utf8').trim())
    assert.equal(newHeader.version, 4)
    assert.equal(newHeader.cwd, tempHome)
    assert.equal(newHeader.isSeeded, false)
    const after = await get('/workspaces')
    const created = after.workspaces.filter(function (item) { return item.key === forkModule.projectKey(tempHome) })
    assert.equal(created.length, 1, 'fork 应该落在按 cwd 编码出来的工作区目录')
    assert.equal(created[0].sessions, 1)
    const missing = await post('/fork', { machine: row.machineId, id: 'session-nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'NOT_FOUND')
    assert.equal(body.fork.attached, true, '拿到工作区注册表时应当挂进工作区')
    assert.deepEqual(attachedSessions, [{ path: tempHome, id: body.fork.sessionId }])
    registryMode = 'throw'
    const noAttach = await post('/fork', { machine: row.machineId, id: sessionId })
    registryMode = 'ok'
    assert.equal(noAttach.ok, true, '注册表不可用不应导致 fork 失败')
    assert.equal(noAttach.fork.attached, false)
  })

  await step('files: roots, list, write, read back', async function () {

    const extra = path.join(tempHome, 'shared-dir')
    await fs.mkdir(extra, { recursive: true })
    await fs.writeFile(path.join(extra, 'note.txt'), 'first', 'utf8')
    const roots = await post('/roots', { add: [extra] })
    assert.equal(roots.ok, true)
    const root = roots.roots.find(function (row) { return row.path === extra })
    assert.ok(root, 'the added root should be listed')
    storeRootId = root.id
    const listing = await get('/files/list?scope=local&root=' + encodeURIComponent(root.id) + '&path=')
    assert.deepEqual(listing.entries.map(function (e) { return e.name }), ['note.txt'])
    const written = await post('/files/write', { scope: 'local', root: root.id, path: 'note.txt', content: 'second', backup: true })
    assert.equal(written.ok, true)
    const read = await get('/files/read?scope=local&root=' + encodeURIComponent(root.id) + '&path=note.txt')
    assert.equal(read.content, 'second')
    assert.ok(written.backup, 'a backup path should be reported')
    const kept = await fs.readFile(written.backup, 'utf8')
    assert.equal(kept, 'first', 'the backup must hold the previous content')
    const siblings = await fs.readdir(extra)
    assert.deepEqual(siblings, ['note.txt'], 'no backup litter in the shared folder')
    const escape = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/_dsh/lan/files/read?scope=local&root=' + encodeURIComponent(root.id) + '&path=..%2F..%2Fetc%2Fpasswd')
    assert.equal(escape.status, 500, 'traversal must not be served')
  })

  await step('plugins: local manifest is readable', async function () {
    const body = await get('/plugins')
    assert.equal(body.ok, true)
    assert.equal(typeof body.local.pluginCount, 'number')
    assert.ok(Array.isArray(body.local.plugins))
    assert.ok(Array.isArray(body.runtime))
  })

  await step('memory: local discovery does not throw', async function () {
    const body = await get('/memory')
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.local))
    assert.ok(Array.isArray(body.shared))
  })

  await step('LAN API: hello, pull and push work for a peer', async function () {
    const lan = await import('../lib/lan-server.js')
    const peer = lan.createPeer(function () {
      return { hubHost: '127.0.0.1', hubPort: PORT, token: TOKEN }
    })
    const hello = await peer.hello()
    assert.equal(hello.ok, true)
    assert.equal(hello.identity.machineId, machineId)
    const pulled = await peer.pull(0)
    assert.ok(pulled.conversations.length >= 1)

    const remote = {
      sessionId: 'session-from-mac',
      machineId: 'mac-001',
      machineName: 'MacBook',
      title: '来自 Mac 的提问',
      cwd: '/Users/x/project',
      createdAt: 1,
      updatedAt: 2,
      items: [
        { t: 'user', source: 'user', text: '在 Mac 上问一句' },
        { t: 'assistant', blocks: [{ k: 'reasoning', text: '想一想' }, { k: 'text', text: '回答' }] }
      ]
    }
    const pushed = await peer.push({ conversations: [remote] })
    assert.equal(pushed.ok, true)
    assert.equal(pushed.accepted.conversations, 1)

    const list = await get('/conversations')
    const row = list.conversations.find(function (item) { return item.sessionId === 'session-from-mac' })
    assert.ok(row, 'the peer conversation must appear in the shared store')
    assert.equal(row.mine, false)
    assert.equal(row.machineName, 'MacBook')
  })

  await step('LAN API: a wrong token is rejected', async function () {
    const lan = await import('../lib/lan-server.js')
    const bad = lan.createPeer(function () {
      return { hubHost: '127.0.0.1', hubPort: PORT, token: 'wrong-token' }
    })
    await assert.rejects(function () { return bad.hello() }, /rejected the token/)
  })

  await step('sync: hub self-sync reports ok', async function () {
    const body = await post('/sync', {})
    assert.equal(body.ok, true)
    assert.equal(body.result.role, 'hub')
  })

  await step('audit: reads and writes are recorded', async function () {
    const body = await get('/audit?limit=50')
    assert.equal(body.ok, true)
    const kinds = body.entries.map(function (row) { return row.kind })
    assert.ok(kinds.indexOf('hub-listen') >= 0, 'hub-listen should be audited')
  })
} catch (err) {
  /* reported per step */
} finally {
  for (const cleanup of cleanups) {
    try {
      if (typeof cleanup === 'function') cleanup()
    } catch (err) {
      /* ignore */
    }
  }
  await new Promise(function (resolve) { localServer.close(resolve) })
  await new Promise(function (r) { setTimeout(r, 300) })
  await fs.rm(tempHome, { recursive: true, force: true })
  const failed = steps.filter(function (row) { return row.ok !== true }).length
  console.log('\n' + (steps.length - failed) + '/' + steps.length + ' steps passed')
  process.exit(failed === 0 ? 0 : 1)
}
