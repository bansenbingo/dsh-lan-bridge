/**
 * dsh-lan-bridge — conversation exporter.
 *
 * DSH persists one session per directory as an append-only stream of zstd
 * frames, each frame holding one or more JSONL events:
 *
 *   $DSH_HOME/sessions/<workspace-key>/session-<uuid>/session.v4.jsonl.zstd
 *
 * Reading those files directly (rather than asking a runtime service) keeps the
 * exporter identical on Windows and macOS, works for sessions that are not
 * loaded in this process, and survives DSH service changes. Every frame is an
 * independent zstd frame, so we split on the magic number and inflate each one;
 * a half-written trailing frame is skipped and picked up on the next sync.
 *
 * Event shapes handled (DSH session v4):
 *   { type:'session', id, cwd, createdAt }                       header
 *   { type:'user/message',      data:{ content:[{type:'text'}] } }
 *   { type:'assistant/message', data:{ turn, step, message:{ content:[
 *        {type:'text'}, {type:'reasoning'}, {type:'tool-call',id,name,arguments} ] } } }
 *   { type:'tool/call',   data:{ callId, name, arguments, turn, step } }
 *   { type:'tool/result', data:{ message:{ toolCallId, isError, content:[{type:'text'}] } } }
 *   { type:'session/title', data:{ title } }
 *
 * The normalised transcript keeps the chain of thought, every tool call and
 * every tool result, which is exactly what the peer needs to replay the turn.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** Per text block cap; transcripts stay readable and payloads stay small. */
const BLOCK_CAP = 24000
const SESSION_FILE_PATTERN = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/

export function sessionsRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  const base = home || path.join(os.homedir(), '.dsh')
  return path.join(base, 'sessions')
}

/** True when a file name is a DSH session log. */
export function isSessionFile(name) {
  return SESSION_FILE_PATTERN.test(name)
}

// ------------------------------------------------------------------ decoding

/**
 * Inflate every zstd frame in `buffer`. Frames are concatenated without a
 * container, so the magic number is the only reliable boundary marker; a
 * candidate offset that does not inflate is simply skipped.
 */
export function inflateFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ''
  const offsets = []
  let cursor = 0
  while (offsets.length < 100000) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (at < 0) break
    offsets.push(at)
    cursor = at + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) return buffer.toString('utf8')
  const parts = []
  for (const offset of offsets) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(offset)).toString('utf8'))
    } catch (err) {
      // Truncated frame (session still being written) or a stray magic number
      // inside compressed bytes: skip it.
    }
  }
  return parts.join('')
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object') out.push(value)
    } catch (err) {
      /* a torn line */
    }
  }
  return out
}

export async function readSessionFile(file) {
  let buffer
  try {
    buffer = await fs.readFile(file)
  } catch (err) {
    return null
  }
  const text = file.endsWith('.zstd') ? inflateFrames(buffer) : buffer.toString('utf8')
  const events = parseLines(text)
  if (events.length === 0) return null
  let header = null
  const rest = []
  for (const event of events) {
    if (!header && event.type === 'session') header = event
    else rest.push(event)
  }
  return { header, events: rest, bytes: buffer.length }
}

// --------------------------------------------------------------- normalising

function textOfBlocks(content) {
  const parts = []
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function clamp(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= BLOCK_CAP) return { text: value, truncated: false }
  return { text: value.slice(0, BLOCK_CAP), truncated: true }
}

function titleFrom(events, fallback) {
  let title = ''
  for (const event of events) {
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      const candidate = event.data.title.trim()
      if (candidate) title = candidate
    }
  }
  if (title) return title
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data && event.data.source
    if (source && source.kind && source.kind !== 'user') continue
    const text = textOfBlocks(event.data && event.data.content).trim()
    if (!text) continue
    const flat = text.replace(/\s+/g, ' ')
    return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
  }
  return fallback || '(untitled)'
}

/**
 * Turn raw events into the portable transcript the peer renders.
 *
 * @param {object} header   the `type:'session'` header event
 * @param {object[]} events everything after the header
 * @param {object} options  { includeSystem, maxBytes }
 */
export function normalizeTranscript(header, events, options) {
  const settings = options || {}
  const includeSystem = settings.includeSystem === true
  const maxBytes = typeof settings.maxBytes === 'number' ? settings.maxBytes : 8 * 1024 * 1024
  const items = []
  let createdAt = header && Number.isFinite(header.createdAt) ? header.createdAt : 0
  let updatedAt = createdAt
  let turn = 0

  for (const event of events) {
    const time = Number.isFinite(event.time) ? event.time : 0
    if (time > updatedAt) updatedAt = time

    switch (event.type) {
      case 'turn/start': {
        if (event.data && Number.isFinite(event.data.turn)) turn = event.data.turn
        items.push({ t: 'turn', at: time, n: turn })
        break
      }
      case 'step/start': {
        items.push({
          t: 'step',
          at: time,
          turn: event.data && event.data.turn,
          n: event.data && event.data.step
        })
        break
      }
      case 'user/message': {
        const data = event.data || {}
        const source = data.source && typeof data.source.kind === 'string' ? data.source.kind : 'user'
        const clipped = clamp(textOfBlocks(data.content))
        if (!clipped.text.trim()) break
        items.push({
          t: 'user',
          at: time,
          source,
          text: clipped.text,
          truncated: clipped.truncated || undefined
        })
        break
      }
      case 'assistant/message': {
        const data = event.data || {}
        const content = (data.message && data.message.content) || []
        const blocks = []
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            const clipped = clamp(block.text)
            blocks.push({ k: 'text', text: clipped.text, truncated: clipped.truncated || undefined })
          } else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text !== '') {
            const clipped = clamp(block.text)
            blocks.push({ k: 'reasoning', text: clipped.text, truncated: clipped.truncated || undefined })
          } else if (block.type === 'tool-call') {
            const clipped = clamp(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {}))
            blocks.push({
              k: 'tool-call',
              id: block.id || '',
              name: block.name || 'tool',
              args: clipped.text,
              truncated: clipped.truncated || undefined
            })
          } else if (block.type === 'image') {
            blocks.push({ k: 'image', note: block.mediaType || block.mimeType || 'image' })
          }
        }
        if (blocks.length === 0) break
        items.push({
          t: 'assistant',
          at: time,
          turn: data.turn,
          step: data.step,
          blocks
        })
        break
      }
      case 'tool/call': {
        const data = event.data || {}
        const clipped = clamp(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {}))
        items.push({
          t: 'tool-call',
          at: time,
          callId: data.callId || '',
          name: data.name || 'tool',
          args: clipped.text,
          turn: data.turn,
          step: data.step
        })
        break
      }
      case 'tool/result': {
        const data = event.data || {}
        const message = data.message || {}
        const clipped = clamp(textOfBlocks(message.content))
        items.push({
          t: 'tool-result',
          at: time,
          callId: message.toolCallId || data.toolCallId || '',
          isError: message.isError === true,
          text: clipped.text,
          truncated: clipped.truncated || undefined
        })
        break
      }
      case 'system/message': {
        if (!includeSystem) break
        const clipped = clamp(textOfBlocks(event.data && event.data.message && event.data.message.content))
        if (!clipped.text) break
        items.push({ t: 'system', at: time, text: clipped.text, truncated: clipped.truncated || undefined })
        break
      }
      case 'command/run': {
        const data = event.data || {}
        items.push({ t: 'command', at: time, name: data.name || '', args: String(data.args || '') })
        break
      }
      default:
        break
    }
  }

  let body = JSON.stringify(items)
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    // Keep the tail (most recent turns) rather than the head: a peer cares far
    // more about what just happened than about the opening prompt.
    let start = 0
    while (start < items.length && Buffer.byteLength(JSON.stringify(items.slice(start)), 'utf8') > maxBytes) {
      start += 1
    }
    items.splice(0, start)
    body = JSON.stringify(items)
  }

  const sessionId = header && typeof header.id === 'string' ? header.id : ''
  return {
    sessionId,
    title: titleFrom(events, sessionId),
    cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
    createdAt,
    updatedAt: updatedAt || createdAt,
    version: header && Number.isFinite(header.version) ? header.version : 4,
    agentPreset: header && typeof header.agentPreset === 'string' ? header.agentPreset : '',
    items,
    bytes: Buffer.byteLength(body, 'utf8')
  }
}

// ------------------------------------------------------------------ scanning

/**
 * Walk `$DSH_HOME/sessions` and return one row per session log.
 * The workspace directory encodes the cwd; the header carries it exactly.
 */
export async function scanSessionFiles() {
  const root = sessionsRoot()
  const rows = []
  let workspaces = []
  try {
    workspaces = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    return rows
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(root, workspace.name)
    let entries = []
    try {
      entries = await fs.readdir(workspaceDir, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionDir = path.join(workspaceDir, entry.name)
      let files = []
      try {
        files = await fs.readdir(sessionDir, { withFileTypes: true })
      } catch (err) {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !isSessionFile(file.name)) continue
        const full = path.join(sessionDir, file.name)
        try {
          const info = await fs.stat(full)
          rows.push({
            file: full,
            workspace: workspace.name,
            dirName: entry.name,
            size: info.size,
            mtimeMs: Math.trunc(info.mtimeMs)
          })
        } catch (err) {
          /* vanished mid-scan */
        }
      }
    }
  }
  return rows
}

/** Sessions are directories only when DSH used the directory layout. */
export async function readSessionRow(row) {
  const parsed = await readSessionFile(row.file)
  if (!parsed || !parsed.header) return null
  return parsed
}
