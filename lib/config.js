/**
 * dsh-lan-bridge — configuration store.
 *
 * One JSON file under `$DSH_HOME/lan-bridge/config.json` holds everything the
 * host half needs to know: whether this machine is the hub or a peer, the LAN
 * token, the port, and which filesystem roots may be shared.
 *
 * Config is read lazily and cached in memory; `save()` writes atomically so a
 * crash can never leave a half-written file behind. Every mutating caller goes
 * through `update()` so concurrent HTTP requests cannot interleave writes.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

export const PLUGIN_NAME = 'dsh-lan-bridge'
export const DEFAULT_PORT = 47820
export const DEFAULT_DISCOVERY_PORT = 47821

const CONFIG_VERSION = 1

/** Absolute path of the plugin data directory (`$DSH_HOME/lan-bridge`). */
export function dataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  const base = home || path.join(os.homedir(), '.dsh')
  return path.join(base, 'lan-bridge')
}

export function configFile() {
  return path.join(dataDir(), 'config.json')
}

export function storeDir() {
  return path.join(dataDir(), 'store')
}

export function cacheDir() {
  return path.join(dataDir(), 'cache')
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

function newToken() {
  return randomBytes(24).toString('hex')
}

/**
 * Discovery is opt-in because a broadcast beacon on a shared office LAN is a
 * surprise the user should choose; explicit host+token pairing always works.
 */
export function defaults() {
  return {
    version: CONFIG_VERSION,
    machineId: randomUUID(),
    machineName: machineName(),
    role: 'peer', // 'hub' | 'peer'
    port: DEFAULT_PORT,
    discoveryPort: DEFAULT_DISCOVERY_PORT,
    discovery: false,
    token: newToken(),
    // Peer side: where the hub lives.
    hubHost: '',
    hubPort: DEFAULT_PORT,
    // Sync behaviour.
    autoSync: true,
    pushIntervalMs: 4000,
    pullIntervalMs: 4000,
    maxConversationBytes: 8 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
    // Explicit extra roots the user allowed for remote file access.
    extraRoots: [],
    // Roots the user explicitly denied even if they would qualify.
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

/** Coerce arbitrary JSON (hand-edited file, older version) into a full config. */
export function normalize(input) {
  const base = defaults()
  const raw = input && typeof input === 'object' ? input : {}
  const role = raw.role === 'hub' ? 'hub' : 'peer'
  return {
    version: CONFIG_VERSION,
    machineId: asString(raw.machineId, base.machineId),
    machineName: asString(raw.machineName, base.machineName),
    role,
    port: asInt(raw.port, base.port, 1024, 65535),
    discoveryPort: asInt(raw.discoveryPort, base.discoveryPort, 1024, 65535),
    discovery: asBool(raw.discovery, base.discovery),
    token: asString(raw.token, base.token),
    hubHost: typeof raw.hubHost === 'string' ? raw.hubHost.trim() : '',
    hubPort: asInt(raw.hubPort, base.hubPort, 1024, 65535),
    autoSync: asBool(raw.autoSync, base.autoSync),
    pushIntervalMs: asInt(raw.pushIntervalMs, base.pushIntervalMs, 1000, 600000),
    pullIntervalMs: asInt(raw.pullIntervalMs, base.pullIntervalMs, 1000, 600000),
    maxConversationBytes: asInt(raw.maxConversationBytes, base.maxConversationBytes, 65536, 64 * 1024 * 1024),
    maxFileBytes: asInt(raw.maxFileBytes, base.maxFileBytes, 4096, 32 * 1024 * 1024),
    extraRoots: asStringList(raw.extraRoots),
    deniedRoots: asStringList(raw.deniedRoots)
  }
}

let cached = null
let writeChain = Promise.resolve()

export async function load() {
  if (cached) return cached
  const file = configFile()
  try {
    const text = await fs.readFile(file, 'utf8')
    cached = normalize(JSON.parse(text))
    return cached
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      // A corrupt or unreadable config must not brick the plugin: keep a copy
      // for forensics and continue from defaults.
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

async function writeAtomic(file, text) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  await fs.writeFile(temp, text, 'utf8')
  await fs.rename(temp, file)
}

export async function save(config) {
  const next = normalize(config)
  const text = JSON.stringify(next, null, 2) + '\n'
  // Serialize writes so two overlapping updates cannot clobber each other.
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
  const merged = normalize(Object.assign({}, current, patch || {}))
  return save(merged)
}

export function peek() {
  return cached
}

/** Reset the memoized config; used after external edits and in tests. */
export function invalidate() {
  cached = null
}
