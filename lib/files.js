/**
 * dsh-lan-bridge — remote workspace files.
 *
 * Sharing a filesystem across two personal machines is the most dangerous part
 * of this plugin, so the rules are explicit and enforced in one place:
 *
 *   1. Only paths under a *registered root* are reachable. Roots come from the
 *      workspaces this DSH has actually used (read out of session headers) plus
 *      whatever the user added by hand.
 *   2. A relative path may never escape its root once `realpath` is applied, so
 *      a symlink cannot be used to climb out.
 *   3. A small deny list covers credential-shaped names; nothing under
 *      `$DSH_HOME/profiles` is reachable unless the user adds it deliberately.
 *   4. Writes are atomic (temp file + rename) so a dropped connection cannot
 *      truncate a document.
 *
 * Everything the model reads here is plain text; binaries are reported, never
 * shipped.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as config from './config.js'

const DEFAULT_DENY = [
  '.credentials.yaml',
  '.credentials.yml',
  '.env',
  '.env.local',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  'credentials.json'
]

const DENY_EXTENSIONS = ['.pem', '.key', '.pfx', '.p12', '.keystore']
const MAX_ENTRIES = 2000

let roots = []

export function setRoots(list) {
  roots = Array.isArray(list)
    ? list.filter(function (root) {
        return root && typeof root.id === 'string' && typeof root.path === 'string'
      })
    : []
  return roots
}

export function getRoots() {
  return roots
}

export function findRoot(id) {
  const key = typeof id === 'string' ? id : ''
  return roots.find(function (root) {
    return root.id === key
  }) || null
}

export function homeDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  return home || path.join(os.homedir(), '.dsh')
}

/** Normalise a client-supplied relative path, rejecting anything hostile. */
export function normalizeRelative(input) {
  const raw = typeof input === 'string' ? input : ''
  if (raw.indexOf('\0') >= 0) {
    const error = new Error('path contains a NUL byte')
    error.code = 'BAD_PATH'
    throw error
  }
  const slashed = raw.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed) || slashed.startsWith('~')) {
    const error = new Error('path must be relative to the root')
    error.code = 'BAD_PATH'
    throw error
  }
  const parts = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const error = new Error('path may not walk above the root')
      error.code = 'BAD_PATH'
      throw error
    }
    parts.push(segment)
  }
  return parts.join('/')
}

function isDenied(relativePath) {
  const base = path.basename(relativePath).toLowerCase()
  if (DEFAULT_DENY.indexOf(base) >= 0) return true
  const ext = path.extname(base)
  if (DENY_EXTENSIONS.indexOf(ext) >= 0) return true
  const segments = relativePath.toLowerCase().split('/')
  if (segments.indexOf('.git') >= 0 && base === 'config') return true
  return false
}

/**
 * Resolve `relative` inside the root's directory, following symlinks and
 * proving the result stays inside. `allowMissing` permits a not-yet-created
 * target (used by write and mkdir).
 */
export async function resolveWithin(root, relative, allowMissing) {
  if (!root) {
    const error = new Error('unknown root')
    error.code = 'UNKNOWN_ROOT'
    throw error
  }
  const rel = normalizeRelative(relative)
  if (isDenied(rel)) {
    const error = new Error('path is on the deny list')
    error.code = 'DENIED'
    throw error
  }
  const rootPath = path.resolve(root.path)
  const target = rel === '' ? rootPath : path.resolve(rootPath, rel)
  const rootReal = await fs.realpath(rootPath).catch(function () {
    return rootPath
  })
  // Prove containment on the lexical path first: that catches `..` and symlink
  // free traversal before we touch the disk.
  if (!contains(rootReal, target) && !contains(rootPath, target)) {
    const error = new Error('path escapes the shared root')
    error.code = 'BAD_PATH'
    throw error
  }
  let real = target
  try {
    real = await fs.realpath(target)
  } catch (err) {
    if (!allowMissing) {
      const error = new Error('path does not exist')
      error.code = 'ENOENT'
      throw error
    }
    // Resolve the deepest existing ancestor so a symlinked parent is still
    // caught before we create anything.
    real = await realpathOfExistingAncestor(target)
  }
  if (!contains(rootReal, real)) {
    const error = new Error('path escapes the shared root through a link')
    error.code = 'BAD_PATH'
    throw error
  }
  return { absolute: real, relative: rel, rootPath: rootReal }
}

function contains(parent, child) {
  const from = parent.replace(/[\\/]+$/, '')
  if (child === from) return true
  const prefix = from + path.sep
  return child.startsWith(prefix)
}

async function realpathOfExistingAncestor(target) {
  let current = target
  const missing = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await fs.realpath(current)
      return path.join(real, ...missing.reverse())
    } catch (err) {
      const parent = path.dirname(current)
      if (parent === current) return target
      missing.push(path.basename(current))
      current = parent
    }
  }
  return target
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096))
  for (let i = 0; i < probe.length; i += 1) {
    if (probe[i] === 0) return true
  }
  return false
}

export async function listDir(root, relative) {
  const resolved = await resolveWithin(root, relative, false)
  const entries = await fs.readdir(resolved.absolute, { withFileTypes: true })
  const rows = []
  for (const entry of entries) {
    if (rows.length >= MAX_ENTRIES) break
    const full = path.join(resolved.absolute, entry.name)
    let info = null
    try {
      info = await fs.lstat(full)
    } catch (err) {
      continue
    }
    const rel = resolved.relative === '' ? entry.name : resolved.relative + '/' + entry.name
    rows.push({
      name: entry.name,
      path: rel,
      dir: entry.isDirectory() || (entry.isSymbolicLink() && info.isDirectory()),
      link: entry.isSymbolicLink(),
      size: info.size,
      mtime: Math.trunc(info.mtimeMs),
      denied: isDenied(rel)
    })
  }
  rows.sort(function (a, b) {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { path: resolved.relative, entries: rows, root: root.id, rootPath: resolved.rootPath }
}

export async function readFile(root, relative, maxBytes) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 2 * 1024 * 1024
  const resolved = await resolveWithin(root, relative, false)
  const info = await fs.stat(resolved.absolute)
  if (info.isDirectory()) {
    const error = new Error('path is a directory')
    error.code = 'IS_DIR'
    throw error
  }
  if (info.size > limit) {
    const error = new Error('file is ' + info.size + ' bytes, above the ' + limit + ' byte limit')
    error.code = 'TOO_LARGE'
    throw error
  }
  const buffer = await fs.readFile(resolved.absolute)
  if (looksBinary(buffer)) {
    return {
      path: resolved.relative,
      binary: true,
      size: buffer.length,
      mtime: Math.trunc(info.mtimeMs),
      content: ''
    }
  }
  return {
    path: resolved.relative,
    binary: false,
    size: buffer.length,
    mtime: Math.trunc(info.mtimeMs),
    content: buffer.toString('utf8')
  }
}

export async function writeFile(root, relative, content, options) {
  const resolved = await resolveWithin(root, relative, true)
  if (resolved.relative === '') {
    const error = new Error('refusing to write the root itself')
    error.code = 'BAD_PATH'
    throw error
  }
  const data = typeof content === 'string' ? content : ''
  await fs.mkdir(path.dirname(resolved.absolute), { recursive: true })
  let previous = null
  let backup = null
  if (options && options.backup) {
    try {
      previous = await fs.readFile(resolved.absolute, 'utf8')
    } catch (err) {
      previous = null
    }
    // Backups live under the plugin data directory, not beside the document:
    // a shared folder should never fill up with .bak siblings.
    if (previous !== null) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target = path.join(config.dataDir(), 'backups', root.id, resolved.relative + '.' + stamp + '.bak')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, previous, 'utf8')
        backup = target
      } catch (err) {
        backup = null
      }
    }
  }
  const temp = resolved.absolute + '.' + process.pid + '.lan-tmp'
  await fs.writeFile(temp, data, 'utf8')
  await fs.rename(temp, resolved.absolute)
  const info = await fs.stat(resolved.absolute)
  return {
    path: resolved.relative,
    size: info.size,
    mtime: Math.trunc(info.mtimeMs),
    bytes: Buffer.byteLength(data, 'utf8'),
    backup,
    hadPrevious: previous !== null
  }
}

export async function makeDir(root, relative) {
  const resolved = await resolveWithin(root, relative, true)
  await fs.mkdir(resolved.absolute, { recursive: true })
  return { path: resolved.relative, dir: true }
}

export async function removePath(root, relative, options) {
  const resolved = await resolveWithin(root, relative, false)
  if (resolved.relative === '') {
    const error = new Error('refusing to delete the root itself')
    error.code = 'BAD_PATH'
    throw error
  }
  const recursive = options && options.recursive === true
  const info = await fs.lstat(resolved.absolute)
  if (info.isDirectory() && !recursive) {
    const entries = await fs.readdir(resolved.absolute)
    if (entries.length > 0) {
      const error = new Error('directory is not empty; pass recursive to delete it')
      error.code = 'NOT_EMPTY'
      throw error
    }
  }
  await fs.rm(resolved.absolute, { recursive, force: false })
  return { path: resolved.relative, deleted: true }
}

export async function renamePath(root, from, to) {
  const source = await resolveWithin(root, from, false)
  const target = await resolveWithin(root, to, true)
  if (source.relative === '' || target.relative === '') {
    const error = new Error('refusing to move a root')
    error.code = 'BAD_PATH'
    throw error
  }
  await fs.mkdir(path.dirname(target.absolute), { recursive: true })
  await fs.rename(source.absolute, target.absolute)
  return { from: source.relative, to: target.relative, moved: true }
}

/** Cheap existence probe used when building the root list. */
export async function exists(target) {
  try {
    const info = await fs.stat(target)
    return info.isDirectory()
  } catch (err) {
    return false
  }
}

export const denyList = DEFAULT_DENY
