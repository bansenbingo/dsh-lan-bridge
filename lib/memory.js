/**
 * dsh-lan-bridge — memory sharing.
 *
 * DSH's durable memory lives in a few well-known Markdown files (the mnemon
 * runtime keeps MEMORY.md / USER.md, and the user may add more). This module
 * does two things and nothing clever:
 *
 *   1. discovers candidate files by probing the places DSH actually uses, and
 *   2. copies text in or out, always backing up whatever it overwrites.
 *
 * It deliberately does not merge: two machines editing the same paragraph with
 * different words is a decision for the owner, so the UI shows both sides and
 * offers "take remote" / "push mine" as explicit actions.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MAX_BYTES = 2 * 1024 * 1024

export function dshHome() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  return home || path.join(os.homedir(), '.dsh')
}

export function profileDir() {
  const dir = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim()
  if (dir) return dir
  return path.join(dshHome(), 'profiles', (process.env.DSH_PROFILE || 'desktop').trim())
}

/**
 * Conventional locations, most specific first. The same relative name is used
 * as the shared store key, so both machines agree on what "MEMORY.md" means.
 */
export function candidates() {
  const home = dshHome()
  const profile = profileDir()
  return [
    { name: 'MEMORY.md', file: path.join(home, 'MEMORY.md'), scope: 'dsh-home' },
    { name: 'USER.md', file: path.join(home, 'USER.md'), scope: 'dsh-home' },
    { name: 'MEMORY.md', file: path.join(home, 'memory', 'MEMORY.md'), scope: 'dsh-home/memory' },
    { name: 'USER.md', file: path.join(home, 'memory', 'USER.md'), scope: 'dsh-home/memory' },
    { name: 'MEMORY.md', file: path.join(profile, 'MEMORY.md'), scope: 'profile' },
    { name: 'USER.md', file: path.join(profile, 'USER.md'), scope: 'profile' },
    { name: 'MEMORY.md', file: path.join(os.homedir(), '.dsh', 'memory', 'MEMORY.md'), scope: 'home' },
    { name: 'USER.md', file: path.join(os.homedir(), '.dsh', 'memory', 'USER.md'), scope: 'home' }
  ]
}

/**
 * Probe every candidate and report which exist. A missing file is normal: the
 * mnemon runtime may project memory from a provider database instead of a file,
 * in which case the user can point the plugin at a path by hand.
 */
export async function discover() {
  const seen = new Set()
  const found = []
  for (const candidate of candidates()) {
    const key = candidate.file.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const info = await fs.stat(candidate.file)
      if (!info.isFile()) continue
      found.push({
        name: candidate.name,
        file: candidate.file,
        scope: candidate.scope,
        size: info.size,
        mtime: Math.trunc(info.mtimeMs)
      })
    } catch (err) {
      /* absent */
    }
  }
  return found
}

export async function readMemory(file) {
  const info = await fs.stat(file)
  if (info.size > MAX_BYTES) {
    const error = new Error('memory file is larger than ' + MAX_BYTES + ' bytes')
    error.code = 'TOO_LARGE'
    throw error
  }
  return fs.readFile(file, 'utf8')
}

/**
 * Overwrite a local memory file, keeping the previous content beside it.
 * Returns `{ file, backup, bytes }`.
 */
export async function writeMemory(file, text, options) {
  const opts = options || {}
  const body = typeof text === 'string' ? text : ''
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    const error = new Error('refusing to write more than ' + MAX_BYTES + ' bytes')
    error.code = 'TOO_LARGE'
    throw error
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  let backup = null
  if (opts.backup !== false) {
    try {
      await fs.copyFile(file, file + '.lan-bridge-backup-' + Date.now())
      backup = file + '.lan-bridge-backup-' + Date.now()
    } catch (err) {
      backup = null
    }
  }
  const temp = file + '.' + process.pid + '.lan-tmp'
  await fs.writeFile(temp, body, 'utf8')
  await fs.rename(temp, file)
  return { file, backup, bytes: Buffer.byteLength(body, 'utf8') }
}

/** Append a block to a local memory file, used by "import remote memory". */
export async function appendMemory(file, block) {
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch (err) {
    existing = ''
  }
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  return writeMemory(file, existing + separator + block, { backup: true })
}

/** A short, stable fingerprint used to detect "both sides changed". */
export function digest(text) {
  const source = typeof text === 'string' ? text : ''
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
