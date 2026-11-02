/**
 * Request authentication for the LAN protocol.
 *
 * Every request carries an HMAC-SHA256 over a canonical description of the
 * request, keyed with the shared space key. That proves membership without
 * sending the key on the wire, and it works with HTTP keep-alive, chunked
 * uploads, and raw binary downloads. A timestamp + nonce window stops replay;
 * the nonce cache is bounded and pruned on use.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const AUTH_HEADERS = {
  node: 'x-dsh-node',
  fingerprint: 'x-dsh-fingerprint',
  time: 'x-dsh-time',
  nonce: 'x-dsh-nonce',
  sign: 'x-dsh-sign',
  proto: 'x-dsh-proto'
}

const MAX_SKEW_MS = 5 * 60 * 1000
const NONCE_TTL_MS = 10 * 60 * 1000
const NONCE_LIMIT = 20000
const nonceCache = new Map()

function pruneNonces(now) {
  if (nonceCache.size < NONCE_LIMIT) return
  for (const [key, expiry] of nonceCache) {
    if (expiry <= now) nonceCache.delete(key)
  }
  if (nonceCache.size >= NONCE_LIMIT) {
    // Still full: drop the oldest quarter. Map preserves insertion order.
    const drop = Math.ceil(nonceCache.size / 4)
    let index = 0
    for (const key of nonceCache.keys()) {
      nonceCache.delete(key)
      if (++index >= drop) break
    }
  }
}

export function bodyDigest(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '')
  return createHash('sha256').update(buffer).digest('base64url')
}

export function canonical({ method, path, nodeId, fingerprint, time, nonce, body }) {
  return [
    'dsh-lan-v2',
    String(method || 'GET').toUpperCase(),
    String(path || '/'),
    String(nodeId || ''),
    String(fingerprint || ''),
    String(time || ''),
    String(nonce || ''),
    bodyDigest(body)
  ].join('\n')
}

export function signRequest({ method, path, nodeId, fingerprint, networkKey, body, time, nonce }) {
  const stamp = String(time || Date.now())
  const salt = nonce || randomBytes(12).toString('base64url')
  const mac = createHmac('sha256', networkKey)
    .update(canonical({ method, path, nodeId, fingerprint, time: stamp, nonce: salt, body }))
    .digest('base64url')
  return { time: stamp, nonce: salt, sign: mac }
}

export function verifyRequest(req, rawBody, networkKey, options) {
  const opts = options || {}
  if (!networkKey) return { ok: false, status: 503, code: 'NO_SPACE_KEY' }
  const nodeId = String(req.headers[AUTH_HEADERS.node] || '')
  const fingerprint = String(req.headers[AUTH_HEADERS.fingerprint] || '')
  const time = String(req.headers[AUTH_HEADERS.time] || '')
  const nonce = String(req.headers[AUTH_HEADERS.nonce] || '')
  const sign = String(req.headers[AUTH_HEADERS.sign] || '')
  if (!nodeId || !time || !nonce || !sign) return { ok: false, status: 401, code: 'NO_AUTH' }

  const stamp = Number(time)
  if (!Number.isFinite(stamp)) return { ok: false, status: 401, code: 'BAD_TIME' }
  const now = Date.now()
  if (Math.abs(now - stamp) > (opts.maxSkewMs || MAX_SKEW_MS)) {
    return { ok: false, status: 401, code: 'STALE_TIME' }
  }

  const expected = createHmac('sha256', networkKey)
    .update(canonical({ method: req.method, path: req.url || '/', nodeId, fingerprint, time, nonce, body: rawBody }))
    .digest()
  let actual
  try {
    actual = Buffer.from(sign, 'base64url')
  } catch (err) {
    return { ok: false, status: 401, code: 'BAD_SIGNATURE' }
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, status: 401, code: 'BAD_SIGNATURE' }
  }

  pruneNonces(now)
  const replayKey = nodeId + ':' + nonce
  if (nonceCache.has(replayKey)) return { ok: false, status: 401, code: 'REPLAY' }
  nonceCache.set(replayKey, now + NONCE_TTL_MS)
  return { ok: true, nodeId }
}

export function headerSet(nodeId, signed) {
  const out = {}
  out[AUTH_HEADERS.node] = nodeId
  out[AUTH_HEADERS.time] = signed.time
  out[AUTH_HEADERS.nonce] = signed.nonce
  out[AUTH_HEADERS.sign] = signed.sign
  out[AUTH_HEADERS.proto] = '2'
  return out
}
