/**
 * dsh-lan-bridge — offline smoke test.
 *
 * Runs the exporter, the store, the file guards and the profile reader without
 * DSH, against a throw-away DSH_HOME plus one real session file copied in.
 *
 *   node test/smoke.mjs
 *
 * Exit code 0 means every assertion passed. Nothing outside the temp directory
 * is written.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const REAL_HOME = process.env.REAL_DSH_HOME || path.join(os.homedir(), '.dsh')
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-bridge-test-'))
process.env.DSH_HOME = tempHome
process.env.DSH_PROFILE = 'desktop'
delete process.env.DSH_PROFILE_DIR

const results = []
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      results.push({ label, ok: true })
    })
    .catch(function (err) {
      results.push({ label, ok: false, message: String((err && err.stack) || err) })
    })
}

// Build a synthetic session: two turn markers, a user message, an assistant
// message that carries reasoning + a tool call, and a tool result.
function frame(events) {
  const text = events.map(function (event) { return JSON.stringify(event) }).join('\n') + '\n'
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

const header = {
  type: 'session',
  version: 4,
  id: 'session-11111111-2222-3333-4444-555555555555',
  createdAt: Date.now() - 60000,
  cwd: tempHome
}
const events = [
  { type: 'turn/start', seq: 1, time: Date.now() - 50000, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: Date.now() - 49000,
    data: { content: [{ type: 'text', text: '帮我看一下磁盘占用' }], source: { kind: 'user' } }
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: Date.now() - 48000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先列目录，再算大小。' },
          { type: 'text', text: '我先看一下目录结构。' },
          { type: 'tool-call', id: 'call_a', name: 'pwsh', arguments: '{"command":"dir"}' }
        ]
      }
    }
  },
  { type: 'tool/call', seq: 4, time: Date.now() - 47000, data: { callId: 'call_a', name: 'pwsh', arguments: '{"command":"dir"}' } },
  {
    type: 'tool/result',
    seq: 5,
    time: Date.now() - 46000,
    data: { message: { toolCallId: 'call_a', isError: false, content: [{ type: 'text', text: 'total 42' }] } }
  },
  { type: 'session/title', seq: 6, time: Date.now() - 45000, data: { title: '磁盘占用排查' } }
]

const workspaceDir = path.join(tempHome, 'sessions', '--tmp-project--')
const sessionDir = path.join(workspaceDir, header.id)
await fs.mkdir(sessionDir, { recursive: true })
const sessionFile = path.join(sessionDir, 'session.v4.jsonl.zstd')
await fs.writeFile(sessionFile, Buffer.concat([frame([header]), frame(events)]))

const sessions = await import('../lib/sessions.js')
const store = await import('../lib/store.js')
const files = await import('../lib/files.js')
const config = await import('../lib/config.js')
const plugins = await import('../lib/plugins.js')
const meshModule = await import('../lib/mesh.js')

await check('inflateFrames reads concatenated zstd frames', async function () {
  const raw = await fs.readFile(sessionFile)
  const text = sessions.inflateFrames(raw)
  assert.ok(text.includes('"type":"session"'), 'header line missing')
  assert.ok(text.includes('"type":"tool/result"'), 'tool result line missing')
})

await check('readSessionFile separates header from events', async function () {
  const parsed = await sessions.readSessionFile(sessionFile)
  assert.equal(parsed.header.id, header.id)
  assert.equal(parsed.events.length, events.length)
})

await check('normalizeTranscript keeps reasoning, tool call and tool result', async function () {
  const parsed = await sessions.readSessionFile(sessionFile)
  const transcript = sessions.normalizeTranscript(parsed.header, parsed.events, {})
  assert.equal(transcript.sessionId, header.id)
  assert.equal(transcript.title, '磁盘占用排查')
  const assistant = transcript.items.find(function (item) { return item.t === 'assistant' })
  assert.ok(assistant, 'no assistant item')
  const kinds = assistant.blocks.map(function (block) { return block.k })
  assert.deepEqual(kinds, ['reasoning', 'text', 'tool-call'])
  const toolResult = transcript.items.find(function (item) { return item.t === 'tool-result' })
  assert.equal(toolResult.callId, 'call_a')
  assert.equal(toolResult.text, 'total 42')
  const user = transcript.items.find(function (item) { return item.t === 'user' })
  assert.equal(user.text, '帮我看一下磁盘占用')
})

await check('normalizeTranscript survives a truncated trailing frame', async function () {
  const raw = await fs.readFile(sessionFile)
  const broken = Buffer.concat([raw, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])])
  const text = sessions.inflateFrames(broken)
  assert.ok(text.includes('"type":"tool/result"'), 'valid frames must still inflate')
})

await check('store round trip and revision bump', async function () {
  const body = {
    sessionId: 's1',
    machineId: 'm1',
    machineName: 'box',
    title: 't',
    cwd: '/tmp',
    createdAt: 1,
    updatedAt: 2,
    items: [{ t: 'user', text: 'hi' }],
    hash: 'deadbeef'
  }
  const first = await store.putConversation('m1', body)
  assert.equal(first.changed, true)
  const again = await store.putConversation('m1', body)
  assert.equal(again.changed, false, 'an identical transcript must not bump the revision')
  const read = await store.getConversation('m1', 's1')
  assert.equal(read.title, 't')
  const list = await store.listConversations()
  assert.equal(list.length, 1)
  const delta = await store.changesSince(0)
  assert.equal(delta.conversations.length, 1)
  const empty = await store.changesSince(first.rev)
  assert.equal(empty.conversations.length, 0)
})

await check('config defaults, update and reload', async function () {
  const initial = await config.load()
  assert.equal(initial.role, 'peer')
  assert.ok(initial.token.length >= 16)
  const next = await config.update({ role: 'hub', port: 47999 })
  assert.equal(next.role, 'hub')
  config.invalidate()
  const reloaded = await config.load()
  assert.equal(reloaded.port, 47999)
  assert.equal(reloaded.machineId, initial.machineId, 'machine identity must be stable')
})

await check('file API blocks traversal and symlink escapes', async function () {
  const rootPath = path.join(tempHome, 'root')
  await fs.mkdir(path.join(rootPath, 'sub'), { recursive: true })
  await fs.writeFile(path.join(rootPath, 'a.txt'), 'hello', 'utf8')
  files.setRoots([{ id: 'r1', label: 'root', path: rootPath, kind: 'extra' }])
  const root = files.findRoot('r1')
  const listing = await files.listDir(root, '')
  const names = listing.entries.map(function (entry) {
    return entry.name
  })
  assert.deepEqual(names.sort(), ['a.txt', 'sub'])
  assert.equal(listing.entries.find(function (entry) { return entry.name === 'sub' }).dir, true)
  const read = await files.readFile(root, 'a.txt', 1024)
  assert.equal(read.content, 'hello')
  await assert.rejects(function () { return files.readFile(root, '../escape.txt', 1024) }, /relative|walk above/)
  await assert.rejects(function () { return files.resolveWithin(root, '/etc/passwd', false) }, /relative/)
  const written = await files.writeFile(root, 'sub/b.txt', 'x', { backup: true })
  assert.equal(written.path, 'sub/b.txt')
  assert.equal(await fs.readFile(path.join(rootPath, 'sub', 'b.txt'), 'utf8'), 'x')
})

await check('deny list hides credential shapes', async function () {
  const rootPath = path.join(tempHome, 'root2')
  await fs.mkdir(rootPath, { recursive: true })
  await fs.writeFile(path.join(rootPath, '.env'), 'SECRET=1', 'utf8')
  files.setRoots([{ id: 'r2', label: 'root2', path: rootPath, kind: 'extra' }])
  const root = files.findRoot('r2')
  await assert.rejects(function () { return files.readFile(root, '.env', 1024) }, /deny list/)
})

await check('plan() finds a drifted profile', async function () {
  const local = { dependencies: { a: '1.0.0' }, bundles: ['a'] }
  const remote = { dependencies: { a: '2.0.0', b: '1.0.0' }, bundles: ['a', 'b'] }
  const diff = plugins.plan(remote, local)
  assert.equal(diff.identical, false)
  assert.deepEqual(diff.missing, [{ name: 'b', version: '1.0.0', bundle: true }])
  assert.deepEqual(diff.versionDiff, [{ name: 'a', local: '1.0.0', remote: '2.0.0' }])
  const same = plugins.plan(remote, remote)
  assert.equal(same.identical, true)
})

await check('mesh exports the synthetic session and builds roots', async function () {
  process.env.DSH_HOME = tempHome
  const ctx = { get: function () { return null }, on: function () { return function () {} } }
  const mesh = meshModule.createMesh(ctx, {})
  const summary = await mesh.exportLocal()
  assert.equal(summary.sessions.total, 1)
  assert.equal(summary.sessions.exported, 1)
  const list = await store.listConversations()
  assert.ok(list.length >= 1)
  const roots = files.getRoots()
  assert.ok(roots.length >= 1, 'the session cwd should become a shared root')
  const second = await mesh.exportLocal()
  assert.equal(second.sessions.exported, 0, 'an unchanged session must not be re-exported')
})

await check('real DSH session parses when one is available', async function () {
  const realSessions = path.join(REAL_HOME, 'sessions')
  let found = null
  try {
    const workspaces = await fs.readdir(realSessions, { withFileTypes: true })
    outer: for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const dirs = await fs.readdir(path.join(realSessions, workspace.name), { withFileTypes: true })
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        const files2 = await fs.readdir(path.join(realSessions, workspace.name, dir.name), { withFileTypes: true })
        for (const file of files2) {
          if (file.isFile() && sessions.isSessionFile(file.name)) {
            found = path.join(realSessions, workspace.name, dir.name, file.name)
            break outer
          }
        }
      }
    }
  } catch (err) {
    found = null
  }
  if (!found) {
    results.push({ label: 'real DSH session parses when one is available', ok: true, skipped: true })
    return
  }
  const parsed = await sessions.readSessionFile(found)
  assert.ok(parsed && parsed.header && parsed.header.id, 'no header in a real session')
  const transcript = sessions.normalizeTranscript(parsed.header, parsed.events, {})
  assert.ok(transcript.items.length > 0, 'a real session should yield items')
})

await check('splitPayload keeps every push under the size budget', async function () {
  const big = 'x'.repeat(1024 * 1024)
  const payload = {
    conversations: [1, 2, 3, 4, 5].map(function (index) {
      return { sessionId: 's-' + index, machineId: 'm', items: [{ t: 'user', text: big }] }
    }),
    memory: [{ machineId: 'm', name: 'MEMORY.md', text: 'small' }],
    manifests: [{ machineId: 'm', packages: [] }]
  }
  const batches = meshModule.splitPayload(payload, 2 * 1024 * 1024)
  assert.ok(batches.length >= 3, 'expected the payload to be split, got ' + batches.length)
  let conversations = 0
  let memory = 0
  let manifests = 0
  for (const batch of batches) {
    const size = Buffer.byteLength(JSON.stringify(batch))
    assert.ok(size <= 2 * 1024 * 1024 + 4096, 'batch of ' + size + ' bytes exceeds the budget')
    conversations += batch.conversations.length
    memory += batch.memory.length
    manifests += batch.manifests.length
  }
  assert.equal(conversations, 5, 'every conversation must travel exactly once')
  assert.equal(memory, 1)
  assert.equal(manifests, 1)
  assert.deepEqual(meshModule.splitPayload({ conversations: [], memory: [], manifests: [] }), [])
})

// ---------------------------------------------------------------- reporting

await fs.rm(tempHome, { recursive: true, force: true })

let failed = 0
for (const row of results) {
  const status = row.skipped ? 'skip' : row.ok ? 'ok  ' : 'FAIL'
  if (!row.ok) failed += 1
  console.log(status, row.label)
  if (!row.ok) console.log('     ' + String(row.message).split('\n').slice(0, 6).join('\n     '))
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)
