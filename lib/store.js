/**
 * dsh-lan-bridge — the shared store.
 *
 * Every machine keeps one of these on disk. On a hub it is authoritative; on a
 * peer it holds what the hub has published (plus that peer's own exports, so a
 * peer that loses the link still shows its own history).
 *
 * Layout under `$DSH_HOME/lan-bridge/store`:
 *
 *   index.json                              { rev, conversations, memory, manifests }
 *   conversations/<machineId>/<sessionId>.json
 *   memory/<machineId>/<name>               raw text
 *   manifests/<machineId>.json
 *   audit.jsonl
 *
 * Every record carries the global `rev` it was last written at, so a pull is
 * "give me everything newer than N" with no per-record clocks to reconcile.
 * Writes are serialised through one chain: two concurrent pushes can never
 * produce a torn index.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { storeDir } from './config.js'

const INDEX_VERSION = 1
/** Records kept per machine before the oldest are dropped. */
const KEEP_PER_MACHINE = 300
const AUDIT_MAX_BYTES = 512 * 1024

let cachedIndex = null
let chain = Promise.resolve()

function indexPath() {
  return path.join(storeDir(), 'index.json')
}

function conversationsDir(machineId) {
  return path.join(storeDir(), 'conversations', safeSegment(machineId))
}

function memoryDir(machineId) {
  return path.join(storeDir(), 'memory', safeSegment(machineId))
}

function manifestsDir() {
  return path.join(storeDir(), 'manifests')
}

/** Filesystem-safe form of an id that may arrive from another machine. */
export function safeSegment(value) {
  const text = typeof value === 'string' ? value : ''
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return cleaned === '' ? 'unknown' : cleaned.slice(0, 120)
}

function emptyIndex() {
  return {
    version: INDEX_VERSION,
    rev: 0,
    updatedAt: 0,
    conversations: {},
    memory: {},
    manifests: {}
  }
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    return fallback
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  await fs.writeFile(temp, JSON.stringify(value), 'utf8')
  await fs.rename(temp, file)
}

/** Run `task` after every previously queued task has settled. */
function serialized(task) {
  const next = chain.then(task, task)
  // Keep the chain alive even when a task rejects.
  chain = next.then(
    function () {},
    function () {}
  )
  return next
}

export async function ensure() {
  await fs.mkdir(storeDir(), { recursive: true })
  await fs.mkdir(path.join(storeDir(), 'conversations'), { recursive: true })
  await fs.mkdir(path.join(storeDir(), 'memory'), { recursive: true })
  await fs.mkdir(manifestsDir(), { recursive: true })
  return storeDir()
}

export async function index() {
  if (cachedIndex) return cachedIndex
  const raw = await readJsonFile(indexPath(), null)
  if (!raw || typeof raw !== 'object') {
    cachedIndex = emptyIndex()
    return cachedIndex
  }
  const merged = emptyIndex()
  merged.rev = Number.isFinite(raw.rev) ? Math.max(0, Math.trunc(raw.rev)) : 0
  merged.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  for (const key of ['conversations', 'memory', 'manifests']) {
    if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) merged[key] = raw[key]
  }
  cachedIndex = merged
  return cachedIndex
}

export function invalidate() {
  cachedIndex = null
}

async function commit(next) {
  next.updatedAt = Date.now()
  cachedIndex = next
  await writeJsonFile(indexPath(), next)
  return next
}

function bump(current) {
  const next = {
    version: INDEX_VERSION,
    rev: current.rev + 1,
    updatedAt: 0,
    conversations: Object.assign({}, current.conversations),
    memory: Object.assign({}, current.memory),
    manifests: Object.assign({}, current.manifests)
  }
  return next
}

function keyOf(machineId, sessionId) {
  return safeSegment(machineId) + '/' + safeSegment(sessionId)
}

// ------------------------------------------------------------- conversations

/**
 * Store one normalised transcript. Returns `{ changed, rev }`; a transcript
 * whose content hash matches the stored one is left untouched so repeated
 * pushes do not inflate the revision counter.
 */
export async function putConversation(machineId, transcript) {
  return serialized(async function () {
    await ensure()
    const current = await index()
    const sessionId = transcript && transcript.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { changed: false, rev: current.rev, reason: 'missing sessionId' }
    }
    const key = keyOf(machineId, sessionId)
    const previous = current.conversations[key]
    if (previous && previous.hash === transcript.hash) {
      return { changed: false, rev: current.rev }
    }
    const next = bump(current)
    const rev = next.rev
    const file = path.join(conversationsDir(machineId), safeSegment(sessionId) + '.json')
    await writeJsonFile(file, transcript)
    const machineName =
      typeof transcript.machineName === 'string' && transcript.machineName !== ''
        ? transcript.machineName
        : previous && previous.machineName
          ? previous.machineName
          : safeSegment(machineId)
    next.conversations[key] = {
      machineId: safeSegment(machineId),
      machineName,
      sessionId,
      title: transcript.title || '',
      cwd: transcript.cwd || '',
      createdAt: transcript.createdAt || 0,
      updatedAt: transcript.updatedAt || 0,
      items: Array.isArray(transcript.items) ? transcript.items.length : 0,
      bytes: transcript.bytes || 0,
      hash: transcript.hash,
      rev,
      storedAt: Date.now()
    }
    await pruneMachine(next, machineId)
    await commit(next)
    return { changed: true, rev }
  })
}

/** Drop the oldest conversations for one machine once the cap is exceeded. */
async function pruneMachine(next, machineId) {
  const prefix = safeSegment(machineId) + '/'
  const rows = Object.keys(next.conversations)
    .filter(function (key) {
      return key.startsWith(prefix)
    })
    .map(function (key) {
      return { key, meta: next.conversations[key] }
    })
  if (rows.length <= KEEP_PER_MACHINE) return
  rows.sort(function (a, b) {
    return (a.meta.updatedAt || a.meta.storedAt || 0) - (b.meta.updatedAt || b.meta.storedAt || 0)
  })
  const drop = rows.slice(0, rows.length - KEEP_PER_MACHINE)
  for (const row of drop) {
    delete next.conversations[row.key]
    try {
      await fs.rm(path.join(conversationsDir(machineId), safeSegment(row.meta.sessionId) + '.json'), { force: true })
    } catch (err) {
      /* the index no longer references it */
    }
  }
}

export async function getConversation(machineId, sessionId) {
  const file = path.join(conversationsDir(machineId), safeSegment(sessionId) + '.json')
  const body = await readJsonFile(file, null)
  if (body) return body
  // Tolerate a machine id that only differs by sanitising.
  const rows = await listConversations()
  const hit = rows.find(function (row) {
    return row.sessionId === sessionId
  })
  if (!hit) return null
  return readJsonFile(path.join(conversationsDir(hit.machineId), safeSegment(sessionId) + '.json'), null)
}

export async function listConversations() {
  const current = await index()
  return Object.keys(current.conversations)
    .map(function (key) {
      return current.conversations[key]
    })
    .sort(function (a, b) {
      return (b.updatedAt || b.storedAt || 0) - (a.updatedAt || a.storedAt || 0)
    })
}

// -------------------------------------------------------------------- memory

export async function putMemory(machineId, name, text) {
  return serialized(async function () {
    await ensure()
    const current = await index()
    const segment = safeSegment(name)
    const key = safeSegment(machineId) + '/' + segment
    const hash = hashText(text)
    const previous = current.memory[key]
    if (previous && previous.hash === hash) return { changed: false, rev: current.rev }
    const next = bump(current)
    const rev = next.rev
    await fs.mkdir(memoryDir(machineId), { recursive: true })
    await fs.writeFile(path.join(memoryDir(machineId), segment), text, 'utf8')
    next.memory[key] = {
      machineId: safeSegment(machineId),
      name: segment,
      bytes: Buffer.byteLength(text, 'utf8'),
      hash,
      rev,
      storedAt: Date.now()
    }
    await commit(next)
    return { changed: true, rev }
  })
}

export async function getMemory(machineId, name) {
  try {
    return await fs.readFile(path.join(memoryDir(machineId), safeSegment(name)), 'utf8')
  } catch (err) {
    return null
  }
}

export async function listMemory() {
  const current = await index()
  return Object.keys(current.memory).map(function (key) {
    return current.memory[key]
  })
}

// ----------------------------------------------------------------- manifests

export async function putManifest(machineId, manifest) {
  return serialized(async function () {
    await ensure()
    const current = await index()
    const key = safeSegment(machineId)
    const hash = hashText(JSON.stringify(manifest))
    const previous = current.manifests[key]
    if (previous && previous.hash === hash) return { changed: false, rev: current.rev }
    const next = bump(current)
    const rev = next.rev
    await writeJsonFile(path.join(manifestsDir(), key + '.json'), manifest)
    next.manifests[key] = {
      machineId: key,
      machineName: manifest.machineName || key,
      capturedAt: manifest.capturedAt || Date.now(),
      plugins: Array.isArray(manifest.plugins) ? manifest.plugins.length : 0,
      hash,
      rev,
      storedAt: Date.now()
    }
    await commit(next)
    return { changed: true, rev }
  })
}

export async function getManifest(machineId) {
  return readJsonFile(path.join(manifestsDir(), safeSegment(machineId) + '.json'), null)
}

export async function listManifests() {
  const current = await index()
  return Object.keys(current.manifests).map(function (key) {
    return current.manifests[key]
  })
}

// ------------------------------------------------------------------- pulling

/**
 * Everything written after `since`. Bodies are included, so one round trip is
 * enough for a peer to catch up.
 */
export async function changesSince(since) {
  const current = await index()
  const floor = Number.isFinite(since) ? Math.max(0, Math.trunc(since)) : 0
  const conversations = []
  for (const [key, meta] of Object.entries(current.conversations)) {
    if ((meta.rev || 0) <= floor) continue
    const body = await readJsonFile(
      path.join(conversationsDir(meta.machineId), safeSegment(meta.sessionId) + '.json'),
      null
    )
    if (body) conversations.push(body)
  }
  const memory = []
  for (const meta of Object.values(current.memory)) {
    if ((meta.rev || 0) <= floor) continue
    const text = await getMemory(meta.machineId, meta.name)
    if (text !== null) memory.push({ machineId: meta.machineId, name: meta.name, rev: meta.rev, text })
  }
  const manifests = []
  for (const meta of Object.values(current.manifests)) {
    if ((meta.rev || 0) <= floor) continue
    const manifest = await getManifest(meta.machineId)
    if (manifest) manifests.push(Object.assign({ rev: meta.rev }, manifest))
  }
  return { rev: current.rev, since: floor, conversations, memory, manifests }
}

export async function stats() {
  const current = await index()
  const body = {
    rev: current.rev,
    updatedAt: current.updatedAt,
    conversations: Object.keys(current.conversations).length,
    memory: Object.keys(current.memory).length,
    manifests: Object.keys(current.manifests).length,
    machines: {}
  }
  for (const meta of Object.values(current.conversations)) {
    body.machines[meta.machineId] = (body.machines[meta.machineId] || 0) + 1
  }
  return body
}

// --------------------------------------------------------------------- audit

export async function audit(entry) {
  try {
    await fs.mkdir(storeDir(), { recursive: true })
    const file = path.join(storeDir(), 'audit.jsonl')
    const line = JSON.stringify(Object.assign({ at: Date.now() }, entry)) + '\n'
    await fs.appendFile(file, line, 'utf8')
    const info = await fs.stat(file)
    if (info.size > AUDIT_MAX_BYTES) {
      const text = await fs.readFile(file, 'utf8')
      const tail = text.slice(-Math.trunc(AUDIT_MAX_BYTES / 2))
      const cut = tail.indexOf('\n')
      await fs.writeFile(file, cut >= 0 ? tail.slice(cut + 1) : tail, 'utf8')
    }
  } catch (err) {
    /* auditing must never break the caller */
  }
}

export async function recentAudit(limit) {
  try {
    const text = await fs.readFile(path.join(storeDir(), 'audit.jsonl'), 'utf8')
    const lines = text.split('\n').filter(Boolean).slice(-1 * (limit || 50))
    const out = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch (err) {
        /* skip a torn line */
      }
    }
    return out.reverse()
  } catch (err) {
    return []
  }
}

function hashText(text) {
  // FNV-1a over UTF-16 code units: cheap, stable, and only used to detect
  // "nothing actually changed", never for security.
  let hash = 0x811c9dc5
  const source = typeof text === 'string' ? text : ''
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0') + '-' + source.length.toString(16)
}

export { hashText }
