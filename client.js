/**
 * dsh-lan-bridge — browser half.
 *
 * One sidebar entry ("局域网") that opens a single tabbed panel. All data comes
 * from `/_dsh/lan/*` on this origin, so no host, port or token ever reaches the
 * page: the host half owns the LAN traffic.
 *
 * Tabs:
 *   对话  every conversation in the shared store, with chain of thought, tool
 *         calls and tool output rendered in order
 *   插件  this machine's plugin list, the peers' published lists, one-click
 *         apply, install, enable/disable
 *   文件  browse and edit workspace files here or on the peer
 *   记忆  MEMORY.md / USER.md on both sides, with explicit take/push
 *   设置  pairing (hub or peer), discovery, sync plan, shared roots, audit
 */

window.__ModuleLoader__.load({
  id: 'dsh-lan-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useMemo = React.useMemo
    const useRef = React.useRef

    const PREFIX = '/_dsh/lan'

    // ------------------------------------------------------------ primitives

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8eaed)',
      dim: 'var(--dsw-alias-label-secondary, #9aa0a6)',
      faint: 'var(--dsw-alias-label-tertiary, #6b7076)',
      border: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.10))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.03))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))',
      brand: 'var(--dsw-alias-brand-primary, #7aa2f7)',
      ok: 'var(--dsw-alias-state-success-primary, #6cc070)',
      warn: 'var(--dsw-alias-state-warning-primary, #e0af68)',
      err: 'var(--dsw-alias-state-error-primary, #f7768e)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.text, fontSize: 13 },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid ' + C.border,
        flexShrink: 0
      },
      tabs: {
        display: 'flex',
        gap: 2,
        padding: '6px 10px',
        borderBottom: '1px solid ' + C.border,
        flexShrink: 0,
        flexWrap: 'wrap'
      },
      tab: {
        appearance: 'none',
        border: '1px solid transparent',
        background: 'transparent',
        color: C.dim,
        padding: '5px 11px',
        borderRadius: 7,
        cursor: 'pointer',
        fontSize: 12.5,
        fontFamily: 'inherit'
      },
      tabOn: {
        color: C.text,
        background: C.layer2,
        border: '1px solid ' + C.border
      },
      body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      card: { border: '1px solid ' + C.border, background: C.layer, borderRadius: 10, padding: 12 },
      label: { fontSize: 11.5, color: C.dim, marginBottom: 4, display: 'block' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: C.layer,
        border: '1px solid ' + C.border,
        color: C.text,
        borderRadius: 7,
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: 12.5,
        outline: 'none'
      },
      btn: {
        appearance: 'none',
        border: '1px solid ' + C.border,
        background: C.layer2,
        color: C.text,
        borderRadius: 7,
        padding: '5px 11px',
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap'
      },
      btnPrimary: {
        appearance: 'none',
        border: '1px solid ' + C.brand,
        background: C.brand,
        color: '#0b1020',
        borderRadius: 7,
        padding: '5px 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        fontWeight: 600,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap'
      },
      btnDanger: {
        appearance: 'none',
        border: '1px solid ' + C.err,
        background: 'transparent',
        color: C.err,
        borderRadius: 7,
        padding: '5px 11px',
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit'
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid ' + C.border,
        color: C.dim
      },
      dot: { width: 6, height: 6, borderRadius: 3, display: 'inline-block' },
      mono: { fontFamily: C.mono, fontSize: 12 },
      scroll: { overflow: 'auto', minHeight: 0 },
      muted: { color: C.dim, fontSize: 12 },
      faint: { color: C.faint, fontSize: 11.5 },
      err: { color: C.err, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      ok: { color: C.ok, fontSize: 12 }
    }

    function fmtTime(value) {
      if (!value) return ''
      try {
        const date = new Date(value)
        const now = Date.now()
        const diff = now - value
        if (diff < 60000) return '刚刚'
        if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前'
        if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前'
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString().slice(0, 5)
      } catch (err) {
        return ''
      }
    }

    function fmtBytes(value) {
      const n = typeof value === 'number' ? value : 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    async function api(path, options) {
      const opts = options || {}
      const init = { method: opts.method || 'GET', headers: { accept: 'application/json' } }
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      const response = await fetch(PREFIX + path, init)
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        body = null
      }
      if (!response.ok) {
        const message = (body && body.error && body.error.message) || 'HTTP ' + response.status
        const error = new Error(message)
        error.code = (body && body.error && body.error.code) || 'HTTP_' + response.status
        throw error
      }
      return body
    }

    function Text(props) {
      return h('div', { style: Object.assign({}, props.style) }, props.children)
    }

    function Btn(props) {
      const style = props.primary ? S.btnPrimary : props.danger ? S.btnDanger : S.btn
      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, style, props.disabled ? { opacity: 0.5, cursor: 'default' } : null, props.style),
          disabled: props.disabled === true,
          onClick: props.disabled ? undefined : props.onClick,
          title: props.title
        },
        props.children
      )
    }

    function Field(props) {
      return h(
        'label',
        { style: { display: 'block', marginBottom: 10 } },
        h('span', { style: S.label }, props.label),
        props.children
      )
    }

    /** Collapsible block used for reasoning, tool arguments and tool output. */
    function Fold(props) {
      const [open, setOpen] = useState(props.defaultOpen === true)
      const count = typeof props.chars === 'number' ? props.chars : 0
      const forceOpen = props.forceOpen
      const gen = typeof props.gen === 'number' ? props.gen : 0
      useEffect(
        function () {
          if (typeof forceOpen === 'boolean') setOpen(forceOpen)
        },
        [gen]
      )
      return h(
        'div',
        { style: { margin: '6px 0' } },
        h(
          'button',
          {
            type: 'button',
            onClick: function () {
              setOpen(!open)
            },
            style: {
              appearance: 'none',
              border: '1px solid ' + (props.tone || C.border),
              background: 'transparent',
              color: props.color || C.dim,
              borderRadius: 7,
              padding: '3px 9px',
              fontSize: 11.5,
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }
          },
          h('span', null, open ? '▾' : '▸'),
          h('span', null, props.title),
          count > 0 ? h('span', { style: { color: C.faint } }, fmtBytes(count)) : null
        ),
        open
          ? h(
              'pre',
              {
                style: Object.assign(
                  {
                    margin: '6px 0 0',
                    padding: 10,
                    background: C.layer,
                    border: '1px solid ' + C.border,
                    borderRadius: 8,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: C.mono,
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    maxHeight: 420,
                    overflow: 'auto'
                  },
                  props.preStyle
                )
              },
              props.children
            )
          : null
      )
    }

    function prettyJson(text) {
      if (typeof text !== 'string' || text === '') return ''
      try {
        return JSON.stringify(JSON.parse(text), null, 2)
      } catch (err) {
        return text
      }
    }

    // ------------------------------------------------------------ markdown

    function escHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    /** 这些属性的数字值本来就无单位，加 px 会让浏览器整条声明作废（line-height:1.62px → 行挤出屏幕）。 */
    const UNITLESS = {
      lineHeight: 1,
      fontWeight: 1,
      opacity: 1,
      zIndex: 1,
      flex: 1,
      flexGrow: 1,
      flexShrink: 1,
      order: 1,
      zoom: 1,
      lineClamp: 1,
      WebkitLineClamp: 1,
      aspectRatio: 1,
      tabSize: 1,
      columnCount: 1,
      fillOpacity: 1,
      strokeOpacity: 1,
      strokeWidth: 1
    }

    function css(obj) {
      const parts = []
      for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue
        const raw = obj[key]
        if (raw == null || raw === '') continue
        const value = typeof raw === 'number' ? (UNITLESS[key] ? String(raw) : raw + 'px') : raw
        parts.push(key.replace(/[A-Z]/g, function (mark) { return '-' + mark.toLowerCase() }) + ':' + value)
      }
      return parts.join(';')
    }

    const MD = {
      p: { margin: '0 0 8px', lineHeight: 1.62 },
      h: { fontWeight: 640, margin: '14px 0 6px', lineHeight: 1.4, color: C.text },
      code: {
        fontFamily: C.mono,
        fontSize: 12,
        background: C.layer2,
        border: '1px solid ' + C.border,
        borderRadius: 4,
        padding: '0 4px'
      },
      pre: {
        margin: '6px 0 10px',
        padding: 10,
        background: C.layer,
        border: '1px solid ' + C.border,
        borderRadius: 8,
        overflow: 'auto',
        fontFamily: C.mono,
        fontSize: 11.5,
        lineHeight: 1.5
      },
      quote: { margin: '6px 0 10px', padding: '2px 0 2px 10px', borderLeft: '3px solid ' + C.border, color: C.dim },
      list: { margin: '0 0 8px', paddingLeft: 20 },
      listNest: { margin: '2px 0 2px', paddingLeft: 18 },
      li: { margin: '2px 0', lineHeight: 1.6 },
      hr: { border: 'none', borderTop: '1px solid ' + C.border, margin: '12px 0' },
      link: { color: C.brand, textDecoration: 'none' },
      tableWrap: { margin: '6px 0 10px', maxWidth: '100%', overflowX: 'auto' },
      table: { borderCollapse: 'collapse', fontSize: 12 },
      cell: { border: '1px solid ' + C.border, padding: '4px 8px', textAlign: 'left', verticalAlign: 'top' },
      headCell: { border: '1px solid ' + C.border, padding: '4px 8px', textAlign: 'left', fontWeight: 640, background: C.layer2 }
    }

    const MD_HEAD_SIZE = { 1: 19, 2: 17, 3: 15.5, 4: 14, 5: 13.5, 6: 13 }

    /** Inline markdown: code spans, links, bold, italic, strikethrough. Input is escaped first. */
    function inlineMd(raw) {
      const text0 = String(raw == null ? '' : raw)
      if (text0 === '') return ''
      const held = []
      const hold = function (html) {
        held.push(html)
        return '\u0000' + (held.length - 1) + '\u0000'
      }
      let text = escHtml(text0)

      text = text.replace(/`([^`\n]+)`/g, function (match, code) {
        return hold('<code style="' + css(MD.code) + '">' + code + '</code>')
      })
      text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (match, alt) {
        return hold('<span style="' + css({ color: C.faint }) + '">[图片' + (alt ? ' ' + alt : '') + ']</span>')
      })
      text = text.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, function (match, label, href) {
        if (!/^(https?:|mailto:)/i.test(href)) return label
        return hold('<a href="' + href + '" target="_blank" rel="noreferrer" style="' + css(MD.link) + '">' + label + '</a>')
      })
      text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+)/g, function (match, lead, href) {
        return lead + hold('<a href="' + href + '" target="_blank" rel="noreferrer" style="' + css(MD.link) + '">' + href + '</a>')
      })
      text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      text = text.replace(/~~([^~]+)~~/g, '<span style="text-decoration:line-through">$1</span>')
      text = text.replace(/\u0000(\d+)\u0000/g, function (match, index) {
        return held[Number(index)] || ''
      })
      return text
    }

    function startsBlock(line) {
      return (
        /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
        /^\s{0,3}#{1,6}\s+/.test(line) ||
        /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line) ||
        /^\s{0,3}>/.test(line) ||
        /^\s*([-*+]|\d{1,3}[.)])\s+/.test(line)
      )
    }

    function splitRow(row) {
      return row
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map(function (cell) {
          return cell.trim()
        })
    }

    const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/

    function indentOf(space) {
      return space.replace(/\t/g, '  ').length
    }

    /** A row followed by a | --- | delimiter line starts a table. */
    function isTableStart(lines, at) {
      if (at + 1 >= lines.length) return false
      const next = lines[at + 1]
      return lines[at].indexOf('|') >= 0 && next.indexOf('-') >= 0 && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next)
    }

    function tableAlign(cell) {
      const left = cell.charAt(0) === ':'
      const right = cell.charAt(cell.length - 1) === ':'
      if (left && right) return 'center'
      if (right) return 'right'
      return 'left'
    }

    /**
     * Parses one list starting at lines[at]. Deeper indents become a real child list
     * inside the previous item instead of being flattened into one flat <ul>.
     */
    function parseList(lines, at, depth) {
      const first = LIST_ITEM.exec(lines[at])
      const base = indentOf(first[1])
      const ordered = /\d/.test(first[2])
      const start = ordered ? parseInt(first[2], 10) : 1
      const items = []
      let index = at
      while (index < lines.length) {
        const line = lines[index]
        if (/^\s*$/.test(line)) {
          let look = index + 1
          while (look < lines.length && /^\s*$/.test(lines[look])) look += 1
          if (look >= lines.length) break
          const after = LIST_ITEM.exec(lines[look])
          if (!after || indentOf(after[1]) < base) break
          index = look
          continue
        }
        const hit = LIST_ITEM.exec(line)
        if (!hit) {
          if (items.length > 0 && /^\s{2,}\S/.test(line) && !startsBlock(line)) {
            items[items.length - 1].html += '<br>' + inlineMd(line.trim())
            index += 1
            continue
          }
          break
        }
        const indent = indentOf(hit[1])
        if (indent < base) break
        if (indent > base) {
          const child = parseList(lines, index, depth + 1)
          if (child.next === index || items.length === 0) break
          items[items.length - 1].children.push(child.html)
          index = child.next
          continue
        }
        if (/\d/.test(hit[2]) !== ordered) break
        items.push({ html: inlineMd(hit[3]), children: [] })
        index += 1
      }
      return { html: renderList(ordered, start, items, depth), next: index }
    }

    function renderList(ordered, start, items, depth) {
      const tag = ordered ? 'ol' : 'ul'
      const attrs = ordered && start !== 1 ? ' start="' + start + '"' : ''
      const style = css(depth > 0 ? MD.listNest : MD.list)
      return (
        '<' +
        tag +
        attrs +
        ' style="' +
        style +
        '">' +
        items
          .map(function (item) {
            return '<li style="' + css(MD.li) + '">' + item.html + item.children.join('') + '</li>'
          })
          .join('') +
        '</' +
        tag +
        '>'
      )
    }

    /** Small markdown to HTML renderer: headings, fences, lists, quotes, tables, inline styles. */
    function mdToHtml(source) {
      const lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n')
      const html = []
      const blank = function (line) {
        return /^\s*$/.test(line)
      }
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (blank(line)) {
          index += 1
          continue
        }

        const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line)
        if (fence) {
          const marker = fence[1]
          const body = []
          index += 1
          while (index < lines.length && lines[index].trim().indexOf(marker) !== 0) {
            body.push(lines[index])
            index += 1
          }
          if (index < lines.length) index += 1
          html.push('<pre style="' + css(MD.pre) + '"><code>' + escHtml(body.join('\n')) + '</code></pre>')
          continue
        }

        const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
        if (heading) {
          const level = heading[1].length
          // 首块不留上边距，否则每条消息开头都会空一大截
          const margin = html.length === 0 ? '0 0 6px' : '14px 0 6px'
          html.push(
            '<div style="' +
              css(Object.assign({}, MD.h, { margin: margin, fontSize: MD_HEAD_SIZE[level] })) +
              '">' +
              inlineMd(heading[2]) +
              '</div>'
          )
          index += 1
          continue
        }

        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          html.push('<hr style="' + css(MD.hr) + '">')
          index += 1
          continue
        }

        if (/^\s{0,3}>/.test(line)) {
          const body = []
          while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
            body.push(lines[index].replace(/^\s{0,3}>\s?/, ''))
            index += 1
          }
          html.push(
            '<div style="' +
              css(MD.quote) +
              '">' +
              body
                .map(inlineMd)
                .join('<br>') +
              '</div>'
          )
          continue
        }

        if (isTableStart(lines, index)) {
          const head = splitRow(line)
          const aligns = splitRow(lines[index + 1]).map(tableAlign)
          index += 2
          const rows = []
          while (index < lines.length && lines[index].indexOf('|') >= 0 && !blank(lines[index])) {
            rows.push(splitRow(lines[index]))
            index += 1
          }
          const cellStyle = function (at, extra) {
            return css(Object.assign({}, extra, { textAlign: aligns[at] || 'left' }))
          }
          html.push(
            '<div style="' +
              css(MD.tableWrap) +
              '"><table style="' +
              css(MD.table) +
              '"><thead><tr>' +
              head
                .map(function (cell, at) {
                  return '<th style="' + cellStyle(at, MD.headCell) + '">' + inlineMd(cell) + '</th>'
                })
                .join('') +
              '</tr></thead><tbody>' +
              rows
                .map(function (row) {
                  const cells = []
                  for (let at = 0; at < Math.max(head.length, row.length); at += 1) {
                    cells.push('<td style="' + cellStyle(at, MD.cell) + '">' + inlineMd(row[at] == null ? '' : row[at]) + '</td>')
                  }
                  return '<tr>' + cells.join('') + '</tr>'
                })
                .join('') +
              '</tbody></table></div>'
          )
          continue
        }

        if (LIST_ITEM.test(line)) {
          const list = parseList(lines, index, 0)
          html.push(list.html)
          index = list.next
          continue
        }

        const para = [inlineMd(line)]
        index += 1
        while (index < lines.length && !blank(lines[index]) && !startsBlock(lines[index]) && !isTableStart(lines, index)) {
          para.push(inlineMd(lines[index]))
          index += 1
        }
        html.push('<div style="' + css(MD.p) + '">' + para.join('<br>') + '</div>')
      }
      return html.join('')
    }

    /** Renders markdown produced on the peer machine. */
    function Md(props) {
      const html = useMemo(
        function () {
          return mdToHtml(props.text)
        },
        [props.text]
      )
      return h('div', {
        style: { lineHeight: 1.62, fontSize: 13, wordBreak: 'break-word' },
        dangerouslySetInnerHTML: { __html: html }
      })
    }

    // ---------------------------------------------------------- transcript

    function Block(props) {
      const block = props.block
      const think = props.think
      if (block.k === 'reasoning') {
        return h(
          Fold,
          {
            title: '思考链',
            chars: block.text.length,
            tone: C.warn,
            color: C.warn,
            defaultOpen: false,
            forceOpen: think ? think.open : undefined,
            gen: think ? think.gen : 0
          },
          block.text
        )
      }
      if (block.k === 'tool-call') {
        return h(
          'div',
          { style: { margin: '6px 0' } },
          h(
            'div',
            { style: { fontSize: 11.5, color: C.brand, fontFamily: C.mono, marginBottom: 2 } },
            '⚙ ' + block.name + (block.id ? '  ' + String(block.id).slice(0, 14) : '')
          ),
          h(Fold, { title: '调用参数', chars: block.args.length, defaultOpen: false }, prettyJson(block.args))
        )
      }
      if (block.k === 'image') {
        return h('div', { style: S.faint }, '[图片 ' + (block.note || '') + ']')
      }
      return h('div', { style: { margin: '4px 0' } }, h(Md, { text: block.text }))
    }

    function TranscriptItem(props) {
      const item = props.item
      const think = props.think
      if (item.t === 'turn') {
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 6px' } },
          h('div', { style: { flex: 1, height: 1, background: C.border } }),
          h('span', { style: { fontSize: 11, color: C.faint } }, '第 ' + item.n + ' 轮'),
          h('div', { style: { flex: 1, height: 1, background: C.border } })
        )
      }
      if (item.t === 'step') {
        return h('div', { style: { fontSize: 11, color: C.faint, margin: '8px 0 2px' } }, 'step ' + String(item.n))
      }
      if (item.t === 'user') {
        const approval = item.source && item.source !== 'user'
        return h(
          'div',
          {
            style: {
              margin: '10px 0',
              padding: '9px 12px',
              borderRadius: 10,
              border: '1px solid ' + C.border,
              background: approval ? 'transparent' : C.layer2
            }
          },
          h(
            'div',
            { style: { fontSize: 11, color: approval ? C.faint : C.brand, marginBottom: 4 } },
            approval ? '系统 · ' + item.source : '我'
          ),
          h(
            'div',
            { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.62, fontSize: 13 } },
            item.text
          )
        )
      }
      if (item.t === 'assistant') {
        return h(
          'div',
          { style: { margin: '8px 0 10px' } },
          h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 2 } }, '助手'),
          (item.blocks || []).map(function (block, index) {
            return h(Block, { key: 'b' + index, block: block, think: think })
          })
        )
      }
      if (item.t === 'tool-result') {
        return h(
          'div',
          { style: { margin: '4px 0 10px 12px' } },
          h(
            Fold,
            {
              title: (item.isError ? '✕ 工具输出（错误）' : '✓ 工具输出') + (item.callId ? '  ' + String(item.callId).slice(0, 14) : ''),
              chars: (item.text || '').length,
              tone: item.isError ? C.err : C.ok,
              color: item.isError ? C.err : C.ok,
              defaultOpen: item.isError === true
            },
            item.text || ''
          )
        )
      }
      if (item.t === 'system') {
        return h(Fold, { title: '系统提示', chars: item.text.length }, item.text)
      }
      if (item.t === 'command') {
        return h('div', { style: { fontSize: 11.5, color: C.dim, fontFamily: C.mono, margin: '4px 0' } }, '/ ' + item.name + ' ' + item.args)
      }
      return null
    }

    function ConversationView(props) {
      const conversation = props.conversation
      const items = conversation.items || []
      const [think, setThink] = useState({ open: false, gen: 0 })
      const thinkCount = items.reduce(function (total, item) {
        if (item.t !== 'assistant') return total
        return (
          total +
          (item.blocks || []).filter(function (block) {
            return block.k === 'reasoning'
          }).length
        )
      }, 0)
      const wrap = useRef(null)
      useEffect(
        function () {
          if (wrap.current) wrap.current.scrollTop = 0
        },
        [conversation.sessionId]
      )
      return h(
        'div',
        { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
        h(
          'div',
          { style: { padding: '10px 16px', borderBottom: '1px solid ' + C.border, flexShrink: 0 } },
          h('div', { style: { fontWeight: 600, fontSize: 13.5, wordBreak: 'break-word' } }, conversation.title || '(无标题)'),
          h(
            'div',
            { style: Object.assign({}, S.faint, { marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }) },
            h('span', null, '来自 ' + (conversation.machineName || conversation.machineId)),
            h('span', null, fmtTime(conversation.updatedAt)),
            h('span', null, items.length + ' 段'),
            conversation.cwd ? h('span', { style: { fontFamily: C.mono } }, conversation.cwd) : null
          ),
          h(
            'div',
            { style: { marginTop: 7, display: 'flex', gap: 8, alignItems: 'center' } },
            h(
              'button',
              {
                type: 'button',
                disabled: thinkCount === 0,
                onClick: function () {
                  setThink(function (prev) {
                    return { open: !prev.open, gen: prev.gen + 1 }
                  })
                },
                style: Object.assign({}, S.btn, {
                  padding: '2px 9px',
                  fontSize: 11,
                  opacity: thinkCount === 0 ? 0.45 : 1,
                  cursor: thinkCount === 0 ? 'default' : 'pointer'
                }),
                title: '一键折叠或展开本次对话的全部思考链'
              },
              think.open ? '折叠全部思考' : '展开全部思考'
            ),
            h(
              'span',
              { style: S.faint },
              thinkCount === 0 ? '本次对话没有思考内容' : thinkCount + ' 段思考链 · 正文按 Markdown 渲染'
            )
          )
        ),
        h(
          'div',
          { ref: wrap, style: Object.assign({}, S.scroll, { flex: 1, padding: '4px 18px 40px' }) },
          items.length === 0 ? h('div', { style: S.muted }, '这条会话还没有可显示的内容。') : items.map(function (item, index) {
            return h(TranscriptItem, { key: 'i' + index, item: item, think: think })
          })
        )
      )
    }

    // ------------------------------------------------------------- 对话 tab

    function ConversationsTab(props) {
      const status = props.status
      const [rows, setRows] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [query, setQuery] = useState('')
      const [machine, setMachine] = useState('')
      const [open, setOpen] = useState(null)
      const [conversation, setConversation] = useState(null)
      const [convError, setConvError] = useState('')
      const [workspaces, setWorkspaces] = useState([])
      const [target, setTarget] = useState('')
      const [forking, setForking] = useState(false)
      const [forkNote, setForkNote] = useState('')
      const [forkError, setForkError] = useState('')

      const load = useCallback(function () {
        setLoading(true)
        const params = []
        if (machine) params.push('machine=' + encodeURIComponent(machine))
        if (query.trim()) params.push('q=' + encodeURIComponent(query.trim()))
        api('/conversations' + (params.length ? '?' + params.join('&') : ''))
          .then(function (body) {
            setRows(body.conversations || [])
            setError('')
          })
          .catch(function (err) {
            setError(String(err.message || err))
          })
          .finally(function () {
            setLoading(false)
          })
      }, [machine, query])

      useEffect(
        function () {
          load()
        },
        [load, props.tick]
      )

      const openConversation = function (row) {
        setOpen(row)
        setConversation(null)
        setConvError('')
        setForkNote('')
        setForkError('')
        api('/conversation?machine=' + encodeURIComponent(row.machineId) + '&id=' + encodeURIComponent(row.sessionId))
          .then(function (body) {
            setConversation(body.conversation)
          })
          .catch(function (err) {
            setConvError(String(err.message || err))
          })
      }

      useEffect(
        function () {
          api('/workspaces')
            .then(function (body) {
              const list = body.workspaces || []
              setWorkspaces(list)
              setTarget(function (previous) {
                if (previous && list.some(function (row) { return row.key === previous })) return previous
                return list.length > 0 ? list[0].key : ''
              })
            })
            .catch(function () {
              setWorkspaces([])
            })
        },
        [props.tick]
      )

      const doFork = function () {
        if (!open || !conversation) return
        setForking(true)
        setForkNote('')
        setForkError('')
        api('/fork', { method: 'POST', body: { machine: open.machineId, id: open.sessionId, workspace: target } })
          .then(function (body) {
            const result = (body && body.fork) || {}
            const rounds = String(result.turns || 0)
            const name = result.title || ''
            setForkNote(
              result.attached
                ? '已挂进工作区 ' + (result.cwd || '') + '（' + rounds + ' 轮）。刷新一下页面，侧栏里就能看到「' + name + '」。'
                : '已写入 ' + (result.cwd || '') + '（' + rounds + ' 轮）。重启 DSH 后侧栏里就能看到「' + name + '」，点开继续聊。'
            )

          })
          .catch(function (err) {
            setForkError(String(err.message || err))
          })
          .finally(function () {
            setForking(false)
          })
      }

      const machines = (status && status.machines) || []

      return h(
        'div',
        { style: { display: 'flex', flex: 1, minHeight: 0 } },
        h(
          'div',
          {
            style: {
              width: 300,
              flexShrink: 0,
              borderRight: '1px solid ' + C.border,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0
            }
          },
          h(
            'div',
            { style: { padding: 10, borderBottom: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('input', {
              style: S.input,
              placeholder: '搜索标题或路径',
              value: query,
              onChange: function (event) {
                setQuery(event.target.value)
              }
            }),
            h(
              'select',
              {
                style: S.input,
                value: machine,
                onChange: function (event) {
                  setMachine(event.target.value)
                }
              },
              h('option', { value: '' }, '全部电脑'),
              machines.map(function (row) {
                return h('option', { key: row.machineId, value: row.machineId }, row.machineName + ' (' + row.conversations + ')')
              })
            ),
            h(
              'div',
              { style: Object.assign({}, S.faint, { display: 'flex', justifyContent: 'space-between' }) },
              h('span', null, loading ? '读取中…' : rows.length + ' 条会话'),
              h(Btn, { onClick: load, style: { padding: '2px 8px', fontSize: 11 } }, '刷新')
            ),
            error ? h('div', { style: S.err }, error) : null
          ),
          h(
            'div',
            { style: Object.assign({}, S.scroll, { flex: 1 }) },
            rows.length === 0
              ? h('div', { style: Object.assign({}, S.muted, { padding: 14 }) }, '还没有同步到任何会话。在另一台电脑上提问后，等几秒或点「立即同步」。')
              : rows.map(function (row) {
                  const active = open && open.sessionId === row.sessionId
                  return h(
                    'button',
                    {
                      key: row.machineId + '/' + row.sessionId,
                      type: 'button',
                      onClick: function () {
                        openConversation(row)
                      },
                      style: {
                        appearance: 'none',
                        textAlign: 'left',
                        width: '100%',
                        border: 'none',
                        borderBottom: '1px solid ' + C.border,
                        background: active ? C.layer2 : 'transparent',
                        color: C.text,
                        padding: '9px 11px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        display: 'block'
                      }
                    },
                    h(
                      'div',
                      { style: { fontSize: 12.5, lineHeight: 1.4, wordBreak: 'break-word' } },
                      row.title || '(无标题)'
                    ),
                    h(
                      'div',
                      { style: Object.assign({}, S.faint, { marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }) },
                      row.mine ? h('span', { style: { color: C.ok } }, '本机') : h('span', null, row.machineName || row.machineId),
                      h('span', null, fmtTime(row.updatedAt)),
                      h('span', null, String(row.items) + ' 段')
                    )
                  )
                })
          )
        ),
        open
          ? h(
              'div',
              { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 } },
              h(
                'div',
                {
                  style: {
                    padding: '8px 12px',
                    borderBottom: '1px solid ' + C.border,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap'
                  }
                },
                h('span', { style: { fontSize: 11.5, color: C.dim } }, 'Fork 到本机工作区'),
                h(
                  'select',
                  {
                    style: Object.assign({}, S.input, { width: 260, marginBottom: 0 }),
                    value: target,
                    onChange: function (event) {
                      setTarget(event.target.value)
                    }
                  },
                  workspaces.length === 0
                    ? h('option', { value: '' }, '本机没有可用工作区')
                    : workspaces.map(function (row) {
                        return h(
                          'option',
                          { key: row.key, value: row.key },
                          row.cwd + ' · ' + String(row.sessions) + ' 条会话'
                        )
                      })
                ),
                h(
                  Btn,
                  { primary: true, disabled: forking || !conversation || !target, onClick: doFork },
                  forking ? '写入中…' : 'Fork'
                ),
                forkNote ? h('span', { style: S.ok }, forkNote) : null,
                forkError ? h('span', { style: S.err }, forkError) : null
              ),
              convError
                ? h('div', { style: { padding: 16 } }, h('div', { style: S.err }, convError))
                : conversation
                  ? h(ConversationView, { conversation })
                  : h('div', { style: { padding: 16, color: C.dim } }, '读取中…')
            )
          : h(
              'div',
              { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30 } },
              h(
                'div',
                { style: { maxWidth: 420, textAlign: 'center' } },
                h('div', { style: { fontSize: 14, marginBottom: 8 } }, '选择左侧任意一条会话'),
                h(
                  'div',
                  { style: S.muted },
                  '这里显示的是完整过程：思考链、每一次工具调用与返回、以及最终回答。内容来自所有已连接电脑的共享区。'
                )
              )
            )
      )
    }

    // ------------------------------------------------------------- 插件 tab

    function PluginsTab(props) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')

      const load = useCallback(function () {
        api('/plugins')
          .then(function (body) {
            setData(body)
            setError('')
          })
          .catch(function (err) {
            setError(String(err.message || err))
          })
      }, [])

      useEffect(
        function () {
          load()
        },
        [load, props.tick]
      )

      const run = function (label, promise) {
        setBusy(label)
        setMessage('')
        promise
          .then(function (result) {
            setMessage(label + '：' + JSON.stringify(result && result.result ? result.result : result).slice(0, 300))
            load()
          })
          .catch(function (err) {
            setMessage(label + ' 失败：' + String(err.message || err))
          })
          .finally(function () {
            setBusy('')
          })
      }

      if (!data) {
        return h('div', { style: { padding: 16 } }, error ? h('div', { style: S.err }, error) : h('div', { style: S.muted }, '读取中…'))
      }

      const local = data.local || {}
      const remote = data.remote || []
      const plans = data.plans || []
      const runtime = data.runtime || []

      return h(
        'div',
        { style: Object.assign({}, S.scroll, { flex: 1, padding: 14 }) },
        error ? h('div', { style: Object.assign({}, S.err, { marginBottom: 10 }) }, error) : null,
        message ? h('div', { style: Object.assign({}, S.ok, { marginBottom: 10 }) }, message) : null,
        h(
          'div',
          { style: Object.assign({}, S.card, { marginBottom: 14 }) },
          h(
            'div',
            { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginBottom: 8 }) },
            h('div', { style: { fontWeight: 600 } }, '本机插件清单 · ' + (local.machineName || '')),
            h(Btn, { onClick: load }, '刷新')
          ),
          h(
            'div',
            { style: Object.assign({}, S.faint, { marginBottom: 10 }) },
            local.profileDir + ' · ' + (local.pluginCount || 0) + ' 个依赖 · ' + ((local.bundles || []).length) + ' 个 bundle'
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            (local.plugins || []).map(function (row) {
              const state = row.runtime
              return h(
                'span',
                {
                  key: row.name,
                  style: Object.assign({}, S.badge, state && state.enabled ? { borderColor: C.ok, color: C.ok } : null),
                  title: row.name + ' ' + row.version
                },
                h('span', { style: Object.assign({}, S.dot, { background: state ? (state.enabled ? C.ok : C.faint) : C.faint }) }),
                row.name.replace(/^@[^/]+\//, '')
              )
            })
          )
        ),
        h(
          'div',
          { style: Object.assign({}, S.card, { marginBottom: 14 }) },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '其他电脑的清单 · 一键同步'),
          remote.length === 0
            ? h('div', { style: S.muted }, '还没有收到其他电脑的插件清单。确保对方已完成配对并同步一次。')
            : remote.map(function (entry) {
                const planRow = plans.find(function (row) {
                  return row.machineId === entry.machineId
                })
                const plan = (planRow && planRow.plan) || null
                return h(
                  'div',
                  { key: entry.machineId, style: { borderTop: '1px solid ' + C.border, paddingTop: 10, marginTop: 10 } },
                  h(
                    'div',
                    { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
                    h('div', null, entry.machineName || entry.machineId, ' · ', h('span', { style: S.faint }, entry.pluginCount + ' 个插件')),
                    plan
                      ? h(
                          Btn,
                          {
                            primary: true,
                            disabled: plan.identical || Boolean(busy),
                            onClick: function () {
                              run('应用清单', api('/plugins/apply', { method: 'POST', body: { machineId: entry.machineId } }))
                            }
                          },
                          plan.identical ? '已一致' : '一键应用'
                        )
                      : null
                  ),
                  plan
                    ? h(
                        'div',
                        { style: Object.assign({}, S.faint, { marginTop: 6, lineHeight: 1.6 }) },
                        plan.missing.length > 0 ? h('div', null, '待安装：' + plan.missing.map(function (row) { return row.name }).join('、')) : null,
                        plan.versionDiff.length > 0
                          ? h('div', null, '版本不同：' + plan.versionDiff.map(function (row) { return row.name + ' ' + row.local + ' → ' + row.remote }).join('、'))
                          : null,
                        plan.bundlesToAdd.length > 0 ? h('div', null, '待启用 bundle：' + plan.bundlesToAdd.join('、')) : null,
                        plan.identical ? h('div', { style: { color: C.ok } }, '与本机完全一致') : null
                      )
                    : null
                )
              })
        ),
        h(
          'div',
          { style: Object.assign({}, S.card, { marginBottom: 14 }) },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '安装与运行'),
          h(
            'div',
            { style: Object.assign({}, S.muted, { marginBottom: 8 }) },
            '应用清单只会改写 profile 的 package.json，不会自动联网安装。确认后用下面的按钮跑 pnpm install。'
          ),
          h(
            'div',
            { style: S.row },
            h(
              Btn,
              {
                disabled: Boolean(busy),
                onClick: function () {
                  run('pnpm install', api('/plugins/install', { method: 'POST', body: {} }))
                }
              },
              busy === 'pnpm install' ? '安装中…' : '运行 pnpm install'
            ),
            h('span', { style: S.faint }, '首次可能需要几分钟')
          )
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '已加载的运行时插件 · 启用/停用'),
          runtime.length === 0
            ? h('div', { style: S.muted }, '当前宿主没有暴露插件管理器。')
            : runtime.map(function (row) {
                return h(
                  'div',
                  {
                    key: row.entryId,
                    style: Object.assign({}, S.row, {
                      justifyContent: 'space-between',
                      borderTop: '1px solid ' + C.border,
                      padding: '6px 0'
                    })
                  },
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h('div', { style: Object.assign({}, S.mono, { overflow: 'hidden', textOverflow: 'ellipsis' }) }, row.name),
                    h('div', { style: S.faint }, row.patchId || row.entryId)
                  ),
                  h(
                    Btn,
                    {
                      disabled: Boolean(busy) || row.readOnly,
                      onClick: function () {
                        run('切换 ' + row.name, api('/plugins/toggle', { method: 'POST', body: { entryId: row.entryId, enabled: !row.enabled } }))
                      }
                    },
                    row.enabled ? '已启用' : '已停用'
                  )
                )
              })
        )
      )
    }

    // ------------------------------------------------------------- 文件 tab

    function FilesTab(props) {
      const status = props.status
      const [scope, setScope] = useState('local')
      const [remoteRoots, setRemoteRoots] = useState([])
      const [rootId, setRootId] = useState('')
      const [currentPath, setCurrentPath] = useState('')
      const [listing, setListing] = useState(null)
      const [error, setError] = useState('')
      const [file, setFile] = useState(null)
      const [draft, setDraft] = useState('')
      const [dirty, setDirty] = useState(false)
      const [message, setMessage] = useState('')

      const localRoots = (status && status.roots) || []
      const roots = scope === 'remote' ? remoteRoots : localRoots

      useEffect(
        function () {
          if (scope !== 'remote') return
          api('/roots?scope=remote')
            .then(function (body) {
              setRemoteRoots(body.roots || [])
              setError('')
            })
            .catch(function (err) {
              setRemoteRoots([])
              setError(String(err.message || err))
            })
        },
        [scope, props.tick]
      )

      useEffect(
        function () {
          if (roots.length === 0) {
            setRootId('')
            return
          }
          const exists = roots.some(function (row) {
            return row.id === rootId
          })
          if (!exists) setRootId(roots[0].id)
        },
        [roots.length, scope]
      )

      const loadDir = useCallback(
        function (rel) {
          if (!rootId) return
          api(
            '/files/list?scope=' + scope + '&root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(rel || '')
          )
            .then(function (body) {
              setListing(body)
              setCurrentPath(rel || '')
              setError('')
            })
            .catch(function (err) {
              setError(String(err.message || err))
            })
        },
        [rootId, scope]
      )

      useEffect(
        function () {
          if (rootId) loadDir('')
        },
        [rootId, scope]
      )

      const openFile = function (name) {
        const rel = currentPath ? currentPath + '/' + name : name
        api('/files/read?scope=' + scope + '&root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(rel))
          .then(function (body) {
            setFile({ path: rel, binary: body.binary, size: body.size })
            setDraft(body.content || '')
            setDirty(false)
            setMessage('')
            setError('')
          })
          .catch(function (err) {
            setError(String(err.message || err))
          })
      }

      const save = function () {
        if (!file) return
        api('/files/write', {
          method: 'POST',
          body: { scope, root: rootId, path: file.path, content: draft, backup: true }
        })
          .then(function () {
            setDirty(false)
            setMessage('已保存 ' + file.path)
            loadDir(currentPath)
          })
          .catch(function (err) {
            setError(String(err.message || err))
          })
      }

      const crumbs = currentPath === '' ? [] : currentPath.split('/')

      return h(
        'div',
        { style: { display: 'flex', flex: 1, minHeight: 0 } },
        h(
          'div',
          { style: { width: 320, flexShrink: 0, borderRight: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          h(
            'div',
            { style: { padding: 10, borderBottom: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'div',
              { style: { display: 'flex', gap: 4 } },
              h(
                Btn,
                { onClick: function () { setScope('local') }, style: scope === 'local' ? { borderColor: C.brand, color: C.brand } : null },
                '本机'
              ),
              h(
                Btn,
                { onClick: function () { setScope('remote') }, style: scope === 'remote' ? { borderColor: C.brand, color: C.brand } : null },
                '对端'
              )
            ),
            h(
              'select',
              {
                style: S.input,
                value: rootId,
                onChange: function (event) {
                  setRootId(event.target.value)
                }
              },
              roots.length === 0 ? h('option', { value: '' }, '没有共享的根目录') : null,
              roots.map(function (row) {
                return h('option', { key: row.id, value: row.id }, row.label + ' · ' + (row.path || row.kind))
              })
            ),
            h(
              'div',
              { style: Object.assign({}, S.faint, { display: 'flex', gap: 6, flexWrap: 'wrap' }) },
              h(
                'button',
                {
                  type: 'button',
                  onClick: function () { loadDir('') },
                  style: { appearance: 'none', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 11 }
                },
                '根目录'
              ),
              crumbs.map(function (segment, index) {
                const rel = crumbs.slice(0, index + 1).join('/')
                return h(
                  'button',
                  {
                    key: rel,
                    type: 'button',
                    onClick: function () { loadDir(rel) },
                    style: { appearance: 'none', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', padding: 0, fontFamily: C.mono, fontSize: 11 }
                  },
                  '/ ' + segment
                )
              })
            ),
            error ? h('div', { style: S.err }, error) : null
          ),
          h(
            'div',
            { style: Object.assign({}, S.scroll, { flex: 1 }) },
            listing && listing.entries
              ? listing.entries.map(function (entry) {
                  return h(
                    'button',
                    {
                      key: entry.path,
                      type: 'button',
                      onClick: function () {
                        if (entry.dir) loadDir(entry.path)
                        else openFile(entry.name)
                      },
                      style: {
                        appearance: 'none',
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        borderBottom: '1px solid ' + C.border,
                        background: 'transparent',
                        color: entry.denied ? C.faint : C.text,
                        padding: '7px 11px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8
                      }
                    },
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (entry.dir ? '📁 ' : '') + entry.name),
                    h('span', { style: S.faint }, entry.dir ? '' : fmtBytes(entry.size))
                  )
                })
              : h('div', { style: Object.assign({}, S.muted, { padding: 14 }) }, scope === 'remote' ? '选择对端的共享目录' : '选择共享目录')
          )
        ),
        h(
          'div',
          { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 } },
          file
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { style: { padding: '8px 12px', borderBottom: '1px solid ' + C.border, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: Object.assign({}, S.mono, { flex: 1, minWidth: 120, wordBreak: 'break-all' }) }, file.path),
                  file.binary ? h('span', { style: { color: C.warn, fontSize: 12 } }, '二进制文件，不可编辑') : null,
                  h(Btn, { primary: true, disabled: !dirty || file.binary, onClick: save }, dirty ? '保存' : '已保存'),
                  h(
                    Btn,
                    {
                      onClick: function () {
                        setFile(null)
                        setDraft('')
                        setDirty(false)
                      }
                    },
                    '关闭'
                  ),
                  message ? h('span', { style: S.ok }, message) : null
                ),
                h('textarea', {
                  value: draft,
                  spellCheck: false,
                  readOnly: file.binary,
                  onChange: function (event) {
                    setDraft(event.target.value)
                    setDirty(true)
                  },
                  style: {
                    flex: 1,
                    minHeight: 0,
                    resize: 'none',
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: C.text,
                    padding: 12,
                    fontFamily: C.mono,
                    fontSize: 12,
                    lineHeight: 1.6
                  }
                })
              )
            : h(
                'div',
                { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30 } },
                h('div', { style: Object.assign({}, S.muted, { textAlign: 'center', maxWidth: 400 }) }, '从左侧选择文件即可查看和编辑；保存会先写临时文件再替换，并保留一份备份。')
              )
        )
      )
    }

    // ------------------------------------------------------------- 记忆 tab

    function MemoryTab(props) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')

      const load = useCallback(function () {
        api('/memory')
          .then(function (body) {
            setData(body)
            setError('')
          })
          .catch(function (err) {
            setError(String(err.message || err))
          })
      }, [])

      useEffect(
        function () {
          load()
        },
        [load, props.tick]
      )

      if (!data) return h('div', { style: { padding: 16 } }, error ? h('div', { style: S.err }, error) : h('div', { style: S.muted }, '读取中…'))

      const local = data.local || []
      const shared = data.shared || []

      const take = function (row) {
        const target = local.find(function (entry) {
          return entry.name === row.name
        })
        if (!target) {
          setMessage('本机没有 ' + row.name + '，请先在设置里指定一个路径。')
          return
        }
        api('/memory/write', { method: 'POST', body: { file: target.file, text: row.text } })
          .then(function () {
            setMessage('已用 ' + row.name + '（来自 ' + row.machineId + '）覆盖本机，原文件已备份')
            load()
          })
          .catch(function (err) {
            setMessage('失败：' + String(err.message || err))
          })
      }

      return h(
        'div',
        { style: Object.assign({}, S.scroll, { flex: 1, padding: 14 }) },
        error ? h('div', { style: Object.assign({}, S.err, { marginBottom: 10 }) }, error) : null,
        message ? h('div', { style: Object.assign({}, S.ok, { marginBottom: 10 }) }, message) : null,
        h(
          'div',
          { style: Object.assign({}, S.card, { marginBottom: 14 }) },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '本机找到的记忆文件'),
          local.length === 0
            ? h(
                'div',
                { style: S.muted },
                '没有在常规位置找到 MEMORY.md / USER.md。如果你的记忆由别的插件托管，可在下面的共享区里手动对照内容。'
              )
            : local.map(function (entry) {
                return h(
                  'div',
                  { key: entry.file, style: { borderTop: '1px solid ' + C.border, padding: '6px 0' } },
                  h('div', { style: S.mono }, entry.name),
                  h('div', { style: S.faint }, entry.file + ' · ' + fmtBytes(entry.size))
                )
              })
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginBottom: 8 }) },
            h('div', { style: { fontWeight: 600 } }, '共享区里的记忆'),
            h(Btn, { onClick: load }, '刷新')
          ),
          shared.length === 0
            ? h('div', { style: S.muted }, '还没有同步到记忆文件。')
            : shared.map(function (row) {
                return h(
                  'div',
                  { key: row.machineId + '/' + row.name, style: { borderTop: '1px solid ' + C.border, paddingTop: 10, marginTop: 10 } },
                  h(
                    'div',
                    { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
                    h(
                      'div',
                      null,
                      h('span', { style: { fontWeight: 600 } }, row.name),
                      ' ',
                      h('span', { style: S.faint }, (row.mine ? '本机' : row.machineId) + ' · ' + fmtBytes(row.bytes))
                    ),
                    row.mine
                      ? null
                      : h(Btn, { onClick: function () { take(row) } }, '用这份覆盖本机')
                  ),
                  h(Fold, { title: '查看内容', chars: row.text.length }, row.text)
                )
              })
        )
      )
    }

    // ------------------------------------------------------------- 设置 tab

    function SettingsTab(props) {
      const status = props.status
      const [form, setForm] = useState(null)
      const [message, setMessage] = useState('')
      const [hubs, setHubs] = useState([])
      const [busy, setBusy] = useState(false)
      const [audit, setAudit] = useState([])
      const [rootInput, setRootInput] = useState('')

      useEffect(
        function () {
          if (!status || form) return
          setForm({
            role: status.config.role,
            port: String(status.config.port),
            hubHost: status.config.hubHost,
            hubPort: String(status.config.hubPort),
            token: status.token,
            autoSync: status.config.autoSync,
            pushIntervalMs: String(status.config.pushIntervalMs),
            pullIntervalMs: String(status.config.pullIntervalMs),
            discovery: status.config.discovery,
            machineName: status.identity.machineName
          })
        },
        [status]
      )

      useEffect(
        function () {
          api('/audit?limit=30')
            .then(function (body) {
              setAudit(body.entries || [])
            })
            .catch(function () {
              setAudit([])
            })
        },
        [props.tick]
      )

      if (!status || !form) return h('div', { style: { padding: 16, color: C.dim } }, '读取中…')

      const set = function (key, value) {
        setForm(Object.assign({}, form, { [key]: value }))
      }

      const save = function () {
        setBusy(true)
        setMessage('')
        api('/setup', {
          method: 'POST',
          body: {
            role: form.role,
            port: Number(form.port),
            hubHost: form.hubHost.trim(),
            hubPort: Number(form.hubPort),
            token: form.token.trim(),
            autoSync: form.autoSync,
            pushIntervalMs: Number(form.pushIntervalMs),
            pullIntervalMs: Number(form.pullIntervalMs),
            discovery: form.discovery,
            machineName: form.machineName
          }
        })
          .then(function () {
            setMessage('设置已保存')
            props.refresh()
          })
          .catch(function (err) {
            setMessage('保存失败：' + String(err.message || err))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      const discover = function () {
        setBusy(true)
        api('/discover', { method: 'POST', body: {} })
          .then(function (body) {
            setHubs(body.hubs || [])
            setMessage((body.hubs || []).length === 0 ? '没有发现任何设备（可手动填写地址，或用「测试连接」直连）' : '发现 ' + body.hubs.length + ' 台设备')
          })
          .catch(function (err) {
            setMessage('发现失败：' + String(err.message || err))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      const testHub = function () {
        setBusy(true)
        api('/test-hub', {
          method: 'POST',
          body: { hubHost: form.hubHost.trim(), hubPort: Number(form.hubPort), token: form.token.trim() }
        })
          .then(function (body) {
            if (body.ok) setMessage('连接成功：' + (body.hello.identity.machineName || '') + ' · rev ' + body.hello.rev)
            else setMessage('连接失败：' + (body.error && body.error.message))
          })
          .catch(function (err) {
            setMessage('连接失败：' + String(err.message || err))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      const addRoot = function () {
        if (!rootInput.trim()) return
        api('/roots', { method: 'POST', body: { add: [rootInput.trim()] } })
          .then(function () {
            setRootInput('')
            setMessage('已加入共享根目录')
            props.refresh()
          })
          .catch(function (err) {
            setMessage('失败：' + String(err.message || err))
          })
      }

      return h(
        'div',
        { style: Object.assign({}, S.scroll, { flex: 1, padding: 14, maxWidth: 760 }) },
        message ? h('div', { style: Object.assign({}, S.ok, { marginBottom: 10 }) }, message) : null,
        h(
          'div',
          { style: Object.assign({}, S.card, { marginBottom: 14 }) },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '配对'),
          h(
            Field,
            { label: '这台电脑的角色' },
            h(
              'select',
              {
                style: S.input,
                value: form.role,
                onChange: function (event) {
                  set('role', event.target.value)
                }
              },
              h('option', { value: 'hub' }, '主机（hub，常开的那台，提供共享区）'),
              h('option', { value: 'peer' }, '成员（peer，连接主机）')
            )
          ),
          form.role === 'hub'
            ? h(
                'div',
                { style: { marginBottom: 10 } },
                h(Field, { label: '监听端口' }, h('input', { style: S.input, value: form.port, onChange: function (e) { set('port', e.target.value) } })),
                h(
                  'div',
                  { style: Object.assign({}, S.card, { background: 'transparent', marginBottom: 10 }) },
                  h('div', { style: S.label }, '把这串信息填到另一台电脑'),
                  h('div', { style: Object.assign({}, S.mono, { wordBreak: 'break-all', marginBottom: 6 }) }, (status.lan.addresses[0] && status.lan.addresses[0].address) || '（没有局域网地址）'),
                  h('div', { style: Object.assign({}, S.mono, { wordBreak: 'break-all' }) }, form.token),
                  h(
                    'div',
                    { style: Object.assign({}, S.faint, { marginTop: 6 }) },
                    '地址取这一台在局域网里的 IPv4；端口 ' + form.port + '。对端需要放行该端口。'
                  )
                )
              )
            : h(
                React.Fragment,
                null,
                h(
                  Field,
                  { label: '主机地址' },
                  h('input', {
                    style: S.input,
                    value: form.hubHost,
                    placeholder: '例如 192.168.1.23',
                    onChange: function (event) {
                      set('hubHost', event.target.value)
                    }
                  })
                ),
                h(Field, { label: '主机端口' }, h('input', { style: S.input, value: form.hubPort, onChange: function (e) { set('hubPort', e.target.value) } })),
                h(
                  'div',
                  { style: Object.assign({}, S.row, { marginBottom: 10 }) },
                  h(Btn, { onClick: discover, disabled: busy }, '局域网自动发现'),
                  h(Btn, { onClick: testHub, disabled: busy }, '测试连接')
                ),
                hubs.length > 0
                  ? h(
                      'div',
                      { style: { marginBottom: 10 } },
                      hubs.map(function (hub) {
                        const isHub = hub.role !== 'peer'
                        return h(
                          'button',
                          {
                            key: hub.identity.machineId,
                            type: 'button',
                            disabled: !isHub,
                            onClick: function () {
                              if (!isHub) return
                              setForm(Object.assign({}, form, { hubHost: hub.host, hubPort: String(hub.port) }))
                            },
                            style: Object.assign({}, S.btn, {
                              display: 'block',
                              width: '100%',
                              textAlign: 'left',
                              marginBottom: 4,
                              opacity: isHub ? 1 : 0.6
                            })
                          },
                          hub.identity.machineName + ' · ' + hub.host + ':' + hub.port + ' · ' + (isHub ? '主机' : '成员')
                        )
                      })
                    )
                  : null
              ),
          h(Field, { label: '共享令牌（两台必须一致）' }, h('input', { style: S.input, value: form.token, onChange: function (e) { set('token', e.target.value) } })),
          h(
            'div',
            { style: S.row },
            h(Btn, { primary: true, onClick: save, disabled: busy }, '保存'),
            h(Btn, { onClick: props.refresh }, '刷新状态')
          )
        ),
        h(
          'div',
          { style: Object.assign({}, S.card, { marginBottom: 14 }) },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '同步计划'),
          h(
            Field,
            { label: '自动同步' },
            h(
              'select',
              {
                style: S.input,
                value: form.autoSync ? '1' : '0',
                onChange: function (event) {
                  set('autoSync', event.target.value === '1')
                }
              },
              h('option', { value: '1' }, '开启（接近实时）'),
              h('option', { value: '0' }, '关闭（只手动同步）')
            )
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 10 } },
            h(Field, { label: '推送间隔 (ms)' }, h('input', { style: S.input, value: form.pushIntervalMs, onChange: function (e) { set('pushIntervalMs', e.target.value) } })),
            h(Field, { label: '拉取间隔 (ms)' }, h('input', { style: S.input, value: form.pullIntervalMs, onChange: function (e) { set('pullIntervalMs', e.target.value) } }))
          ),
          h(
            'div',
            { style: Object.assign({}, S.faint, { lineHeight: 1.7 }) },
            '本机新的对话事件会合并到一次导出；成员按拉取间隔向主机取回新记录。想定时跑真正的"代理任务"，请用 DSH 自带的自动化（automation_create）。'
          )
        ),
        h(
          'div',
          { style: Object.assign({}, S.card, { marginBottom: 14 }) },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '共享的根目录'),
          (status.roots || []).map(function (root) {
            return h(
              'div',
              { key: root.id, style: Object.assign({}, S.row, { justifyContent: 'space-between', borderTop: '1px solid ' + C.border, padding: '6px 0' }) },
              h(
                'div',
                { style: { minWidth: 0 } },
                h('div', null, root.label),
                h('div', { style: Object.assign({}, S.faint, { fontFamily: C.mono, wordBreak: 'break-all' }) }, root.path)
              ),
              h(
                Btn,
                {
                  danger: true,
                  onClick: function () {
                    api('/roots', { method: 'POST', body: { remove: [root.path] } })
                      .then(function () {
                        setMessage('已移出共享')
                        props.refresh()
                      })
                      .catch(function (err) {
                        setMessage('失败：' + String(err.message || err))
                      })
                  }
                },
                '移除'
              )
            )
          }),
          h(
            'div',
            { style: Object.assign({}, S.row, { marginTop: 10 }) },
            h('input', {
              style: S.input,
              placeholder: '额外共享目录的绝对路径',
              value: rootInput,
              onChange: function (event) {
                setRootInput(event.target.value)
              }
            }),
            h(Btn, { onClick: addRoot }, '添加')
          )
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '最近活动'),
          audit.length === 0
            ? h('div', { style: S.muted }, '暂无记录')
            : audit.map(function (row, index) {
                return h(
                  'div',
                  { key: index, style: Object.assign({}, S.faint, { fontFamily: C.mono, padding: '2px 0', wordBreak: 'break-all' }) },
                  new Date(row.at).toLocaleTimeString() + '  ' + (row.kind || '') + '  ' + JSON.stringify(Object.assign({}, row, { at: undefined, kind: undefined })).slice(0, 140)
                )
              })
        )
      )
    }

    // ------------------------------------------------------------- 主 面板

    function ErrorBoundary(props) {
      return h(Boundary, null, props.children)
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { padding: 20 } },
            h('div', { style: { color: C.err, marginBottom: 6, fontWeight: 600 } }, '局域网面板渲染失败'),
            h('pre', { style: { color: C.dim, whiteSpace: 'pre-wrap', fontSize: 12 } }, String(this.state.error && this.state.error.stack ? this.state.error.stack : this.state.error)),
            h(Btn, { onClick: () => this.setState({ error: null }) }, '重试')
          )
        }
        return this.props.children
      }
    }

    const TABS = [
      { key: 'conversations', label: '对话' },
      { key: 'plugins', label: '插件' },
      { key: 'files', label: '文件' },
      { key: 'memory', label: '记忆' },
      { key: 'settings', label: '设置' }
    ]

    function Panel() {
      const [tab, setTab] = useState('conversations')
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [tick, setTick] = useState(0)
      const [syncing, setSyncing] = useState(false)
      const [note, setNote] = useState('')
      const mounted = useRef(true)

      const refresh = useCallback(function () {
        api('/status')
          .then(function (body) {
            if (!mounted.current) return
            setStatus(body)
            setError('')
          })
          .catch(function (err) {
            if (!mounted.current) return
            setError(String(err.message || err))
          })
      }, [])

      useEffect(function () {
        mounted.current = true
        refresh()
        const timer = setInterval(refresh, 8000)
        let stream = null
        try {
          stream = new EventSource(PREFIX + '/stream')
          stream.onmessage = function () {
            setTick(function (value) {
              return value + 1
            })
            refresh()
          }
          stream.onerror = function () {
            /* the 8s poll keeps the UI alive */
          }
        } catch (err) {
          stream = null
        }
        return function () {
          mounted.current = false
          clearInterval(timer)
          if (stream) stream.close()
        }
      }, [])

      const syncNow = function () {
        setSyncing(true)
        setNote('')
        api('/sync', { method: 'POST', body: {} })
          .then(function (body) {
            const result = (body && body.result) || {}
            if (result && result.ok === false) setNote('同步未完成：' + (result.message || result.code || ''))
            else setNote('已同步')
            setTick(function (value) {
              return value + 1
            })
            refresh()
          })
          .catch(function (err) {
            setNote('同步失败：' + String(err.message || err))
          })
          .finally(function () {
            setSyncing(false)
          })
      }

      const role = status && status.identity ? status.identity.role : ''
      const hubOk = status && status.hub ? status.hub.reachable === true : false
      const linkLabel =
        role === 'hub'
          ? status && status.lan.listening
            ? '主机 · 监听中'
            : '主机 · 未监听'
          : hubOk
            ? '已连接主机'
            : status && status.config.hubHost
              ? '主机不可达'
              : '未配对'

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.header },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
            h('div', { style: { fontWeight: 600, fontSize: 13.5 } }, '局域网共享'),
            h(
              'div',
              { style: Object.assign({}, S.faint, { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }) },
              h('span', null, (status && status.identity && status.identity.machineName) || '本机'),
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h('span', { style: Object.assign({}, S.dot, { background: role === 'hub' ? C.warn : hubOk ? C.ok : C.faint }) }),
                linkLabel
              ),
              status
                ? h('span', null, String((status.store && status.store.conversations) || 0) + ' 条会话')
                : null
            )
          ),
          h('div', { style: { flex: 1 } }),
          note ? h('span', { style: S.faint, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, note) : null,
          h(Btn, { primary: true, onClick: syncNow, disabled: syncing }, syncing ? '同步中…' : '立即同步')
        ),
        error ? h('div', { style: Object.assign({}, S.err, { padding: '6px 14px' }) }, error) : null,
        h(
          'div',
          { style: S.tabs },
          TABS.map(function (row) {
            return h(
              'button',
              {
                key: row.key,
                type: 'button',
                onClick: function () {
                  setTab(row.key)
                },
                style: Object.assign({}, S.tab, tab === row.key ? S.tabOn : null)
              },
              row.label
            )
          })
        ),
        h(
          'div',
          { style: S.body },
          tab === 'conversations' ? h(ConversationsTab, { status, tick }) : null,
          tab === 'plugins' ? h(PluginsTab, { status, tick }) : null,
          tab === 'files' ? h(FilesTab, { status, tick }) : null,
          tab === 'memory' ? h(MemoryTab, { status, tick }) : null,
          tab === 'settings' ? h(SettingsTab, { status, tick, refresh }) : null
        )
      )
    }

    // -------------------------------------------------------------- sidebar

    function Glyph(props) {
      const size = props.size || 20
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: props.color || C.dim, strokeWidth: 1.6, strokeLinecap: 'round' },
        h('circle', { key: 'a', cx: 6, cy: 7, r: 2.4 }),
        h('circle', { key: 'b', cx: 18, cy: 17, r: 2.4 }),
        h('path', { key: 'l', d: 'M8.1 8.2 15.9 15.8' }),
        h('path', { key: 'c', d: 'M12 3.5v3M3.5 12h3M17.5 12h3M12 17.5v3', opacity: 0.5 })
      )
    }

    function PanelIcon(props) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' } },
        h(Glyph, { size: (props && props.size) || 20, color: C.text })
      )
    }

    function guarded(Component) {
      return function Guarded(props) {
        return h(ErrorBoundary, null, h(Component, props))
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'lan',
                order: 41,
                label: function () {
                  return '局域网'
                }
              },
              guarded(PanelIcon)
            )
          })
        } catch (err) {
          /* the host may not expose the sidebar slot */
        }
        try {
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: 'lan' }, guarded(Panel))
          })
        } catch (err) {
          /* the host may not expose the main slot */
        }
      }
    }
  }
})
