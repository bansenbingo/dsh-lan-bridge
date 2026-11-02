/**
 * Small HTTP helpers shared by the plugin's browser API and the LAN API.
 * Everything works with Buffers so binary transfer chunks and HMAC bodies do
 * not get re-encoded.
 */

export function sendJson(res, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store'
  }, extraHeaders || {}))
  res.end(body)
}

export function sendText(res, status, text, type) {
  const body = Buffer.from(String(text), 'utf8')
  res.writeHead(status, {
    'content-type': type || 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store'
  })
  res.end(body)
}

export function sendBuffer(res, status, buffer, type, extraHeaders) {
  res.writeHead(status, Object.assign({
    'content-type': type || 'application/octet-stream',
    'content-length': String(buffer.length),
    'cache-control': 'no-store'
  }, extraHeaders || {}))
  res.end(buffer)
}

export function fail(res, status, message, code) {
  sendJson(res, status, { ok: false, error: { code: code || 'ERROR', message: String(message || '') } })
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const limit = maxBytes || 32 * 1024 * 1024
    function done(err, value) {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('request body is too large')
        error.code = 'BODY_TOO_LARGE'
        done(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(null, Buffer.concat(chunks)))
    req.on('error', (err) => done(err))
    req.on('aborted', () => done(Object.assign(new Error('request aborted'), { code: 'ABORTED' })))
  })
}

export async function readJson(req, maxBytes) {
  const body = await readBody(req, maxBytes)
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch (err) {
    const error = new Error('request body is not valid JSON')
    error.code = 'BAD_JSON'
    throw error
  }
}

export function pathOf(url) {
  const raw = String(url || '/')
  const index = raw.indexOf('?')
  return index >= 0 ? raw.slice(0, index) : raw
}

export function queryOf(url) {
  const raw = String(url || '/')
  const index = raw.indexOf('?')
  if (index < 0) return {}
  const out = {}
  for (const [key, value] of new URLSearchParams(raw.slice(index + 1))) out[key] = value
  return out
}

export function statusOfError(err) {
  const explicit = Number(err && err.status)
  if (explicit) return explicit
  const code = err && err.code
  if (code === 'BODY_TOO_LARGE' || code === 'TOO_LARGE') return 413
  if (code === 'BAD_JSON' || code === 'BAD_PATH' || code === 'BAD_INDEX' || code === 'BAD_CHUNK' || code === 'BAD_HASH' || code === 'EMPTY_CONVERSATION' || code === 'NO_WORKSPACE' || code === 'NO_ROOT' || code === 'UNKNOWN_ROOT' || code === 'IS_DIR' || code === 'NOT_EMPTY') return 400
  if (code === 'DENIED' || code === 'EACCES' || code === 'EPERM') return 403
  if (code === 'NO_PEER' || code === 'NO_CONVERSATION' || code === 'NO_TRANSFER' || code === 'NO_MEMORY_FILE') return 404
  if (code === 'PEER_NOT_TRUSTED' || code === 'PEER_BLOCKED' || code === 'REMOTE_READ_OFF' || code === 'REMOTE_AI_OFF') return 403
  if (code === 'PEER_PENDING' || code === 'NOT_ACCEPTED' || code === 'REJECTED' || code === 'OUT_OF_ORDER' || code === 'CHUNK_CONFLICT' || code === 'INCOMPLETE') return 409
  if (code === 'ENOENT') return 404
  return 500
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return (req.socket && req.socket.remoteAddress) || ''
}

export function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type, x-dsh-node, x-dsh-time, x-dsh-nonce, x-dsh-sign, x-dsh-proto')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-max-age', '600')
}

export function isPreflight(req) {
  return req.method === 'OPTIONS'
}

/**
 * Exact-key router kept for the browser API table and tests. Handlers receive
 * (req, res, context) and may throw; known statuses are mapped below.
 */
export async function route(routes, method, path, req, res, context) {
  const handler = routes[method + ' ' + path]
  if (!handler) {
    fail(res, 404, 'no such endpoint', 'NOT_FOUND')
    return
  }
  try {
    await handler(req, res, context || {})
  } catch (err) {
    const status = statusOfError(err)
    return fail(res, status, (err && err.message) || 'internal error', (err && err.code) || 'INTERNAL')
  }
}

export function humanBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unit = -1
  do {
    size /= 1024
    unit++
  } while (size >= 1024 && unit < units.length - 1)
  return (size >= 10 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[unit]
}
