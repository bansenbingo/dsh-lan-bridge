/** Network address helpers shared by discovery, transport, and the UI. */

import os from 'node:os'

export function localAddresses() {
  const out = []
  const interfaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list || []) {
      if (info.internal) continue
      if (info.family !== 'IPv4' && info.family !== 4) continue
      out.push({ name, address: info.address, netmask: info.netmask })
    }
  }
  return out
}

export function broadcastTargets() {
  const targets = new Set(['255.255.255.255'])
  for (const info of localAddresses()) {
    const parts = String(info.address).split('.').map(Number)
    const mask = String(info.netmask || '255.255.255.0').split('.').map(Number)
    if (parts.length !== 4 || mask.length !== 4) continue
    const broadcast = parts.map((part, index) => (part & mask[index]) | (~mask[index] & 255))
    targets.add(broadcast.join('.'))
  }
  return Array.from(targets)
}

export function normalizeAddress(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    try {
      const url = new URL(text)
      return url.port ? url.hostname + ':' + url.port : url.hostname
    } catch (err) {
      return ''
    }
  }
  return text
}

export function hostPort(address, fallbackPort) {
  const text = normalizeAddress(address)
  if (!text) return { host: '', port: fallbackPort || 0 }
  const index = text.lastIndexOf(':')
  if (index > 0 && /^\d+$/.test(text.slice(index + 1))) {
    return { host: text.slice(0, index), port: Number(text.slice(index + 1)) }
  }
  return { host: text, port: fallbackPort || 0 }
}

export function isPrivateAddress(address) {
  const text = String(address || '')
  if (/^10\./.test(text)) return true
  if (/^192\.168\./.test(text)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(text)) return true
  if (/^169\.254\./.test(text)) return true
  if (text === '127.0.0.1' || text === '::1' || text === 'localhost') return true
  return false
}

/**
 * Pick the address most likely to be reachable by another machine on the same
 * LAN. Virtual adapters (Tailscale, VMware, Hyper-V, Docker) often sort first
 * in `os.networkInterfaces()` and produce an invite code the other machine
 * cannot dial, so rank real RFC1918 interfaces above them.
 */
export function preferredAddress() {
  const rows = localAddresses().map((row) => {
    const name = String(row.name || '').toLowerCase()
    const address = String(row.address || '')
    let score = 0
    if (/tailscale|zerotier|vmware|virtualbox|vethernet|hyper-v|docker|wsl|loopback|tap|tun/.test(name)) score -= 100
    if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(address)) score -= 60
    if (/^169\.254\./.test(address)) score -= 40
    if (/^192\.168\./.test(address)) score += 30
    else if (/^10\./.test(address)) score += 20
    else if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(address)) score += 10
    return { row, score }
  })
  rows.sort((a, b) => b.score - a.score)
  return rows.length ? rows[0].row : null
}
