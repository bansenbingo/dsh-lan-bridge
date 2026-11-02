import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lan-v2-core-'))
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'

// A v1 config and a v1 store index are written before the modules load.
const configPath = path.join(home, 'lan-bridge')
await fs.mkdir(path.join(configPath, 'store', 'conversations', 'old-machine'), { recursive: true })
await fs.writeFile(path.join(configPath, 'config.json'), JSON.stringify({
  version: 1,
  machineId: 'old-machine',
  machineName: 'old-box',
  role: 'peer',
  token: 'legacy-token',
  discovery: false,
  port: 47820,
  discoveryPort: 47821,
  maxConversationBytes: 8 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024
}))
await fs.writeFile(path.join(configPath, 'store', 'conversations', 'old-machine', 's-old.json'), JSON.stringify({
  sessionId: 's-old',
  title: 'Legacy chat',
  cwd: '/tmp/work',
  updatedAt: '2026-01-01T00:00:00.000Z',
  items: [{ t: 'user', text: 'hello' }]
}))
await fs.writeFile(path.join(configPath, 'store', 'index.json'), JSON.stringify({
  version: 1,
  rev: 7,
  conversations: { 'old-machine': { 's-old': { sessionId: 's-old', machineId: 'old-machine', title: 'Legacy chat', cwd: '/tmp/work', updatedAt: '2026-01-01T00:00:00.000Z', bytes: 10, hash: 'x' } } },
  memory: {},
  manifests: {}
}))

const config = await import('../lib/config.js')
const store = await import('../lib/store.js')
const auth = await import('../lib/auth.js')
const { createTransfer } = await import('../lib/transfer.js')

const loaded = await config.load()
assert(loaded.version === 2, 'v1 config migrates to v2')
assert(loaded.nodeId === 'old-machine', 'node id is kept from v1 machine id')
assert(loaded.networkKey && loaded.spaceId, 'network key and space id are derived')
assert(loaded.bootstrapPeers.indexOf('undefined:47820') < 0, 'bootstrap peers are clean')

const index = await store.ensure()
assert(index.version === 2, 'v1 store migrates to v2')
const legacy = await store.getConversation('old-machine', 's-old')
assert(legacy && legacy.body.title === 'Legacy chat', 'legacy conversation survives migration')
assert(index.rev >= 1, 'migration assigns a fresh revision')

const put = await store.putConversation({
  nodeId: 'node-a',
  sessionId: 's-1',
  title: 'First',
  cwd: '/work/a',
  updatedAt: '2026-02-01T00:00:00.000Z',
  body: { sessionId: 's-1', title: 'First', cwd: '/work/a', updatedAt: '2026-02-01T00:00:00.000Z', items: [{ t: 'user', text: 'hi' }] }
})
assert(put.ok, 'conversation is stored')
const list = await store.listConversations()
assert(list.some((row) => row.sessionId === 's-1'), 'conversation is listed')
const page = await store.changesSince(0, { excludeNodeId: 'node-a' })
assert(page.objects.length >= 1, 'changes page contains legacy and peer objects')
assert(page.objects.every((row) => row.nodeId !== 'node-a'), 'own objects are excluded')

const body = Buffer.from('signed body')
const signed = auth.signRequest({ method: 'POST', path: '/api/v2/push', nodeId: 'node-a', networkKey: loaded.networkKey, body })
const fakeReq = { method: 'POST', url: '/api/v2/push', headers: {
  'x-dsh-node': 'node-a',
  'x-dsh-time': signed.time,
  'x-dsh-nonce': signed.nonce,
  'x-dsh-sign': signed.sign
} }
const verified = auth.verifyRequest(fakeReq, body, loaded.networkKey)
assert(verified.ok === true, 'valid HMAC verifies')
const replay = auth.verifyRequest(fakeReq, body, loaded.networkKey)
assert(replay.ok === false && replay.code === 'REPLAY', 'nonce replay is rejected')
const tampered = auth.verifyRequest(fakeReq, Buffer.from('tampered'), loaded.networkKey)
assert(tampered.ok === false, 'tampered body is rejected')

// ---------------------------------------------------------------- transfer

const rootPath = path.join(home, 'shared')
await fs.mkdir(rootPath, { recursive: true })
const root = { id: 'w-test', label: 'shared', path: rootPath, kind: 'workspace' }
const workspaces = {
  resolve(id) { return id === root.id ? root : null },
  list() { return [root] },
  async ensure() { return [root] }
}
const transferConfig = {
  maxTransferBytes: 64 * 1024 * 1024,
  transferChunkBytes: 2 * 1024 * 1024,
  autoAcceptTransfers: false
}
const transfer = createTransfer({
  getConfig: () => transferConfig,
  getPeers: () => ({ list: async () => [] }),
  transport: {},
  workspaces,
  onEvent: () => {}
})
const payload = Buffer.from('hello over the LAN')
const sha256 = createHash('sha256').update(payload).digest('hex')
const offer = transfer.offer({ json: { id: 'tx-1', name: 'note.txt', size: payload.length, sha256, mode: 'inbox', chunkBytes: 1024 }, nodeId: 'node-b' })
assert(offer.needApproval === true, 'offer waits for approval by default')
const accepted = await transfer.approve('tx-1', { mode: 'inbox' })
assert(accepted.status === 'accepted', 'offer can be approved')
const chunk = await transfer.receiveChunk({
  query: { id: 'tx-1', index: '0' },
  body: payload,
  req: { headers: { 'x-dsh-chunk-sha256': createHash('sha256').update(payload).digest('hex') } }
})
assert(chunk.ok, 'chunk is accepted')
const done = await transfer.complete({ query: { id: 'tx-1' }, json: {} })
assert(done.ok && done.size === payload.length, 'transfer completes')
const savedText = await fs.readFile(done.path, 'utf8')
assert(savedText === payload.toString(), 'received file matches the payload')

console.log('v2-core ok · migrated rev=', page.rev, '· transfer=', done.size, 'bytes')
process.exit(0)

function assert(value, message) {
  if (!value) {
    console.error('FAIL:', message)
    process.exit(1)
  }
}
