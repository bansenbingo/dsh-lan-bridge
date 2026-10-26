/**
 * dsh-lan-bridge — the LAN transport.
 *
 * Two halves live here:
 *
 *   `startServer`  the hub's API, bound to 0.0.0.0 so the other machine can
 *                  reach it. Every route needs the shared token; there is no
 *                  anonymous endpoint.
 *   `createPeer`   the thin client a peer uses to talk to a hub.
 *
 * UDP discovery is best-effort sugar on top: a peer shouts, a hub answers with
 * its name and port. Pairing by hand always works even when the broadcast is
 * blocked by the access point or the host firewall.
 */

import http from 'node:http'
import os from 'node:os'
import dgram from 'node:dgram'
import { randomUUID } from 'node:crypto'
import {
  applyCors,
  clientIp,
  fail,
  isPreflight,
  pathOf,
  queryOf,
  readJson,
  route,
  sendJson,
  tokenEquals,
  tokenOf
} from './http.js'

export const API_PREFIX = '/api'
const MAX_POST = 32 * 1024 * 1024
const DISCOVERY_QUERY = 'DSH-LAN-BRIDGE?'
const DISCOVERY_ANSWER = 'DSH-LAN-BRIDGE!'

/** Every non-loopback IPv4 address, so the UI can show the pairing URL. */
export function localAddresses() {
  const out = []
  try {
    const interfaces = os.networkInterfaces()
    for (const [name, rows] of Object.entries(interfaces)) {
      for (const row of rows || []) {
        if (row.family !== 'IPv4' || row.internal) continue
        out.push({ name, address: row.address, netmask: row.netmask })
      }
    }
  } catch (err) {
    /* empty */
  }
  return out
}

/**
 * Directed broadcast address for every routable IPv4 interface, plus the
 * limited broadcast as a last resort.
 *
 * A multi-homed Windows box (Hyper-V, VMware, Tailscale, Bluetooth) sends
 * `255.255.255.255` out of whichever interface owns the default route, which is
 * usually *not* the LAN one. Sending to `192.168.10.255` instead hits the
 * on-link route for that subnet, so the datagram leaves the right NIC.
 *
 * @returns {string[]} deduplicated broadcast targets
 */
export function broadcastTargets() {
  const out = []
  function add(address) {
    if (!address) return
    if (out.indexOf(address) === -1) out.push(address)
  }
  for (const row of localAddresses()) {
    const mask = String(row.netmask || '').split('.').map(Number)
    const ip = String(row.address || '').split('.').map(Number)
    if (mask.length !== 4 || ip.length !== 4) continue
    if (mask.some(function (part) { return !Number.isFinite(part) })) continue
    const parts = ip.map(function (part, index) {
      return (part | (~mask[index] & 255)) & 255
    })
    add(parts.join('.'))
  }
  add('255.255.255.255')
  return out
}

/**
 * @param {object} config  resolved plugin config
 * @param {object} mesh    { store, files, plugins, identity } — the hub handler
 * @returns {Promise<{server, port, close}>}
 */
export function startServer(config, mesh) {
  const server = http.createServer(function (req, res) {
    const method = (req.method || 'GET').toUpperCase()
    const path = pathOf(req)
    if (isPreflight(req)) {
      applyCors(res)
      res.statusCode = 204
      res.end()
      return
    }
    applyCors(res)

    // Authentication first: no route is public, and a wrong token must not
    // reveal whether a path exists.
    if (!tokenEquals(config.token, tokenOf(req))) {
      fail(res, 401, 'unauthorized', 'missing or wrong LAN token')
      return
    }

    const handled = routes(mesh)(method, path, req, res)
    if (!handled) fail(res, 404, 'not-found', 'unknown endpoint ' + path)
  })

  return new Promise(function (resolve, reject) {
    server.once('error', reject)
    server.listen(config.port, '0.0.0.0', function () {
      server.removeListener('error', reject)
      resolve({
        server,
        port: config.port,
        close: function () {
          return new Promise(function (done) {
            server.close(function () {
              done()
            })
          })
        }
      })
    })
  })
}

function routes(mesh) {
  const table = {}

  table['GET ' + API_PREFIX + '/hello'] = async function (req, res) {
    const stats = await mesh.store.stats()
    sendJson(res, 200, {
      ok: true,
      product: 'dsh-lan-bridge',
      schema: 1,
      identity: mesh.identity,
      rev: stats.rev,
      stats,
      port: mesh.port,
      protocol: 'http',
      addresses: localAddresses().map(function (row) {
        return row.address
      })
    })
  }

  table['GET ' + API_PREFIX + '/pull'] = async function (req, res) {
    const query = queryOf(req)
    const since = Number.parseInt(query.since || '0', 10)
    const payload = await mesh.store.changesSince(Number.isFinite(since) ? since : 0)
    await mesh.store.audit({
      kind: 'pull',
      from: clientIp(req),
      since: payload.since,
      rev: payload.rev,
      conversations: payload.conversations.length
    })
    sendJson(res, 200, Object.assign({ ok: true }, payload))
  }

  table['POST ' + API_PREFIX + '/push'] = async function (req, res) {
    const body = await readJson(req, MAX_POST)
    const result = await mesh.ingest(body, { from: clientIp(req), direction: 'push' })
    sendJson(res, 200, result)
  }

  table['GET ' + API_PREFIX + '/roots'] = async function (req, res) {
    sendJson(res, 200, {
      ok: true,
      roots: mesh.files.getRoots().map(function (root) {
        return { id: root.id, label: root.label, kind: root.kind }
      })
    })
  }

  table['GET ' + API_PREFIX + '/files/list'] = async function (req, res) {
    const query = queryOf(req)
    const root = mesh.files.findRoot(query.root)
    if (!root) {
      fail(res, 404, 'unknown-root', 'root "' + String(query.root) + '" is not shared here')
      return
    }
    const listing = await mesh.files.listDir(root, query.path || '')
    sendJson(res, 200, Object.assign({ ok: true }, listing))
  }

  table['GET ' + API_PREFIX + '/files/read'] = async function (req, res) {
    const query = queryOf(req)
    const root = mesh.files.findRoot(query.root)
    if (!root) {
      fail(res, 404, 'unknown-root', 'root "' + String(query.root) + '" is not shared here')
      return
    }
    const body = await mesh.files.readFile(root, query.path || '', mesh.maxFileBytes)
    sendJson(res, 200, Object.assign({ ok: true }, body))
  }

  table['POST ' + API_PREFIX + '/files/write'] = async function (req, res) {
    const body = await readJson(req, MAX_POST)
    const root = mesh.files.findRoot(body.root)
    if (!root) {
      fail(res, 404, 'unknown-root', 'root "' + String(body.root) + '" is not shared here')
      return
    }
    const written = await mesh.files.writeFile(root, body.path || '', body.content, { backup: body.backup === true })
    await mesh.store.audit({
      kind: 'write',
      from: clientIp(req),
      root: root.id,
      path: written.path,
      bytes: written.bytes
    })
    sendJson(res, 200, {
      ok: true,
      path: written.path,
      size: written.size,
      mtime: written.mtime,
      bytes: written.bytes
    })
  }

  table['POST ' + API_PREFIX + '/files/mkdir'] = async function (req, res) {
    const body = await readJson(req, MAX_POST)
    const root = mesh.files.findRoot(body.root)
    if (!root) {
      fail(res, 404, 'unknown-root', 'root is not shared here')
      return
    }
    const made = await mesh.files.makeDir(root, body.path || '')
    sendJson(res, 200, Object.assign({ ok: true }, made))
  }

  table['POST ' + API_PREFIX + '/files/delete'] = async function (req, res) {
    const body = await readJson(req, MAX_POST)
    const root = mesh.files.findRoot(body.root)
    if (!root) {
      fail(res, 404, 'unknown-root', 'root is not shared here')
      return
    }
    const removed = await mesh.files.removePath(root, body.path || '', { recursive: body.recursive === true })
    await mesh.store.audit({
      kind: 'delete',
      from: clientIp(req),
      root: root.id,
      path: removed.path,
      recursive: body.recursive === true
    })
    sendJson(res, 200, Object.assign({ ok: true }, removed))
  }

  table['POST ' + API_PREFIX + '/files/move'] = async function (req, res) {
    const body = await readJson(req, MAX_POST)
    const root = mesh.files.findRoot(body.root)
    if (!root) {
      fail(res, 404, 'unknown-root', 'root is not shared here')
      return
    }
    const moved = await mesh.files.renamePath(root, body.from || '', body.to || '')
    await mesh.store.audit({ kind: 'move', from: clientIp(req), root: root.id, fromPath: moved.from, toPath: moved.to })
    sendJson(res, 200, Object.assign({ ok: true }, moved))
  }

  table['GET ' + API_PREFIX + '/manifest'] = async function (req, res) {
    sendJson(res, 200, { ok: true, manifest: await mesh.plugins.readLocalManifest(mesh.ctx, mesh.identity) })
  }

  table['GET ' + API_PREFIX + '/status'] = async function (req, res) {
    const stats = await mesh.store.stats()
    sendJson(res, 200, {
      ok: true,
      identity: mesh.identity,
      rev: stats.rev,
      stats,
      roots: mesh.files.getRoots().map(function (root) {
        return { id: root.id, label: root.label, kind: root.kind }
      })
    })
  }

  return function dispatch(method, path, req, res) {
    return route(table, method, path, req, res)
  }
}

// ------------------------------------------------------------------- client

/**
 * Talk to one hub. Every call rejects with a plain `Error` carrying a `code`,
 * so the UI can say "wrong token" instead of "fetch failed".
 */
export function createPeer(getConfig) {
  function target() {
    const config = getConfig()
    if (!config || !config.hubHost) {
      const error = new Error('no hub host configured')
      error.code = 'NO_HUB'
      throw error
    }
    const host = config.hubHost.includes(':') && !config.hubHost.startsWith('[') ? '[' + config.hubHost + ']' : config.hubHost
    return 'http://' + host + ':' + config.hubPort
  }

  async function call(method, endpoint, options) {
    const opts = options || {}
    const config = getConfig()
    const url = target() + API_PREFIX + endpoint
    const headers = { 'x-lan-token': config.token, accept: 'application/json' }
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 20000)
    }
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
    let response
    try {
      response = await fetch(url, init)
    } catch (err) {
      const error = new Error('cannot reach ' + url + ': ' + String((err && err.message) || err))
      error.code = 'UNREACHABLE'
      throw error
    }
    let body = null
    try {
      body = await response.json()
    } catch (err) {
      body = null
    }
    if (response.status === 401) {
      const error = new Error('the hub rejected the token')
      error.code = 'BAD_TOKEN'
      throw error
    }
    if (!response.ok) {
      const message = body && body.error && body.error.message ? body.error.message : 'HTTP ' + response.status
      const error = new Error(message)
      error.code = (body && body.error && body.error.code) || 'HTTP_' + response.status
      throw error
    }
    return body
  }

  return {
    baseUrl: function () {
      try {
        return target()
      } catch (err) {
        return ''
      }
    },
    hello: function () {
      return call('GET', '/hello')
    },
    status: function () {
      return call('GET', '/status')
    },
    pull: function (since) {
      return call('GET', '/pull?since=' + encodeURIComponent(String(since || 0)))
    },
    push: function (payload) {
      return call('POST', '/push', { body: payload, timeoutMs: 60000 })
    },
    roots: function () {
      return call('GET', '/roots')
    },
    list: function (root, relPath) {
      return call('GET', '/files/list?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(relPath || ''))
    },
    read: function (root, relPath) {
      return call('GET', '/files/read?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(relPath || ''))
    },
    write: function (root, relPath, content, backup) {
      return call('POST', '/files/write', { body: { root, path: relPath, content, backup: backup === true } })
    },
    mkdir: function (root, relPath) {
      return call('POST', '/files/mkdir', { body: { root, path: relPath } })
    },
    remove: function (root, relPath, recursive) {
      return call('POST', '/files/delete', { body: { root, path: relPath, recursive: recursive === true } })
    },
    move: function (root, from, to) {
      return call('POST', '/files/move', { body: { root, from, to } })
    },
    manifest: function () {
      return call('GET', '/manifest')
    },
    authToken: function () {
      try {
        return (getConfig() || {}).token || ''
      } catch (err) {
        return ''
      }
    }
  }
}

// ---------------------------------------------------------------- discovery

/**
 * Announce this machine on the LAN. Returns `{ close }`.
 * A broadcast failure (no route, firewall) is logged once and otherwise ignored.
 *
 * The beacon is not hub-only: any machine that has discovery switched on
 * announces itself and answers probes, so a hub can find its members just as a
 * member finds its hub.
 */
export function startBeacon(config, descriptor) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  let closed = false
  try {
    socket.bind(config.discoveryPort, function () {
      try {
        socket.setBroadcast(true)
      } catch (err) {
        /* keep going without broadcast */
      }
      announce()
    })
  } catch (err) {
    return { close: function () {} }
  }
  let timer = null
  function answerText() {
    return (
      DISCOVERY_ANSWER +
      JSON.stringify({
        product: 'dsh-lan-bridge',
        schema: 1,
        nonce: randomUUID(),
        role: config.role,
        identity: descriptor.identity,
        port: config.port,
        at: Date.now()
      })
    )
  }
  function announce() {
    if (closed) return
    const answer = answerText()
    for (const target of broadcastTargets()) {
      try {
        socket.send(answer, config.discoveryPort, target)
      } catch (err) {
        /* no broadcast route on that interface */
      }
    }
  }
  timer = setInterval(announce, 15000)
  if (timer.unref) timer.unref()

  // Answer direct probes in unicast too, so a peer does not have to wait for a
  // beacon — and so a probe works even when its broadcast hop is filtered.
  socket.on('message', function (message, remote) {
    const text = String(message)
    if (!text.startsWith(DISCOVERY_QUERY)) return
    try {
      socket.send(answerText(), remote.port, remote.address)
    } catch (err) {
      /* fall back to the periodic beacon */
    }
  })
  socket.on('error', function () {
    /* a broken socket must not take the plugin down */
  })
  return {
    close: function () {
      closed = true
      if (timer) clearInterval(timer)
      try {
        socket.close()
      } catch (err) {
        /* already closed */
      }
    }
  }
}

/**
 * Shout once on the LAN and collect hub answers for `windowMs`.
 * @returns {Promise<Array<{host, port, identity, at}>>}
 */
export function discoverHubs(config, windowMs) {
  const wait = typeof windowMs === 'number' && windowMs > 0 ? windowMs : 1500
  return new Promise(function (resolve) {
    const found = []
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let done = false
    function finish() {
      if (done) return
      done = true
      try {
        socket.close()
      } catch (err) {
        /* ignore */
      }
      resolve(found)
    }
    socket.on('message', function (message, remote) {
      const text = String(message)
      if (!text.startsWith(DISCOVERY_ANSWER)) return
      let payload = null
      try {
        payload = JSON.parse(text.slice(DISCOVERY_ANSWER.length))
      } catch (err) {
        return
      }
      if (!payload || payload.product !== 'dsh-lan-bridge') return
      if (!payload.identity || payload.identity.machineId === config.machineId) return
      if (
        found.some(function (row) {
          return row.identity && row.identity.machineId === payload.identity.machineId
        })
      ) {
        return
      }
      found.push({
        host: remote.address,
        port: payload.port || config.port,
        role: payload.role || 'hub',
        identity: payload.identity,
        at: payload.at
      })
    })
    socket.on('error', function () {
      finish()
    })
    try {
      socket.bind(config.discoveryPort, function () {
        try {
          socket.setBroadcast(true)
        } catch (err) {
          /* ignore */
        }
        const query = DISCOVERY_QUERY + JSON.stringify({ machineId: config.machineId })
        const targets = broadcastTargets()
        // Probe the configured hub directly as well: a unicast round trip is not
        // subject to broadcast filtering on either side.
        if (config.hubHost && targets.indexOf(config.hubHost) === -1) targets.push(config.hubHost)
        for (const target of targets) {
          try {
            socket.send(query, config.discoveryPort, target)
          } catch (err) {
            /* interface without a broadcast route */
          }
        }
      })
    } catch (err) {
      finish()
      return
    }
    const timer = setTimeout(finish, wait)
    if (timer.unref) timer.unref()
  })
}
