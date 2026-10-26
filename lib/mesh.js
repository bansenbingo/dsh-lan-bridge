/**
 * dsh-lan-bridge — the sync engine.
 *
 * One object owns the whole pipeline so the HTTP layer stays dumb:
 *
 *   exportLocal()   walk this machine's sessions, memory files and profile,
 *                   write every changed record into the local store
 *   ingest(payload) write records that arrived from another machine
 *   syncWithHub()   export → push mine → pull theirs → ingest
 *
 * Exports are incremental: a session file is only re-read when its size or
 * mtime changed, which keeps a 400-session history cheap to sweep every few
 * seconds.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as config from './config.js'
import * as store from './store.js'
import * as files from './files.js'
import * as plugins from './plugins.js'
import * as memory from './memory.js'
import { normalizeTranscript, readSessionFile, scanSessionFiles } from './sessions.js'

const EXPORT_CACHE_VERSION = 1

function cacheFile() {
  return path.join(config.cacheDir(), 'export.json')
}

function rootsFile() {
  return path.join(config.cacheDir(), 'roots.json')
}

function syncStateFile() {
  return path.join(config.cacheDir(), 'sync.json')
}

/** How much one push request may carry. The hub refuses bodies above 32 MiB. */
const PUSH_BATCH_BYTES = 8 * 1024 * 1024

/**
 * Split one push payload into requests that stay under `maxBytes`.
 *
 * A sync used to hand every conversation to the hub in a single request, which
 * quietly broke as soon as the local history outgrew the hub's 32 MiB body cap.
 * Batching keeps each request small; a single oversized record still travels
 * alone, and it cannot exceed the cap because the exporter caps a conversation
 * at `maxConversationBytes` (8 MiB by default).
 *
 * @param {{conversations?: any[], memory?: any[], manifests?: any[]}} payload
 * @param {number} [maxBytes]
 * @returns {Array<{conversations: any[], memory: any[], manifests: any[]}>} batches; empty when there is nothing to send
 */
export function splitPayload(payload, maxBytes) {
  const budget = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : PUSH_BATCH_BYTES
  const source = payload && typeof payload === 'object' ? payload : {}
  const batches = []
  let current = { conversations: [], memory: [], manifests: [] }
  let size = 2
  let count = 0
  for (const key of ['conversations', 'memory', 'manifests']) {
    for (const record of Array.isArray(source[key]) ? source[key] : []) {
      const recordBytes = Buffer.byteLength(JSON.stringify(record) || '') + 2
      if (count > 0 && size + recordBytes > budget) {
        batches.push(current)
        current = { conversations: [], memory: [], manifests: [] }
        size = 2
        count = 0
      }
      current[key].push(record)
      size += recordBytes
      count += 1
    }
  }
  if (count > 0) batches.push(current)
  return batches
}

function shortHash(text) {
  let hash = 0x811c9dc5
  const source = String(text)
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(36)
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    return fallback
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  await fs.writeFile(temp, JSON.stringify(value), 'utf8')
  await fs.rename(temp, file)
}

export function createMesh(ctx, options) {
  const opts = options || {}
  const state = {
    lastExportAt: 0,
    lastPullAt: 0,
    lastPushAt: 0,
    lastError: null,
    lastSummary: null,
    pullRev: 0,
    pushRev: 0,
    syncLoaded: false,
    hubKey: '',
    busy: false,
    exportedSessions: 0,
    pendingPush: 0
  }

  const identity = async function () {
    const current = await config.load()
    return {
      machineId: current.machineId,
      machineName: current.machineName,
      platform: process.platform,
      arch: process.arch,
      role: current.role
    }
  }

  // ----------------------------------------------------------------- roots

  /**
   * Shared roots are the workspaces this DSH has genuinely used (their exact
   * cwd comes from session headers) plus anything the user added by hand.
   */
  async function refreshRoots(cwds) {
    const current = await config.load()
    const list = []
    const seen = new Set()
    const push = function (rootPath, kind) {
      const resolved = path.resolve(rootPath)
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      if (seen.has(key)) return
      seen.add(key)
      list.push({
        id: (kind === 'extra' ? 'x-' : 'w-') + shortHash(key),
        label: path.basename(resolved) || resolved,
        path: resolved,
        kind
      })
    }
    for (const cwd of cwds) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue
      const exists = await files.exists(cwd)
      if (exists) push(cwd, 'workspace')
    }
    for (const extra of current.extraRoots) {
      if (!path.isAbsolute(extra)) continue
      const exists = await files.exists(extra)
      if (exists) push(extra, 'extra')
    }
    const denied = new Set(
      current.deniedRoots.map(function (entry) {
        return process.platform === 'win32' ? path.resolve(entry).toLowerCase() : path.resolve(entry)
      })
    )
    const filtered = list.filter(function (root) {
      const key = process.platform === 'win32' ? root.path.toLowerCase() : root.path
      return !denied.has(key)
    })
    files.setRoots(filtered)
    await writeJson(rootsFile(), filtered)
    return filtered
  }

  async function loadCachedRoots() {
    const cached = await readJson(rootsFile(), null)
    if (Array.isArray(cached) && cached.length > 0) {
      const alive = []
      for (const root of cached) {
        if (root && typeof root.path === 'string' && (await files.exists(root.path))) alive.push(root)
      }
      files.setRoots(alive)
      return alive
    }
    return []
  }

  // --------------------------------------------------------------- exports

  async function readExportCache() {
    const raw = await readJson(cacheFile(), null)
    if (!raw || raw.version !== EXPORT_CACHE_VERSION || typeof raw.files !== 'object') {
      return { version: EXPORT_CACHE_VERSION, files: {}, cwds: [] }
    }
    return raw
  }

  async function exportSessions(current, cache, options) {
    const settings = options || {}
    const rows = await scanSessionFiles()
    const cwds = new Set(cache.cwds || [])
    const nextFiles = Object.assign({}, cache.files)
    let exported = 0
    let skipped = 0
    let failed = 0

    for (const row of rows) {
      const known = nextFiles[row.file]
      const unchanged = known && known.size === row.size && known.mtimeMs === row.mtimeMs
      if (unchanged && !settings.force) {
        skipped += 1
        if (known.cwd) cwds.add(known.cwd)
        continue
      }
      let parsed = null
      try {
        parsed = await readSessionFile(row.file)
      } catch (err) {
        failed += 1
        continue
      }
      if (!parsed || !parsed.header) {
        failed += 1
        continue
      }
      const transcript = normalizeTranscript(parsed.header, parsed.events, {
        maxBytes: current.maxConversationBytes
      })
      if (!transcript.sessionId) {
        failed += 1
        continue
      }
      transcript.machineId = current.machineId
      transcript.machineName = current.machineName
      transcript.platform = process.platform
      transcript.originFile = row.file
      transcript.hash = store.hashText(JSON.stringify(transcript.items))
      if (parsed.header.cwd) cwds.add(parsed.header.cwd)
      try {
        await store.putConversation(current.machineId, transcript)
        exported += 1
      } catch (err) {
        failed += 1
      }
      nextFiles[row.file] = {
        size: row.size,
        mtimeMs: row.mtimeMs,
        sessionId: transcript.sessionId,
        cwd: parsed.header.cwd || '',
        hash: transcript.hash
      }
    }

    await writeJson(cacheFile(), {
      version: EXPORT_CACHE_VERSION,
      files: nextFiles,
      cwds: Array.from(cwds)
    })
    return { exported, skipped, failed, total: rows.length, cwds: Array.from(cwds) }
  }

  async function exportMemory(current) {
    const found = await memory.discover()
    let pushed = 0
    for (const entry of found) {
      let text = null
      try {
        text = await memory.readMemory(entry.file)
      } catch (err) {
        continue
      }
      const result = await store.putMemory(current.machineId, entry.name, text)
      if (result.changed) pushed += 1
    }
    return { found: found.length, pushed }
  }

  async function exportManifest(current) {
    const manifest = await plugins.readLocalManifest(ctx, {
      machineId: current.machineId,
      machineName: current.machineName
    })
    const result = await store.putManifest(current.machineId, manifest)
    return { changed: result.changed, plugins: manifest.pluginCount, manifest }
  }

  /** Full local sweep: sessions, memory, manifest, roots. */
  async function exportLocal(options) {
    const settings = options || {}
    const current = await config.load()
    const cache = await readExportCache()
    const sessions = await exportSessions(current, cache, settings)
    const memoryResult = await exportMemory(current)
    const manifestResult = await exportManifest(current)
    const rootList = await refreshRoots(sessions.cwds)
    state.lastExportAt = Date.now()
    const summary = {
      sessions,
      memory: memoryResult,
      manifest: { plugins: manifestResult.plugins },
      roots: rootList.length
    }
    state.lastSummary = summary
    state.exportedSessions = sessions.exported
    return summary
  }

  // ---------------------------------------------------------------- ingest

  /**
   * Write records that came from another machine. Bodies are re-normalised only
   * in the sense of being validated: a record without an id or items is
   * rejected rather than stored.
   */
  async function ingest(payload, meta) {
    const body = payload && typeof payload === 'object' ? payload : {}
    const info = meta || {}
    const accepted = { conversations: 0, memory: 0, manifests: 0, rejected: 0 }
    let rev = 0

    for (const record of Array.isArray(body.conversations) ? body.conversations : []) {
      if (!record || typeof record !== 'object') {
        accepted.rejected += 1
        continue
      }
      const sessionId = record.sessionId
      const machineId = record.machineId
      if (typeof sessionId !== 'string' || sessionId === '' || typeof machineId !== 'string' || machineId === '') {
        accepted.rejected += 1
        continue
      }
      const sanitized = {
        sessionId,
        machineId: store.safeSegment(machineId),
        machineName: typeof record.machineName === 'string' ? record.machineName : machineId,
        platform: typeof record.platform === 'string' ? record.platform : '',
        title: typeof record.title === 'string' ? record.title : '',
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0,
        updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
        agentPreset: typeof record.agentPreset === 'string' ? record.agentPreset : '',
        items: Array.isArray(record.items) ? record.items : [],
        bytes: Number.isFinite(record.bytes) ? record.bytes : 0,
        hash:
          typeof record.hash === 'string' && record.hash
            ? record.hash
            : store.hashText(JSON.stringify(Array.isArray(record.items) ? record.items : []))
      }
      const result = await store.putConversation(sanitized.machineId, sanitized)
      if (result.changed) accepted.conversations += 1
      rev = Math.max(rev, result.rev || 0)
    }

    for (const record of Array.isArray(body.memory) ? body.memory : []) {
      if (!record || typeof record.machineId !== 'string' || typeof record.name !== 'string') {
        accepted.rejected += 1
        continue
      }
      if (typeof record.text !== 'string') {
        accepted.rejected += 1
        continue
      }
      const result = await store.putMemory(record.machineId, record.name, record.text)
      if (result.changed) accepted.memory += 1
      rev = Math.max(rev, result.rev || 0)
    }

    for (const record of Array.isArray(body.manifests) ? body.manifests : []) {
      if (!record || typeof record.machineId !== 'string') {
        accepted.rejected += 1
        continue
      }
      const result = await store.putManifest(record.machineId, record)
      if (result.changed) accepted.manifests += 1
      rev = Math.max(rev, result.rev || 0)
    }

    if (info.direction === 'push') {
      state.lastPushAt = Date.now()
      await store.audit({
        kind: 'push-received',
        from: info.from || '',
        conversations: accepted.conversations,
        memory: accepted.memory,
        manifests: accepted.manifests,
        rejected: accepted.rejected
      })
    } else {
      state.lastPullAt = Date.now()
      await store.audit({
        kind: 'pull-applied',
        conversations: accepted.conversations,
        memory: accepted.memory,
        manifests: accepted.manifests,
        rejected: accepted.rejected
      })
    }
    return { ok: true, accepted, rev: rev || (await store.index()).rev }
  }

  /** What this machine should hand to the hub: only its own records. */
  async function ownRecords(sinceRev) {
    const current = await config.load()
    const from = Number.isFinite(sinceRev) && sinceRev > 0 ? sinceRev : 0
    const payload = await store.changesSince(from)
    return {
      conversations: payload.conversations.filter(function (row) {
        return row.machineId === store.safeSegment(current.machineId)
      }),
      memory: payload.memory.filter(function (row) {
        return row.machineId === store.safeSegment(current.machineId)
      }),
      manifests: payload.manifests.filter(function (row) {
        return row.machineId === store.safeSegment(current.machineId)
      })
    }
  }

  function hubKeyOf(current) {
    return [current.hubHost || '', String(current.hubPort || ''), shortHash(current.token || '')].join('|')
  }

  async function loadSyncState(current) {
    if (state.syncLoaded) return
    state.syncLoaded = true
    const saved = await readJson(syncStateFile(), {})
    const key = hubKeyOf(current)
    // A different hub means different revisions: replay from zero instead of
    // silently skipping everything that hub has never received.
    if (saved && saved.hubKey && saved.hubKey === key) {
      if (Number.isFinite(saved.pullRev) && saved.pullRev > 0) state.pullRev = saved.pullRev
      if (Number.isFinite(saved.pushRev) && saved.pushRev > 0) state.pushRev = saved.pushRev
    }
    state.hubKey = key
  }

  async function saveSyncState() {
    try {
      await writeJson(syncStateFile(), {
        hubKey: state.hubKey,
        pullRev: state.pullRev,
        pushRev: state.pushRev,
        at: Date.now()
      })
    } catch (err) {
      /* losing it only makes the next sync replay more records */
    }
  }

  /**
   * One full round trip against the hub: publish mine, then take theirs.
   * @param {object} peer  the peer client from `createPeer`
   */
  async function syncWithHub(peer) {
    if (state.busy) return { ok: false, code: 'BUSY', message: 'a sync is already running' }
    state.busy = true
    const current = await config.load()
    try {
      await exportLocal()
      await loadSyncState(current)
      const revBefore = (await store.index()).rev
      const own = await ownRecords(state.pushRev)
      const batches = splitPayload(own, PUSH_BATCH_BYTES)
      const acceptedTotals = { conversations: 0, memory: 0, manifests: 0, rejected: 0 }
      for (const batch of batches) {
        const result = await peer.push(batch)
        const accepted = (result && result.accepted) || {}
        acceptedTotals.conversations += accepted.conversations || 0
        acceptedTotals.memory += accepted.memory || 0
        acceptedTotals.manifests += accepted.manifests || 0
        acceptedTotals.rejected += accepted.rejected || 0
      }
      if (batches.length > 0) {
        // Everything up to `revBefore` has now reached the hub. Records written
        // while the push ran keep a higher revision and go out next round.
        state.pushRev = Math.max(state.pushRev, revBefore)
      }
      const pulled = await peer.pull(state.pullRev)
      await ingest(pulled, { direction: 'pull' })
      if (Number.isFinite(pulled.rev)) state.pullRev = pulled.rev
      await saveSyncState()
      state.lastPullAt = Date.now()
      state.lastError = null
      return {
        ok: true,
        rev: pulled.rev,
        pushed: {
          conversations: own.conversations.length,
          memory: own.memory.length,
          manifests: own.manifests.length,
          accepted: acceptedTotals,
          batches: batches.length
        },
        pulled: {
          conversations: pulled.conversations ? pulled.conversations.length : 0,
          memory: pulled.memory ? pulled.memory.length : 0,
          manifests: pulled.manifests ? pulled.manifests.length : 0
        }
      }
    } catch (err) {
      state.lastError = {
        at: Date.now(),
        code: (err && err.code) || 'SYNC_FAILED',
        message: String((err && err.message) || err)
      }
      return { ok: false, code: state.lastError.code, message: state.lastError.message }
    } finally {
      state.busy = false
      state.lastPullAt = Date.now()
      const refreshed = await config.load()
      if (refreshed.role === 'hub') {
        // A hub self-syncs so its own history is always in the shared store.
        state.lastExportAt = state.lastExportAt || Date.now()
      }
    }
  }

  return {
    state,
    identity,
    store,
    files,
    plugins,
    memory,
    exportLocal,
    ingest,
    ownRecords,
    syncWithHub,
    refreshRoots,
    loadCachedRoots,
    get maxFileBytes() {
      return config.peek() ? config.peek().maxFileBytes : 2 * 1024 * 1024
    },
    get port() {
      return config.peek() ? config.peek().port : config.DEFAULT_PORT
    },
    get ctx() {
      return ctx
    }
  }
}

export function homeDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  return home || path.join(os.homedir(), '.dsh')
}
