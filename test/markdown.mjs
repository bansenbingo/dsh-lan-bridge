// Renders the markdown helpers that live inside client.js, without a browser.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const start = source.indexOf('// ------------------------------------------------------------ markdown')
const end = source.indexOf('// ---------------------------------------------------------- transcript')
if (start < 0 || end < 0 || end <= start) {
  console.error('FAIL: could not locate the markdown section in client.js')
  process.exit(1)
}
const slice = source.slice(start, end)

const C = {
  text: '#text',
  dim: '#dim',
  faint: '#faint',
  border: '#border',
  layer: '#layer',
  layer2: '#layer2',
  brand: '#brand',
  ok: '#ok',
  warn: '#warn',
  err: '#err',
  mono: 'monospace'
}
const h = function () {
  return null
}
const useMemo = function (fn) {
  return fn()
}

const factory = new Function('C', 'h', 'useMemo', slice + '\nreturn { mdToHtml: mdToHtml, inlineMd: inlineMd }')
const { mdToHtml, inlineMd } = factory(C, h, useMemo)

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

// headings
const h2 = mdToHtml('## 小标题')
check('h2 renders a block', h2.includes('小标题') && h2.indexOf('font-size:17px') >= 0, h2)
check('h1 larger than h3', mdToHtml('# t').indexOf('19px') >= 0 && mdToHtml('### t').indexOf('15.5px') >= 0)

// fenced code keeps markers literal
const fence = mdToHtml('```js\nconst a = **not bold**\n```')
check('fence becomes pre', fence.indexOf('<pre') === 0, fence)
check('fence body is escaped, not formatted', fence.indexOf('**not bold**') >= 0 && fence.indexOf('<strong>') < 0, fence)

// inline code
const inline = mdToHtml('use `a < b && c` here')
check('inline code escaped', inline.indexOf('a &lt; b &amp;&amp; c') >= 0, inline)
check('inline code styled', inline.indexOf('<code') >= 0, inline)

// bold / italic / strikethrough
check('bold', mdToHtml('**加粗**').indexOf('<strong>加粗</strong>') >= 0)
check('italic', mdToHtml('*斜体*').indexOf('<em>斜体</em>') >= 0)
check('strike', mdToHtml('~~删~~').indexOf('line-through') >= 0)

// lists
const ul = mdToHtml('- 一\n- 二\n- 三')
check('unordered list', ul.indexOf('<ul') === 0 && (ul.match(/<li/g) || []).length === 3, ul)
const ol = mdToHtml('1. 甲\n2. 乙')
check('ordered list', ol.indexOf('<ol') === 0 && (ol.match(/<li/g) || []).length === 2, ol)

// quote and hr
check('blockquote', mdToHtml('> 引用一句').indexOf('border-left') >= 0)
check('hr', mdToHtml('---').indexOf('<hr') >= 0)

// table
const table = mdToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |')
check('table head', table.indexOf('<th') >= 0, table)
check('table cell', table.indexOf('<td') >= 0 && table.indexOf('>1<') >= 0, table)

// escaping of raw html
const evil = mdToHtml('<script>alert(1)</script>')
check('script escaped', evil.indexOf('&lt;script&gt;') >= 0 && evil.indexOf('<script') < 0, evil)

// links
check('https link', mdToHtml('[文档](https://example.com/a)').indexOf('href="https://example.com/a"') >= 0)
check('javascript link dropped', mdToHtml('[x](javascript:alert(1))').indexOf('href') < 0)
check('bare url linked', mdToHtml('见 https://example.com/x 结束').indexOf('href="https://example.com/x"') >= 0)

// paragraph breaks
const para = mdToHtml('第一行\n第二行\n\n第二段')
check('soft newline becomes br', (para.match(/<br>/g) || []).length === 1, para)
check('blank line splits paragraphs', (para.match(/<div/g) || []).length === 2, para)

// plain text untouched value
check('inlineMd keeps plain text', inlineMd('普通文字').indexOf('普通文字') >= 0)
check('empty input', mdToHtml('') === '' && mdToHtml(null) === '')

console.log('')
console.log(passed + '/' + (passed + failed) + ' checks passed')
process.exit(failed === 0 ? 0 : 1)
