import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lan-v2-ai-'))
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'
const rootPath = path.join(home, 'work')
await fs.mkdir(rootPath, { recursive: true })
await fs.writeFile(path.join(rootPath, 'hello.txt'), 'hello tool\n', 'utf8')

const config = await import('../lib/config.js')
const store = await import('../lib/store.js')
const { createAi } = await import('../lib/ai.js')
const { createAgentTools } = await import('../lib/agent-tools.js')

const saved = await config.save(Object.assign({}, config.defaults(), {
  nodeId: 'ai-node',
  nodeName: 'ai-node',
  allowRemoteAi: true,
  agentTools: true
}))
await store.ensure()

const fakeLlm = {
  async listProviders() {
    return ['fake']
  },
  async listModels(provider) {
    return provider === 'fake' ? [{ id: 'm1', name: 'Fake One' }] : []
  },
  stream() {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', index: 0, text: 'hello ' }
        yield { type: 'text-delta', index: 0, text: 'world' }
        yield { type: 'finish', kind: 'stop' }
      }
    }
  }
}

const peers = {
  async list() {
    return [
      { nodeId: 'p1', name: 'Peer One', trust: 'trusted', address: '127.0.0.1', port: 1, sync: {} },
      { nodeId: 'p2', name: 'Peer Two', trust: 'pending', address: '127.0.0.1', port: 2, sync: {} }
    ]
  },
  async get() {
    return null
  }
}

const transport = {
  async request(peer, method, pathname, options) {
    if (pathname === '/api/v2/ai/ask') {
      return { ok: true, provider: 'fake', model: 'm1', text: 'from ' + peer.name, ms: 3 }
    }
    if (pathname === '/api/v2/workspaces') {
      return { ok: true, roots: [{ id: 'w-1', label: 'peer-work', kind: 'workspace' }] }
    }
    if (pathname.indexOf('/api/v2/fs/read') === 0) {
      return { ok: true, root: 'w-1', label: 'peer-work', path: 'hello.txt', binary: false, size: 11, content: 'peer hello\n' }
    }
    return { ok: true, conversations: [] }
  }
}

const workspaces = {
  async ensure() { return [root] },
  resolve(id) { return id === root.id ? root : null },
  list() { return [root] }
}
const root = { id: 'w-local', label: 'local', path: rootPath, kind: 'workspace', exists: true }
const files = await import('../lib/files.js')
files.setRoots([root])

const ai = createAi({ getContext: () => ({ get: (name) => (name === 'llm' ? fakeLlm : null) }), getConfig: config.peek, transport, getPeers: () => peers })
const models = await ai.models()
assert(models.length === 1 && models[0].id === 'm1', 'models are discovered')
const answer = await ai.ask({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
assert(answer.text === 'hello world', 'ask accumulates text deltas')
const remote = await ai.askPeer({ nodeId: 'p1', name: 'Peer One' }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
assert(remote.text === 'from Peer One', 'remote ask uses transport')
const team = await ai.team([], 'compare', {})
assert(team.results.length === 1 && team.results[0].ok, 'team targets trusted peers')

const tools = {}
const agentTools = createAgentTools({
  getContext: () => ({ get: () => null, tools: { register(tool) { tools[tool.name] = tool } } }),
  getConfig: config.peek,
  peers,
  transport,
  workspaces,
  ai,
  transfer: {},
  store
})
const registered = agentTools.register({ tools: { register(tool) { tools[tool.name] = tool } } })
assert(registered.length === 8, 'eight tools registered')
assert(tools.lan_peers && tools.lan_read && tools.lan_team, 'tool names are stable')

const peersResult = await tools.lan_peers.execute({}, {})
assert(peersResult.ok === true && Array.isArray(peersResult.peers), 'lan_peers returns peers')
const readLocal = await tools.lan_read.execute({ root: 'w-local', path: 'hello.txt' }, {})
assert(readLocal.ok === true && readLocal.content === 'hello tool\n', 'lan_read reads locally')
const readRemote = await tools.lan_read.execute({ node: 'p1', root: 'w-1', path: 'hello.txt' }, {})
assert(readRemote.ok === true && readRemote.content === 'peer hello\n', 'lan_read proxies remotely')
const roots = await tools.lan_workspaces.execute({}, {})
assert(roots.ok === true && roots.roots.length === 1, 'lan_workspaces lists local roots')

console.log('v2-ai ok · models=', models.length, '· tools=', registered.length)
process.exit(0)

function assert(value, message) {
  if (!value) {
    console.error('FAIL:', message)
    process.exit(1)
  }
}
