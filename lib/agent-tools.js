/**
 * Model-facing LAN tools.
 *
 * These are ordinary DSH tools registered on the host: once registered the
 * model sees their schemas in the system prompt and can call them from any
 * local session. The tools are intentionally read-mostly. `lan_send_file` is
 * the only write, and it goes through DSH's native approval service with the
 * open turn's agent, so the user sees the usual approval card rather than a
 * plugin-specific dialog.
 */

import * as files from './files.js'

const textOutput = {
  schema: { type: 'object' },
  render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function failText(message) {
  return { ok: false, error: String(message || '') }
}

function peerLabel(peer) {
  return peer.name || peer.nodeId
}

export function createAgentTools(options) {
  const getContext = options.getContext
  const getConfig = options.getConfig
  const peers = options.peers
  const transport = options.transport
  const workspaces = options.workspaces
  const ai = options.ai
  const transfer = options.transfer

  function ctxOf() {
    const ctx = getContext()
    if (!ctx) throw new Error('plugin host is not ready')
    return ctx
  }

  async function findPeer(selector) {
    const key = String(selector || '').trim()
    if (!key) throw new Error('node is required')
    const rows = await peers.list()
    const found = rows.find((peer) => peer.nodeId === key) || rows.find((peer) => peer.name === key)
    if (!found) throw new Error('unknown peer: ' + key)
    if (found.trust !== 'trusted') throw new Error('peer is not trusted: ' + key)
    return found
  }

  async function peerRoots(selector) {
    if (!selector) {
      await workspaces.ensure(ctxOf())
      return { ok: true, nodeId: getConfig().nodeId, local: true, roots: workspaces.list() }
    }
    const peer = await findPeer(selector)
    const result = await transport.request(peer, 'GET', '/api/v2/workspaces')
    return { ok: true, nodeId: peer.nodeId, name: peerLabel(peer), local: false, roots: (result && result.roots) || [] }
  }

  async function readFile(args) {
    const rootId = String(args.root || '')
    const relative = String(args.path || '')
    if (!args.node) {
      await workspaces.ensure(ctxOf())
      const root = workspaces.resolve(rootId)
      if (!root) throw new Error('unknown root: ' + rootId)
      const config = getConfig()
      const result = await files.readFile(root, relative, config.maxFileBytes)
      return { ok: true, nodeId: config.nodeId, root: root.id, label: root.label, ...result }
    }
    const peer = await findPeer(args.node)
    const result = await transport.request(
      peer,
      'GET',
      '/api/v2/fs/read?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(relative)
    )
    return Object.assign({ ok: true, nodeId: peer.nodeId, name: peerLabel(peer) }, result)
  }

  async function listConversations(args) {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
    if (!args.node) {
      const store = options.store
      const rows = await store.listConversations({ nodeId: getConfig().nodeId, limit })
      return { ok: true, nodeId: getConfig().nodeId, conversations: rows }
    }
    const peer = await findPeer(args.node)
    const result = await transport.request(peer, 'GET', '/api/v2/conversations?limit=' + limit)
    return Object.assign({ ok: true, nodeId: peer.nodeId, name: peerLabel(peer) }, result)
  }

  async function getConversation(args) {
    const sessionId = String(args.session || '')
    if (!sessionId) throw new Error('session is required')
    if (!args.node) {
      const store = options.store
      const found = await store.getConversation(getConfig().nodeId, sessionId)
      return { ok: true, nodeId: getConfig().nodeId, conversation: found ? found.body : null }
    }
    const peer = await findPeer(args.node)
    const result = await transport.request(
      peer,
      'GET',
      '/api/v2/conversation?session=' + encodeURIComponent(sessionId)
    )
    return Object.assign({ ok: true, nodeId: peer.nodeId, name: peerLabel(peer) }, result)
  }

  async function askRemote(args) {
    const prompt = String(args.prompt || '').trim()
    if (!prompt) throw new Error('prompt is required')
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    if (args.system) messages.unshift({ role: 'system', content: [{ type: 'text', text: String(args.system) }] })
    if (!args.node) {
      const result = await ai.ask({ messages, provider: args.provider, model: args.model })
      return { ok: true, local: true, text: result.text, provider: result.provider, model: result.model, ms: result.ms }
    }
    const peer = await findPeer(args.node)
    const result = await ai.askPeer(peer, { messages, provider: args.provider, model: args.model })
    return { ok: true, nodeId: peer.nodeId, name: peerLabel(peer), text: result.text, provider: result.provider, model: result.model, ms: result.ms }
  }

  async function team(args) {
    const prompt = String(args.prompt || '').trim()
    if (!prompt) throw new Error('prompt is required')
    const result = await ai.team(args.nodes, prompt, { provider: args.provider, model: args.model })
    return result
  }

  async function sendFile(args, exec) {
    const peer = await findPeer(args.node)
    const rootId = String(args.root || '')
    const relative = String(args.path || '')
    await workspaces.ensure(ctxOf())
    const root = workspaces.resolve(rootId)
    if (!root) throw new Error('unknown root: ' + rootId)
    const resolved = await files.resolveWithin(root, relative, false)
    const reason = 'Send ' + resolved.relative + ' from ' + root.label + ' to ' + peerLabel(peer) + ' over the LAN?'
    const ctx = ctxOf()
    const approval = ctx.get('approval') || ctx.get('userApproval')
    if (!approval || typeof approval.request !== 'function') {
      return failText('approval service is unavailable; refusing to send a file')
    }
    let outcome
    try {
      outcome = await approval.request({
        agent: exec && exec.agent,
        toolName: 'lan_send_file',
        reason,
        signal: exec && exec.signal
      })
    } catch (err) {
      return failText('approval failed: ' + String((err && err.message) || err))
    }
    if (outcome !== 'allowed-once' && outcome !== true) {
      return failText('the user declined the transfer')
    }
    const result = await transfer.sendFile(peer, {
      root: root.id,
      relative: resolved.relative,
      mode: args.mode === 'workspace' ? 'workspace' : 'inbox',
      destRoot: args.destRoot,
      destPath: args.destPath
    })
    return { ok: true, to: peer.nodeId, ...result }
  }

  function define(name, description, parameters, execute) {
    return {
      name,
      description,
      parameters,
      output: textOutput,
      async execute(args, exec) {
        try {
          return await execute(args || {}, exec || {})
        } catch (err) {
          return failText((err && err.message) || err)
        }
      }
    }
  }

  const disposers = []

  function dispose() {
    while (disposers.length) {
      const fn = disposers.pop()
      try {
        if (typeof fn === 'function') fn()
        else if (fn && typeof fn.dispose === 'function') fn.dispose()
      } catch (err) {
        /* best effort */
      }
    }
  }

  function register(ctx) {
    const config = getConfig()
    if (!config.agentTools) return []
    let registry = null
    try {
      registry = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null
    } catch (err) {
      registry = null
    }
    if (!registry) {
      try {
        registry = ctx && ctx.tools ? ctx.tools : null
      } catch (err) {
        registry = null
      }
    }
    if (!registry || typeof registry.register !== 'function') return []
    const tools = [
      define(
        'lan_peers',
        'List the other DSH nodes on this LAN, their trust state, address, and last sync. Use before any cross-device action.',
        { type: 'object', properties: {}, additionalProperties: false },
        async () => {
          const rows = (await peers.list()).map((peer) => ({
            nodeId: peer.nodeId,
            name: peer.name,
            trust: peer.trust,
            address: peer.address,
            port: peer.port,
            lastSeenAt: peer.lastSeenAt,
            lastError: peer.lastError,
            synced: peer.sync && peer.sync.lastSummary
          }))
          return { ok: true, self: { nodeId: config.nodeId, name: config.nodeName }, peers: rows }
        }
      ),
      define(
        'lan_workspaces',
        'List workspaces shared by this machine, or by another trusted node. Returns opaque root ids, never absolute paths.',
        {
          type: 'object',
          properties: { node: { type: 'string', description: 'Target node id or name. Omit for this machine.' } },
          additionalProperties: false
        },
        async (args) => peerRoots(args.node)
      ),
      define(
        'lan_read',
        'Read a text file from a shared workspace on this machine or on a trusted node. Binary files are reported, not returned.',
        {
          type: 'object',
          properties: {
            node: { type: 'string', description: 'Target node id or name. Omit for this machine.' },
            root: { type: 'string', description: 'Root id from lan_workspaces.' },
            path: { type: 'string', description: 'Path relative to the root.' }
          },
          required: ['root', 'path'],
          additionalProperties: false
        },
        readFile
      ),
      define(
        'lan_conversations',
        'List recent AI conversations on this machine or on a trusted node. Metadata only; use lan_conversation for a transcript.',
        {
          type: 'object',
          properties: {
            node: { type: 'string' },
            limit: { type: 'number' }
          },
          additionalProperties: false
        },
        listConversations
      ),
      define(
        'lan_conversation',
        'Read one AI conversation transcript from this machine or a trusted node.',
        {
          type: 'object',
          properties: { node: { type: 'string' }, session: { type: 'string' } },
          required: ['session'],
          additionalProperties: false
        },
        getConversation
      ),
      define(
        'lan_ask',
        'Ask a model running on a trusted node. The target only runs a plain chat completion: it receives no tools and cannot touch its filesystem. Omit node to use this machine.',
        {
          type: 'object',
          properties: {
            node: { type: 'string' },
            prompt: { type: 'string' },
            system: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' }
          },
          required: ['prompt'],
          additionalProperties: false
        },
        askRemote
      ),
      define(
        'lan_team',
        'Send one prompt to several trusted nodes in parallel and return each node\'s model answer. Use for a second opinion or model comparison.',
        {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            nodes: { type: 'array', items: { type: 'string' } },
            provider: { type: 'string' },
            model: { type: 'string' }
          },
          required: ['prompt'],
          additionalProperties: false
        },
        team
      ),
      define(
        'lan_send_file',
        'Send one file from a shared workspace to a trusted node. The receiving user must approve it unless auto-accept is on.',
        {
          type: 'object',
          properties: {
            node: { type: 'string' },
            root: { type: 'string' },
            path: { type: 'string' },
            mode: { type: 'string', enum: ['inbox', 'workspace'] },
            destRoot: { type: 'string' },
            destPath: { type: 'string' }
          },
          required: ['node', 'root', 'path'],
          additionalProperties: false
        },
        sendFile
      )
    ]
    const registered = []
    for (const tool of tools) {
      if (tool.name === 'lan_send_file' || tool.name === 'lan_ask' || tool.name === 'lan_team') {
        tool.timeoutMs = 300000
      }
      try {
        const disposer = registry.register(tool)
        if (disposer) disposers.push(disposer)
        registered.push(tool.name)
      } catch (err) {
        // A rejected tool must not take down plugin startup.
      }
    }
    return registered
  }

  return { register, dispose }
}
