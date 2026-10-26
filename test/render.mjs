// Renders the transcript section of client.js with stub hooks, without a browser.
// 0.1.2 shipped a bare `think` identifier inside TranscriptItem: opening 对话 threw
// "ReferenceError: think is not defined" and the panel fell into its ErrorBoundary.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ? process.argv[2] : join(here, '..', 'client.js')
const source = readFileSync(target, 'utf8')

const start = source.indexOf('// ------------------------------------------------------------ primitives')
const transcriptEnd = source.indexOf('// ------------------------------------------------------------- 对话 tab')
const pluginsEnd = source.indexOf('// ------------------------------------------------------------- 插件 tab')
if (start < 0 || transcriptEnd < 0 || transcriptEnd <= start) {
  console.error('FAIL: could not locate the primitives..transcript section in ' + target)
  process.exit(1)
}
if (pluginsEnd < 0 || pluginsEnd <= transcriptEnd) {
  console.error('FAIL: could not locate the 对话 tab section end in ' + target)
  process.exit(1)
}
const slice = source.slice(start, pluginsEnd)

// ---- minimal React ----

function h(type, props) {
  const children = []
  for (let index = 2; index < arguments.length; index += 1) children.push(arguments[index])
  const merged = props ? Object.assign({}, props) : {}
  if (merged.children === undefined && children.length > 0) {
    merged.children = children.length === 1 ? children[0] : children
  }
  return { type, props: merged, children }
}
function useState(initial) {
  return [typeof initial === 'function' ? initial() : initial, function () {}]
}
function useEffect() {}
function useMemo(fn) {
  return fn()
}
function useRef(initial) {
  return { current: initial }
}
function useCallback(fn) {
  return fn
}

const factory = new Function(
  'h',
  'useState',
  'useEffect',
  'useMemo',
  'useRef',
  'useCallback',
  slice + '\nreturn { TranscriptItem: TranscriptItem, ConversationView: ConversationView, Fold: Fold }'
)
const mod = factory(h, useState, useEffect, useMemo, useRef, useCallback)
const Fold = mod.Fold

/** Expands function components the way React would, then walks the resulting tree. */
function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    node.forEach(function (child) {
      walk(child, visit)
    })
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node.type === 'function') {
    visit({ type: node.type, props: node.props })
    walk(node.type(node.props), visit)
    return
  }
  visit({ type: node.type, props: node.props })
  node.children.forEach(function (child) {
    walk(child, visit)
  })
}

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error('FAIL ' + name + (detail ? ': ' + detail : ''))
}

const assistant = {
  t: 'assistant',
  blocks: [
    { k: 'reasoning', text: '先看一下上下文。' },
    { k: 'tool-call', name: 'read', id: 'call_abc', args: '{"file":"a.js"}' },
    { k: 'text', text: '## 结论\n\n**可以**。' }
  ]
}

const conversation = {
  sessionId: 's1',
  title: '测试对话',
  machineId: 'm1',
  machineName: 'PC',
  updatedAt: Date.now(),
  items: [
    { t: 'turn', n: 1 },
    { t: 'user', text: '你好', source: 'user' },
    { t: 'step', n: 1 },
    assistant,
    { t: 'tool-result', text: '文件内容', callId: 'call_abc', isError: false },
    { t: 'system', text: '系统提示' }
  ]
}

// 1. the crash from 0.1.2: rendering a conversation must not throw
let viewError = null
let viewTree = null
try {
  viewTree = mod.ConversationView({ conversation: conversation })
  const nodes = []
  const rendered = h('div', null, viewTree)
  walk(rendered, function (node) {
    nodes.push(node)
  })
  check('conversation renders every item', nodes.length > 0)
} catch (error) {
  viewError = error
}
check('assistant transcript renders without throwing', viewError === null, viewError && viewError.message)

// 2. the reasoning block receives the folding state from ConversationView
const folds = []
if (viewTree) {
  try {
    walk(h('div', null, viewTree), function (node) {
      if (node.type === Fold && node.props.title === '思考链') folds.push(node.props)
    })
  } catch (error) {
    check('conversation walk does not throw', false, error.message)
  }
}
check('reasoning block is rendered', folds.length === 1, 'found ' + folds.length)
if (folds.length === 1) {
  check('fold default state comes from think.open', folds[0].forceOpen === false, String(folds[0].forceOpen))
  check('fold generation comes from think.gen', folds[0].gen === 0, String(folds[0].gen))
}

// 3. TranscriptItem forwards an explicit think value straight through
const explicit = []
try {
  walk(h(mod.TranscriptItem, { item: assistant, think: { open: true, gen: 3 } }), function (node) {
    if (node.type === Fold && node.props.title === '思考链') explicit.push(node.props)
  })
} catch (error) {
  check('explicit think walk does not throw', false, error.message)
}
check('explicit think reaches the reasoning fold', explicit.length === 1, 'found ' + explicit.length)
if (explicit.length === 1) {
  check('explicit think.open reaches forceOpen', explicit[0].forceOpen === true, String(explicit[0].forceOpen))
  check('explicit think.gen reaches gen', explicit[0].gen === 3, String(explicit[0].gen))
}

// 4. the 对话 tab renders the fork toolbar once a conversation is open.
//    useState is fed fixed values in hook order so the open branch is reachable.
const row = {
  machineId: 'm1',
  machineName: 'PC',
  sessionId: 's1',
  title: '测试对话',
  cwd: 'D:\\GitHub\\x',
  updatedAt: Date.now(),
  items: 3,
  mine: true
}
const forced = [
  [row],
  false,
  '',
  '',
  '',
  row,
  conversation,
  '',
  [{ key: '--D-GitHub-x--', cwd: 'D:\\GitHub\\x', sessions: 2, updatedAt: Date.now() }],
  '--D-GitHub-x--',
  false,
  '',
  ''
]
let cursor = 0
function useStateForced(initial) {
  if (cursor < forced.length) return [forced[cursor++], function () {}]
  return [typeof initial === 'function' ? initial() : initial, function () {}]
}
const tabFactory = new Function(
  'h',
  'useState',
  'useEffect',
  'useMemo',
  'useRef',
  'useCallback',
  slice + '\nreturn { ConversationsTab: ConversationsTab }'
)
const tabMod = tabFactory(h, useStateForced, useEffect, useMemo, useRef, useCallback)

let tabError = null
const tabNodes = []
let tabFolds = 0
try {
  walk(h(tabMod.ConversationsTab, { status: { machines: [] } }), function (node) {
    tabNodes.push(node)
    if (node.props.title === '思考链' && node.props.forceOpen !== undefined) tabFolds += 1
  })
} catch (error) {
  tabError = error
}
check('对话 tab renders with a conversation open', tabError === null, tabError && tabError.message)

/** Concatenates the text under a node, expanding function components like walk does. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  if (Array.isArray(node.children) && node.children.length > 0) return node.children.map(textOf).join('')
  return textOf(node.props.children)
}

const selects = tabNodes.filter(function (node) {
  return node.type === 'select'
})
check('对话 tab renders its machine filter and fork picker', selects.length === 2, 'found ' + selects.length)
const pickers = selects.filter(function (node) {
  const options = []
  ;(function collect(node) {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      node.forEach(collect)
      return
    }
    if (typeof node.type === 'function') {
      collect(node.type(node.props))
      return
    }
    if (node.type === 'option') {
      options.push(node.props.value)
      return
    }
    if (Array.isArray(node.props.children)) node.props.children.forEach(collect)
  })(node.props.children)
  return options.indexOf('--D-GitHub-x--') >= 0
})
check('fork toolbar renders a workspace picker', pickers.length === 1, 'found ' + pickers.length)

const forkButtons = tabNodes.filter(function (node) {
  return node.type === 'button' && textOf(node.props.children) === 'Fork'
})
check('fork button renders when a workspace is selected', forkButtons.length === 1, 'found ' + forkButtons.length)
if (forkButtons.length === 1) {
  check('fork button is enabled for a ready conversation', forkButtons[0].props.disabled === false)
}
check('opened conversation still renders its transcript', tabFolds === 1, 'found ' + tabFolds)

console.log(passed + '/' + (passed + failed) + ' checks passed')
if (failed > 0) process.exit(1)
