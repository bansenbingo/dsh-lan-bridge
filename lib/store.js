/**
 * Shared content store (v2).
 *
 * Every object (conversation transcript, memory file, plugin manifest) is
 * stored once under its owning node, addressed by a SHA-256 content hash. The
 * index carries a single monotonically increasing `rev`; a peer pulls the
 * prefix of objects after its last cursor and pushes its own objects by node
 * id. Conversations are immutable, memory and manifests are last-write-wins by
 * `updatedAt`.
 *
 * The v1 layout (index.json version 1 + the same body paths) is imported on
 * first boot and kept on disk as `index.v1.json` for rollback.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { storeDir, shortHash } from './config.js'

const INDEX_VERSION = 2
const KEEP_PER_NODE = 300
const AUDIT_MAX_BYTES = 512 * 1024
const DEFAULT_PAGE_BYTES = 6 * 1024 * 1024
const DEFAULT_PAGE_ITEMS = 400

let cached = null
let chain = Promise.resolve()

export function safeSegment(value) {
  const text = String(value == null ? '' : value).replace(/[^A-Za-z0-9._-]/g, '_')
  return text || '_'
}

export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

function indexPath() {
  return path.join(storeDir(), 'index.json')
}

function conversationsDir() {
  return path.join(storeDir(), 'conversations')
}

function memoryDir() {
  return path.join(storeDir(), 'memory')
}

function manifestsDir() {
  return path.join(storeDir(), 'manifests')
}

function auditPath() {
  return path.join(storeDir(), 'audit.jsonl')
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fs.writeFile(temp, text, 'utf8')
  await fs.rename(temp, file)
  await fs.chmod(file, 0o600).catch(() => {})
}

async function writeAtomicBuffer(file, buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fs.writeFile(temp, buffer)
  await fs.rename(temp, file)
  await fs.chmod(file, 0o600).catch(() => {})
}

function emptyIndex() {
  return {
    version: INDEX_VERSION,
    rev: 0,
    updatedAt: new Date().toISOString(),
    conversations: {},
    memory: {},
    manifests: {}
  }
}

function entryRev(entry) {
  return Number(entry && entry.rev) || 0
}

function byRev(a, b) {
  return entryRev(a.entry) - entryRev(b.entry)
}

function conversationPath(nodeId, sessionId) {
  return path.join(conversationsDir(), safeSegment(nodeId), safeSegment(sessionId) + '.json')
}

function memoryPath(nodeId, name) {
  return path.join(memoryDir(), safeSegment(nodeId), safeSegment(name))
}

function manifestPath(nodeId) {
  return path.join(manifestsDir(), safeSegment(nodeId) + '.json')
}

/**
 * Read an index entry plus its body. Returns null when the body disappeared.
 */
async function hydrate(kind, nodeId, id, entry) {
  let file
  if (kind === 'conversation') file = conversationPath(nodeId, id)
  else if (kind === 'memory') file = memoryPath(nodeId, id)
  else file = manifestPath(nodeId)
  try {
    const text = await fs.readFile(file, 'utf8')
    let body
    if (kind === 'memory') {
      body = text
    } else {
      try {
        body = JSON.parse(text)
      } catch (err) {
        return null
      }
    }
    return {
      kind,
      nodeId,
      id,
      hash: entry.hash,
      updatedAt: entry.updatedAt,
      rev: entry.rev,
      bytes: entry.bytes,
      body
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

async function commit() {
  const index = cached
  index.updatedAt = new Date().toISOString()
  await writeAtomic(indexPath(), JSON.stringify(index) + '\n')
}

function schedule(fn) {
  chain = chain.then(fn, fn)
  return chain
}

async function migrateV1(raw) {
  const next = emptyIndex()
  const now = new Date().toISOString()
  for (const [machineId, list] of Object.entries(raw.conversations || {})) {
    for (const [sessionId, entry] of Object.entries(list || {})) {
      const bodyFile = path.join(conversationsDir(), safeSegment(machineId), safeSegment(sessionId) + '.json')
      try {
        const text = await fs.readFile(bodyFile, 'utf8')
        const body = JSON.parse(text)
        const nodeId = entry.machineId || body.machineId || machineId
        next.rev += 1
        next.conversations[nodeId] = next.conversations[nodeId] || {}
        next.conversations[nodeId][sessionId] = {
          sessionId,
          nodeId,
          title: entry.title || body.title || sessionId,
          cwd: entry.cwd || body.cwd || '',
          updatedAt: entry.updatedAt || body.updatedAt || now,
          bytes: entry.bytes || Buffer.byteLength(text),
          hash: entry.hash || hashText(text),
          rev: next.rev
        }
      } catch (err) {
        /* skip a broken v1 body, keep the rest */
      }
    }
  }
  for (const [machineId, list] of Object.entries(raw.memory || {})) {
    for (const [name, entry] of Object.entries(list || {})) {
      const bodyFile = path.join(memoryDir(), safeSegment(machineId), safeSegment(name))
      try {
        const text = await fs.readFile(bodyFile, 'utf8')
        const nodeId = entry.machineId || machineId
        next.rev += 1
        next.memory[nodeId] = next.memory[nodeId] || {}
        next.memory[nodeId][name] = {
          name,
          nodeId,
          updatedAt: entry.updatedAt || now,
          bytes: entry.bytes || Buffer.byteLength(text),
          hash: entry.hash || hashText(text),
          rev: next.rev
        }
      } catch (err) {
        /* skip */
      }
    }
  }
  for (const [machineId, entry] of Object.entries(raw.manifests || {})) {
    const bodyFile = path.join(manifestsDir(), safeSegment(machineId) + '.json')
    try {
      const text = await fs.readFile(bodyFile, 'utf8')
      const nodeId = entry.machineId || machineId
      next.rev += 1
      next.manifests[nodeId] = {
        nodeId,
        updatedAt: entry.updatedAt || now,
        bytes: entry.bytes || Buffer.byteLength(text),
        hash: entry.hash || hashText(text),
        rev: next.rev
      }
    } catch (err) {
      /* skip */
    }
  }
  return next
}

export async function ensure() {
  if (cached) return cached
  await fs.mkdir(storeDir(), { recursive: true })
  const file = indexPath()
  let raw = null
  try {
    raw = await readJson(file, null)
  } catch (err) {
    try {
      await fs.rename(file, file + '.corrupt-' + Date.now())
    } catch (renameError) {
      /* best effort */
    }
    raw = null
  }
  if (!raw) {
    // No v2 index. Import a v1 index if one exists, otherwise start empty.
    let v1 = null
    try {
      v1 = await readJson(path.join(storeDir(), 'index.v1.json'), null)
    } catch (err) {
      v1 = null
    }
    let legacy = v1
    if (!legacy) {
      try {
        legacy = await readJson(file, null)
      } catch (err) {
        legacy = null
      }
    }
    if (legacy && legacy.version === 1) {
      if (!v1) {
        try {
          await fs.copyFile(file, path.join(storeDir(), 'index.v1.json'))
        } catch (err) {
          /* best effort */
        }
      }
      cached = await migrateV1(legacy)
      await commit()
    } else {
      cached = emptyIndex()
      await commit()
    }
    return cached
  }
  if (raw.version === 1) {
    try {
      await fs.copyFile(file, path.join(storeDir(), 'index.v1.json'))
    } catch (err) {
      /* best effort */
    }
    cached = await migrateV1(raw)
    await commit()
    return cached
  }
  cached = Object.assign(emptyIndex(), raw)
  cached.version = INDEX_VERSION
  return cached
}

export function index() {
  return cached
}

export function invalidate() {
  cached = null
}

export async function putConversation(record) {
  const nodeId = String(record.nodeId || record.machineId || '')
  const sessionId = String(record.sessionId || '')
  if (!nodeId || !sessionId) throw new Error('conversation needs nodeId and sessionId')
  return schedule(async () => {
    await ensure()
    const body = record.body || record.conversation || record
    const text = JSON.stringify(body)
    const hash = record.hash || hashText(text)
    const now = record.updatedAt || body.updatedAt || new Date().toISOString()
    const bytes = Buffer.byteLength(text)
    const current = cached.conversations[nodeId] && cached.conversations[nodeId][sessionId]
    if (current && current.hash === hash) return { ok: true, deduped: true, rev: current.rev }
    if (current && String(current.updatedAt) > String(now)) {
      return { ok: true, stale: true, rev: current.rev }
    }
    await writeAtomic(conversationPath(nodeId, sessionId), text)
    cached.rev += 1
    cached.conversations[nodeId] = cached.conversations[nodeId] || {}
    const entry = {
      sessionId,
      nodeId,
      title: record.title || body.title || sessionId,
      cwd: record.cwd || body.cwd || '',
      machineName: record.machineName || body.machineName || '',
      platform: record.platform || body.platform || '',
      updatedAt: now,
      bytes,
      hash,
      rev: cached.rev
    }
    cached.conversations[nodeId][sessionId] = entry
    prune(cached.conversations[nodeId], KEEP_PER_NODE, sessionId)
    await commit()
    await audit('conversation.put', { nodeId, id: sessionId, bytes })
    return { ok: true, rev: entry.rev, entry }
  })
}

/**
 * Drop objects owned by other nodes. Used when this node joins a different
 * space: local artifacts will be exported again by the mesh, but objects that
 * belonged to the previous space must never be pushed to the new peers.
 */
export async function dropForeign(nodeId) {
  await ensure()
  const keep = String(nodeId || '')
  let dropped = 0
  for (const [owner, list] of Object.entries(cached.conversations)) {
    if (owner === keep) continue
    dropped += Object.keys(list || {}).length
    delete cached.conversations[owner]
  }
  for (const [owner, list] of Object.entries(cached.memory)) {
    if (owner === keep) continue
    dropped += Object.keys(list || {}).length
    delete cached.memory[owner]
  }
  for (const owner of Object.keys(cached.manifests)) {
    if (owner === keep) continue
    dropped += 1
    delete cached.manifests[owner]
  }
  if (dropped > 0) {
    cached.rev += 1
    await commit()
    await audit('space.reset', { nodeId: keep, dropped })
  }
  return dropped
}

export async function getConversation(nodeId, sessionId) {  await ensure()
  const entry = cached.conversations[nodeId] && cached.conversations[nodeId][sessionId]
  if (!entry) return null
  const text = await fs.readFile(conversationPath(nodeId, sessionId), 'utf8')
  return { entry, body: JSON.parse(text) }
}

export async function listConversations(options) {
  await ensure()
  const opts = options || {}
  const out = []
  for (const [nodeId, list] of Object.entries(cached.conversations)) {
    if (opts.nodeId && opts.nodeId !== nodeId) continue
    for (const entry of Object.values(list || {})) {
      out.push(Object.assign({ kind: 'conversation', nodeId }, entry))
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out
}

export async function putMemory(record) {
  const nodeId = String(record.nodeId || record.machineId || '')
  const name = String(record.name || '')
  if (!nodeId || !name) throw new Error('memory needs nodeId and name')
  return schedule(async () => {
    await ensure()
    const text = String(record.text == null ? record.body : record.text)
    const hash = record.hash || hashText(text)
    const now = record.updatedAt || new Date().toISOString()
    const current = cached.memory[nodeId] && cached.memory[nodeId][name]
    if (current && current.hash === hash) return { ok: true, deduped: true, rev: current.rev }
    if (current && String(current.updatedAt) > String(now)) {
      return { ok: true, stale: true, rev: current.rev }
    }
    await writeAtomic(memoryPath(nodeId, name), text)
    cached.rev += 1
    cached.memory[nodeId] = cached.memory[nodeId] || {}
    const entry = {
      name,
      nodeId,
      updatedAt: now,
      bytes: Buffer.byteLength(text),
      hash,
      rev: cached.rev
    }
    cached.memory[nodeId][name] = entry
    await commit()
    await audit('memory.put', { nodeId, name, bytes: entry.bytes })
    return { ok: true, rev: entry.rev, entry }
  })
}

export async function getMemory(nodeId, name) {
  await ensure()
  const entry = cached.memory[nodeId] && cached.memory[nodeId][name]
  if (!entry) return null
  const text = await fs.readFile(memoryPath(nodeId, name), 'utf8')
  return { entry, text }
}

export async function listMemory(options) {
  await ensure()
  const out = []
  for (const [nodeId, list] of Object.entries(cached.memory)) {
    if (options && options.nodeId && options.nodeId !== nodeId) continue
    for (const entry of Object.values(list || {})) out.push(Object.assign({ kind: 'memory', nodeId }, entry))
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

export async function putManifest(record) {
  const nodeId = String(record.nodeId || record.machineId || '')
  if (!nodeId) throw new Error('manifest needs nodeId')
  return schedule(async () => {
    await ensure()
    const body = record.body || record.manifest || record
    const text = JSON.stringify(body)
    const hash = record.hash || hashText(text)
    const now = record.updatedAt || new Date().toISOString()
    const current = cached.manifests[nodeId]
    if (current && current.hash === hash) return { ok: true, deduped: true, rev: current.rev }
    if (current && String(current.updatedAt) > String(now)) {
      return { ok: true, stale: true, rev: current.rev }
    }
    await writeAtomic(manifestPath(nodeId), text)
    cached.rev += 1
    cached.manifests[nodeId] = {
      nodeId,
      updatedAt: now,
      bytes: Buffer.byteLength(text),
      hash,
      rev: cached.rev
    }
    await commit()
    await audit('manifest.put', { nodeId, bytes: cached.manifests[nodeId].bytes })
    return { ok: true, rev: cached.manifests[nodeId].rev }
  })
}

export async function getManifest(nodeId) {
  await ensure()
  const entry = cached.manifests[nodeId]
  if (!entry) return null
  return { entry, body: JSON.parse(await fs.readFile(manifestPath(nodeId), 'utf8')) }
}

export async function listManifests() {
  await ensure()
  return Object.values(cached.manifests).map((entry) => Object.assign({ kind: 'manifest' }, entry))
}

/**
 * The next contiguous page of objects after `since`. Objects are ordered by
 * the local `rev`; the returned `cursor` is safe to store as "pulled through"
 * because it is the revision of the last object actually included.
 */
export async function changesSince(since, options) {
  await ensure()
  const opts = options || {}
  const maxBytes = opts.maxBytes || DEFAULT_PAGE_BYTES
  const maxItems = opts.maxItems || DEFAULT_PAGE_ITEMS
  const exclude = opts.excludeNodeId || ''
  const all = []
  for (const [nodeId, list] of Object.entries(cached.conversations)) {
    if (exclude && nodeId === exclude) continue
    for (const entry of Object.values(list || {})) all.push({ kind: 'conversation', nodeId, id: entry.sessionId, entry })
  }
  for (const [nodeId, list] of Object.entries(cached.memory)) {
    if (exclude && nodeId === exclude) continue
    for (const entry of Object.values(list || {})) all.push({ kind: 'memory', nodeId, id: entry.name, entry })
  }
  for (const [nodeId, entry] of Object.entries(cached.manifests)) {
    if (exclude && nodeId === exclude) continue
    all.push({ kind: 'manifest', nodeId, id: nodeId, entry })
  }
  all.sort(byRev)
  const objects = []
  let bytes = 0
  let cursor = Number(since) || 0
  for (const item of all) {
    if (entryRev(item.entry) <= cursor) continue
    const hydrated = await hydrate(item.kind, item.nodeId, item.id, item.entry)
    if (!hydrated) continue
    if (objects.length >= maxItems) break
    if (objects.length > 0 && bytes + hydrated.bytes > maxBytes) break
    objects.push(hydrated)
    bytes += hydrated.bytes
    cursor = entryRev(item.entry)
  }
  return { rev: cached.rev, cursor, objects, bytes }
}

export async function stats() {
  await ensure()
  const conversations = Object.values(cached.conversations).reduce((n, list) => n + Object.keys(list).length, 0)
  const memory = Object.values(cached.memory).reduce((n, list) => n + Object.keys(list).length, 0)
  return {
    rev: cached.rev,
    updatedAt: cached.updatedAt,
    nodes: new Set([
      ...Object.keys(cached.conversations),
      ...Object.keys(cached.memory),
      ...Object.keys(cached.manifests)
    ]).size,
    conversations,
    memory,
    manifests: Object.keys(cached.manifests).length
  }
}

async function audit(action, detail) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), action, detail }) + '\n'
    await fs.mkdir(storeDir(), { recursive: true })
    await fs.appendFile(auditPath(), line, 'utf8')
    const stat = await fs.stat(auditPath()).catch(() => null)
    if (stat && stat.size > AUDIT_MAX_BYTES) {
      const text = await fs.readFile(auditPath(), 'utf8')
      await writeAtomic(auditPath(), text.slice(Math.max(0, text.length - AUDIT_MAX_BYTES + 8192)))
    }
  } catch (err) {
    /* audit must never break a write */
  }
}

export async function recentAudit(limit) {
  try {
    const text = await fs.readFile(auditPath(), 'utf8')
    const lines = text.trim().split('\n').slice(-(limit || 40))
    return lines.map((line) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        return { raw: line }
      }
    })
  } catch (err) {
    return []
  }
}

export async function auditEvent(action, detail) {
  return audit(action, detail)
}

function prune(mapForNode, keep, protectKey) {
  const entries = Object.values(mapForNode || {})
  if (entries.length <= keep) return
  entries.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
  const drop = entries.length - keep
  for (let i = 0; i < drop; i++) {
    const entry = entries[i]
    const key = entry.sessionId || entry.name || entry.nodeId
    if (key === protectKey) continue
    delete mapForNode[key]
  }
}
