/**
 * AirDrop-style file transfer.
 *
 * Push: the sender offers `{name,size,sha256}`; the receiver either accepts
 * automatically, or the offer sits in the incoming tray until a person clicks
 * accept. Chunks are sequential, each with its own SHA-256, and the assembled
 * file is verified against the offer hash before it is moved into the inbox or
 * a shared workspace.
 *
 * Pull: the local node asks a peer to export one file, then downloads the same
 * chunks itself. That keeps the transport one-directional (only the initiator
 * dials), which is what works on a LAN with host firewalls.
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { inboxDir, tmpDir } from './config.js'
import * as files from './files.js'

const MAX_OFFER_AGE_MS = 10 * 60 * 1000

function safeName(name) {
  const base = path.basename(String(name || 'file'))
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned || 'file'
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function readChunk(file, index, chunkBytes) {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes)
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, index * chunkBytes)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function chunkHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function concatChunks(dir, count, target) {
  const handle = await fs.open(target, 'w')
  try {
    for (let index = 0; index < count; index += 1) {
      const part = await fs.readFile(path.join(dir, String(index) + '.part'))
      await handle.write(part)
    }
  } finally {
    await handle.close()
  }
}

export function createTransfer(options) {
  const getConfig = options.getConfig
  const getPeers = options.getPeers
  const transport = options.transport
  const workspaces = options.workspaces
  const onEvent = options.onEvent || function () {}

  const incoming = new Map()
  const outgoing = new Map()
  const exports = new Map()
  let counter = 0

  function transferDir(id) {
    return path.join(tmpDir(), 'transfers', id)
  }

  function publicIncoming(row) {
    return {
      id: row.id,
      kind: 'incoming',
      name: row.name,
      size: row.size,
      bytes: row.received,
      chunkBytes: row.chunkBytes,
      chunks: row.chunks,
      receivedChunks: row.receivedChunks,
      sha256: row.sha256,
      status: row.status,
      mode: row.mode,
      destRoot: row.destRoot,
      destPath: row.destPath,
      from: row.from,
      createdAt: row.createdAt,
      error: row.error || '',
      path: row.savedPath || ''
    }
  }

  function publicOutgoing(row) {
    return {
      id: row.id,
      kind: 'outgoing',
      name: row.name,
      size: row.size,
      bytes: row.sent,
      status: row.status,
      peer: row.peer,
      createdAt: row.createdAt,
      error: row.error || ''
    }
  }

  function emit() {
    onEvent('transfers', {
      incoming: Array.from(incoming.values()).map(publicIncoming),
      outgoing: Array.from(outgoing.values()).map(publicOutgoing),
      exports: exports.size
    })
  }

  function prune() {
    const now = Date.now()
    for (const [id, row] of incoming) {
      if (now - Date.parse(row.createdAt) > MAX_OFFER_AGE_MS && (row.status === 'pending' || row.status === 'rejected')) {
        incoming.delete(id)
        fs.rm(transferDir(id), { recursive: true, force: true }).catch(() => {})
      }
    }
    if (incoming.size > 100) {
      const rows = Array.from(incoming.values()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      for (const row of rows.slice(0, incoming.size - 100)) incoming.delete(row.id)
    }
  }

  // ---------------------------------------------------------------- incoming

  function offer(context) {
    const config = getConfig()
    const body = context.json
    const id = String(body.id || randomUUID())
    const size = Number(body.size)
    const sha256 = String(body.sha256 || '').toLowerCase()
    if (!Number.isFinite(size) || size < 0 || size > config.maxTransferBytes) {
      const error = new Error('file exceeds the transfer limit')
      error.status = 413
      error.code = 'TOO_LARGE'
      throw error
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      const error = new Error('offer needs a SHA-256')
      error.status = 400
      error.code = 'BAD_HASH'
      throw error
    }
    const chunkBytes = Math.min(
      Math.max(Number(body.chunkBytes) || config.transferChunkBytes, 256 * 1024),
      16 * 1024 * 1024
    )
    const row = {
      id,
      name: safeName(body.name),
      size,
      sha256,
      chunkBytes,
      chunks: Math.max(1, Math.ceil(size / chunkBytes)),
      receivedChunks: 0,
      received: 0,
      mode: body.mode === 'workspace' ? 'workspace' : 'inbox',
      destRoot: typeof body.destRoot === 'string' ? body.destRoot : '',
      destPath: typeof body.destPath === 'string' ? body.destPath : '',
      status: 'pending',
      from: context.nodeId || '',
      createdAt: new Date().toISOString(),
      error: ''
    }
    incoming.set(id, row)
    prune()
    if (config.autoAcceptTransfers) {
      row.status = 'accepted'
    }
    emit()
    return {
      ok: true,
      id,
      status: row.status,
      needApproval: row.status === 'pending',
      chunkBytes: row.chunkBytes,
      chunks: row.chunks
    }
  }

  async function approve(id, payload) {
    const row = incoming.get(id)
    if (!row) {
      const error = new Error('unknown transfer')
      error.status = 404
      error.code = 'NO_TRANSFER'
      throw error
    }
    const body = payload || {}
    if (body.mode === 'workspace') {
      const root = workspaces.resolve(body.destRoot)
      if (!root) {
        const error = new Error('unknown destination workspace')
        error.status = 400
        error.code = 'NO_ROOT'
        throw error
      }
      await files.resolveWithin(root, String(body.destPath || ''), true)
      row.mode = 'workspace'
      row.destRoot = root.id
      row.destPath = String(body.destPath || '')
    } else if (body.mode === 'inbox') {
      row.mode = 'inbox'
      row.destRoot = ''
      row.destPath = ''
    } else if (row.mode === 'workspace') {
      // The sender already chose one of *this* node's roots via
      // /remote/workspaces; keep that choice when the receiver accepts.
      const root = workspaces.resolve(row.destRoot)
      if (!root) {
        const error = new Error('destination workspace is gone')
        error.status = 400
        error.code = 'NO_ROOT'
        throw error
      }
      await files.resolveWithin(root, String(row.destPath || ''), true)
    }
    row.status = 'accepted'
    row.error = ''
    emit()
    return publicIncoming(row)
  }

  function reject(id) {
    const row = incoming.get(id)
    if (!row) return null
    row.status = 'rejected'
    emit()
    return publicIncoming(row)
  }

  async function receiveChunk(context) {
    const id = String(context.query.id || '')
    const index = Number(context.query.index)
    const row = incoming.get(id)
    if (!row) {
      const error = new Error('unknown transfer')
      error.status = 404
      error.code = 'NO_TRANSFER'
      throw error
    }
    if (row.status === 'rejected') {
      const error = new Error('transfer was rejected')
      error.status = 409
      error.code = 'REJECTED'
      throw error
    }
    if (row.status === 'complete') return { ok: true, complete: true, received: row.received }
    if (row.status !== 'accepted' && row.status !== 'receiving') {
      const error = new Error('transfer is not accepted yet')
      error.status = 409
      error.code = 'NOT_ACCEPTED'
      throw error
    }
    if (!Number.isInteger(index) || index < 0 || index >= row.chunks) {
      const error = new Error('bad chunk index')
      error.status = 400
      error.code = 'BAD_INDEX'
      throw error
    }
    if (context.body.length > row.chunkBytes) {
      const error = new Error('chunk is larger than negotiated')
      error.status = 413
      error.code = 'BAD_CHUNK'
      throw error
    }
    const expected = String(context.req.headers['x-dsh-chunk-sha256'] || '')
    const actual = chunkHash(context.body)
    if (!expected || expected !== actual) {
      const error = new Error('chunk hash mismatch')
      error.status = 400
      error.code = 'BAD_CHUNK_HASH'
      throw error
    }
    if (index === row.receivedChunks) {
      const dir = transferDir(id)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, String(index) + '.part'), context.body)
      row.receivedChunks += 1
      row.received += context.body.length
      row.status = 'receiving'
      if (row.receivedChunks === row.chunks) row.status = 'assembling'
      emit()
    } else if (index < row.receivedChunks) {
      const existing = await fs.readFile(path.join(transferDir(id), String(index) + '.part'))
      if (chunkHash(existing) !== actual) {
        const error = new Error('chunk was already sent with different content')
        error.status = 409
        error.code = 'CHUNK_CONFLICT'
        throw error
      }
    } else {
      const error = new Error('chunks must arrive in order')
      error.status = 409
      error.code = 'OUT_OF_ORDER'
      throw error
    }
    return { ok: true, received: row.received, receivedChunks: row.receivedChunks }
  }

  async function complete(context) {
    const id = String(context.query.id || (context.json && context.json.id) || '')
    const row = incoming.get(id)
    if (!row) {
      const error = new Error('unknown transfer')
      error.status = 404
      error.code = 'NO_TRANSFER'
      throw error
    }
    if (row.status === 'complete') return { ok: true, path: row.savedPath, size: row.size }
    if (row.receivedChunks !== row.chunks) {
      const error = new Error('transfer is incomplete')
      error.status = 409
      error.code = 'INCOMPLETE'
      throw error
    }
    const dir = transferDir(id)
    const assembled = path.join(dir, 'assembled.bin')
    try {
      await concatChunks(dir, row.chunks, assembled)
      const stat = await fs.stat(assembled)
      if (stat.size !== row.size) throw Object.assign(new Error('size mismatch'), { code: 'SIZE_MISMATCH' })
      const digest = await hashFile(assembled)
      if (digest !== row.sha256) throw Object.assign(new Error('hash mismatch'), { code: 'HASH_MISMATCH' })
      let saved
      if (row.mode === 'workspace') {
        const root = workspaces.resolve(row.destRoot)
        if (!root) throw Object.assign(new Error('destination workspace is gone'), { code: 'NO_ROOT' })
        const relative = row.destPath ? row.destPath.replace(/\/+$/, '') + '/' + row.name : row.name
        saved = await files.importFile(root, relative, assembled)
        row.savedPath = saved.path
      } else {
        const targetDir = path.join(inboxDir(), id)
        await fs.mkdir(targetDir, { recursive: true })
        const target = path.join(targetDir, row.name)
        await fs.copyFile(assembled, target)
        row.savedPath = target
      }
      row.status = 'complete'
      row.received = row.size
      row.error = ''
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      emit()
      return { ok: true, path: row.savedPath, size: row.size }
    } catch (err) {
      row.status = 'failed'
      row.error = String((err && err.message) || err)
      emit()
      throw err
    }
  }

  function listIncoming() {
    return Array.from(incoming.values()).map(publicIncoming).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  // ---------------------------------------------------------------- outgoing

  async function offerTo(peer, record) {
    return transport.request(peer, 'POST', '/api/v2/transfer/offer', {
      json: {
        id: record.id,
        name: record.name,
        size: record.size,
        sha256: record.sha256,
        mode: record.mode,
        destRoot: record.destRoot,
        destPath: record.destPath,
        chunkBytes: record.chunkBytes
      },
      timeoutMs: 20000
    })
  }

  async function waitForAccept(peer, id, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 120000)
    while (Date.now() < deadline) {
      const status = await transport.request(peer, 'GET', '/api/v2/transfer/status?id=' + encodeURIComponent(id))
      if (status && (status.status === 'accepted' || status.status === 'receiving' || status.status === 'complete')) return status
      if (status && (status.status === 'rejected' || status.status === 'failed')) {
        const error = new Error(status.error || 'transfer rejected')
        error.code = 'TRANSFER_REJECTED'
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    const error = new Error('the receiving side did not answer in time')
    error.code = 'TRANSFER_TIMEOUT'
    throw error
  }

  async function sendFile(peer, input) {
    const config = getConfig()
    if (!peer || peer.trust !== 'trusted') {
      const error = new Error('only trusted peers can receive files')
      error.code = 'PEER_NOT_TRUSTED'
      throw error
    }
    const root = workspaces.resolve(input.root)
    if (!root) {
      const error = new Error('unknown source workspace')
      error.code = 'NO_ROOT'
      throw error
    }
    const resolved = await files.resolveWithin(root, input.relative, false)
    const info = await fs.stat(resolved.absolute)
    if (info.isDirectory()) {
      const error = new Error('only files can be sent')
      error.code = 'IS_DIR'
      throw error
    }
    if (info.size > config.maxTransferBytes) {
      const error = new Error('file exceeds the transfer limit')
      error.code = 'TOO_LARGE'
      throw error
    }
    const record = {
      id: randomUUID(),
      name: safeName(input.name || path.basename(resolved.absolute)),
      size: info.size,
      sha256: await hashFile(resolved.absolute),
      file: resolved.absolute,
      mode: input.mode === 'workspace' ? 'workspace' : 'inbox',
      destRoot: input.destRoot || '',
      destPath: input.destPath || '',
      chunkBytes: Math.min(config.transferChunkBytes, 16 * 1024 * 1024),
      peer: peer.nodeId,
      status: 'offering',
      sent: 0,
      createdAt: new Date().toISOString(),
      error: ''
    }
    outgoing.set(record.id, record)
    for (const [key, row] of outgoing) {
      if (row.status === 'complete' && Date.now() - Date.parse(row.createdAt) > 60 * 60 * 1000) outgoing.delete(key)
    }
    emit()
    const offer = await offerTo(peer, record)
    if (offer && offer.needApproval) {
      record.status = 'waiting'
      emit()
      await waitForAccept(peer, record.id)
    }
    record.status = 'sending'
    emit()
    const status = await transport.request(peer, 'GET', '/api/v2/transfer/status?id=' + encodeURIComponent(record.id))
    const start = Number(status && status.receivedChunks) || 0
    record.chunks = Math.max(1, Math.ceil(record.size / record.chunkBytes))
    for (let index = start; index < record.chunks; index += 1) {
      const buffer = await readChunk(record.file, index, record.chunkBytes)
      await transport.request(peer, 'POST', '/api/v2/transfer/chunk?id=' + encodeURIComponent(record.id) + '&index=' + index, {
        body: buffer,
        contentType: 'application/octet-stream',
        timeoutMs: 60000,
        headers: { 'x-dsh-chunk-sha256': chunkHash(buffer) }
      })
      record.sent += buffer.length
      emit()
    }
    const done = await transport.request(peer, 'POST', '/api/v2/transfer/complete?id=' + encodeURIComponent(record.id), {
      json: {},
      timeoutMs: 60000
    })
    record.status = 'complete'
    record.sent = record.size
    emit()
    return done
  }

  // ------------------------------------------------------------------ export

  async function exportFile(context) {
    const config = getConfig()
    const body = context.json
    const root = workspaces.resolve(body.root)
    if (!root) {
      const error = new Error('unknown root')
      error.status = 400
      error.code = 'NO_ROOT'
      throw error
    }
    const resolved = await files.resolveWithin(root, String(body.path || ''), false)
    const info = await fs.stat(resolved.absolute)
    if (info.isDirectory()) {
      const error = new Error('path is a directory')
      error.status = 400
      error.code = 'IS_DIR'
      throw error
    }
    if (info.size > config.maxTransferBytes) {
      const error = new Error('file exceeds the transfer limit')
      error.status = 413
      error.code = 'TOO_LARGE'
      throw error
    }
    const record = {
      id: randomUUID(),
      file: resolved.absolute,
      name: safeName(path.basename(resolved.absolute)),
      size: info.size,
      sha256: await hashFile(resolved.absolute),
      chunkBytes: config.transferChunkBytes,
      createdAt: Date.now()
    }
    exports.set(record.id, record)
    for (const [key, row] of exports) {
      if (Date.now() - row.createdAt > MAX_OFFER_AGE_MS) exports.delete(key)
    }
    return {
      ok: true,
      id: record.id,
      name: record.name,
      size: record.size,
      sha256: record.sha256,
      chunkBytes: record.chunkBytes,
      chunks: Math.max(1, Math.ceil(record.size / record.chunkBytes))
    }
  }

  async function exportChunk(context) {
    const id = String(context.query.id || '')
    const index = Number(context.query.index)
    const record = exports.get(id)
    if (!record) {
      const error = new Error('unknown export')
      error.status = 404
      error.code = 'NO_EXPORT'
      throw error
    }
    if (!Number.isInteger(index) || index < 0) {
      const error = new Error('bad chunk index')
      error.status = 400
      error.code = 'BAD_INDEX'
      throw error
    }
    const buffer = await readChunk(record.file, index, record.chunkBytes)
    context.res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(buffer.length),
      'x-dsh-chunk-sha256': chunkHash(buffer),
      'cache-control': 'no-store'
    })
    context.res.end(buffer)
  }

  function closeExport(context) {
    const id = String((context.json && context.json.id) || context.query.id || '')
    exports.delete(id)
    return { ok: true }
  }

  async function downloadFile(peer, input) {
    if (!peer || peer.trust !== 'trusted') {
      const error = new Error('only trusted peers can be downloaded from')
      error.code = 'PEER_NOT_TRUSTED'
      throw error
    }
    const meta = await transport.request(peer, 'POST', '/api/v2/transfer/export', {
      json: { root: input.root, path: input.relative },
      timeoutMs: 30000
    })
    if (!meta || !meta.id) throw new Error('peer did not start the export')
    const dir = transferDir(meta.id)
    await fs.mkdir(dir, { recursive: true })
    const record = {
      id: meta.id,
      name: safeName(meta.name),
      size: meta.size,
      sha256: meta.sha256,
      chunkBytes: meta.chunkBytes,
      chunks: meta.chunks,
      peer: peer.nodeId,
      status: 'downloading',
      sent: 0,
      createdAt: new Date().toISOString(),
      error: ''
    }
    outgoing.set(record.id, record)
    emit()
    try {
      for (let index = 0; index < meta.chunks; index += 1) {
        const buffer = await transport.requestBuffer(
          peer,
          'GET',
          '/api/v2/transfer/export/chunk?id=' + encodeURIComponent(meta.id) + '&index=' + index,
          { timeoutMs: 60000 }
        )
        await fs.writeFile(path.join(dir, String(index) + '.part'), buffer)
        record.sent += buffer.length
        emit()
      }
      const assembled = path.join(dir, 'assembled.bin')
      await concatChunks(dir, meta.chunks, assembled)
      const stat = await fs.stat(assembled)
      if (stat.size !== meta.size) throw Object.assign(new Error('size mismatch'), { code: 'SIZE_MISMATCH' })
      if ((await hashFile(assembled)) !== meta.sha256) throw Object.assign(new Error('hash mismatch'), { code: 'HASH_MISMATCH' })
      const targetDir = path.join(inboxDir(), 'download-' + meta.id)
      await fs.mkdir(targetDir, { recursive: true })
      const target = path.join(targetDir, record.name)
      await fs.copyFile(assembled, target)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      record.status = 'complete'
      record.savedPath = target
      emit()
      await transport.request(peer, 'POST', '/api/v2/transfer/export/close', {
        json: { id: meta.id },
        timeoutMs: 10000
      }).catch(() => {})
      return { ok: true, path: target, size: meta.size }
    } catch (err) {
      record.status = 'failed'
      record.error = String((err && err.message) || err)
      emit()
      await transport.request(peer, 'POST', '/api/v2/transfer/export/close', {
        json: { id: meta.id },
        timeoutMs: 10000
      }).catch(() => {})
      throw err
    }
  }

  function statusOf(id) {
    const row = incoming.get(String(id))
    if (!row) return null
    return publicIncoming(row)
  }

  function listOutgoing() {
    return Array.from(outgoing.values()).map(publicOutgoing).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  return {
    offer,
    approve,
    reject,
    receiveChunk,
    complete,
    listIncoming,
    statusOf,
    sendFile,
    downloadFile,
    exportFile,
    exportChunk,
    closeExport,
    listOutgoing
  }
}
