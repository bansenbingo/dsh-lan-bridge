/**
 * dsh-lan-bridge — host half.
 *
 * Responsibilities, in order of importance:
 *
 *   1. keep this machine's sessions, memory files and profile manifest synced
 *      into the shared store (and, as a peer, hand them to the hub),
 *   2. serve the LAN API when this machine is the hub, and
 *   3. give the browser half one same-origin surface at `/_dsh/lan/*` so the
 *      token never has to travel to the renderer.
 *
 * The renderer talks only to `/_dsh/lan`; every cross-machine call leaves from
 * here. That is why `client.js` contains no host or port logic at all.
 */

import path from 'node:path'
import * as config from './lib/config.js'
import * as fork from './lib/fork.js'
import * as store from './lib/store.js'
import * as auditless from './lib/http.js'
import { createMesh } from './lib/mesh.js'
import { createPeer, discoverHubs, localAddresses, startBeacon, startServer } from './lib/lan-server.js'
import { plan as planPlugins, applyManifest, runInstall, setPluginEnabled, listRuntimePlugins, readLocalManifest } from './lib/plugins.js'

export const name = 'dsh-lan-bridge'
export const inject = ['webServer']

const PREFIX = '/_dsh/lan'
const EXPORT_DEBOUNCE_MS = 900

/**
 * 尽量把新会话挂进 cwd 对应的工作区，侧栏里就不会落进「未分组」。
 * DSH 没暴露工作区注册表时安静地返回 false —— 文件已经写好，下次扫描照样看得到。
 */
async function attachToWorkspace(ctx, cwd, sessionId) {
  try {
    const registry = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
    if (!registry || typeof registry.resolveByPath !== 'function') return false
    const entity = await registry.resolveByPath(cwd)
    if (!entity || typeof entity.attachSession !== 'function') return false
    await entity.attachSession(sessionId)
    return true
  } catch (err) {
    return false
  }
}

export function apply(ctx) {
  /** Open SSE responses; the renderer registers one per tab. */
  const streams = new Set()
  let serverHandle = null
  let beaconHandle = null
  let exportTimer = null
  let syncTimer = null
  let debounceTimer = null
  let disposed = false
  let mesh = null
  let peer = null
  const lastPushCounts = { conversations: 0, memory: 0, manifests: 0 }

  const cfg = function () {
    return config.peek() || config.defaults()
  }

  function broadcast(event) {
    const payload = 'data: ' + JSON.stringify(event) + '\n\n'
    for (const res of streams) {
      try {
        res.write(payload)
      } catch (err) {
        streams.delete(res)
      }
    }
  }

  // ------------------------------------------------------------- lifecycle

  async function reconcileServer() {
    if (disposed) return
    const current = cfg()
    const wanted = current.role === 'hub' ? { port: current.port } : null
    const running = serverHandle ? { port: serverHandle.port } : null
    if (running && wanted && running.port === wanted.port) return
    if (serverHandle) {
      const previous = serverHandle
      serverHandle = null
      try {
        await previous.close()
      } catch (err) {
        /* ignore */
      }
    }
    if (!wanted) return
    try {
      serverHandle = await startServer(current, buildMeshApi())
      await store.audit({ kind: 'hub-listen', port: serverHandle.port })
    } catch (err) {
      serverHandle = null
      await store.audit({ kind: 'hub-listen-failed', message: String((err && err.message) || err) })
    }
  }

  function reconcileBeacon() {
    const current = cfg()
    if (beaconHandle) {
      beaconHandle.close()
      beaconHandle = null
    }
    // Any machine with discovery switched on announces itself: a hub needs to
    // find its members exactly as much as a member needs to find its hub.
    if (!current.discovery) return
    beaconHandle = startBeacon(current, {
      identity: { machineId: current.machineId, machineName: current.machineName, platform: process.platform }
    })
  }

  async function runExport() {
    if (disposed || !mesh) return null
    try {
      const summary = await mesh.exportLocal()
      broadcast({ type: 'export', at: Date.now(), summary })
      return summary
    } catch (err) {
      await store.audit({ kind: 'export-failed', message: String((err && err.message) || err) })
      return null
    }
  }

  async function runSync() {
    if (disposed || !mesh) return null
    const current = cfg()
    if (current.role === 'hub') {
      const summary = await runExport()
      const applied = { ok: true, role: 'hub', export: summary }
      broadcast({ type: 'synced', at: Date.now(), result: applied })
      return applied
    }
    if (!current.hubHost) {
      // Nothing to sync with yet, but local history still deserves an export so
      // the UI has something to show while the user pairs.
      await runExport()
      return { ok: false, code: 'NO_HUB' }
    }
    const result = await mesh.syncWithHub(peer)
    if (result && result.ok) {
      lastPushCounts.conversations = result.pushed.conversations
      lastPushCounts.memory = result.pushed.memory
      lastPushCounts.manifests = result.pushed.manifests
    }
    broadcast({ type: 'synced', at: Date.now(), result })
    return result
  }

  function scheduleExport() {
    if (disposed || !cfg().autoSync) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(function () {
      debounceTimer = null
      runExport()
    }, EXPORT_DEBOUNCE_MS)
    if (debounceTimer.unref) debounceTimer.unref()
  }

  function startLoops() {
    if (exportTimer) clearInterval(exportTimer)
    if (syncTimer) clearInterval(syncTimer)
    const current = cfg()
    // A hub only has to ingest its own history; a peer has to do that *and*
    // trade records with the hub, so the peer's timer drives the round trip.
    exportTimer = setInterval(function () {
      if (cfg().role === 'hub') runExport()
    }, current.pushIntervalMs)
    syncTimer = setInterval(function () {
      if (cfg().role !== 'hub' && cfg().autoSync) runSync()
    }, current.pullIntervalMs)
    if (exportTimer.unref) exportTimer.unref()
    if (syncTimer.unref) syncTimer.unref()
  }

  // ------------------------------------------------------------ mesh facade

  function buildMeshApi() {
    return {
      ctx,
      identity: {
        machineId: cfg().machineId,
        machineName: cfg().machineName,
        platform: process.platform,
        role: cfg().role
      },
      store,
      files: mesh.files,
      plugins: { readLocalManifest },
      ingest: function (payload, meta) {
        return mesh.ingest(payload, meta)
      },
      get port() {
        return cfg().port
      },
      get maxFileBytes() {
        return cfg().maxFileBytes
      }
    }
  }

  // ------------------------------------------------------------------ routes

  function json(res, status, body) {
    auditless.sendJson(res, status, body)
  }

  function errorPayload(err) {
    return {
      ok: false,
      error: {
        code: (err && err.code) || 'FAILED',
        message: String((err && err.message) || err)
      }
    }
  }

  async function statusPayload() {
    const current = cfg()
    const stats = await store.stats()
    const links = await store.listConversations()
    const machines = {}
    for (const row of links) {
      const key = row.machineId
      if (!machines[key]) {
        machines[key] = { machineId: key, machineName: row.machineName || key, conversations: 0, lastAt: 0 }
      }
      machines[key].conversations += 1
      machines[key].lastAt = Math.max(machines[key].lastAt, row.updatedAt || row.storedAt || 0)
    }
    let hub = null
    if (current.role === 'peer' && current.hubHost) {
      try {
        const hello = await peer.hello()
        hub = {
          reachable: true,
          machineName: (hello.identity && hello.identity.machineName) || current.hubHost,
          machineId: (hello.identity && hello.identity.machineId) || '',
          rev: hello.rev,
          baseUrl: peer.baseUrl()
        }
      } catch (err) {
        hub = { reachable: false, code: (err && err.code) || 'UNREACHABLE', message: String((err && err.message) || err) }
      }
    }
    return {
      ok: true,
      identity: {
        machineId: current.machineId,
        machineName: current.machineName,
        platform: process.platform,
        arch: process.arch,
        role: current.role
      },
      config: {
        port: current.port,
        discovery: current.discovery,
        hubHost: current.hubHost,
        hubPort: current.hubPort,
        autoSync: current.autoSync,
        pushIntervalMs: current.pushIntervalMs,
        pullIntervalMs: current.pullIntervalMs,
        maxFileBytes: current.maxFileBytes,
        extraRoots: current.extraRoots,
        deniedRoots: current.deniedRoots,
        dataDir: config.dataDir()
      },
      // The renderer needs the token to paste on the other machine; showing it
      // is the whole pairing flow, and it never leaves this origin.
      token: current.token,
      lan: {
        addresses: localAddresses(),
        listening: Boolean(serverHandle),
        url:
          serverHandle && localAddresses().length > 0
            ? 'http://' + localAddresses()[0].address + ':' + current.port
            : ''
      },
      hub,
      store: stats,
      machines: Object.values(machines),
      roots: mesh.files.getRoots().map(function (root) {
        return { id: root.id, label: root.label, path: root.path, kind: root.kind }
      }),
      sync: {
        lastExportAt: mesh.state.lastExportAt,
        lastPullAt: mesh.state.lastPullAt,
        lastPushAt: mesh.state.lastPushAt,
        lastError: mesh.state.lastError,
        pullRev: mesh.state.pullRev,
        busy: mesh.state.busy,
        pushed: lastPushCounts
      }
    }
  }

  const table = {}

  table['GET ' + PREFIX + '/status'] = async function (req, res) {
    json(res, 200, await statusPayload())
  }

  table['POST ' + PREFIX + '/setup'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const before = cfg()
    const patch = {}
    for (const key of [
      'role',
      'port',
      'discovery',
      'token',
      'hubHost',
      'hubPort',
      'autoSync',
      'pushIntervalMs',
      'pullIntervalMs',
      'machineName'
    ]) {
      if (body && body[key] !== undefined) patch[key] = body[key]
    }
    const after = await config.update(patch)
    const restartNeeded = before.role !== after.role || before.port !== after.port
    const beaconChanged = before.discovery !== after.discovery || before.role !== after.role
    if (restartNeeded) await reconcileServer()
    if (beaconChanged) reconcileBeacon()
    if (before.pushIntervalMs !== after.pushIntervalMs || before.pullIntervalMs !== after.pullIntervalMs) startLoops()
    broadcast({ type: 'setup', at: Date.now() })
    json(res, 200, { ok: true, config: after, restartNeeded })
  }

  table['GET ' + PREFIX + '/roots'] = async function (req, res) {
    const query = auditless.queryOf(req)
    if (query.scope === 'remote') {
      try {
        const body = await peer.roots()
        json(res, 200, { ok: true, roots: (body && body.roots) || [] })
      } catch (err) {
        json(res, 200, Object.assign({ roots: [] }, errorPayload(err)))
      }
      return
    }
    json(res, 200, {
      ok: true,
      roots: mesh.files.getRoots().map(function (root) {
        return { id: root.id, label: root.label, path: root.path, kind: root.kind }
      })
    })
  }

  table['POST ' + PREFIX + '/discover'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const hubs = await discoverHubs(cfg(), body && body.windowMs)
    json(res, 200, { ok: true, hubs })
  }

  table['POST ' + PREFIX + '/sync'] = async function (req, res) {
    const result = await runSync()
    json(res, 200, { ok: true, result })
  }

  table['POST ' + PREFIX + '/test-hub'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const probe = createPeer(function () {
      return Object.assign({}, cfg(), body && body.hubHost ? { hubHost: body.hubHost, hubPort: body.hubPort || cfg().hubPort } : {}, body && body.token ? { token: body.token } : {})
    })
    try {
      const hello = await probe.hello()
      json(res, 200, { ok: true, hello })
    } catch (err) {
      json(res, 200, errorPayload(err))
    }
  }

  table['GET ' + PREFIX + '/conversations'] = async function (req, res) {
    const query = auditless.queryOf(req)
    const rows = await store.listConversations()
    const filtered = rows.filter(function (row) {
      if (query.machine && row.machineId !== query.machine) return false
      if (query.q) {
        const needle = String(query.q).toLowerCase()
        const haystack = (row.title + ' ' + row.cwd).toLowerCase()
        if (haystack.indexOf(needle) < 0) return false
      }
      return true
    })
    json(res, 200, {
      ok: true,
      conversations: filtered.map(function (row) {
        return {
          machineId: row.machineId,
          machineName: row.machineName || row.machineId,
          sessionId: row.sessionId,
          title: row.title,
          cwd: row.cwd,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          items: row.items,
          bytes: row.bytes,
          mine: row.machineId === store.safeSegment(cfg().machineId)
        }
      })
    })
  }

  table['GET ' + PREFIX + '/conversation'] = async function (req, res) {
    const query = auditless.queryOf(req)
    const body = await store.getConversation(query.machine, query.id)
    if (!body) {
      json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such conversation in the shared store' } })
      return
    }
    json(res, 200, { ok: true, conversation: body })
  }

  // 本机有哪些工作区可以接收 fork：来自 ~/.dsh/sessions 下真实存在的项目目录。
  table['GET ' + PREFIX + '/workspaces'] = async function (req, res) {
    json(res, 200, {
      ok: true,
      workspaces: fork.listWorkspaces().map(function (row) {
        return { key: row.key, cwd: row.cwd, sessions: row.sessions, updatedAt: row.updatedAt }
      })
    })
  }

  // 把共享区里任意一条会话 fork 成本机某工作区的一条新会话，之后可以直接接着聊。
  table['POST ' + PREFIX + '/fork'] = async function (req, res) {
    const body = await auditless.readJson(req, 256 * 1024)
    const conversation = await store.getConversation(body && body.machine, body && body.id)
    if (!conversation) {
      json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such conversation in the shared store' } })
      return
    }
    let result = null
    try {
      result = fork.forkConversation({ conversation, workspace: body && body.workspace })
    } catch (err) {
      // 可预期的分支（会话是空的、目标工作区没了）回 400，把中文原因原样给面板；
      // 其它异常继续走外面的兜底 500，方便排查。
      if (!err || typeof err.code !== 'string') throw err
      json(res, 400, { ok: false, error: { code: err.code, message: String(err.message || err.code) } })
      return
    }
    // 有工作区注册表就顺手把它挂进目标工作区（侧栏里就不会落进「未分组」）；
    // 拿不到注册表也没关系，文件已经写好，DSH 下次扫描会话目录同样能看到。
    result.attached = await attachToWorkspace(ctx, result.cwd, result.sessionId)
    await store.audit({ kind: 'conversation-fork', from: String((body && body.id) || ''), to: result.sessionId, cwd: result.cwd })
    broadcast({ type: 'conversations', at: Date.now() })
    json(res, 200, { ok: true, fork: result })
  }

  table['GET ' + PREFIX + '/memory'] = async function (req, res) {
    const current = cfg()
    const rows = await store.listMemory()
    const local = await mesh.memory.discover()
    const localByName = {}
    for (const entry of local) {
      try {
        localByName[entry.name] = await mesh.memory.readMemory(entry.file)
      } catch (err) {
        localByName[entry.name] = null
      }
    }
    const shared = []
    for (const row of rows) {
      const text = await store.getMemory(row.machineId, row.name)
      shared.push({
        machineId: row.machineId,
        mine: row.machineId === store.safeSegment(current.machineId),
        name: row.name,
        bytes: row.bytes,
        rev: row.rev,
        storedAt: row.storedAt,
        text: text === null ? '' : text
      })
    }
    json(res, 200, {
      ok: true,
      local: local.map(function (entry) {
        return { name: entry.name, file: entry.file, scope: entry.scope, size: entry.size, mtime: entry.mtime }
      }),
      localText: localByName,
      shared
    })
  }

  table['POST ' + PREFIX + '/memory/write'] = async function (req, res) {
    const body = await auditless.readJson(req, 4 * 1024 * 1024)
    const target = (body && body.file) || ''
    if (typeof target !== 'string' || !path.isAbsolute(target)) {
      json(res, 400, { ok: false, error: { code: 'BAD_PATH', message: 'memory writes need an absolute file path' } })
      return
    }
    const result = await mesh.memory.writeMemory(target, body.text, { backup: true })
    await runExport()
    broadcast({ type: 'memory', at: Date.now() })
    json(res, 200, { ok: true, result })
  }

  table['GET ' + PREFIX + '/plugins'] = async function (req, res) {
    const local = await readLocalManifest(ctx, { machineId: cfg().machineId, machineName: cfg().machineName })
    const rows = await store.listManifests()
    const remote = []
    for (const row of rows) {
      if (row.machineId === store.safeSegment(cfg().machineId)) continue
      const manifest = await store.getManifest(row.machineId)
      if (!manifest) continue
      remote.push({
        machineId: row.machineId,
        machineName: row.machineName,
        capturedAt: row.capturedAt,
        pluginCount: row.plugins,
        manifest
      })
    }
    const runtime = await listRuntimePlugins(ctx)
    json(res, 200, {
      ok: true,
      local: {
        machineId: local.machineId,
        machineName: local.machineName,
        profile: local.profile,
        profileDir: local.profileDir,
        pluginCount: local.pluginCount,
        plugins: local.plugins,
        bundles: local.bundles,
        patchBytes: local.patchBytes,
        patch: local.patch
      },
      remote,
      runtime,
      plans: remote.map(function (entry) {
        return { machineId: entry.machineId, machineName: entry.machineName, plan: planPlugins(entry.manifest, local) }
      })
    })
  }

  table['POST ' + PREFIX + '/plugins/apply'] = async function (req, res) {
    const body = await auditless.readJson(req, 1024 * 1024)
    const manifest = await store.getManifest(body && body.machineId)
    if (!manifest) {
      json(res, 404, { ok: false, error: { code: 'NO_MANIFEST', message: 'that machine has not published a manifest yet' } })
      return
    }
    const result = await applyManifest(manifest, {
      include: Array.isArray(body && body.include) ? body.include : undefined,
      skipVersionDiff: body && body.skipVersionDiff === true
    })
    broadcast({ type: 'plugins', at: Date.now() })
    json(res, 200, { ok: true, result })
  }

  table['POST ' + PREFIX + '/plugins/install'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const result = await runInstall({ registry: (body && body.registry) || undefined })
    json(res, 200, Object.assign({ ok: result.ok === true }, result))
  }

  table['POST ' + PREFIX + '/plugins/toggle'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const result = await setPluginEnabled(ctx, body && body.entryId, body && body.enabled === true)
    json(res, 200, Object.assign({ ok: result.ok === true }, result))
  }

  table['POST ' + PREFIX + '/roots'] = async function (req, res) {
    const body = await auditless.readJson(req, 256 * 1024)
    const add = Array.isArray(body && body.add) ? body.add : []
    const remove = Array.isArray(body && body.remove) ? body.remove : []
    const current = cfg()
    let extras = current.extraRoots.slice()
    for (const entry of add) {
      if (typeof entry !== 'string' || !path.isAbsolute(entry)) continue
      if (extras.indexOf(entry) < 0) extras.push(entry)
    }
    if (remove.length > 0) {
      const drop = new Set(remove.map(function (entry) { return String(entry) }))
      extras = extras.filter(function (entry) {
        return drop.has(entry) === false && drop.has(path.basename(entry)) === false
      })
    }
    await config.update({ extraRoots: extras })
    const roots = await mesh.refreshRoots((await mesh.store.listConversations()).map(function (row) { return row.cwd }))
    json(res, 200, { ok: true, roots })
  }

  table['GET ' + PREFIX + '/files/list'] = async function (req, res) {
    const query = auditless.queryOf(req)
    const roots = await remoteRoots(query.scope)
    const root = resolveRoot(roots, query.root)
    const body =
      query.scope === 'remote'
        ? await peer.list(root.id, query.path || '')
        : await mesh.files.listDir(root, query.path || '')
    json(res, 200, Object.assign({ ok: true }, body))
  }

  table['GET ' + PREFIX + '/files/read'] = async function (req, res) {
    const query = auditless.queryOf(req)
    const roots = await remoteRoots(query.scope)
    const root = resolveRoot(roots, query.root)
    const body =
      query.scope === 'remote'
        ? await peer.read(root.id, query.path || '')
        : await mesh.files.readFile(root, query.path || '', cfg().maxFileBytes)
    json(res, 200, Object.assign({ ok: true }, body))
  }

  table['POST ' + PREFIX + '/files/write'] = async function (req, res) {
    const body = await auditless.readJson(req, 32 * 1024 * 1024)
    const roots = await remoteRoots(body && body.scope)
    const root = resolveRoot(roots, body && body.root)
    const result =
      (body && body.scope === 'remote')
        ? await peer.write(root.id, body.path || '', body.content, body.backup === true)
        : await mesh.files.writeFile(root, body.path || '', body.content, { backup: body && body.backup === true })
    await store.audit({ kind: 'ui-write', scope: (body && body.scope) || 'local', path: body && body.path })
    broadcast({ type: 'files', at: Date.now() })
    json(res, 200, Object.assign({ ok: true }, result))
  }

  table['POST ' + PREFIX + '/files/mkdir'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const roots = await remoteRoots(body && body.scope)
    const root = resolveRoot(roots, body && body.root)
    const result =
      body && body.scope === 'remote'
        ? await peer.mkdir(root.id, body.path || '')
        : await mesh.files.makeDir(root, body.path || '')
    json(res, 200, Object.assign({ ok: true }, result))
  }

  table['POST ' + PREFIX + '/files/delete'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const roots = await remoteRoots(body && body.scope)
    const root = resolveRoot(roots, body && body.root)
    const result =
      body && body.scope === 'remote'
        ? await peer.remove(root.id, body.path || '', body.recursive === true)
        : await mesh.files.removePath(root, body.path || '', { recursive: body && body.recursive === true })
    await store.audit({ kind: 'ui-delete', scope: (body && body.scope) || 'local', path: body && body.path })
    json(res, 200, Object.assign({ ok: true }, result))
  }

  table['POST ' + PREFIX + '/files/move'] = async function (req, res) {
    const body = await auditless.readJson(req, 64 * 1024)
    const roots = await remoteRoots(body && body.scope)
    const root = resolveRoot(roots, body && body.root)
    const result =
      body && body.scope === 'remote'
        ? await peer.move(root.id, body.from || '', body.to || '')
        : await mesh.files.renamePath(root, body.from || '', body.to || '')
    json(res, 200, Object.assign({ ok: true }, result))
  }

  table['GET ' + PREFIX + '/audit'] = async function (req, res) {
    const query = auditless.queryOf(req)
    const limit = Number.parseInt(query.limit || '40', 10)
    json(res, 200, { ok: true, entries: await store.recentAudit(Number.isFinite(limit) ? limit : 40) })
  }

  table['GET ' + PREFIX + '/stream'] = async function (req, res) {
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'keep-alive')
    res.write('data: ' + JSON.stringify({ type: 'hello', at: Date.now() }) + '\n\n')
    streams.add(res)
    const heartbeat = setInterval(function () {
      try {
        res.write(': ping\n\n')
      } catch (err) {
        clearInterval(heartbeat)
      }
    }, 25000)
    if (heartbeat.unref) heartbeat.unref()
    const cleanup = function () {
      clearInterval(heartbeat)
      streams.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
  }

  // --------------------------------------------------------------- helpers

  async function remoteRoots(scope) {
    if (scope === 'remote') {
      try {
        const body = await peer.roots()
        return (body && body.roots) || []
      } catch (err) {
        return []
      }
    }
    return mesh.files.getRoots()
  }

  function resolveRoot(rootList, id) {
    const root = rootList.find(function (row) {
      return row.id === id
    })
    if (!root) {
      const error = new Error('root "' + String(id) + '" is not available')
      error.code = 'UNKNOWN_ROOT'
      throw error
    }
    // A remote root only carries id/label; the peer resolves the real path.
    return root
  }

  // ------------------------------------------------------------------- apply

  ctx.effect(
    function () {
      let cancelled = false
      ;(async function boot() {
        await config.load()
        await store.ensure()
        mesh = createMesh(ctx, {})
        peer = createPeer(cfg)
        await mesh.loadCachedRoots()
        if (cancelled || disposed) return
        const initial = cfg()
        if (initial.role === 'hub' || initial.discovery) await reconcileServer()
        reconcileBeacon()
        startLoops()
        // First sweep runs in the background so a big history never delays the
        // plugin from mounting.
        setTimeout(function () {
          runSync()
        }, 1200)
      })().catch(function (err) {
        store.audit({ kind: 'boot-failed', message: String((err && err.message) || err) })
      })
      return function cleanup() {
        cancelled = true
        disposed = true
        if (exportTimer) clearInterval(exportTimer)
        if (syncTimer) clearInterval(syncTimer)
        if (debounceTimer) clearTimeout(debounceTimer)
        if (beaconHandle) beaconHandle.close()
        if (serverHandle) {
          const handle = serverHandle
          serverHandle = null
          handle.close().catch(function () {})
        }
        for (const res of streams) {
          try {
            res.end()
          } catch (err) {
            /* ignore */
          }
        }
        streams.clear()
      }
    },
    'lan-bridge: engine'
  )

  ctx.effect(
    function () {
      if (typeof ctx.on !== 'function') return function () {}
      const off = ctx.on('session/event', function () {
        scheduleExport()
      })
      return function () {
        if (typeof off === 'function') off()
        else if (off && typeof off.dispose === 'function') off.dispose()
      }
    },
    'lan-bridge: session feed'
  )

  ctx.effect(
    function () {
      return ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async function (req, res) {
          const method = (req.method || 'GET').toUpperCase()
          if (auditless.isPreflight(req)) {
            auditless.applyCors(res)
            res.statusCode = 204
            res.end()
            return
          }
          const path = auditless.pathOf(req)
          try {
            // SSE keeps its own response lifecycle and must not be wrapped.
            if (method === 'GET' && path === PREFIX + '/stream') {
              await table['GET ' + PREFIX + '/stream'](req, res)
              return
            }
            const handled = auditless.route(table, method, path, req, res)
            if (!handled) {
              auditless.fail(res, 404, 'not-found', 'unknown endpoint ' + path)
            }
          } catch (err) {
            if (res.writableEnded) return
            auditless.sendJson(res, 500, errorPayload(err))
          }
        }
      })
    },
    'lan-bridge: routes'
  )
}
