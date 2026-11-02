/**
 * HTTP transport for the LAN protocol.
 *
 * Inbound: authenticate every request with the shared space key, check the
 * peer table, then hand off to a registered route. Outbound: sign the request,
 * call a peer, and map transport failures to small stable error codes the UI
 * can show.
 *
 * The server is plain HTTP on the LAN. Confidentiality comes from the fact
 * that the payloads never leave the local network; membership and integrity
 * come from the HMAC. Large file bodies are chunked and hashed by the transfer
 * engine, not encrypted.
 */

import http from 'node:http'
import { applyCors, fail, isPreflight, pathOf, queryOf, readBody, sendJson, statusOfError } from './http.js'
import { headerSet, signRequest, verifyRequest } from './auth.js'
import { fingerprint as fingerprintOf } from './identity.js'

const DEFAULT_MAX_BYTES = 1024 * 1024

function jsonOf(body) {
  if (!body || !body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch (err) {
    const error = new Error('invalid JSON body')
    error.code = 'BAD_JSON'
    error.status = 400
    throw error
  }
}

function socketAddress(req) {
  const raw = String((req.socket && req.socket.remoteAddress) || '')
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

export function createTransport(options) {
  const getConfig = options.getConfig
  const getIdentity = options.getIdentity
  const getPeers = options.getPeers
  const routes = new Map()
  let server = null
  let started = false
  let lastError = ''

  function add(method, path, handler, opts) {
    routes.set(method.toUpperCase() + ' ' + path, Object.assign({ handler, maxBytes: DEFAULT_MAX_BYTES }, opts || {}))
  }

  async function handle(req, res) {
    applyCors(res)
    if (isPreflight(req)) {
      res.writeHead(204)
      res.end()
      return
    }
    const pathname = pathOf(req.url || '/')
    const route = routes.get(req.method + ' ' + pathname)
    if (!route) return fail(res, 404, 'not found', 'NOT_FOUND')

    let body = Buffer.alloc(0)
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req, route.maxBytes)
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') return fail(res, 413, 'body too large', 'BODY_TOO_LARGE')
      return fail(res, 400, 'could not read body', err && err.code)
    }

    const config = getConfig()
    let nodeId = ''
    let peer = null
    if (!route.public) {
      const verified = verifyRequest(req, body, config.networkKey)
      if (!verified.ok) return fail(res, verified.status || 401, 'authentication failed', verified.code || 'BAD_AUTH')
      nodeId = verified.nodeId
      const peers = getPeers()
      peer = await peers.get(nodeId)
      if (!peer) {
        const identity = getIdentity()
        let name = String(req.headers['x-dsh-name'] || nodeId)
        try {
          name = decodeURIComponent(name)
        } catch (err) {
          /* keep raw */
        }
        peer = await peers.observe({
          nodeId,
          name,
          fingerprint: String(req.headers['x-dsh-fingerprint'] || ''),
          address: String(req.headers['x-dsh-address'] || socketAddress(req) || ''),
          port: Number(req.headers['x-dsh-port'] || 0)
        })
      }
      if (peer && peer.trust === 'blocked') return fail(res, 403, 'peer is blocked', 'PEER_BLOCKED')
      if (peer && peer.trust === 'pending' && !route.allowPending) {
        return fail(res, 403, 'peer is waiting for approval', 'PEER_PENDING')
      }
      const claimedFingerprint = String(req.headers['x-dsh-fingerprint'] || '')
      if (peer && peer.fingerprint && claimedFingerprint && peer.fingerprint !== claimedFingerprint) {
        return fail(res, 401, 'peer identity changed', 'IDENTITY_MISMATCH')
      }
    }

    let json
    const context = {
      req,
      res,
      url: req.url || '/',
      path: pathname,
      query: queryOf(req.url || '/'),
      body,
      get json() {
        if (json === undefined) json = jsonOf(body)
        return json
      },
      nodeId,
      peer,
      identity: getIdentity()
    }

    try {
      await route.handler(context)
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
      const code = (err && err.code) || 'INTERNAL'
      if (status >= 500) lastError = String((err && err.message) || err)
      return fail(res, status, (err && err.message) || 'internal error', code)
    }
  }

  function start() {
    if (started) return Promise.resolve()
    const config = getConfig()
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        lastError = String((err && err.stack) || err)
        try {
          fail(res, 500, 'transport failure', 'TRANSPORT')
        } catch (closeError) {
          /* ignore */
        }
      })
    })
    server.on('clientError', (err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch (closeError) {
        /* ignore */
      }
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, '0.0.0.0', () => {
        started = true
        server.removeListener('error', reject)
        server.on('error', (err) => {
          lastError = String((err && err.message) || err)
        })
        resolve()
      })
    })
  }

  function stop() {
    if (!server) return Promise.resolve()
    const current = server
    server = null
    started = false
    return new Promise((resolve) => {
      current.close(() => resolve())
      if (typeof current.closeAllConnections === 'function') {
        try {
          current.closeAllConnections()
        } catch (err) {
          /* best effort */
        }
      }
      setTimeout(resolve, 1500).unref()
    })
  }

  async function requestBuffer(peer, method, pathname, requestOptions) {
    const opts = requestOptions || {}
    const config = getConfig()
    const identity = getIdentity()
    if (!peer || !peer.address) {
      const error = new Error('peer has no address')
      error.code = 'NO_ADDRESS'
      throw error
    }
    let body = Buffer.alloc(0)
    const headers = {}
    if (opts.json !== undefined) {
      body = Buffer.from(JSON.stringify(opts.json), 'utf8')
      headers['content-type'] = 'application/json; charset=utf-8'
    } else if (Buffer.isBuffer(opts.body)) {
      body = opts.body
      headers['content-type'] = opts.contentType || 'application/octet-stream'
    }
    const fingerprint = identity ? fingerprintOf(identity) : ''
    const signed = signRequest({
      method,
      path: pathname,
      nodeId: config.nodeId,
      fingerprint,
      networkKey: config.networkKey,
      body
    })
    Object.assign(headers, opts.headers || {})
    Object.assign(headers, headerSet(config.nodeId, signed))
    if (identity) {
      headers['x-dsh-name'] = encodeURIComponent(config.nodeName)
      headers['x-dsh-fingerprint'] = fingerprint
      headers['x-dsh-port'] = String(config.port)
    }
    headers['content-length'] = String(body.length)

    const url = 'http://' + peer.address + ':' + (peer.port || config.port) + pathname
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 20000)
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body.length ? body : undefined,
        signal: controller.signal
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      if (!response.ok) {
        let message = 'peer request failed'
        let code = 'HTTP_' + response.status
        try {
          const parsed = JSON.parse(buffer.toString('utf8'))
          message = (parsed.error && parsed.error.message) || message
          code = (parsed.error && parsed.error.code) || code
        } catch (err) {
          /* keep defaults */
        }
        const error = new Error(message)
        error.code = code
        error.status = response.status
        throw error
      }
      return buffer
    } catch (err) {
      if (controller.signal.aborted || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'))) {
        const error = new Error('peer timed out')
        error.code = 'TIMEOUT'
        throw error
      }
      if (err && (err.code === 'BAD_AUTH' || err.code === 'PEER_PENDING' || err.code === 'PEER_BLOCKED')) throw err
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' || err.code === 'ENOTFOUND')) {
        const error = new Error('peer is unreachable')
        error.code = 'UNREACHABLE'
        throw error
      }
      if (err && err.code && err.status) throw err
      const error = new Error((err && err.message) || 'peer request failed')
      error.code = 'UNREACHABLE'
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function request(peer, method, pathname, requestOptions) {
    const buffer = await requestBuffer(peer, method, pathname, requestOptions)
    if (!buffer.length) return null
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch (err) {
      const error = new Error('peer returned invalid JSON')
      error.code = 'BAD_RESPONSE'
      throw error
    }
  }

  function status() {
    return { listening: started, port: getConfig().port, error: lastError, routes: routes.size }
  }

  return { add, start, stop, request, requestBuffer, status, server: () => server, jsonOf }
}
