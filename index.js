/**
 * dsh-lan-bridge — host half (v2).
 *
 * One process, one node. The node runs an HTTP surface for peers, a UDP
 * discovery beacon, an anti-entropy sync loop, and the same-origin browser API
 * at `/_dsh/lan/*`. The browser never talks to another machine directly: every
 * cross-device call is proxied through this host, which is where the peer
 * table, HMAC, and path rules are enforced.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as config from './lib/config.js'
import * as identityMod from './lib/identity.js'
import * as store from './lib/store.js'
import * as peers from './lib/peers.js'
import * as files from './lib/files.js'
import * as fork from './lib/fork.js'
import * as memory from './lib/memory.js'
import * as plugins from './lib/plugins.js'
import { createTransport } from './lib/transport.js'
import { createDiscovery } from './lib/discovery.js'
import { createWorkspaces } from './lib/workspaces.js'
import { createMesh } from './lib/mesh.js'
import { createTransfer } from './lib/transfer.js'
import { createAi } from './lib/ai.js'
import { createAgentTools } from './lib/agent-tools.js'
import { localAddresses, preferredAddress } from './lib/net.js'
import { fail, isPreflight, pathOf, queryOf, readJson, sendJson, statusOfError } from './lib/http.js'

export const name = 'dsh-lan-bridge'
export const inject = ['webServer', 'tools']

const PREFIX = '/_dsh/lan'
const VERSION = '0.2.0'
const EXPORT_DEBOUNCE_MS = 900

const LAN = {
  hello: '/api/v2/hello',
  pull: '/api/v2/pull',
  push: '/api/v2/push',
  workspaces: '/api/v2/workspaces',
  fsList: '/api/v2/fs/list',
  fsRead: '/api/v2/fs/read',
  conversations: '/api/v2/conversations',
  conversation: '/api/v2/conversation',
  aiModels: '/api/v2/ai/models',
  aiAsk: '/api/v2/ai/ask',
  transferOffer: '/api/v2/transfer/offer',
  transferStatus: '/api/v2/transfer/status',
  transferChunk: '/api/v2/transfer/chunk',
  transferComplete: '/api/v2/transfer/complete',
  transferExport: '/api/v2/transfer/export',
  transferExportChunk: '/api/v2/transfer/export/chunk',
  transferExportClose: '/api/v2/transfer/export/close'
}

function errorOf(status, code, message) {
  const error = new Error(message || code)
  error.status = status
  error.code = code
  return error
}

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

function publicConfig(cfg) {
  return {
    nodeId: cfg.nodeId,
    nodeName: cfg.nodeName,
    port: cfg.port,
    discoveryPort: cfg.discoveryPort,
    discovery: cfg.discovery,
    spaceId: cfg.spaceId,
    bootstrapPeers: cfg.bootstrapPeers,
    syncIntervalMs: cfg.syncIntervalMs,
    scanIntervalMs: cfg.scanIntervalMs,
    autoAcceptTransfers: cfg.autoAcceptTransfers,
    allowRemoteRead: cfg.allowRemoteRead,
    allowRemoteAi: cfg.allowRemoteAi,
    agentTools: cfg.agentTools,
    maxFileBytes: cfg.maxFileBytes,
    maxTransferBytes: cfg.maxTransferBytes,
    aiModelAllowlist: cfg.aiModelAllowlist,
    extraRoots: cfg.extraRoots,
    deniedRoots: cfg.deniedRoots,
    retentionDays: cfg.retentionDays
  }
}

export function apply(ctx) {
  const streams = new Set()
  let transport = null
  let discovery = null
  let mesh = null
  let workspaces = null
  let transfer = null
  let ai = null
  let tools = null
  let identity = null
  let disposed = false
  let booted = false
  let bootError = ''
  let registeredToolNames = []
  let syncTimer = null
  let exportTimer = null
  let debounceTimer = null
  let initialTimer = null
  const tasks = new Map()

  function cfg() {
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

  function audit(action, detail) {
    store.auditEvent(action, detail).catch(() => {})
  }

  async function statusPayload() {
    const current = cfg()
    const peerRows = await peers.list()
    return {
      ok: true,
      version: VERSION,
      protocol: config.PROTOCOL_VERSION,
      identity: {
        nodeId: current.nodeId,
        nodeName: current.nodeName,
        fingerprint: identity ? identityMod.fingerprint(identity) : '',
        platform: process.platform,
        arch: process.arch,
        port: current.port
      },
      config: publicConfig(current),
      discovery: discovery ? discovery.status() : { listening: false, port: current.discoveryPort },
      transport: transport ? transport.status() : { listening: false, port: current.port },
      peers: peerRows,
      roots: workspaces ? workspaces.list() : [],
      sync: mesh ? mesh.status() : {},
      stats: await store.stats(),
      transfers: {
        incoming: transfer ? transfer.listIncoming() : [],
        outgoing: transfer ? transfer.listOutgoing() : []
      },
      ai: {
        remoteEnabled: current.allowRemoteAi,
        agentTools: current.agentTools,
        models: ai ? (await ai.models()).length : 0
      },
      tools: {
        agentTools: current.agentTools,
        registered: registeredToolNames
      },
      network: localAddresses().map((row) => ({
        name: row.name,
        address: row.address,
        url: 'http://' + row.address + ':' + current.port
      })),
      invites: true,
      booted,
      bootError
    }
  }

  function lanRoutes() {
    transport.add('GET', LAN.hello, async (context) => {
      const current = cfg()
      sendJson(context.res, 200, {
        ok: true,
        protocol: config.PROTOCOL_VERSION,
        node: {
          nodeId: current.nodeId,
          nodeName: current.nodeName,
          fingerprint: identity ? identityMod.fingerprint(identity) : '',
          platform: process.platform,
          arch: process.arch,
          port: current.port
        },
        spaceId: current.spaceId,
        roots: workspaces.list(),
        stats: await store.stats(),
        remoteAi: current.allowRemoteAi,
        remoteRead: current.allowRemoteRead
      })
    }, { allowPending: true })

    transport.add('GET', LAN.pull, async (context) => {
      const since = Number(context.query.since) || 0
      const page = await store.changesSince(since, { excludeNodeId: context.nodeId })
      sendJson(context.res, 200, { ok: true, rev: page.rev, cursor: page.cursor, objects: page.objects })
    })

    transport.add('POST', LAN.push, async (context) => {
      const result = await mesh.ingest(context.json.objects)
      sendJson(context.res, 200, { ok: true, accepted: result.accepted, skipped: result.skipped, rev: (await store.stats()).rev })
      broadcast({ type: 'sync', direction: 'push' })
    }, { maxBytes: 32 * 1024 * 1024 })

    transport.add('GET', LAN.workspaces, async (context) => {
      sendJson(context.res, 200, { ok: true, roots: workspaces.list() })
    })

    transport.add('GET', LAN.fsList, async (context) => {
      if (!cfg().allowRemoteRead) throw errorOf(403, 'REMOTE_READ_OFF', 'remote read is disabled')
      const root = workspaces.resolve(context.query.root)
      if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
      const result = await files.listDir(root, String(context.query.path || ''))
      delete result.rootPath
      sendJson(context.res, 200, { ok: true, root: root.id, label: root.label, ...result })
    })

    transport.add('GET', LAN.fsRead, async (context) => {
      if (!cfg().allowRemoteRead) throw errorOf(403, 'REMOTE_READ_OFF', 'remote read is disabled')
      const root = workspaces.resolve(context.query.root)
      if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
      const result = await files.readFile(root, String(context.query.path || ''), cfg().maxFileBytes)
      sendJson(context.res, 200, { ok: true, root: root.id, label: root.label, ...result })
    })

    transport.add('GET', LAN.conversations, async (context) => {
      const limit = Math.min(Math.max(Number(context.query.limit) || 40, 1), 200)
      const rows = await store.listConversations({ nodeId: cfg().nodeId, limit })
      sendJson(context.res, 200, { ok: true, conversations: rows })
    })

    transport.add('GET', LAN.conversation, async (context) => {
      const sessionId = String(context.query.session || '')
      const found = await store.getConversation(cfg().nodeId, sessionId)
      if (!found) throw errorOf(404, 'NO_CONVERSATION', 'conversation not found')
      sendJson(context.res, 200, { ok: true, conversation: found.body })
    })

    transport.add('GET', LAN.aiModels, async (context) => {
      if (!cfg().allowRemoteAi) throw errorOf(403, 'REMOTE_AI_OFF', 'remote model access is disabled')
      sendJson(context.res, 200, { ok: true, models: await ai.models() })
    })

    transport.add('POST', LAN.aiAsk, async (context) => {
      const result = await ai.handleRemote(context)
      sendJson(context.res, 200, result)
      audit('ai.remote', { from: context.nodeId, model: result.model })
    }, { maxBytes: 2 * 1024 * 1024 })

    transport.add('POST', LAN.transferOffer, async (context) => {
      const result = transfer.offer(context)
      sendJson(context.res, 200, result)
      broadcast({ type: 'transfer', event: 'offer', id: result.id })
    }, { maxBytes: 256 * 1024 })

    transport.add('GET', LAN.transferStatus, async (context) => {
      const result = transfer.statusOf(context.query.id)
      if (!result) throw errorOf(404, 'NO_TRANSFER', 'unknown transfer')
      sendJson(context.res, 200, { ok: true, ...result })
    })

    transport.add('POST', LAN.transferChunk, async (context) => {
      const result = await transfer.receiveChunk(context)
      sendJson(context.res, 200, { ok: true, ...result })
    }, { maxBytes: 20 * 1024 * 1024 })

    transport.add('POST', LAN.transferComplete, async (context) => {
      const result = await transfer.complete(context)
      sendJson(context.res, 200, result)
      broadcast({ type: 'transfer', event: 'complete', id: context.query.id })
    }, { maxBytes: 256 * 1024 })

    transport.add('POST', LAN.transferExport, async (context) => {
      if (!cfg().allowRemoteRead) throw errorOf(403, 'REMOTE_READ_OFF', 'remote read is disabled')
      const result = await transfer.exportFile(context)
      sendJson(context.res, 200, result)
    }, { maxBytes: 256 * 1024 })

    transport.add('GET', LAN.transferExportChunk, async (context) => {
      await transfer.exportChunk(context)
    })

    transport.add('POST', LAN.transferExportClose, async (context) => {
      sendJson(context.res, 200, transfer.closeExport(context))
    }, { maxBytes: 256 * 1024 })
  }

  function table() {
    return {
['GET ' + PREFIX + '/status']: async (req, res) => sendJson(res, 200, await statusPayload()),
['POST ' + PREFIX + '/setup']: async (req, res) => {
        const body = await readJson(req, 1024 * 1024)
        const allowed = [
          'nodeName', 'port', 'discoveryPort', 'discovery', 'syncIntervalMs', 'scanIntervalMs',
          'autoAcceptTransfers', 'allowRemoteRead', 'allowRemoteAi', 'agentTools',
          'extraRoots', 'deniedRoots', 'aiModelAllowlist', 'maxTransferBytes', 'maxFileBytes',
          'bootstrapPeers'
        ]
        const patch = {}
        for (const key of allowed) if (body[key] !== undefined) patch[key] = body[key]
        const previous = cfg()
        await config.update(patch)
        const next = cfg()
        if (previous.port !== next.port || previous.discoveryPort !== next.discoveryPort || previous.networkKey !== next.networkKey) {
          await restartNetwork()
        }
        await workspaces.refresh(ctx)
        if (next.discovery && discovery) discovery.start()
        if (!next.discovery && discovery) discovery.stop()
        startLoops()
        broadcast({ type: 'config' })
        sendJson(res, 200, await statusPayload())
      },
['GET ' + PREFIX + '/peers']: async (req, res) => {
        sendJson(res, 200, { ok: true, peers: await peers.list() })
      },
['POST ' + PREFIX + '/peers/trust']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const peer = await peers.trust(String(body.nodeId || ''), String(body.trust || 'trusted'))
        if (!peer) throw errorOf(404, 'NO_PEER', 'unknown peer')
        broadcast({ type: 'peer', nodeId: peer.nodeId })
        if (peer.trust === 'trusted') setTimeout(() => { mesh.syncPeer(peer).catch(() => {}) }, 100)
        sendJson(res, 200, { ok: true, peer })
      },
['POST ' + PREFIX + '/peers/remove']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        await peers.remove(String(body.nodeId || ''))
        sendJson(res, 200, { ok: true })
      },
['POST ' + PREFIX + '/peers/bootstrap']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const address = String(body.address || '').trim()
        if (!address) throw errorOf(400, 'BAD_ADDRESS', 'address is required')
        await peers.addBootstrap(address, String(body.name || ''))
        const current = cfg()
        const list = current.bootstrapPeers.slice()
        if (list.indexOf(address) < 0) list.push(address)
        await config.update({ bootstrapPeers: list })
        const pingError = await pingBootstrap(address)
        sendJson(res, 200, { ok: true, peers: await peers.list(), pingError: pingError || '' })
      },
['POST ' + PREFIX + '/discover']: async (req, res) => {
        if (discovery) discovery.probe()
        await new Promise((resolve) => setTimeout(resolve, 1300))
        sendJson(res, 200, { ok: true, peers: await peers.list() })
      },
['GET ' + PREFIX + '/invite']: async (req, res) => {
        const current = cfg()
        const local = preferredAddress() || localAddresses()[0]
        const code = identityMod.createInvite(current, identity, {
          host: local ? local.address : '127.0.0.1',
          port: current.port
        })
        sendJson(res, 200, { ok: true, code, spaceId: current.spaceId, host: local ? local.address : '127.0.0.1' })
      },
['POST ' + PREFIX + '/join']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const invite = identityMod.parseInvite(String(body.code || ''))
        if (!invite) throw errorOf(400, 'BAD_INVITE', '邀请码无效')
        await peers.removeAll()
        const bootstrap = invite.host ? [invite.host + ':' + (invite.port || config.DEFAULT_PORT)] : []
        await config.update({ networkKey: invite.networkKey, bootstrapPeers: bootstrap })
        // Local sessions are re-exported by the mesh; objects learned from the
        // previous space must not leak into the new one.
        await store.dropForeign(cfg().nodeId)
        await restartNetwork()
        for (const address of bootstrap) pingBootstrap(address).catch(() => {})
        setTimeout(() => { mesh.syncAll().catch(() => {}) }, 700)
        sendJson(res, 200, { ok: true, spaceId: cfg().spaceId, status: await statusPayload() })
      },
['GET ' + PREFIX + '/workspaces']: async (req, res) => {
        await workspaces.ensure(ctx)
        sendJson(res, 200, { ok: true, roots: workspaces.list(), local: fork.listWorkspaces() })
      },
['POST ' + PREFIX + '/workspaces/refresh']: async (req, res) => {
        await workspaces.refresh(ctx)
        sendJson(res, 200, { ok: true, roots: workspaces.list() })
      },
['POST ' + PREFIX + '/workspaces/add']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const target = path.resolve(String(body.path || ''))
        if (!target) throw errorOf(400, 'BAD_PATH', 'path is required')
        const current = cfg()
        const extraRoots = current.extraRoots.slice()
        if (extraRoots.indexOf(target) < 0) extraRoots.push(target)
        await config.update({ extraRoots })
        await workspaces.refresh(ctx)
        sendJson(res, 200, { ok: true, roots: workspaces.list() })
      },
['GET ' + PREFIX + '/files/list']: async (req, res) => {
        const query = queryOf(req.url)
        const root = workspaces.resolve(query.root)
        if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
        sendJson(res, 200, await files.listDir(root, String(query.path || '')))
      },
['GET ' + PREFIX + '/files/read']: async (req, res) => {
        const query = queryOf(req.url)
        const root = workspaces.resolve(query.root)
        if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
        sendJson(res, 200, await files.readFile(root, String(query.path || ''), cfg().maxFileBytes))
      },
['POST ' + PREFIX + '/files/write']: async (req, res) => {
        const body = await readJson(req, 8 * 1024 * 1024)
        const root = workspaces.resolve(body.root)
        if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
        sendJson(res, 200, await files.writeFile(root, String(body.path || ''), String(body.content || ''), { backup: true }))
      },
['POST ' + PREFIX + '/files/mkdir']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const root = workspaces.resolve(body.root)
        if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
        sendJson(res, 200, await files.makeDir(root, String(body.path || '')))
      },
['POST ' + PREFIX + '/files/delete']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const root = workspaces.resolve(body.root)
        if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
        sendJson(res, 200, await files.removePath(root, String(body.path || ''), { recursive: body.recursive === true }))
      },
['POST ' + PREFIX + '/files/move']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const root = workspaces.resolve(body.root)
        if (!root) throw errorOf(400, 'NO_ROOT', 'unknown root')
        sendJson(res, 200, await files.renamePath(root, String(body.from || ''), String(body.to || '')))
      },
['GET ' + PREFIX + '/remote/workspaces']: async (req, res) => {
        const peer = await requirePeer(queryOf(req.url).node)
        sendJson(res, 200, await transport.request(peer, 'GET', LAN.workspaces))
      },
['GET ' + PREFIX + '/remote/files/list']: async (req, res) => {
        const query = queryOf(req.url)
        const peer = await requirePeer(query.node)
        sendJson(res, 200, await transport.request(
          peer,
          'GET',
          LAN.fsList + '?root=' + encodeURIComponent(query.root || '') + '&path=' + encodeURIComponent(query.path || '')
        ))
      },
['GET ' + PREFIX + '/remote/files/read']: async (req, res) => {
        const query = queryOf(req.url)
        const peer = await requirePeer(query.node)
        sendJson(res, 200, await transport.request(
          peer,
          'GET',
          LAN.fsRead + '?root=' + encodeURIComponent(query.root || '') + '&path=' + encodeURIComponent(query.path || '')
        ))
      },
['GET ' + PREFIX + '/conversations']: async (req, res) => {
        const query = queryOf(req.url)
        const limit = Math.min(Math.max(Number(query.limit) || 40, 1), 200)
        if (query.node) {
          const peer = await requirePeer(query.node)
          sendJson(res, 200, await transport.request(peer, 'GET', LAN.conversations + '?limit=' + limit))
          return
        }
        const rows = await store.listConversations({ nodeId: cfg().nodeId, limit })
        sendJson(res, 200, { ok: true, conversations: rows })
      },
['GET ' + PREFIX + '/conversation']: async (req, res) => {
        const query = queryOf(req.url)
        if (query.node) {
          const peer = await requirePeer(query.node)
          sendJson(res, 200, await transport.request(
            peer,
            'GET',
            LAN.conversation + '?session=' + encodeURIComponent(query.session || '')
          ))
          return
        }
        const found = await store.getConversation(cfg().nodeId, String(query.session || ''))
        if (!found) throw errorOf(404, 'NO_CONVERSATION', 'conversation not found')
        sendJson(res, 200, { ok: true, conversation: found.body })
      },
['POST ' + PREFIX + '/fork']: async (req, res) => {
        const body = await readJson(req, 8 * 1024 * 1024)
        let conversation = body.conversation
        if (!conversation && body.session) {
          if (body.node) {
            const peer = await requirePeer(body.node)
            const result = await transport.request(
              peer,
              'GET',
              LAN.conversation + '?session=' + encodeURIComponent(body.session)
            )
            conversation = result && result.conversation
          } else {
            const found = await store.getConversation(cfg().nodeId, String(body.session))
            conversation = found && found.body
          }
        }
        if (!conversation) throw errorOf(400, 'NO_CONVERSATION', 'conversation not found')
        let result
        try {
          result = fork.forkConversation({ conversation, workspace: body.workspace })
        } catch (err) {
          if (err && (err.code === 'EMPTY_CONVERSATION' || err.code === 'NO_WORKSPACE')) err.status = 400
          throw err
        }
        await attachToWorkspace(ctx, result.cwd, result.sessionId)
        broadcast({ type: 'fork', sessionId: result.sessionId })
        sendJson(res, 200, { ok: true, ...result })
      },
['GET ' + PREFIX + '/transfers']: async (req, res) => {
        sendJson(res, 200, {
          ok: true,
          incoming: transfer.listIncoming(),
          outgoing: transfer.listOutgoing()
        })
      },
['POST ' + PREFIX + '/transfers/approve']: async (req, res) => {
        const body = await readJson(req, 512 * 1024)
        sendJson(res, 200, { ok: true, transfer: await transfer.approve(String(body.id || ''), body) })
      },
['POST ' + PREFIX + '/transfers/reject']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        sendJson(res, 200, { ok: true, transfer: transfer.reject(String(body.id || '')) })
      },
['POST ' + PREFIX + '/transfers/send']: async (req, res) => {
        const body = await readJson(req, 512 * 1024)
        const peer = await requirePeer(body.node)
        const taskId = startTask('send', async () => transfer.sendFile(peer, {
          root: body.root,
          relative: body.path,
          mode: body.mode,
          destRoot: body.destRoot,
          destPath: body.destPath
        }))
        sendJson(res, 202, { ok: true, taskId })
      },
['POST ' + PREFIX + '/transfers/download']: async (req, res) => {
        const body = await readJson(req, 512 * 1024)
        const peer = await requirePeer(body.node)
        const taskId = startTask('download', async () => transfer.downloadFile(peer, {
          root: body.root,
          relative: body.path
        }))
        sendJson(res, 202, { ok: true, taskId })
      },
['GET ' + PREFIX + '/ai/models']: async (req, res) => {
        const query = queryOf(req.url)
        if (query.node) {
          const peer = await requirePeer(query.node)
          sendJson(res, 200, await transport.request(peer, 'GET', LAN.aiModels))
          return
        }
        sendJson(res, 200, { ok: true, models: await ai.models() })
      },
['POST ' + PREFIX + '/ai/ask']: async (req, res) => {
        const body = await readJson(req, 4 * 1024 * 1024)
        const messages = [{ role: 'user', content: [{ type: 'text', text: String(body.prompt || '') }] }]
        if (body.system) messages.unshift({ role: 'system', content: [{ type: 'text', text: String(body.system) }] })
        if (body.node) {
          const peer = await requirePeer(body.node)
          sendJson(res, 200, await ai.askPeer(peer, { messages, provider: body.provider, model: body.model }))
          return
        }
        const result = await ai.ask({ messages, provider: body.provider, model: body.model })
        sendJson(res, 200, result)
      },
['POST ' + PREFIX + '/ai/team']: async (req, res) => {
        const body = await readJson(req, 4 * 1024 * 1024)
        sendJson(res, 200, await ai.team(body.nodes, String(body.prompt || ''), {
          provider: body.provider,
          model: body.model
        }))
      },
['GET ' + PREFIX + '/task']: async (req, res) => {
        const id = String(queryOf(req.url).id || '')
        const task = tasks.get(id)
        if (!task) throw errorOf(404, 'NO_TASK', 'unknown task')
        sendJson(res, 200, { ok: true, id, status: task.status, result: task.result, error: task.error })
      },
['GET ' + PREFIX + '/audit']: async (req, res) => {
        sendJson(res, 200, { ok: true, events: await store.recentAudit(60) })
      },
['GET ' + PREFIX + '/memory']: async (req, res) => {
        sendJson(res, 200, { ok: true, items: await store.listMemory() })
      },
['POST ' + PREFIX + '/memory/write']: async (req, res) => {
        const body = await readJson(req, 4 * 1024 * 1024)
        const found = (await memory.discover()).filter((row) => row.name === body.name)
        if (!found.length) throw errorOf(404, 'NO_MEMORY_FILE', 'memory file not found')
        await memory.writeMemory(found[0].file, String(body.text || ''), { backup: true })
        await mesh.exportLocal({ force: true })
        sendJson(res, 200, { ok: true })
      },
['GET ' + PREFIX + '/plugins']: async (req, res) => {
        const manifest = await plugins.readLocalManifest(ctx, { machineId: cfg().nodeId, machineName: cfg().nodeName })
        sendJson(res, 200, { ok: true, manifest, runtime: await plugins.listRuntimePlugins(ctx) })
      },
['POST ' + PREFIX + '/plugins/apply']: async (req, res) => {
        const body = await readJson(req, 4 * 1024 * 1024)
        const result = await plugins.applyManifest(body.remote || body, {})
        sendJson(res, 200, { ok: true, result })
      },
['POST ' + PREFIX + '/plugins/install']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        sendJson(res, 200, { ok: true, result: await plugins.runInstall(body) })
      },
['POST ' + PREFIX + '/plugins/toggle']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        await plugins.setPluginEnabled(ctx, String(body.entryId || ''), body.enabled === true)
        sendJson(res, 200, { ok: true })
      },
['POST ' + PREFIX + '/sync']: async (req, res) => {
        sendJson(res, 200, await mesh.syncAll())
      },
['POST ' + PREFIX + '/ping']: async (req, res) => {
        const body = await readJson(req, 256 * 1024)
        const peer = await requirePeer(body.node)
        const started = Date.now()
        const hello = await transport.request(peer, 'GET', LAN.hello)
        sendJson(res, 200, { ok: true, latencyMs: Date.now() - started, hello })
      }
    }
  }

  function startTask(kind, fn) {
    const id = randomUUID()
    const task = { id, kind, status: 'running', result: null, error: '', at: Date.now() }
    tasks.set(id, task)
    Promise.resolve()
      .then(fn)
      .then((result) => {
        task.status = 'complete'
        task.result = result
        broadcast({ type: 'task', id, kind, status: 'complete', result })
      })
      .catch((err) => {
        task.status = 'failed'
        task.error = String((err && err.message) || err)
        task.code = err && err.code
        broadcast({ type: 'task', id, kind, status: 'failed', error: task.error })
      })
    for (const [key, row] of tasks) {
      if (Date.now() - row.at > 30 * 60 * 1000) tasks.delete(key)
    }
    return id
  }

  async function requirePeer(selector) {
    const key = String(selector || '').trim()
    if (!key) throw errorOf(400, 'NO_NODE', 'node is required')
    const rows = await peers.list()
    const peer = rows.find((row) => row.nodeId === key) || rows.find((row) => row.name === key)
    if (!peer) throw errorOf(404, 'NO_PEER', 'unknown peer: ' + key)
    if (peer.trust !== 'trusted') throw errorOf(403, 'PEER_NOT_TRUSTED', 'peer is not trusted')
    return peer
  }

  async function pingBootstrap(address) {
    const [host, portText] = address.split(':')
    const port = Number(portText) || cfg().port
    const temp = { nodeId: '', name: host, address: host, port, trust: 'pending', sync: {} }
    try {
      const started = Date.now()
      const hello = await transport.request(temp, 'GET', LAN.hello)
      if (hello && hello.node) {
        await peers.observe({
          nodeId: hello.node.nodeId,
          name: hello.node.nodeName,
          address: host,
          port: hello.node.port || port,
          fingerprint: hello.node.fingerprint,
          latencyMs: Date.now() - started
        })
      }
    } catch (err) {
      audit('bootstrap-failed', { address, message: String((err && err.message) || err), code: err && err.code })
      return String((err && err.message) || err)
    }
  }

  async function restartNetwork() {
    if (discovery) discovery.stop()
    // Keep the same transport object: every module holds a reference to it, and
    // both the port and the network key are read from config at request time.
    if (transport) {
      await transport.stop()
      try {
        await transport.start()
      } catch (err) {
        bootError = String((err && err.message) || err)
        audit('transport-failed', { message: bootError })
      }
    }
    discovery = createDiscovery({
      getConfig: cfg,
      getIdentity: () => identity,
      onPeer: (row) => {
        peers.observe(row).then(() => broadcast({ type: 'discovered', nodeId: row.nodeId })).catch(() => {})
      }
    })
    if (cfg().discovery) discovery.start()
  }

  function startLoops() {
    if (exportTimer) clearInterval(exportTimer)
    if (syncTimer) clearInterval(syncTimer)
    exportTimer = setInterval(() => {
      if (disposed) return
      mesh.exportLocal().catch((err) => audit('export-failed', { message: String((err && err.message) || err) }))
    }, Math.max(cfg().scanIntervalMs, 2000))
    exportTimer.unref && exportTimer.unref()
    syncTimer = setInterval(() => {
      if (disposed) return
      mesh.syncAll().catch(() => {})
    }, Math.max(cfg().syncIntervalMs, 2000))
    syncTimer.unref && syncTimer.unref()
  }

  function scheduleExport() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (disposed) return
      mesh.exportLocal().catch(() => {})
    }, EXPORT_DEBOUNCE_MS)
  }

  async function boot() {
    if (disposed) return
    await config.load()
    await store.ensure()
    await peers.ensure()
    identity = await identityMod.ensure(cfg().nodeId)
    workspaces = createWorkspaces({ getConfig: cfg, getContext: () => ctx })
    await workspaces.refresh(ctx)
    if (disposed) return
    transport = createTransport({ getConfig: cfg, getIdentity: () => identity, getPeers: () => peers })
    lanRoutes()
    try {
      await transport.start()
    } catch (err) {
      bootError = String((err && err.message) || err)
      audit('transport-failed', { message: bootError })
    }
    if (disposed) {
      transport.stop().catch(() => {})
      return
    }
    discovery = createDiscovery({
      getConfig: cfg,
      getIdentity: () => identity,
      onPeer: (row) => {
        peers.observe(row).then(() => broadcast({ type: 'discovered', nodeId: row.nodeId })).catch(() => {})
      }
    })
    if (cfg().discovery) discovery.start()
    // A bootstrap address is a direct HTTP ping; discovery may be blocked by a
    // firewall while the known address still works.
    for (const address of cfg().bootstrapPeers) {
      pingBootstrap(address).catch(() => {})
    }
    transfer = createTransfer({
      getConfig: cfg,
      getPeers: () => peers,
      transport,
      workspaces,
      onEvent: (type, detail) => broadcast({ type, detail })
    })
    ai = createAi({ getContext: () => ctx, getConfig: cfg, transport, getPeers: () => peers })
    mesh = createMesh({
      getConfig: cfg,
      store,
      peers,
      transport,
      getContext: () => ctx,
      onEvent: (event, detail) => broadcast({ type: event, detail })
    })
    tools = createAgentTools({ getContext: () => ctx, getConfig: cfg, peers, transport, workspaces, ai, transfer, store })
    try {
      const registered = tools.register(ctx)
      registeredToolNames = registered
      if (registered.length) audit('tools.registered', { tools: registered })
    } catch (err) {
      audit('tools.failed', { message: String((err && err.message) || err) })
    }
    startLoops()
    initialTimer = setTimeout(() => {
      if (disposed) return
      mesh.exportLocal().then(() => mesh.syncAll()).catch(() => {})
    }, 1500)
    initialTimer.unref && initialTimer.unref()
    booted = true
    broadcast({ type: 'boot', ok: true })
  }

  async function browserHandler(req, res) {
    // This surface is same-origin only. Do not emit permissive CORS headers:
    // a random web page must not be able to read /_dsh/lan/invite or drive the
    // LAN API from the user's browser.
    if (isPreflight(req)) {
      res.writeHead(204)
      res.end()
      return
    }
    const method = String(req.method || 'GET').toUpperCase()
    const pathname = pathOf(req.url)
    if (method === 'GET' && pathname === PREFIX + '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      streams.add(res)
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch (err) {
          clearInterval(heartbeat)
          streams.delete(res)
        }
      }, 25000)
      if (heartbeat.unref) heartbeat.unref()
      req.on('close', () => {
        clearInterval(heartbeat)
        streams.delete(res)
      })
      return
    }
    const relative = pathname.slice(PREFIX.length) || '/'
    const handler = table()[method + ' ' + PREFIX + relative]
    if (!handler) return fail(res, 404, 'no such endpoint', 'NOT_FOUND')
    try {
      await handler(req, res)
    } catch (err) {
      if (res.headersSent) {
        try {
          res.destroy()
        } catch (closeError) {
          /* ignore */
        }
        return
      }
      const status = statusOfError(err)
      if (status >= 500) audit('route-failed', { path: relative, message: String((err && err.message) || err) })
      fail(res, status, (err && err.message) || 'internal error', (err && err.code) || 'INTERNAL')
    }
  }

  ctx.effect(
    function () {
      let cancelled = false
      boot()
        .then(() => {
          if (cancelled) dispose()
        })
        .catch((err) => {
          bootError = String((err && err.message) || err)
          audit('boot-failed', { message: bootError })
        })
      return function cleanup() {
        cancelled = true
        dispose()
      }
    },
    'lan-bridge: engine'
  )

  function dispose() {
    if (disposed) return
    disposed = true
    for (const timer of [syncTimer, exportTimer, debounceTimer, initialTimer]) {
      if (timer) clearTimeout(timer)
      if (timer) clearInterval(timer)
    }
    if (discovery) discovery.stop()
    if (transport) transport.stop().catch(() => {})
    if (tools) {
      try {
        tools.dispose()
      } catch (err) {
        /* best effort */
      }
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

  ctx.effect(
    function () {
      if (typeof ctx.on !== 'function') return function () {}
      const off = ctx.on('session/event', () => scheduleExport())
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
        handler: browserHandler
      })
    },
    'lan-bridge: browser surface'
  )
}
