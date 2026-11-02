import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lan-v2-host-'))
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'

const config = await import('../lib/config.js')
const { apply } = await import('../index.js')

const defaults = config.defaults()
const saved = await config.save(Object.assign({}, defaults, {
  nodeId: 'host-test-node',
  nodeName: 'host-test',
  port: 47991,
  discoveryPort: 47992,
  discovery: false,
  networkKey: 'test-network-key-0123456789'
}))

assert(saved.spaceId, 'space id is derived')

let handler = null
const cleanups = []
const registeredTools = []
const fakeCtx = {
  effect(fn, label) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return cleanup
  },
  on(event, fn) {
    return function () {}
  },
  get(name) {
    return null
  },
  webServer: {
    register(options) {
      handler = options.handler
      return { dispose() {} }
    }
  },
  tools: {
    register(tool) {
      registeredTools.push(tool.name)
    }
  }
}

apply(fakeCtx)

async function request(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  req.socket = { remoteAddress: '127.0.0.1' }
  const chunks = []
  const res = {
    statusCode: 200,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
    },
    setHeader() {},
    write(value) {
      chunks.push(Buffer.from(value))
    },
    end(value) {
      if (value) chunks.push(Buffer.from(value))
      const text = Buffer.concat(chunks).toString('utf8')
      let json = null
      try {
        json = JSON.parse(text)
      } catch (err) {}
      this.resolve({ status: this.statusCode, headers: this.headers, text, json })
    },
    destroy() {},
    resolve: null
  }
  const promise = new Promise((resolve) => { res.resolve = resolve })
  handler(req, res)
  if (method === 'GET' || method === 'HEAD') {
    req.emit('end')
  } else {
    const payload = body === undefined ? '' : JSON.stringify(body)
    if (payload) req.emit('data', Buffer.from(payload))
    req.emit('end')
  }
  return promise
}

let status = null
let statusHeaders = null
for (let i = 0; i < 100; i += 1) {
  const response = await request('GET', '/_dsh/lan/status')
  if (response.json && response.json.booted) {
    status = response.json
    statusHeaders = response.headers
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
}
assert(status, 'host boots')
assert(status.identity.nodeId === 'host-test-node', 'identity is exposed')
assert(status.transport.listening === true, 'LAN transport listens')
assert(status.roots.length === 0, 'no roots in a bare home')
assert(!statusHeaders['access-control-allow-origin'], 'browser surface is not CORS-open')

const peers = await request('GET', '/_dsh/lan/peers')
assert(peers.status === 200, 'peers route works')
assert(Array.isArray(peers.json.peers), 'peers is an array')

const workspaces = await request('GET', '/_dsh/lan/workspaces')
assert(workspaces.status === 200, 'workspaces route works')

const models = await request('GET', '/_dsh/lan/ai/models')
assert(models.status === 200, 'models route works')
assert(Array.isArray(models.json.models), 'models is an array')

const transferList = await request('GET', '/_dsh/lan/transfers')
assert(transferList.status === 200, 'transfers route works')

assert(registeredTools.length === 8, 'eight LAN tools are registered when the host exposes a registry')

for (const cleanup of cleanups) {
  try {
    await cleanup()
  } catch (err) {}
}
console.log('v2-host ok · tools=', registeredTools.join(',') || 'none', '· space=', status.config.spaceId)
process.exit(0)

function assert(value, message) {
  if (!value) {
    console.error('FAIL:', message)
    process.exit(1)
  }
}
