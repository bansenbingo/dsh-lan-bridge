/**
 * dsh-lan-bridge — configuration store (v2).
 *
 * One JSON file under `$DSH_HOME/lan-bridge/config.json`. Version 2 removes the
 * hub/peer split: every installation is a node with an identity, a shared
 * space key, and a peer table. The table lives in `peers.json` because it is
 * edited by discovery and by the user, not by the config form.
 *
 * A version-1 config is migrated in place. The old `token` is stretched into a
 * network key so machines that already knew each other keep the same space
 * after both sides upgrade. Nothing is deleted; the previous file is copied to
 * `config.v1.json` once.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PLUGIN_NAME = 'dsh-lan-bridge'
export const DEFAULT_PORT = 47820
export const DEFAULT_DISCOVERY_PORT = 47821
export const CONFIG_VERSION = 2
export const PROTOCOL_VERSION = 2

const V1_TOKEN_SALT = 'dsh-lan-bridge:v2:'

/** Absolute path of the plugin data directory (`$DSH_HOME/lan-bridge`). */
export function dataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  const base = home || path.join(os.homedir(), '.dsh')
  return path.join(base, 'lan-bridge')
}

export function configFile() {
  return path.join(dataDir(), 'config.json')
}

export function peersFile() {
  return path.join(dataDir(), 'peers.json')
}

export function identityFile() {
  return path.join(dataDir(), 'identity.json')
}

export function storeDir() {
  return path.join(dataDir(), 'store')
}

export function cacheDir() {
  return path.join(dataDir(), 'cache')
}

export function inboxDir() {
  return path.join(dataDir(), 'inbox')
}

export function tmpDir() {
  return path.join(dataDir(), 'tmp')
}

export function machineName() {
  try {
    const host = os.hostname()
    if (host && host.trim()) return host.trim()
  } catch (err) {
    /* fall through */
  }
  return 'dsh-' + os.platform()
}

export function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

export function shortHash(text, length) {
  const hex = createHash('sha256').update(String(text)).digest('hex')
  return hex.slice(0, length || 16)
}

export function deriveSpaceId(networkKey) {
  return createHash('sha256').update(String(networkKey)).digest('hex').slice(0, 16)
}

/** Turn a v1 shared token into a v2 group key. */
export function deriveNetworkKey(token) {
  return createHash('sha256').update(V1_TOKEN_SALT + String(token)).digest('base64url')
}

export function newNetworkKey() {
  return randomBytes(32).toString('base64url')
}

export function defaults() {
  const networkKey = newNetworkKey()
  return {
    version: CONFIG_VERSION,
    nodeId: randomUUID(),
    nodeName: machineName(),
    port: DEFAULT_PORT,
    discoveryPort: DEFAULT_DISCOVERY_PORT,
    discovery: true,
    networkKey,
    spaceId: deriveSpaceId(networkKey),
    bootstrapPeers: [],
    syncIntervalMs: 5000,
    scanIntervalMs: 5000,
    maxConversationBytes: 8 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
    maxTransferBytes: 2 * 1024 * 1024 * 1024,
    transferChunkBytes: 4 * 1024 * 1024,
    maxAiCallsPerDay: 200,
    retentionDays: 30,
    autoAcceptTransfers: false,
    allowRemoteRead: true,
    allowRemoteAi: false,
    agentTools: true,
    aiModelAllowlist: [],
    extraRoots: [],
    deniedRoots: []
  }
}

function asString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function asInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  if (min !== undefined && parsed < min) return min
  if (max !== undefined && parsed > max) return max
  return Math.trunc(parsed)
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asStringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
  }
  return out
}

function normalizePeerAddress(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    try {
      const url = new URL(text)
      if (!url.hostname) return ''
      return url.port ? url.hostname + ':' + url.port : url.hostname
    } catch (err) {
      return ''
    }
  }
  return text
}

/**
 * Coerce arbitrary JSON into a full v2 config. Handles v1 keys so an upgrade
 * needs no manual migration step.
 */
export function normalize(input) {
  const base = defaults()
  const raw = input && typeof input === 'object' ? input : {}

  // v1 -> v2 identity and space. Keep the machine id so conversations already
  // attributed to this machine stay attributable, and stretch the shared token
  // so two v1 machines derive the same group key.
  const nodeId = asString(raw.nodeId, asString(raw.machineId, base.nodeId))
  let networkKey = asString(raw.networkKey, '')
  if (!networkKey && typeof raw.token === 'string' && raw.token) networkKey = deriveNetworkKey(raw.token)
  if (!networkKey) networkKey = base.networkKey
  const spaceId = deriveSpaceId(networkKey)

  const bootstrap = asStringList(raw.bootstrapPeers).map(normalizePeerAddress).filter(Boolean)
  if (typeof raw.hubHost === 'string' && raw.hubHost.trim()) {
    const host = raw.hubHost.trim()
    const port = asInt(raw.hubPort, DEFAULT_PORT, 1024, 65535)
    const address = host + ':' + port
    if (bootstrap.indexOf(address) < 0) bootstrap.push(address)
  }

  const legacySync = Math.min(
    asInt(raw.pushIntervalMs, 5000, 1000, 600000),
    asInt(raw.pullIntervalMs, 5000, 1000, 600000)
  )

  return {
    version: CONFIG_VERSION,
    nodeId,
    nodeName: asString(raw.nodeName, asString(raw.machineName, base.nodeName)),
    port: asInt(raw.port, base.port, 1024, 65535),
    discoveryPort: asInt(raw.discoveryPort, base.discoveryPort, 1024, 65535),
    discovery: asBool(raw.discovery, base.discovery),
    networkKey,
    spaceId,
    bootstrapPeers: bootstrap,
    syncIntervalMs: asInt(raw.syncIntervalMs, legacySync, 1000, 600000),
    scanIntervalMs: asInt(raw.scanIntervalMs, base.scanIntervalMs, 1000, 600000),
    maxConversationBytes: asInt(raw.maxConversationBytes, base.maxConversationBytes, 65536, 64 * 1024 * 1024),
    maxFileBytes: asInt(raw.maxFileBytes, base.maxFileBytes, 4096, 32 * 1024 * 1024),
    maxTransferBytes: asInt(raw.maxTransferBytes, base.maxTransferBytes, 1024 * 1024, 16 * 1024 * 1024 * 1024),
    transferChunkBytes: asInt(raw.transferChunkBytes, base.transferChunkBytes, 256 * 1024, 8 * 1024 * 1024),
    maxAiCallsPerDay: asInt(raw.maxAiCallsPerDay, base.maxAiCallsPerDay, 1, 100000),
    retentionDays: asInt(raw.retentionDays, base.retentionDays, 1, 3650),
    autoAcceptTransfers: asBool(raw.autoAcceptTransfers, base.autoAcceptTransfers),
    allowRemoteRead: asBool(raw.allowRemoteRead, base.allowRemoteRead),
    allowRemoteAi: asBool(raw.allowRemoteAi, base.allowRemoteAi),
    agentTools: asBool(raw.agentTools, base.agentTools),
    aiModelAllowlist: asStringList(raw.aiModelAllowlist),
    extraRoots: asStringList(raw.extraRoots),
    deniedRoots: asStringList(raw.deniedRoots)
  }
}

let cached = null
let writeChain = Promise.resolve()

async function writeAtomic(file, text) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fs.writeFile(temp, text, 'utf8')
  await fs.rename(temp, file)
  await fs.chmod(file, 0o600).catch(() => {})
}

export async function load() {
  if (cached) return cached
  const file = configFile()
  try {
    const text = await fs.readFile(file, 'utf8')
    const raw = JSON.parse(text)
    cached = normalize(raw)
    if (cached.version !== raw.version || raw.version === 1) {
      // Keep a forensic copy of the pre-v2 file exactly once.
      try {
        await fs.access(file + '.v1.json')
      } catch (err) {
        await fs.copyFile(file, file + '.v1.json')
        await fs.chmod(file + '.v1.json', 0o600).catch(() => {})
      }
      await save(cached)
    }
    return cached
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      try {
        await fs.rename(file, file + '.corrupt-' + Date.now())
      } catch (renameError) {
        /* best effort */
      }
    }
    cached = defaults()
    await save(cached)
    return cached
  }
}

export async function save(config) {
  const next = normalize(config)
  const text = JSON.stringify(next, null, 2) + '\n'
  writeChain = writeChain.then(
    function () {
      return writeAtomic(configFile(), text)
    },
    function () {
      return writeAtomic(configFile(), text)
    }
  )
  await writeChain
  cached = next
  return next
}

/** Read-modify-write with the in-memory copy as the source of truth. */
export async function update(patch) {
  const current = await load()
  return save(Object.assign({}, current, patch || {}))
}

export function peek() {
  return cached
}

export function invalidate() {
  cached = null
}
