/**
 * LAN discovery.
 *
 * A UDP probe on the configured discovery port asks "who is in this space?".
 * Nodes answer with their HTTP port and public identity. The space id is
 * derived from the shared key, so broadcasts do not leak the key itself and a
 * node from another space is simply ignored. Discovery is a convenience, not a
 * trust decision: a found node still has to be accepted in the peer table.
 */

import dgram from 'node:dgram'
import { broadcastTargets } from './net.js'
import { fingerprint as fingerprintOf } from './identity.js'

const PROBE = 'DSH-LAN-BRIDGE-v2?'
const ANSWER = 'DSH-LAN-BRIDGE-v2!'

export function createDiscovery(options) {
  const getConfig = options.getConfig
  const getIdentity = options.getIdentity
  const onPeer = options.onPeer || function () {}
  let socket = null
  let timer = null
  let started = false
  let lastError = ''

  function descriptor() {
    const config = getConfig()
    const identity = getIdentity()
    return {
      t: 'hello',
      v: 2,
      s: config.spaceId,
      id: config.nodeId,
      n: config.nodeName,
      p: config.port,
      f: identity ? fingerprintOf(identity) : '',
      plat: process.platform
    }
  }

  function sendProbe() {
    if (!socket) return
    const config = getConfig()
    const payload = Buffer.from(JSON.stringify({ t: 'probe', v: 2, s: config.spaceId, id: config.nodeId }))
    for (const target of broadcastTargets()) {
      socket.send(payload, 0, payload.length, config.discoveryPort, target, () => {})
    }
  }

  function handle(message, rinfo) {
    let data
    try {
      data = JSON.parse(message.toString('utf8'))
    } catch (err) {
      return
    }
    if (!data || data.v !== 2) return
    const config = getConfig()
    if (!data.s || data.s !== config.spaceId) return
    if (data.t === 'probe') {
      if (data.id === config.nodeId) return
      const payload = Buffer.from(JSON.stringify(descriptor()))
      socket.send(payload, 0, payload.length, rinfo.port, rinfo.address, () => {})
      return
    }
    if (data.t === 'hello') {
      if (!data.id || data.id === config.nodeId) return
      onPeer({
        nodeId: data.id,
        name: data.n || data.id,
        address: rinfo.address,
        port: Number(data.p) || config.port,
        fingerprint: data.f || '',
        platform: data.plat || '',
        at: new Date().toISOString()
      })
    }
  }

  function start() {
    if (started) return
    const config = getConfig()
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', (err) => {
      lastError = String((err && err.message) || err)
    })
    socket.on('message', (message, rinfo) => handle(message, rinfo))
    socket.bind(config.discoveryPort, '0.0.0.0', () => {
      started = true
      try {
        socket.setBroadcast(true)
      } catch (err) {
        lastError = String((err && err.message) || err)
      }
      sendProbe()
      timer = setInterval(sendProbe, 12000)
      if (timer.unref) timer.unref()
    })
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    if (socket) {
      try {
        socket.close()
      } catch (err) {
        /* already closed */
      }
    }
    socket = null
    started = false
  }

  function status() {
    return { listening: started, port: getConfig().discoveryPort, error: lastError, query: PROBE, answer: ANSWER }
  }

  return { start, stop, status, probe: sendProbe }
}
