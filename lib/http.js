/**
 * dsh-lan-bridge — small HTTP toolkit.
 *
 * Two very different servers use these helpers: the LAN API (`0.0.0.0`, token
 * auth, machine to machine) and the DSH web route (`/_dsh/lan*`, same-origin,
 * browser facing). Both are plain `http.IncomingMessage`/`ServerResponse`, so
 * one set of body/Send helpers keeps behaviour identical.
 */

import { timingSafeEqual } from 'node:crypto'

const JSON_TYPE = 'application/json; charset=utf-8'

export function sendJson(res, status, body) {
  if (res.writableEnded) return
  let payload
  try {
    payload = JSON.stringify(body)
  } catch (err) {
    payload = JSON.stringify({ ok: false, error: { code: 'encode-failed', message: 'response is not serialisable' } })
    status = 500
  }
  res.statusCode = status
  res.setHeader('content-type', JSON_TYPE)
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

export function sendText(res, status, text, type) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', type || 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

export function fail(res, status, code, message, extra) {
  sendJson(res, status, Object.assign({ ok: false, error: { code, message } }, extra || {}))
}

/** Read a request body with a hard byte cap; oversized bodies are rejected. */
export async function readBody(req, limit) {
  const max = typeof limit === 'number' && limit > 0 ? limit : 1024 * 1024
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > max) {
      const error = new Error('request body exceeds ' + max + ' bytes')
      error.code = 'BODY_TOO_LARGE'
      // Drain so the socket is not left half-read.
      req.resume()
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req, limit) {
  const buffer = await readBody(req, limit)
  if (buffer.length === 0) return {}
  const text = buffer.toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    const error = new Error('body is not valid JSON')
    error.code = 'BAD_JSON'
    throw error
  }
}

/** Path portion of the request URL, without query string. */
export function pathOf(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname
  } catch (err) {
    return ''
  }
}

/** Parsed query string as a plain object (first value wins). */
export function queryOf(req) {
  const out = {}
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    for (const [key, value] of url.searchParams) {
      if (!(key in out)) out[key] = value
    }
  } catch (err) {
    /* empty */
  }
  return out
}

/** Constant-time comparison that tolerates differing lengths. */
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    // Still burn a comparison so the timing does not leak length alone.
    try {
      timingSafeEqual(left, left)
    } catch (err) {
      /* ignore */
    }
    return false
  }
  try {
    return timingSafeEqual(left, right)
  } catch (err) {
    return false
  }
}

/** Token from either the `x-lan-token` header or a Bearer authorization. */
export function tokenOf(req) {
  const direct = req.headers['x-lan-token']
  if (typeof direct === 'string' && direct) return direct
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  return ''
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  const socket = req.socket || {}
  return socket.remoteAddress || ''
}

/** Same-origin browser calls only; the LAN server allows its own token instead. */
export function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type,x-lan-token,authorization')
  res.setHeader('access-control-max-age', '600')
}

export function isPreflight(req) {
  return (req.method || 'GET').toUpperCase() === 'OPTIONS'
}

/**
 * Minimal exact-path router. Returns `true` when a route handled the request.
 * Handlers receive `(req, res, params)` and are responsible for their own body.
 */
export function route(routes, method, path, req, res) {
  const key = method.toUpperCase() + ' ' + path
  const handler = routes[key]
  if (!handler) return false
  Promise.resolve()
    .then(function () {
      return handler(req, res)
    })
    .catch(function (err) {
      if (res.writableEnded) return
      const code = err && err.code === 'BODY_TOO_LARGE' ? 'body-too-large' : 'handler-error'
      const status = err && err.code === 'BODY_TOO_LARGE' ? 413 : err && err.code === 'BAD_JSON' ? 400 : 500
      sendJson(res, status, {
        ok: false,
        error: { code, message: String((err && err.message) || err) }
      })
    })
  return true
}

/** Human-readable byte size for diagnostics. */
export function humanBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB']
  let n = typeof value === 'number' ? value : 0
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n = n / 1024
    unit += 1
  }
  return (unit === 0 ? String(Math.trunc(n)) : n.toFixed(1)) + units[unit]
}
