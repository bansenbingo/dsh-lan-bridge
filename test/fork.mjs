// Verifies the fork writer: v4 session log structure, zstd framing and disk layout.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const home = mkdtempSync(join(tmpdir(), 'lan-fork-'))
process.env.DSH_HOME = home

const fork = await import(pathToFileURL(join(root, 'lib', 'fork.js')).href)

let passed = 0
const failures = []
function check(name, run) {
  try {
    const result = run()
    if (result === false) throw new Error('断言为 false')
    passed += 1
    console.log('  ok   ' + name)
  } catch (err) {
    failures.push(name + '：' + String((err && err.message) || err))
    console.log('  FAIL ' + name + ' -> ' + String((err && err.message) || err))
  }
}
function eq(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error((label || '值') + ' 期望 ' + right + '，实际 ' + left)
}

// ------------------------------------------------------------------ fixtures

const transcript = {
  sessionId: 'session-11111111-2222-3333-4444-555555555555',
  title: '局域网渲染失败',
  cwd: 'D:\\GitHub\\dsh-lan-bridge',
  updatedAt: 1700000000000,
  items: [
    { t: 'turn', at: 1, n: 1 },
    { t: 'user', at: 2, text: '面板白屏了' },
    { t: 'assistant', at: 3, blocks: [{ k: 'reasoning', text: '先看报错' }, { k: 'text', text: '把控制台报错发我' }] },
    { t: 'tool-call', at: 4, name: 'read', args: '{"path":"x"}' },
    { t: 'tool-result', at: 5, name: 'read', text: 'ok' },
    { t: 'user', at: 6, text: 'think is not defined' },
    { t: 'assistant', at: 7, blocks: [{ k: 'text', text: '这是折叠逻辑漏传参数' }, { k: 'text', text: '两行就能修' }] }
  ]
}

const config = [
  { type: 'permission/preset', data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
  { type: 'subagent/model-selection-policy', data: { allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] } }
]

// ------------------------------------------------------------- path encoding

check('projectKey 复刻真实目录名', function () {
  eq(fork.projectKey('D:\\GitHub\\dsh-lan-bridge'), '--D-GitHub-dsh-lan-bridge--')
  eq(fork.projectKey('D:\\申请'), '--D-~7533~8BF7--')
  eq(fork.projectKey('C:/a//b'), '--C-a-b--')
  let threw = false
  try {
    fork.projectKey('')
  } catch (err) {
    threw = true
  }
  if (!threw) throw new Error('空 cwd 应当报错')
})

check('encodeSegment 原样保留会话 id', function () {
  eq(fork.encodeSegment('session-abc-123'), 'session-abc-123')
  eq(fork.encodeSegment('..'), '~002E~002E')
  eq(fork.encodeSegment('a b'), 'a~0020b')
})

// --------------------------------------------------------------- log building

check('buildMessages 只保留用户与助手正文', function () {
  const messages = fork.buildMessages(transcript)
  eq(messages.length, 4)
  eq(messages[0], { role: 'user', text: '面板白屏了' })
  eq(messages[1], { role: 'assistant', text: '把控制台报错发我' })
  eq(messages[3], { role: 'assistant', text: '这是折叠逻辑漏传参数\n\n两行就能修' })
})

check('buildMessages 把开头的助手消息补一条用户占位', function () {
  const messages = fork.buildMessages({ items: [{ t: 'assistant', blocks: [{ k: 'text', text: '你好' }] }] })
  eq(messages.length, 2)
  eq(messages[0].role, 'user')
  eq(messages[1], { role: 'assistant', text: '你好' })
})

check('buildTurns 每条用户消息一个 turn', function () {
  const turns = fork.buildTurns(fork.buildMessages(transcript))
  eq(turns.length, 2)
  eq(turns[0], { user: '面板白屏了', assistant: '把控制台报错发我' })
  eq(turns[1].user, 'think is not defined')
})

const built = fork.buildForkLog({
  transcript,
  cwd: 'D:\\GitHub\\dsh-lan-bridge',
  config,
  route: { provider: 'deepseek-official', model: 'deepseek-flash' },
  agentPreset: 'standard',
  now: 1800000000000
})

check('header 是 v4 普通会话', function () {
  const header = built.header
  eq(header.type, 'session')
  eq(header.version, 4)
  eq(header.cwd, 'D:\\GitHub\\dsh-lan-bridge')
  eq(header.isSeeded, false)
  eq(header.delegationDepth, 0)
  eq(header.agentPreset, 'standard')
  if (!/^session-[0-9a-f-]{36}$/.test(header.id)) throw new Error('id 形状不对：' + header.id)
})

check('事件 seq 从 0 严格递增', function () {
  let expected = 0
  for (const event of built.events) {
    eq(event.seq, expected, event.type + ' 的 seq')
    if (event.time !== 1800000000000) throw new Error(event.type + ' 的 time 不对')
    expected += 1
  }
  if (built.events.length !== 17) throw new Error('事件条数不对：' + built.events.length)
})

check('配置前缀按顺序写在最前面', function () {
  eq(built.events.slice(0, 4).map(function (event) { return event.type }), [
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'subagent/model-selection-policy'
  ])
})

check('turn / step 严格配对且从 1 开始', function () {
  let openTurn = 0
  let openStep = 0
  let turns = 0
  const stepsByTurn = {}
  for (const event of built.events) {
    if (event.type === 'turn/start') {
      if (openTurn !== 0) throw new Error('turn 嵌套')
      turns += 1
      eq(event.data.turn, turns, 'turn 序号')
      openTurn = event.data.turn
      continue
    }
    if (event.type === 'step/start') {
      if (openStep !== 0) throw new Error('step 嵌套')
      if (openTurn === 0) throw new Error('step 开在 turn 外')
      eq(event.data.turn, openTurn, 'step 所属 turn')
      stepsByTurn[event.data.turn] = (stepsByTurn[event.data.turn] || 0) + 1
      eq(event.data.step, stepsByTurn[event.data.turn], 'step 序号')
      openStep = event.data.step
      continue
    }
    if (event.type === 'step/end') {
      eq(openStep, event.data.step, 'step/end 对应 open step')
      eq(event.data.turn, openTurn, 'step/end 所属 turn')
      openStep = 0
      continue
    }
    if (event.type === 'turn/end') {
      if (openStep !== 0) throw new Error('turn 结束时 step 还开着')
      eq(event.data.turn, openTurn, 'turn/end 对应 open turn')
      eq(event.data.reason, { kind: 'completed' })
      openTurn = 0
    }
  }
  if (openTurn !== 0 || openStep !== 0) throw new Error('日志末尾有未关闭的 turn/step')
  eq(turns, 2, 'turn 数量')
})

check('assistant/message 只带 text 块且必须开在 step 内', function () {
  let inStep = false
  let assistants = 0
  for (const event of built.events) {
    if (event.type === 'step/start') inStep = true
    if (event.type === 'step/end') inStep = false
    if (event.type !== 'assistant/message') continue
    assistants += 1
    if (!inStep) throw new Error('assistant/message 不在 step 内')
    if (!Array.isArray(event.data.stream)) throw new Error('缺少 stream 数组')
    for (const block of event.data.message.content) {
      if (block.type !== 'text') throw new Error('出现了非 text 块：' + block.type)
    }
    if (!event.data.message.source || typeof event.data.message.source.provider !== 'string') {
      throw new Error('缺少 source.provider')
    }
  }
  eq(assistants, 2, 'assistant 消息数量')
})

check('session/title 引用更早的 user/message', function () {
  const title = built.events.find(function (event) { return event.type === 'session/title' })
  if (!title) throw new Error('没有 session/title')
  eq(title.data.messageSeqs.length, 1)
  const cited = built.events[title.data.messageSeqs[0]]
  eq(cited.type, 'user/message')
  eq(cited.data.source.kind, 'user')
  if (title.data.messageSeqs[0] >= title.seq) throw new Error('引用了自己之后的事件')
  eq(title.data.source.kind, 'fallback')
  if (title.data.title.indexOf('（fork）') < 0) throw new Error('标题缺少 fork 标记')
})

check('不写入 v4 禁止的内容（tool 事件、reasoning 块）', function () {
  for (const event of built.events) {
    if (event.type === 'tool/call' || event.type === 'tool/result') throw new Error('不该有 tool 事件')
    const blocks = (event.data && event.data.message && event.data.message.content) || (event.data && event.data.content) || []
    for (const block of blocks) {
      if (block.type === 'tool-result') throw new Error('v4 禁止 tool-result 块')
      if (block.type === 'reasoning') throw new Error('不该重放 reasoning')
    }
  }
})

// ------------------------------------------------------------ physical format

check('编码成两个独立 zstd 帧且可还原', function () {
  const bytes = fork.encodeSessionLog(built.header, built.events)
  const first = fork.frameEnd(bytes, 0)
  if (first <= 0) throw new Error('第一帧定位失败')
  const second = fork.frameEnd(bytes, first)
  if (second !== bytes.length) throw new Error('帧结束位置不等于文件长度：' + second + ' / ' + bytes.length)
  const headerText = zstdDecompressSync(bytes.subarray(0, first)).toString('utf8')
  const body = zstdDecompressSync(bytes.subarray(first, second)).toString('utf8')
  eq(JSON.parse(headerText.trim()).id, built.header.id)
  const lines = body.split('\n').filter(function (line) { return line.trim() !== '' })
  eq(lines.length, built.events.length)
  eq(JSON.parse(lines[0]).type, 'permission/preset')
  eq(JSON.parse(lines[lines.length - 1]).type, 'turn/end')
})

check('frameEnd 对截断数据返回 -1', function () {
  const bytes = fork.encodeSessionLog(built.header, built.events)
  const first = fork.frameEnd(bytes, 0)
  if (first <= 0) throw new Error('第一帧定位失败')
  eq(fork.frameEnd(bytes.subarray(0, 3), 0), -1)
  eq(fork.frameEnd(bytes.subarray(0, first - 1), 0), -1)
  eq(fork.frameEnd(bytes, first) > first, true)
})

// ------------------------------------------------------------------ disk flow

check('写盘路径与 DSH 的目录布局一致', function () {
  const written = fork.writeSessionLog(built.header, built.events)
  const expected = join(home, 'sessions', '--D-GitHub-dsh-lan-bridge--', built.header.id, 'session.v4.jsonl.zstd')
  eq(written.file, expected)
  if (!existsSync(expected)) throw new Error('文件没写出来')
  const bytes = readFileSync(expected)
  eq(bytes.length, written.bytes)
})

check('同一会话 id 不会被覆盖', function () {
  let threw = false
  try {
    fork.writeSessionLog(built.header, built.events)
  } catch (err) {
    threw = /EEXIST/.test(String(err && err.code)) || /exist/i.test(String(err && err.message))
  }
  if (!threw) throw new Error('第二次写没有报错')
})

check('listWorkspaces 从磁盘读回 cwd 与会话数', function () {
  const list = fork.listWorkspaces()
  eq(list.length, 1)
  eq(list[0].key, '--D-GitHub-dsh-lan-bridge--')
  eq(list[0].cwd, 'D:\\GitHub\\dsh-lan-bridge')
  eq(list[0].sessions, 1)
  eq(list[0].agentPreset, 'standard')
})

check('readHeadEvents 只解压前面的帧', function () {
  const list = fork.listWorkspaces()
  const head = fork.readHeadEvents(list[0].file, 3)
  eq(head.length, 3)
  eq(head[0].type, 'session')
  eq(head[1].type, 'permission/preset')
})

check('forkConversation 端到端写出一个新会话', function () {
  const result = fork.forkConversation({ conversation: transcript })
  eq(result.cwd, 'D:\\GitHub\\dsh-lan-bridge')
  eq(result.turns, 2)
  eq(result.messages, 4)
  if (result.sessionId === transcript.sessionId) throw new Error('不该复用原会话 id')
  if (!existsSync(result.file)) throw new Error('文件不存在：' + result.file)
  const workspaces = fork.listWorkspaces()
  eq(workspaces[0].sessions, 2, '工作区里的会话数')
  const head = fork.readHeadEvents(result.file, 1)
  eq(head[0].id, result.sessionId)
  eq(head[0].cwd, 'D:\\GitHub\\dsh-lan-bridge')
})

check('forkConversation 拒绝没有内容的会话', function () {
  let threw = false
  try {
    fork.forkConversation({ conversation: { items: [] } })
  } catch (err) {
    threw = /没有可 fork 的内容/.test(String(err && err.message))
  }
  if (!threw) throw new Error('空会话没有报错')
})

check('forkConversation 在没有工作区时给出可读错误', function () {
  const empty = mkdtempSync(join(tmpdir(), 'lan-fork-empty-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = empty
  let message = ''
  try {
    fork.forkConversation({ conversation: transcript })
  } catch (err) {
    message = String((err && err.message) || err)
  } finally {
    process.env.DSH_HOME = previous
    rmSync(empty, { recursive: true, force: true })
  }
  if (message.indexOf('还没有任何工作区') < 0) throw new Error('错误信息不对：' + message)
})

rmSync(home, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error('fork: ' + passed + '/' + (passed + failures.length) + ' 通过')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('fork: ' + passed + '/' + passed + ' 通过')
