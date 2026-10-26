/**
 * dsh-lan-bridge — two real machines, two real processes.
 *
 * Starts one hub and one peer, each with its own `DSH_HOME`, session file and
 * MEMORY.md, lets their automatic sync loops run, then checks that the shared
 * picture is the same on both sides: conversations with chain of thought, tool
 * calls and tool output, memory, plugin manifests and remote files.
 *
 *   node test/two-machines.mjs
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import readline from 'node:readline'

const HUB_PORT = 47911
const PEER_PORT = 47912
const TOKEN = 'two-machine-token-0123456789abcdef'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-bridge-two-'))
const homes = { hub: path.join(root, 'home-win'), peer: path.join(root, 'home-mac') }
await fs.mkdir(homes.hub, { recursive: true })
await fs.mkdir(homes.peer, { recursive: true })

const children = []

function start(role, env) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'machine.mjs')], {
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  const errors = []
  child.stderr.on('data', function (chunk) { errors.push(String(chunk)) })
  const ready = new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error(role + ' did not start:\n' + errors.join(''))) }, 30000)
    readline.createInterface({ input: child.stdout }).on('line', function (line) {
      try {
        const parsed = JSON.parse(line)
        if (parsed && parsed.ready) {
          clearTimeout(timer)
          resolve(parsed)
        }
      } catch (err) {
        /* not the ready line */
      }
    })
    child.on('exit', function (code) {
      clearTimeout(timer)
      reject(new Error(role + ' exited with ' + code + ':\n' + errors.join('')))
    })
  })
  return { child, ready, errors }
}

async function get(port, suffix) {
  const response = await fetch('http://127.0.0.1:' + port + '/_dsh/lan' + suffix)
  return response.json()
}
async function post(port, suffix, payload) {
  const response = await fetch('http://127.0.0.1:' + port + '/_dsh/lan' + suffix, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  return response.json()
}

async function until(label, fn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000)
  let last = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      last = err
    }
    await new Promise(function (r) { setTimeout(r, 250) })
  }
  throw new Error('timed out waiting for ' + label + (last ? ' (' + last.message + ')' : ''))
}

const steps = []
async function step(label, fn) {
  try {
    await fn()
    steps.push({ label, ok: true })
    console.log('ok   ' + label)
  } catch (err) {
    steps.push({ label, ok: false, message: String((err && err.stack) || err) })
    console.log('FAIL ' + label)
    console.log('     ' + String((err && err.message) || err))
    throw err
  }
}

const hub = start('hub', {
  LAN_TEST_HOME: homes.hub,
  LAN_TEST_ROLE: 'hub',
  LAN_TEST_PORT: String(HUB_PORT),
  LAN_TEST_TOKEN: TOKEN,
  LAN_TEST_MACHINE_ID: 'win-pc',
  LAN_TEST_NAME: 'Windows',
  LAN_TEST_SESSION_ID: 'session-win-0001'
})
const peer = start('peer', {
  LAN_TEST_HOME: homes.peer,
  LAN_TEST_ROLE: 'peer',
  LAN_TEST_PORT: String(PEER_PORT),
  LAN_TEST_TOKEN: TOKEN,
  LAN_TEST_HUB_HOST: '127.0.0.1',
  LAN_TEST_HUB_PORT: String(HUB_PORT),
  LAN_TEST_MACHINE_ID: 'mac-001',
  LAN_TEST_NAME: 'Mac',
  LAN_TEST_SESSION_ID: 'session-mac-0001'
})

try {
  let hubPort = 0
  let peerPort = 0

  await step('both machines boot', async function () {
    const hubReady = await hub.ready
    const peerReady = await peer.ready
    hubPort = hubReady.localPort
    peerPort = peerReady.localPort
  })

  await step('peer receives the hub conversation with reasoning, tool call and tool output', async function () {
    const row = await until('hub conversation on the peer', async function () {
      const body = await get(peerPort, '/conversations')
      return body.conversations.find(function (item) { return item.sessionId === 'session-win-0001' })
    })
    assert.equal(row.machineId, 'win-pc')
    assert.equal(row.machineName, 'Windows')
    assert.equal(row.mine, false)
    const detail = await get(peerPort, '/conversation?machine=win-pc&id=session-win-0001')
    assert.equal(detail.ok, true)
    const assistant = detail.conversation.items.find(function (item) { return item.t === 'assistant' })
    assert.deepEqual(
      assistant.blocks.map(function (block) { return block.k }),
      ['reasoning', 'tool-call', 'text']
    )
    assert.equal(assistant.blocks[0].text, '思考过程：先查一下。')
    const tool = detail.conversation.items.find(function (item) { return item.t === 'tool-result' })
    assert.equal(tool.text, 'hi')
  })

  await step('hub receives the peer conversation', async function () {
    const row = await until('mac conversation on the hub', async function () {
      const body = await get(hubPort, '/conversations')
      return body.conversations.find(function (item) { return item.sessionId === 'session-mac-0001' })
    })
    assert.equal(row.machineId, 'mac-001')
    assert.equal(row.machineName, 'Mac')
    const detail = await get(hubPort, '/conversation?machine=mac-001&id=session-mac-0001')
    const assistant = detail.conversation.items.find(function (item) { return item.t === 'assistant' })
    assert.deepEqual(
      assistant.blocks.map(function (block) { return block.k }),
      ['reasoning', 'tool-call', 'text']
    )
  })

  await step('memory is visible from both sides', async function () {
    await until('mac memory on the hub', async function () {
      const body = await get(hubPort, '/memory')
      return body.shared.some(function (row) {
        return row.machineId === 'mac-001' && row.text.indexOf('MEMORY-MARKER-MAC-001') >= 0
      })
    })
    const onPeer = await get(peerPort, '/memory')
    const fromHub = onPeer.shared.find(function (row) { return row.machineId === 'win-pc' })
    assert.ok(fromHub, 'the peer should see the hub MEMORY.md')
    assert.ok(fromHub.text.indexOf('MEMORY-MARKER-WIN-PC') >= 0, 'hub memory content should be intact')
  })

  await step('plugin manifests travel both ways', async function () {
    await until('mac manifest on the hub', async function () {
      const body = await get(hubPort, '/plugins')
      return body.remote.some(function (row) { return row.machineId === 'mac-001' })
    })
    const onPeer = await get(peerPort, '/plugins')
    assert.ok(
      onPeer.remote.some(function (row) { return row.machineId === 'win-pc' }),
      'the peer should see the hub plugin list'
    )
  })

  await step('a file created on the hub is read from the peer', async function () {
    const hubs = await get(peerPort, '/roots?scope=remote')
    assert.equal(hubs.ok, true)
    const target = hubs.roots.find(function (row) { return row.label.indexOf('work') >= 0 })
    assert.ok(target, 'the hub should publish its work directory: ' + JSON.stringify(hubs.roots))
    const listing = await get(
      peerPort,
      '/files/list?scope=remote&root=' + encodeURIComponent(target.id) + '&path='
    )
    assert.ok(
      listing.entries.some(function (entry) { return entry.name === 'owned-by-win-pc.txt' }),
      'the peer should list the hub file: ' + JSON.stringify(listing.entries)
    )
    const read = await get(
      peerPort,
      '/files/read?scope=remote&root=' + encodeURIComponent(target.id) + '&path=owned-by-win-pc.txt'
    )
    assert.equal(read.content, 'hello')
  })

  await step('a file written from the peer lands on the hub disk', async function () {
    const hubs = await get(peerPort, '/roots?scope=remote')
    const target = hubs.roots.find(function (row) { return row.label.indexOf('work') >= 0 })
    const written = await post(peerPort, '/files/write', {
      scope: 'remote',
      root: target.id,
      path: 'from-mac.txt',
      content: 'written over the LAN'
    })
    assert.equal(written.ok, true)
    const onDisk = await fs.readFile(path.join(homes.hub, 'work', 'from-mac.txt'), 'utf8')
    assert.equal(onDisk, 'written over the LAN')
  })

  await step('a peer with the wrong token is refused by the hub', async function () {
    const response = await fetch('http://127.0.0.1:' + HUB_PORT + '/api/hello', {
      headers: { 'x-lan-token': 'wrong' }
    })
    assert.equal(response.status, 401)
  })
} catch (err) {
  /* reported per step */
} finally {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch (err) {
      /* ignore */
    }
  }
  await new Promise(function (r) { setTimeout(r, 500) })
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch (err) {
      /* ignore */
    }
  }
  if (process.env.LAN_TEST_KEEP) {
    console.log('\nhomes kept at ' + root)
  } else {
    await fs.rm(root, { recursive: true, force: true })
  }
  const failed = steps.filter(function (row) { return row.ok !== true }).length
  console.log('\n' + (steps.length - failed) + '/' + steps.length + ' steps passed')
  process.exit(failed === 0 ? 0 : 1)
}
