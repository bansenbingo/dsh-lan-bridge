/**
 * Anti-entropy sync (v2).
 *
 * Every node exports its own durable artifacts into the local content store:
 * conversation transcripts, memory files, and a plugin manifest. Peers then
 * exchange the prefix of objects after their own cursor. Objects are
 * immutable (conversations) or last-write-wins (memory, manifests), and the
 * content hash makes a repeated sync cheap.
 *
 * There is no hub. A node syncs with every trusted peer it can reach; a third
 * node's objects arrive transitively because they are ordinary store objects.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { cacheDir } from './config.js'
import { hashText } from './store.js'
import { scanSessionFiles, readSessionFile, normalizeTranscript } from './sessions.js'
import * as memory from './memory.js'
import * as plugins from './plugins.js'

const CACHE_VERSION = 2

function cacheFile() {
  return path.join(cacheDir(), 'export.json')
}

async function readCache() {
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(), 'utf8'))
    if (raw && raw.version === CACHE_VERSION) return raw
  } catch (err) {
    /* first run or unreadable cache */
  }
  return { version: CACHE_VERSION, files: {}, memory: {}, manifestAt: '' }
}

async function writeCache(cache) {
  await fs.mkdir(cacheDir(), { recursive: true })
  const temp = cacheFile() + '.' + process.pid + '.tmp'
  await fs.writeFile(temp, JSON.stringify(cache), 'utf8')
  await fs.rename(temp, cacheFile())
  await fs.chmod(cacheFile(), 0o600).catch(() => {})
}

function timestampOf(ms) {
  const value = Number(ms)
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : new Date().toISOString()
}

export function createMesh(options) {
  const getConfig = options.getConfig
  const store = options.store
  const peers = options.peers
  const transport = options.transport
  const getContext = options.getContext || function () { return null }
  const onEvent = options.onEvent || function () {}
  const state = {
    busy: false,
    lastSyncAt: '',
    lastExportAt: '',
    lastError: '',
    lastSummary: '',
    peerStates: {}
  }

  async function exportSessions(cache, force) {
    const config = getConfig()
    const rows = await scanSessionFiles()
    const seen = new Set()
    let exported = 0
    let skipped = 0
    for (const row of rows) {
      seen.add(row.file)
      const cached = cache.files[row.file]
      if (!force && cached && cached.size === row.size && cached.mtimeMs === row.mtimeMs) {
        skipped += 1
        continue
      }
      try {
        const parsed = await readSessionFile(row.file)
        if (!parsed || !parsed.header) continue
        const transcript = normalizeTranscript(parsed.header, parsed.events, {
          maxBytes: config.maxConversationBytes
        })
        if (!transcript || !transcript.sessionId) continue
        const record = Object.assign({}, transcript, {
          nodeId: config.nodeId,
          machineId: config.nodeId,
          machineName: config.nodeName,
          platform: process.platform,
          workspace: row.workspace,
          updatedAt: transcript.updatedAt || timestampOf(row.mtimeMs)
        })
        await store.putConversation(record)
        cache.files[row.file] = {
          size: row.size,
          mtimeMs: row.mtimeMs,
          hash: storeHash(record),
          at: new Date().toISOString()
        }
        exported += 1
      } catch (err) {
        // One unreadable session must not stop the rest of the export.
      }
    }
    for (const file of Object.keys(cache.files)) {
      if (!seen.has(file)) delete cache.files[file]
    }
    return { exported, skipped }
  }

  function storeHash(record) {
    try {
      return hashText(JSON.stringify(record))
    } catch (err) {
      return ''
    }
  }

  async function exportMemory(cache, force) {
    const config = getConfig()
    const found = await memory.discover()
    const byName = new Map()
    for (const entry of found) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry)
    }
    let exported = 0
    for (const [name, entry] of byName) {
      const cached = cache.memory[name]
      if (!force && cached && cached.size === entry.size && cached.mtime === entry.mtime) continue
      try {
        const text = await memory.readMemory(entry.file)
        await store.putMemory({
          nodeId: config.nodeId,
          machineId: config.nodeId,
          machineName: config.nodeName,
          name,
          text,
          updatedAt: timestampOf(entry.mtime),
          originFile: entry.file,
          scope: entry.scope
        })
        cache.memory[name] = { size: entry.size, mtime: entry.mtime, hash: hashText(text) }
        exported += 1
      } catch (err) {
        /* skip this file */
      }
    }
    return { exported }
  }

  async function exportManifest(cache, force) {
    const config = getConfig()
    if (!force && cache.manifestAt && Date.now() - Date.parse(cache.manifestAt) < 30000) return { exported: 0 }
    try {
      const ctx = getContext()
      const manifest = await plugins.readLocalManifest(ctx || {}, {
        machineId: config.nodeId,
        machineName: config.nodeName
      })
      manifest.nodeId = config.nodeId
      // The manifest is for installing the same plugin set elsewhere; the
      // profile path and the raw user patch may contain machine-local data and
      // are not needed by the consumer.
      delete manifest.profileDir
      delete manifest.patch
      await store.putManifest({ nodeId: config.nodeId, body: manifest })
      cache.manifestAt = new Date().toISOString()
      return { exported: 1 }
    } catch (err) {
      return { exported: 0, error: String((err && err.message) || err) }
    }
  }

  async function exportLocal(options) {
    const force = Boolean(options && options.force)
    const cache = await readCache()
    const sessions = await exportSessions(cache, force)
    const memories = await exportMemory(cache, force)
    const manifests = await exportManifest(cache, force)
    await writeCache(cache)
    state.lastExportAt = new Date().toISOString()
    const result = {
      conversations: sessions.exported,
      skippedSessions: sessions.skipped,
      memory: memories.exported,
      manifests: manifests.exported
    }
    state.lastSummary = 'exported ' + sessions.exported + ' conversations, ' + memories.exported + ' memory files'
    onEvent('export', result)
    return result
  }

  async function ingest(objects) {
    let accepted = 0
    let skipped = 0
    for (const object of Array.isArray(objects) ? objects : []) {
      if (!object || !object.kind || !object.nodeId || !object.id) {
        skipped += 1
        continue
      }
      try {
        if (object.kind === 'conversation') {
          const body = object.body
          if (!body || typeof body !== 'object') {
            skipped += 1
            continue
          }
          const result = await store.putConversation(Object.assign({}, body, {
            nodeId: object.nodeId,
            machineId: object.nodeId,
            sessionId: object.id,
            updatedAt: object.updatedAt || body.updatedAt
          }))
          if (result && (result.deduped || result.stale)) skipped += 1
          else accepted += 1
        } else if (object.kind === 'memory') {
          const text = typeof object.body === 'string' ? object.body : ''
          const result = await store.putMemory({
            nodeId: object.nodeId,
            machineId: object.nodeId,
            name: object.id,
            text,
            updatedAt: object.updatedAt
          })
          if (result && (result.deduped || result.stale)) skipped += 1
          else accepted += 1
        } else if (object.kind === 'manifest') {
          const result = await store.putManifest({
            nodeId: object.nodeId,
            body: object.body,
            updatedAt: object.updatedAt
          })
          if (result && (result.deduped || result.stale)) skipped += 1
          else accepted += 1
        } else {
          skipped += 1
        }
      } catch (err) {
        skipped += 1
      }
    }
    return { accepted, skipped }
  }

  async function pullFrom(peer) {
    const config = getConfig()
    const since = Number(peer.sync && peer.sync.pulledThrough) || 0
    const response = await transport.request(peer, 'GET', '/api/v2/pull?since=' + since)
    if (!response || !Array.isArray(response.objects)) throw new Error('peer returned no pull page')
    const result = await ingest(response.objects)
    const cursor = Number(response.cursor) || since
    await peers.setSyncState(peer.nodeId, {
      pulledThrough: cursor,
      lastPullAt: new Date().toISOString(),
      lastError: '',
      lastSummary: 'pulled ' + result.accepted + ' objects from ' + peer.nodeId
    })
    return { pulled: result.accepted, cursor, remoteRev: response.rev }
  }

  async function pushTo(peer) {
    const config = getConfig()
    const since = Number(peer.sync && peer.sync.pushedThrough) || 0
    const page = await store.changesSince(since, { excludeNodeId: config.nodeId })
    if (!page.objects.length) {
      await peers.setSyncState(peer.nodeId, {
        pushedThrough: page.cursor || since,
        lastPushAt: new Date().toISOString()
      })
      return { pushed: 0, cursor: page.cursor || since }
    }
    const response = await transport.request(peer, 'POST', '/api/v2/push', {
      json: { objects: page.objects, cursor: page.cursor },
      timeoutMs: 45000
    })
    const accepted = Number(response && response.accepted) || 0
    await peers.setSyncState(peer.nodeId, {
      pushedThrough: page.cursor,
      lastPushAt: new Date().toISOString(),
      lastError: '',
      lastSummary: 'pushed ' + accepted + ' objects to ' + peer.nodeId
    })
    return { pushed: accepted, cursor: page.cursor }
  }

  async function syncPeer(peer) {
    if (!peer || peer.trust !== 'trusted') return { skipped: true, reason: 'not-trusted' }
    const config = getConfig()
    if (peer.nodeId === config.nodeId) return { skipped: true, reason: 'self' }
    try {
      const pulled = await pullFrom(peer)
      const pushed = await pushTo(peer)
      const summary = {
        ok: true,
        nodeId: peer.nodeId,
        pulled: pulled.pulled,
        pushed: pushed.pushed,
        at: new Date().toISOString()
      }
      state.peerStates[peer.nodeId] = summary
      return summary
    } catch (err) {
      const message = String((err && err.message) || err)
      await peers.setSyncState(peer.nodeId, { lastError: message })
      state.peerStates[peer.nodeId] = { ok: false, nodeId: peer.nodeId, error: message, code: err && err.code }
      throw err
    }
  }

  async function syncAll(options) {
    if (state.busy) return { ok: true, busy: true, results: [], pulled: 0, pushed: 0 }
    state.busy = true
    state.lastError = ''
    try {
      await exportLocal()
      const list = (await peers.list()).filter((peer) => peer.trust === 'trusted')
      const results = []
      for (const peer of list) {
        try {
          results.push(await syncPeer(peer))
        } catch (err) {
          results.push({ ok: false, nodeId: peer.nodeId, error: String((err && err.message) || err) })
        }
      }
      state.lastSyncAt = new Date().toISOString()
      const failed = results.filter((row) => row && row.ok === false)
      if (failed.length) state.lastError = failed.map((row) => row.nodeId + ': ' + row.error).join('; ')
      const ok = results.filter((row) => row && row.ok)
      const pulled = ok.reduce((sum, row) => sum + (row.pulled || 0), 0)
      const pushed = ok.reduce((sum, row) => sum + (row.pushed || 0), 0)
      state.lastSummary = 'synced ' + ok.length + '/' + results.length + ' peers · ↓' + pulled + ' ↑' + pushed
      onEvent('sync', { results, pulled, pushed })
      return { ok: true, results, pulled, pushed, at: state.lastSyncAt }
    } catch (err) {
      state.lastError = String((err && err.message) || err)
      throw err
    } finally {
      state.busy = false
    }
  }

  function status() {
    return {
      busy: state.busy,
      lastSyncAt: state.lastSyncAt,
      lastExportAt: state.lastExportAt,
      lastError: state.lastError,
      lastSummary: state.lastSummary,
      peers: state.peerStates
    }
  }

  return { exportLocal, syncPeer, syncAll, ingest, status }
}
