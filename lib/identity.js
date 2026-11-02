/**
 * Node identity for dsh-lan-bridge v2.
 *
 * The node id is the durable name used by the store and the peer table. The
 * Ed25519 key pair is a second, independent identity: it survives config
 * resets and lets another node pin this machine's public key instead of
 * trusting a mutable host name. Requests themselves are authenticated with the
 * shared space key (lib/auth.js); the key pair is what "trust this device"
 * pins.
 */

import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { base64url, identityFile } from './config.js'

const IDENTITY_VERSION = 2

let cached = null

function newIdentity(nodeId) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' })
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' })
  return {
    version: IDENTITY_VERSION,
    nodeId: nodeId || randomUUID(),
    publicKey: base64url(pub),
    privateKey: base64url(priv),
    createdAt: new Date().toISOString()
  }
}

function normalize(raw, fallbackNodeId) {
  if (!raw || typeof raw !== 'object' || !raw.publicKey || !raw.privateKey) return null
  return {
    version: IDENTITY_VERSION,
    nodeId: typeof raw.nodeId === 'string' && raw.nodeId ? raw.nodeId : fallbackNodeId || randomUUID(),
    publicKey: String(raw.publicKey),
    privateKey: String(raw.privateKey),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString()
  }
}

export async function ensure(nodeId) {
  if (cached) {
    if (nodeId && cached.nodeId !== nodeId) cached.nodeId = nodeId
    return cached
  }
  const file = identityFile()
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    cached = normalize(raw, nodeId)
    if (cached) {
      await fs.chmod(file, 0o600).catch(() => {})
      return cached
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      try {
        await fs.rename(file, file + '.corrupt-' + Date.now())
      } catch (renameError) {
        /* best effort */
      }
    }
  }
  cached = newIdentity(nodeId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(cached, null, 2) + '\n', 'utf8')
  await fs.chmod(file, 0o600).catch(() => {})
  return cached
}

export function fingerprint(identity) {
  const source = identity && identity.publicKey ? identity.publicKey : ''
  return createHash('sha256').update(source).digest('hex').slice(0, 32)
}

export function publicIdentity(identity) {
  return {
    nodeId: identity.nodeId,
    fingerprint: fingerprint(identity),
    publicKey: identity.publicKey,
    createdAt: identity.createdAt
  }
}

/** A compact, shareable invite that carries the group key and one seed peer. */
export function createInvite(config, identity, extra) {
  const payload = {
    v: 2,
    s: config.spaceId,
    k: config.networkKey,
    n: config.nodeName,
    h: (extra && extra.host) || '',
    p: (extra && extra.port) || config.port,
    f: fingerprint(identity)
  }
  return base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
}

export function parseInvite(text) {
  if (typeof text !== 'string') return null
  let body = text.trim()
  if (!body) return null
  if (body.startsWith('dshlan://')) body = body.slice('dshlan://'.length)
  if (body.startsWith('invite/')) body = body.slice('invite/'.length)
  // Tolerate pasted whitespace/newlines.
  body = body.replace(/\s+/g, '')
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!raw || raw.v !== 2 || typeof raw.k !== 'string' || !raw.k) return null
    return {
      networkKey: raw.k,
      spaceId: typeof raw.s === 'string' ? raw.s : '',
      nodeName: typeof raw.n === 'string' ? raw.n : '',
      host: typeof raw.h === 'string' ? raw.h : '',
      port: Number.isFinite(raw.p) ? raw.p : 0,
      fingerprint: typeof raw.f === 'string' ? raw.f : ''
    }
  } catch (err) {
    return null
  }
}
