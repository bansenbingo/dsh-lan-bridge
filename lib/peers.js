/**
 * Peer table (v2).
 *
 * Discovery finds nodes, but a node is not useful until it is trusted. New
 * nodes land as `pending`; the user accepts or blocks them. `blocked` nodes
 * are never dialled and never admitted. Per-peer sync cursors live here too so
 * a restart resumes anti-entropy instead of re-downloading the world.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { peersFile } from './config.js'

const TABLE_VERSION = 2
let cached = null
let chain = Promise.resolve()

function empty() {
  return { version: TABLE_VERSION, updatedAt: new Date().toISOString(), peers: {} }
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fs.writeFile(temp, text, 'utf8')
  await fs.rename(temp, file)
  await fs.chmod(file, 0o600).catch(() => {})
}

async function commit() {
  cached.updatedAt = new Date().toISOString()
  const text = JSON.stringify(cached, null, 2) + '\n'
  chain = chain.then(() => writeAtomic(peersFile(), text), () => writeAtomic(peersFile(), text))
  await chain
}

export async function ensure() {
  if (cached) return cached
  try {
    const raw = JSON.parse(await fs.readFile(peersFile(), 'utf8'))
    cached = Object.assign(empty(), raw)
    cached.version = TABLE_VERSION
    if (!cached.peers || typeof cached.peers !== 'object') cached.peers = {}
  } catch (err) {
    cached = empty()
  }
  return cached
}

export async function list() {
  await ensure()
  const rows = Object.values(cached.peers)
  rows.sort((a, b) => {
    const rank = { trusted: 0, pending: 1, blocked: 2 }
    const diff = (rank[a.trust] ?? 1) - (rank[b.trust] ?? 1)
    if (diff) return diff
    return String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''))
  })
  return rows
}

export async function get(nodeId) {
  await ensure()
  return cached.peers[nodeId] || null
}

export async function upsert(record) {
  await ensure()
  const nodeId = String((record && record.nodeId) || '')
  if (!nodeId) throw new Error('peer needs nodeId')
  const current = cached.peers[nodeId] || {
    nodeId,
    name: nodeId,
    address: '',
    port: 0,
    fingerprint: '',
    trust: 'pending',
    addedAt: new Date().toISOString(),
    lastSeenAt: '',
    lastError: '',
    latencyMs: 0,
    sync: { pulledThrough: 0, pushedThrough: 0, lastPullAt: '', lastPushAt: '', lastError: '', lastSummary: '' }
  }
  const next = Object.assign(current, record)
  next.nodeId = nodeId
  next.sync = Object.assign(
    { pulledThrough: 0, pushedThrough: 0, lastPullAt: '', lastPushAt: '', lastError: '', lastSummary: '' },
    current.sync || {},
    record.sync || {}
  )
  cached.peers[nodeId] = next
  await commit()
  return next
}

export async function update(nodeId, patch) {
  await ensure()
  const current = cached.peers[nodeId]
  if (!current) return null
  Object.assign(current, patch || {})
  if (patch && patch.sync) current.sync = Object.assign({}, current.sync, patch.sync)
  await commit()
  return current
}

export async function trust(nodeId, level) {
  const allowed = ['trusted', 'pending', 'blocked']
  if (allowed.indexOf(level) < 0) throw new Error('bad trust level')
  return update(nodeId, { trust: level })
}

export async function remove(nodeId) {
  await ensure()
  if (!cached.peers[nodeId]) return false
  delete cached.peers[nodeId]
  await commit()
  return true
}

export async function removeAll() {
  await ensure()
  cached.peers = {}
  cached.bootstrap = {}
  await commit()
  return true
}

/** Record a successful contact and optionally fill address/name. */
export async function observe(record) {
  await ensure()
  const nodeId = String((record && record.nodeId) || '')
  if (!nodeId) return null
  const current = cached.peers[nodeId]
  if (!current) {
    return upsert({
      nodeId,
      name: record.name || nodeId,
      address: record.address || '',
      port: record.port || 0,
      fingerprint: record.fingerprint || '',
      trust: 'pending',
      lastSeenAt: new Date().toISOString(),
      latencyMs: record.latencyMs || 0
    })
  }
  const patch = { lastSeenAt: new Date().toISOString() }
  if (record.name) patch.name = record.name
  if (record.address) patch.address = record.address
  if (record.port) patch.port = record.port
  if (record.fingerprint) patch.fingerprint = record.fingerprint
  if (record.latencyMs) patch.latencyMs = record.latencyMs
  if (record.lastError) patch.lastError = record.lastError
  Object.assign(current, patch)
  await commit()
  return current
}

export async function setSyncState(nodeId, patch) {
  await ensure()
  const current = cached.peers[nodeId]
  if (!current) return null
  current.sync = Object.assign({}, current.sync, patch || {})
  current.lastSeenAt = new Date().toISOString()
  await commit()
  return current
}

export async function addBootstrap(address, name) {
  await ensure()
  if (!address) return null
  const existing = Object.values(cached.peers).find((peer) => peer.address === address)
  if (existing) return existing
  // Bootstrap entries have no node id yet; keep them in a reserved map so the
  // table stays a single file.
  cached.bootstrap = cached.bootstrap || {}
  cached.bootstrap[address] = { address, name: name || '', addedAt: new Date().toISOString() }
  await commit()
  return cached.bootstrap[address]
}

export async function listBootstrap() {
  await ensure()
  return Object.values(cached.bootstrap || {})
}

export async function snapshot() {
  await ensure()
  return { rows: await list(), rev: cached.updatedAt }
}
