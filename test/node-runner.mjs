import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const home = process.env.RUN_HOME
const port = Number(process.env.RUN_PORT)
const controlPort = Number(process.env.RUN_CONTROL_PORT)
const root = process.env.RUN_ROOT
const autoAccept = process.env.RUN_AUTO_ACCEPT === '1'

process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'

await fs.mkdir(root, { recursive: true })
await fs.mkdir(path.join(home, 'lan-bridge'), { recursive: true })

const config = await import('../lib/config.js')
const nodeId = 'node-' + port
await config.save(Object.assign({}, config.defaults(), {
  nodeId,
  nodeName: 'node-' + port,
  port,
  discoveryPort: port + 10,
  discovery: false,
  autoAcceptTransfers: autoAccept,
  allowRemoteRead: true,
  allowRemoteAi: true
}))

const fakeLlm = {
  async listProviders() {
    return ['fake']
  },
  async listModels() {
    return [{ id: 'runner-model', name: 'Runner Model' }]
  },
  stream() {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', index: 0, text: 'remote answer from ' + nodeId }
        yield { type: 'finish', kind: 'stop' }
      }
    }
  }
}

const store = await import('../lib/store.js')
const fork = await import('../lib/fork.js')
const { apply } = await import('../index.js')

const seeded = fork.buildForkLog({
  transcript: { items: [
    { t: 'user', text: 'seed' },
    { t: 'assistant', blocks: [{ k: 'text', text: 'seeded workspace' }] }
  ] },
  cwd: root,
  config: [],
  route: { provider: 'fake', model: 'runner-model' },
  agentPreset: 'standard'
})
fork.writeSessionLog(seeded.header, seeded.events)

let handler = null
const effects = []
const fakeCtx = {
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup)
    return cleanup
  },
  on() {
    return function () {}
  },
  get(name) {
    if (name === 'llm') return fakeLlm
    if (name === 'workspaceRegistry') {
      return {
        list() {
          return [{ path: root, title: 'shared', sessionIds: [] }]
        },
        async resolveByPath(target) {
          return target === root ? { attachSession() {} } : undefined
        }
      }
    }
    return null
  },
  webServer: {
    register(options) {
      handler = options.handler
      return { dispose() {} }
    }
  },
  tools: {
    register() {}
  }
}

apply(fakeCtx)

const control = http.createServer((req, res) => {
  if (!handler) {
    res.writeHead(503)
    res.end('booting')
    return
  }
  handler(req, res)
})

async function waitForBoot() {
  const response = await new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:' + controlPort + '/_dsh/lan/status', (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
  })
  return JSON.parse(response.text)
}

control.listen(controlPort, '127.0.0.1', async () => {
  let status = null
  for (let i = 0; i < 100; i += 1) {
    try {
      status = await waitForBoot()
      if (status.booted) break
    } catch (err) {
      /* control may not be ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  if (!status || !status.booted) {
    console.error('BOOT_FAILED')
    process.exit(1)
  }
  await store.putConversation({
    nodeId,
    sessionId: 'e2e-' + nodeId,
    title: 'E2E chat ' + nodeId,
    cwd: root,
    updatedAt: new Date().toISOString(),
    body: {
      sessionId: 'e2e-' + nodeId,
      title: 'E2E chat ' + nodeId,
      cwd: root,
      updatedAt: new Date().toISOString(),
      items: [
        { t: 'user', text: 'hello from ' + nodeId },
        { t: 'assistant', blocks: [{ k: 'text', text: 'hello back' }] }
      ]
    }
  })
  process.stdout.write('READY ' + JSON.stringify({ nodeId, port, controlPort, root }) + '\n')
})

setInterval(() => {}, 1000)
