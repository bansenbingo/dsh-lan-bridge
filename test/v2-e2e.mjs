import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lan-e2e-'))
const rootA = path.join(temp, 'root-a')
const rootB = path.join(temp, 'root-b')
await fs.mkdir(rootA, { recursive: true })
await fs.mkdir(rootB, { recursive: true })
await fs.writeFile(path.join(rootA, 'note.txt'), 'hello from A\n', 'utf8')

const A = {
  home: path.join(temp, 'home-a'),
  port: 48211,
  controlPort: 48201,
  root: rootA,
  autoAccept: false
}
const B = {
  home: path.join(temp, 'home-b'),
  port: 48212,
  controlPort: 48202,
  root: rootB,
  autoAccept: true
}

const children = []

function startNode(node) {
  const child = spawn(process.execPath, ['test/node-runner.mjs'], {
    cwd: process.cwd(),
    env: Object.assign({}, process.env, {
      RUN_HOME: node.home,
      RUN_PORT: String(node.port),
      RUN_CONTROL_PORT: String(node.controlPort),
      RUN_ROOT: node.root,
      RUN_AUTO_ACCEPT: node.autoAccept ? '1' : '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('node did not start in time')), 20000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((row) => row.startsWith('READY '))
      if (line) {
        clearTimeout(timer)
        resolve(JSON.parse(line.slice(6)))
      }
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error('node exited with ' + code))
    })
  })
}

async function request(node, method, url, body) {
  const response = await fetch('http://127.0.0.1:' + node.controlPort + '/_dsh/lan' + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (err) {
    json = { raw: text }
  }
  if (!response.ok) {
    throw new Error(method + ' ' + url + ' → ' + response.status + ' ' + text.slice(0, 300))
  }
  return json
}

async function waitTask(node, taskId) {
  for (let i = 0; i < 120; i += 1) {
    const row = await request(node, 'GET', '/task?id=' + encodeURIComponent(taskId))
    if (row.status === 'complete') return row.result
    if (row.status === 'failed') throw new Error(row.error || 'task failed')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('task timed out')
}

function assert(value, message) {
  if (!value) throw new Error('ASSERT: ' + message)
}

try {
  const readyA = await startNode(A)
  const readyB = await startNode(B)
  assert(readyA.nodeId === 'node-48211', 'A identity')
  assert(readyB.nodeId === 'node-48212', 'B identity')

  const invite = await request(A, 'GET', '/invite')
  assert(invite.code, 'invite generated')
  await request(B, 'POST', '/join', { code: invite.code })

  // Make both sides aware of each other even when discovery is off.
  const bootstrapA = await request(A, 'POST', '/peers/bootstrap', { address: '127.0.0.1:' + B.port })
  const bootstrapB = await request(B, 'POST', '/peers/bootstrap', { address: '127.0.0.1:' + A.port })
  if (bootstrapA.pingError || bootstrapB.pingError) {
    throw new Error('bootstrap ping failed: ' + (bootstrapA.pingError || bootstrapB.pingError))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))

  const peersA = await request(A, 'GET', '/peers')
  const peersB = await request(B, 'GET', '/peers')
  const peerB = peersA.peers.find((row) => row.nodeId === 'node-48212')
  const peerA = peersB.peers.find((row) => row.nodeId === 'node-48211')
  assert(peerB, 'A discovered B')
  assert(peerA, 'B discovered A')

  await request(A, 'POST', '/peers/trust', { nodeId: 'node-48212', trust: 'trusted' })
  await request(B, 'POST', '/peers/trust', { nodeId: 'node-48211', trust: 'trusted' })

  const syncA = await request(A, 'POST', '/sync', {})
  const syncB = await request(B, 'POST', '/sync', {})
  assert(syncA && syncA.ok, 'A sync')
  assert(syncB && syncB.ok, 'B sync')

  const roots = await request(B, 'GET', '/remote/workspaces?node=node-48211')
  assert(roots.roots && roots.roots.length === 1, 'B sees A roots')
  const rootId = roots.roots[0].id

  const list = await request(B, 'GET', '/remote/files/list?node=node-48211&root=' + encodeURIComponent(rootId) + '&path=')
  assert(list.entries.some((row) => row.name === 'note.txt'), 'B lists A file')

  const read = await request(B, 'GET', '/remote/files/read?node=node-48211&root=' + encodeURIComponent(rootId) + '&path=note.txt')
  assert(read.content === 'hello from A\n', 'B reads A file')

  const conversations = await request(B, 'GET', '/conversations?node=node-48211')
  assert(conversations.conversations.some((row) => row.title === 'E2E chat node-48211'), 'B lists A conversations')

  const remoteConversation = await request(B, 'GET', '/conversation?node=node-48211&session=e2e-node-48211')
  assert(remoteConversation.conversation.items.length === 2, 'B reads A transcript')

  const models = await request(B, 'GET', '/ai/models?node=node-48211')
  assert(models.models.some((row) => row.id === 'runner-model'), 'B lists A models')
  const answer = await request(B, 'POST', '/ai/ask', { node: 'node-48211', prompt: 'hello' })
  assert(answer.text === 'remote answer from node-48211', 'B borrows A model')
  const team = await request(B, 'POST', '/ai/team', { prompt: 'compare', nodes: ['node-48211'] })
  assert(team.results.length === 1 && team.results[0].text === 'remote answer from node-48211', 'B fan-outs to A')

  const forked = await request(B, 'POST', '/fork', { node: 'node-48211', session: 'e2e-node-48211' })
  assert(forked.sessionId && forked.title, 'B forks A conversation into a local session')

  const download = await request(B, 'POST', '/transfers/download', { node: 'node-48211', root: rootId, path: 'note.txt' })
  const downloaded = await waitTask(B, download.taskId)
  assert(downloaded.path && (await fs.readFile(downloaded.path, 'utf8')) === 'hello from A\n', 'download verifies content')

  const send = await request(A, 'POST', '/transfers/send', { node: 'node-48212', root: rootId, path: 'note.txt', mode: 'inbox' })
  const sent = await waitTask(A, send.taskId)
  assert(sent && sent.ok, 'send to B succeeds')
  const transfersB = await request(B, 'GET', '/transfers')
  const incoming = transfersB.incoming.find((row) => row.name === 'note.txt' && row.status === 'complete')
  assert(incoming && incoming.status === 'complete', 'B received the file')

  const rootsB = await request(A, 'GET', '/remote/workspaces?node=node-48212')
  const rootBId = rootsB.roots[0].id
  const workspaceSend = await request(A, 'POST', '/transfers/send', {
    node: 'node-48212',
    root: rootId,
    path: 'note.txt',
    mode: 'workspace',
    destRoot: rootBId
  })
  const workspaceSent = await waitTask(A, workspaceSend.taskId)
  assert(workspaceSent.ok, 'workspace send succeeds')
  assert((await fs.readFile(path.join(rootB, 'note.txt'), 'utf8')) === 'hello from A\n', 'receiver workspace contains the file')

  console.log('v2-e2e ok · sync ↓/', syncA.results.length, '↑', syncB.results.length, '· downloaded', downloaded.size, '· sent', sent.size)
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch (err) {
      /* ignore */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
}
