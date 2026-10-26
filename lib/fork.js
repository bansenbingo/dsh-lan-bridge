/**
 * Fork 一个共享区里的会话到本机某个工作区，写成一个 DSH 能直接打开并继续对话的
 * 会话日志（session.v4.jsonl.zstd）。
 *
 * DSH 自带的 fork 只对本进程内存里的 Session 有效（会话控制器 + agents.create），
 * 而同步过来的远端会话在本机根本没有 Session 对象，所以这里走文件级 fork：
 * 按 DSH v4 会话格式重建一份结构合法的最小日志（配置前缀 + 成对的 turn/step +
 * user/assistant 消息），写进 `<sessionsRoot>/<projectKey(cwd)>/<sessionId>/`。
 * DSH 下次启动扫描会话目录时就会把它当成一条普通会话，可以直接接着聊。
 *
 * 格式依据（app.asar 内的真实实现）：
 *   dsh-session-persistence-jsonl/lib/index.js  —— projectKey/encodeSegment/帧编码
 *   dsh-session/lib/types/known-event-types.js  —— 允许的事件类型
 *   dsh-session-format-v3-to-v4                 —— v4 关系校验（turn/step 配对等）
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { sessionsRoot } from './sessions.js'

/** 当前物理格式代号，也是文件名里的 session.v<N>.jsonl.zstd。 */
const FORMAT_VERSION = 4

/** 与 dsh-session-persistence-jsonl 完全一致的帧参数（带校验和）。 */
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

/** 带 code 的错误：宿主半据此回 4xx，而不是一律 500。 */
function forkError(code, message) {
  return Object.assign(new Error(message), { code })
}

/** 会话开头的配置前缀事件：从目标工作区已有会话里抄，保证枚举值合法。 */
const CONFIG_TYPES = ['permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/model-selection-policy']

/** 本机一个可用工作区都没有时的兜底配置。 */
const FALLBACK_CONFIG = [
  { type: 'permission/preset', data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
  { type: 'subagent/model-selection-policy', data: { allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] } }
]

/** 只读文件头这么多字节就够拿到 header 与配置前缀。 */
const HEAD_BYTES = 64 * 1024
const SESSION_FILE = /^session(\.v[1-9][0-9]*)?\.jsonl(\.zstd)?$/
const FRAME_MAGIC = 0xfd2fb528

/**
 * 项目目录名编码，逐字照抄 dsh-session-persistence-jsonl 的 projectKey。
 * 路径分隔符连续段压成一个 '-'，其余不安全字符转 ~XXXX。
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cwd 不能为空')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
}

/** 会话目录名编码，逐字照抄 dsh-session-persistence-jsonl 的 encodeSegment。 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('会话 id 不能为空')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 返回从 offset 开始的那个 zstd 帧的结束位置；结构不完整返回 -1。
 * 只走帧头与 block 头，不解压数据块，用来低成本定位第一个（header）帧。
 */
export function frameEnd(buffer, offset) {
  const start = offset
  if (typeof start !== 'number' || start < 0) return -1
  if (buffer.length - offset < 5) return -1
  if (buffer.readUInt32LE(offset) !== FRAME_MAGIC) return -1
  offset += 4
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 24) !== 0) return -1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (offset > buffer.length) return -1
  for (;;) {
    if (buffer.length - offset < 3) return -1
    const header = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (header & 1) !== 0
    const blockType = (header >>> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 3) return -1
    offset += blockType === 1 ? 1 : blockSize
    if (offset > buffer.length) return -1
    if (lastBlock) break
  }
  if (checksum) offset += 4
  return offset <= buffer.length ? offset : -1
}

/** 读一个会话文件的前若干条事件（只读文件头，不解压整个日志）。 */
export function readHeadEvents(file, limit) {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 1
  const fd = fs.openSync(file, 'r')
  let chunk = Buffer.alloc(0)
  try {
    const size = fs.fstatSync(fd).size
    chunk = Buffer.alloc(Math.min(size, HEAD_BYTES))
    let read = 0
    while (read < chunk.length) {
      const bytes = fs.readSync(fd, chunk, read, chunk.length - read, read)
      if (bytes <= 0) break
      read += bytes
    }
    chunk = chunk.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
  const events = []
  let offset = 0
  while (offset < chunk.length) {
    const end = frameEnd(chunk, offset)
    if (end < 0) break
    let text = ''
    try {
      text = zlib.zstdDecompressSync(chunk.subarray(offset, end)).toString('utf8')
    } catch (err) {
      break
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch (err) {
        return events
      }
      if (events.length >= cap) return events
    }
    offset = end
  }
  return events
}

/** 列出工作区目录里最新的会话文件（含 mtime 与会话数量）。 */
function newestSessionFile(projectDirPath) {
  let entries = []
  try {
    entries = fs.readdirSync(projectDirPath)
  } catch (err) {
    return null
  }
  let newest = null
  let sessions = 0
  for (const entry of entries) {
    const sessionDirPath = path.join(projectDirPath, entry)
    let names = []
    try {
      names = fs.readdirSync(sessionDirPath)
    } catch (err) {
      continue
    }
    for (const name of names) {
      if (!SESSION_FILE.test(name)) continue
      const file = path.join(sessionDirPath, name)
      let info = null
      try {
        info = fs.statSync(file)
      } catch (err) {
        continue
      }
      sessions += 1
      if (!newest || info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs }
    }
  }
  if (!newest) return null
  return { file: newest.file, mtime: newest.mtime, sessions }
}

/**
 * 本机所有可用工作区（按最近活动倒序）。
 * 每个工作区给出 key（磁盘目录名）、cwd（来自最新会话的 header）与会话数。
 */
export function listWorkspaces() {
  const root = sessionsRoot()
  let keys = []
  try {
    keys = fs.readdirSync(root)
  } catch (err) {
    return []
  }
  const workspaces = []
  for (const key of keys) {
    if (key === '_no-cwd') continue
    const projectDirPath = path.join(root, key)
    let info = null
    try {
      if (!fs.statSync(projectDirPath).isDirectory()) continue
    } catch (err) {
      continue
    }
    info = newestSessionFile(projectDirPath)
    if (!info) continue
    let header = null
    try {
      header = readHeadEvents(info.file, 1)[0] || null
    } catch (err) {
      header = null
    }
    if (!header || header.type !== 'session' || typeof header.cwd !== 'string' || !header.cwd) continue
    workspaces.push({
      key,
      cwd: header.cwd,
      sessions: info.sessions,
      updatedAt: Math.round(info.mtime),
      agentPreset: typeof header.agentPreset === 'string' && header.agentPreset ? header.agentPreset : 'standard',
      file: info.file
    })
  }
  workspaces.sort(function (left, right) {
    return right.updatedAt - left.updatedAt
  })
  return workspaces
}

/** 从目标工作区已有会话里抄配置前缀（枚举值一定合法）。 */
function configPrefix(workspace) {
  if (workspace && workspace.file) {
    let head = []
    try {
      head = readHeadEvents(workspace.file, 12)
    } catch (err) {
      head = []
    }
    const picked = []
    for (const event of head) {
      if (!event || CONFIG_TYPES.indexOf(event.type) < 0) continue
      if (picked.some(function (row) { return row.type === event.type })) continue
      picked.push({ type: event.type, data: event.data === undefined ? {} : event.data })
    }
    if (picked.length > 0) return picked
  }
  return FALLBACK_CONFIG.map(function (row) {
    return { type: row.type, data: row.data }
  })
}

/** 从目标工作区的日志里找一次真实的模型路由，用作合成 assistant 消息的 source。 */
function modelRoute(workspace) {
  const fallback = { provider: 'deepseek-official', model: 'deepseek-flash' }
  if (!workspace || !workspace.file) return fallback
  let head = []
  try {
    head = readHeadEvents(workspace.file, 60)
  } catch (err) {
    return fallback
  }
  for (const event of head) {
    if (!event || event.type !== 'request/context') continue
    const data = event.data || {}
    if (typeof data.provider === 'string' && data.provider && typeof data.model === 'string' && data.model) {
      return { provider: data.provider, model: data.model }
    }
  }
  return fallback
}

/** 取一条已归一化消息的正文（user 用 text，assistant 只取 text 块）。 */
function messageText(item) {
  if (!item) return ''
  if (item.t === 'user') return String(item.text || '').trim()
  if (item.t !== 'assistant') return ''
  const parts = []
  for (const block of item.blocks || []) {
    if (block && block.k === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * 把归一化后的 items 压成「用户 / 助手」消息序列。
 * 工具调用与系统消息直接跳过：它们离开原会话就没有意义，强行重放只会让模型误解。
 */
export function buildMessages(transcript) {
  const source = (transcript && Array.isArray(transcript.items) && transcript.items) || []
  const messages = []
  for (const item of source) {
    const role = item && item.t === 'user' ? 'user' : item && item.t === 'assistant' ? 'assistant' : ''
    if (!role) continue
    const text = messageText(item)
    if (!text) continue
    const last = messages.length > 0 ? messages[messages.length - 1] : null
    if (last && last.role === role) {
      last.text = last.text + '\n\n' + text
      continue
    }
    messages.push({ role, text })
  }
  if (messages.length > 0 && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', text: '（下面是从另一台电脑的会话 fork 过来的历史记录，请接着聊）' })
  }
  return messages
}

/** 把消息序列切成 turn：每条用户消息一个 turn，其后的助手消息合成同一条回复。 */
export function buildTurns(messages) {
  const turns = []
  let current = null
  for (const message of messages || []) {
    if (message.role === 'user') {
      current = { user: message.text, assistant: '' }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { user: '', assistant: message.text }
      turns.push(current)
      continue
    }
    current.assistant = current.assistant ? current.assistant + '\n\n' + message.text : message.text
  }
  return turns
}

/** fork 后的会话标题：沿用原标题，加上标记方便在侧栏里认出来。 */
function forkTitle(transcript, firstUser) {
  const raw = transcript && typeof transcript.title === 'string' ? transcript.title.replace(/\s+/g, ' ').trim() : ''
  const base = raw || String(firstUser || '').replace(/\s+/g, ' ').trim()
  const clipped = base.length > 70 ? base.slice(0, 70) + '…' : base
  return clipped ? clipped + '（fork）' : 'fork 的会话'
}

/**
 * 生成一份合法的 v4 会话日志。
 * 返回 { header, events, messages, turns, title }，纯函数、不碰磁盘，方便测试。
 */
export function buildForkLog(options) {
  const settings = options || {}
  const transcript = settings.transcript || {}
  const cwd = settings.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('缺少目标工作区路径')
  const now = Number.isFinite(settings.now) ? settings.now : Date.now()
  const sessionId = 'session-' + crypto.randomUUID()
  const messages = buildMessages(transcript)
  const turns = buildTurns(messages)
  const config = Array.isArray(settings.config) && settings.config.length > 0 ? settings.config : FALLBACK_CONFIG
  const route = settings.route || { provider: 'deepseek-official', model: 'deepseek-flash' }
  const title = forkTitle(transcript, messages.length > 0 ? messages[0].text : '')

  const events = []
  let seq = 0
  const append = function (type, data, extras) {
    const event = { type, seq, time: now }
    if (data !== undefined) event.data = data
    if (extras) Object.assign(event, extras)
    seq += 1
    events.push(event)
    return event
  }

  for (const entry of config) append(entry.type, entry.data)

  let turn = 1
  for (const item of turns) {
    append('turn/start', { turn })
    append('step/start', { turn, step: 1 })
    let userSeq = -1
    if (item.user) {
      append(
        'user/message',
        {
          content: [{ type: 'text', text: item.user }],
          source: { kind: 'user', rpcId: crypto.randomUUID() },
          role: 'user',
          id: crypto.randomUUID()
        },
        { surfaceOp: 'append' }
      )
      userSeq = seq - 1
    }
    if (turn === 1) {
      append('session/title', {
        title,
        messageSeqs: userSeq >= 0 ? [userSeq] : [],
        source: { kind: userSeq >= 0 ? 'fallback' : 'user' }
      })
    }
    if (item.assistant) {
      append(
        'assistant/message',
        {
          turn,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: item.assistant }],
            source: { kind: 'model', provider: route.provider, model: route.model },
            id: crypto.randomUUID()
          },
          stream: []
        },
        { surfaceOp: 'append' }
      )
    }
    append('step/end', { turn, step: 1 })
    append('turn/end', { turn, reason: { kind: 'completed' } })
    turn += 1
  }

  const header = {
    type: 'session',
    version: FORMAT_VERSION,
    id: sessionId,
    createdAt: now,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: settings.agentPreset || 'standard'
  }

  return { header, events, messages, turns, title }
}

/** 把 header 与事件编码成磁盘字节：header 一个帧，其余事件一个帧。 */
export function encodeSessionLog(header, events) {
  const headerFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), CHECKSUM_OPTIONS)
  const body = (events || []).map(function (event) {
    return JSON.stringify(event) + '\n'
  }).join('')
  const bodyFrame = zlib.zstdCompressSync(Buffer.from(body, 'utf8'), CHECKSUM_OPTIONS)
  return Buffer.concat([headerFrame, bodyFrame])
}

/** 会话日志在磁盘上的目录。 */
export function sessionDirPath(cwd, sessionId, root) {
  return path.join(root || sessionsRoot(), projectKey(cwd), encodeSegment(sessionId))
}

/** 落盘（'wx' 语义，绝不覆盖已有会话），写完 fsync。 */
export function writeSessionLog(header, events, options) {
  const settings = options || {}
  const root = settings.root || sessionsRoot()
  const dirPath = sessionDirPath(header.cwd, header.id, root)
  fs.mkdirSync(dirPath, { recursive: true })
  const file = path.join(dirPath, 'session.v' + FORMAT_VERSION + '.jsonl.zstd')
  const bytes = encodeSessionLog(header, events)
  const fd = fs.openSync(file, 'wx')
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, 0)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return { file, dir: dirPath, bytes: bytes.length }
}

/**
 * fork 主入口：把共享区里的会话写成本机某个工作区的一条新会话。
 * workspace 传工作区 key（listWorkspaces 的 key），不传则优先按原 cwd 匹配，
 * 再退回本机最近活跃的工作区。
 */
export function forkConversation(options) {
  const settings = options || {}
  const conversation = settings.conversation || {}
  if (!conversation || !Array.isArray(conversation.items) || conversation.items.length === 0) {
    throw forkError('EMPTY_CONVERSATION', '这条会话没有可 fork 的内容')
  }
  const workspaces = listWorkspaces()
  let target = null
  if (settings.workspace) {
    target = workspaces.find(function (row) { return row.key === settings.workspace }) || null
    if (!target) {
      throw forkError('NO_WORKSPACE', '目标工作区不存在了（可能已被删除），刷新后重新选一个')
    }
  }
  if (!target && typeof conversation.cwd === 'string' && conversation.cwd) {
    target = workspaces.find(function (row) { return row.cwd === conversation.cwd }) || null
  }
  if (!target) target = workspaces.length > 0 ? workspaces[0] : null
  if (!target) {
    throw forkError('NO_WORKSPACE', '本机还没有任何工作区（先在 DSH 里开一个会话），无法 fork')
  }

  const built = buildForkLog({
    transcript: conversation,
    cwd: target.cwd,
    config: configPrefix(target),
    route: modelRoute(target),
    agentPreset: target.agentPreset,
    now: settings.now
  })
  const written = writeSessionLog(built.header, built.events, { root: settings.root })
  return {
    sessionId: built.header.id,
    title: built.title,
    cwd: target.cwd,
    workspace: target.key,
    turns: built.turns.length,
    messages: built.messages.length,
    bytes: written.bytes,
    file: written.file
  }
}
