/**
 * Workspace catalog.
 *
 * A node shares only the workspaces DSH already knows about (`workspaceRegistry`)
 * plus directories the user adds by hand. The catalog exposes a stable public
 * id, a label, and whether the root still exists. Absolute paths stay local:
 * a remote node asks for `rootId + relative path`, never for `C:\...`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { cacheDir, shortHash } from './config.js'
import * as files from './files.js'

function rootId(prefix, target) {
  return prefix + '-' + shortHash(path.resolve(target), 12)
}

function blocked(target, deniedRoots) {
  const resolved = path.resolve(target).toLowerCase()
  for (const denied of deniedRoots || []) {
    const value = path.resolve(String(denied || '')).toLowerCase()
    if (!value) continue
    if (resolved === value) return true
    if (resolved.startsWith(value.endsWith(path.sep) ? value : value + path.sep)) return true
  }
  return false
}

export function publicRoot(root) {
  return {
    id: root.id,
    label: root.label,
    kind: root.kind,
    remote: Boolean(root.remote),
    exists: Boolean(root.exists)
  }
}

export function createWorkspaces(options) {
  const getConfig = options.getConfig
  const getContext = options.getContext || function () { return null }
  let roots = []
  let loaded = false

  function cacheFile() {
    return path.join(cacheDir(), 'roots.json')
  }

  async function loadCached() {
    if (loaded) return roots
    try {
      const raw = JSON.parse(await fs.readFile(cacheFile(), 'utf8'))
      if (Array.isArray(raw.roots)) roots = raw.roots
    } catch (err) {
      /* ignore */
    }
    loaded = true
    return roots
  }

  async function save() {
    try {
      await fs.mkdir(cacheDir(), { recursive: true })
      const temp = cacheFile() + '.' + process.pid + '.tmp'
      await fs.writeFile(temp, JSON.stringify({ version: 2, roots }), 'utf8')
      await fs.rename(temp, cacheFile())
      await fs.chmod(cacheFile(), 0o600).catch(() => {})
    } catch (err) {
      /* cache is best effort */
    }
  }

  async function refresh(ctx) {
    const config = getConfig()
    const context = ctx || getContext()
    const candidates = []
    try {
      const registry = context && typeof context.get === 'function' ? context.get('workspaceRegistry') : null
      if (registry && typeof registry.list === 'function') {
        const listed = await registry.list()
        for (const entity of Array.isArray(listed) ? listed : []) {
          if (!entity || !entity.path) continue
          candidates.push({
            id: rootId('w', entity.path),
            label: entity.title || path.basename(entity.path) || entity.path,
            path: path.resolve(entity.path),
            kind: 'workspace'
          })
        }
      }
    } catch (err) {
      /* registry is optional */
    }
    for (const extra of config.extraRoots || []) {
      if (!extra) continue
      const target = path.resolve(String(extra))
      if (candidates.some((row) => row.path.toLowerCase() === target.toLowerCase())) continue
      candidates.push({
        id: rootId('x', target),
        label: path.basename(target) || target,
        path: target,
        kind: 'extra'
      })
    }
    const next = []
    const seen = new Set()
    for (const row of candidates) {
      const key = row.path.toLowerCase()
      if (seen.has(key)) continue
      if (blocked(row.path, config.deniedRoots)) continue
      const exists = await files.exists(row.path)
      if (!exists) continue
      seen.add(key)
      next.push({
        id: row.id,
        label: row.label,
        path: row.path,
        kind: row.kind,
        exists: true
      })
    }
    roots = next
    loaded = true
    files.setRoots(roots)
    await save()
    return roots
  }

  function list() {
    return roots.map(publicRoot)
  }

  function localList() {
    return roots.slice()
  }

  function resolve(id) {
    const key = typeof id === 'string' ? id : ''
    return roots.find((root) => root.id === key) || null
  }

  async function ensure(ctx) {
    if (loaded && roots.length) return roots
    await loadCached()
    files.setRoots(roots)
    if (ctx || getContext()) await refresh(ctx)
    return roots
  }

  return { refresh, list, localList, resolve, ensure, publicRoot }
}
