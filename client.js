/**
 * dsh-lan-bridge — browser half (v2).
 *
 * A single sidebar entry ("局域网") that opens a device-centric panel in the
 * native DSH main slot. The panel is deliberately not a second chat client:
 * remote conversations are forked into a real local session and then opened in
 * DSH's own conversation surface. What remains here is the bridge: devices,
 * shared workspaces, AirDrop-style transfers, and model borrowing.
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
    let HOST = null

    // ------------------------------------------------------------ primitives

    const C = {
      text: 'var(--dsw-alias-label-primary, #e9ecef)',
      dim: 'var(--dsw-alias-label-secondary, #a0a6ad)',
      faint: 'var(--dsw-alias-label-tertiary, #737a82)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
      border2: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.055))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.09))',
      layer3: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.13))',
      base: 'var(--dsw-alias-bg-base, transparent)',
      brand: 'var(--dsw-alias-brand-primary, #4d8dff)',
      ok: 'var(--dsw-alias-state-success-primary, #3fb950)',
      warn: 'var(--dsw-alias-state-warning-primary, #d29922)',
      err: 'var(--dsw-alias-state-error-primary, #f85149)',
      link: 'var(--dsw-alias-link, #4d8dff)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      radius: 'var(--dsw-radius-md, 8px)',
      radiusSm: 'var(--dsw-radius-sm, 6px)'
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.text, fontSize: 13, background: C.base },
      header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid ' + C.border, flexShrink: 0 },
      title: { fontWeight: 650, fontSize: 14, letterSpacing: 0.2 },
      sub: { color: C.faint, fontSize: 11.5, marginTop: 2, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: 2, padding: '6px 10px', borderBottom: '1px solid ' + C.border, flexShrink: 0, overflowX: 'auto' },
      tab: {
        border: 'none',
        background: 'transparent',
        color: C.dim,
        padding: '6px 12px',
        borderRadius: C.radiusSm,
        fontSize: 12.5,
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      },
      tabOn: { background: C.layer2, color: C.text, fontWeight: 600 },
      body: { flex: 1, minHeight: 0, overflow: 'auto', padding: 16 },
      card: { border: '1px solid ' + C.border, borderRadius: C.radius, background: C.layer, padding: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      col: { display: 'flex', flexDirection: 'column', gap: 10 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 },
      btn: {
        border: '1px solid ' + C.border2,
        background: C.layer,
        color: C.text,
        padding: '5px 10px',
        borderRadius: C.radiusSm,
        cursor: 'pointer',
        fontSize: 12.5,
        lineHeight: 1.4
      },
      btnPrimary: { border: '1px solid transparent', background: C.brand, color: '#fff', fontWeight: 600 },
      btnGhost: { border: '1px solid transparent', background: 'transparent', color: C.dim },
      btnDanger: { border: '1px solid ' + C.err, background: 'transparent', color: C.err },
      input: {
        border: '1px solid ' + C.border2,
        background: C.base,
        color: C.text,
        padding: '5px 8px',
        borderRadius: C.radiusSm,
        fontSize: 12.5,
        outline: 'none',
        minWidth: 0
      },
      select: {
        border: '1px solid ' + C.border2,
        background: C.base,
        color: C.text,
        padding: '5px 8px',
        borderRadius: C.radiusSm,
        fontSize: 12.5,
        maxWidth: 220
      },
      label: { color: C.faint, fontSize: 11.5, marginBottom: 3, display: 'block' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999, fontSize: 11, border: '1px solid ' + C.border },
      dot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
      mono: { fontFamily: C.mono, fontSize: 11.5 },
      code: { fontFamily: C.mono, fontSize: 11.5, background: C.layer2, padding: '1px 4px', borderRadius: 4 },
      sectionTitle: { fontSize: 12, fontWeight: 650, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.6, margin: '4px 0 8px' },
      divider: { height: 1, background: C.border, margin: '12px 0' },
      empty: { color: C.faint, padding: 18, textAlign: 'center', fontSize: 12.5, border: '1px dashed ' + C.border, borderRadius: C.radius },
      note: { color: C.dim, fontSize: 12, lineHeight: 1.5 },
      err: { color: C.err, fontSize: 12, lineHeight: 1.5 },
      ok: { color: C.ok, fontSize: 12 },
      pre: {
        margin: 0,
        padding: 10,
        background: C.layer2,
        borderRadius: C.radiusSm,
        maxHeight: 420,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: C.mono,
        fontSize: 11.5,
        lineHeight: 1.55
      }
    }

    function classNames() {
      return Array.prototype.slice.call(arguments).filter(Boolean).join(' ')
    }

    function Text(props) {
      return h('div', { style: Object.assign({}, props.style || {}) }, props.children)
    }

    function Btn(props) {
      const style = Object.assign(
        {},
        S.btn,
        props.primary ? S.btnPrimary : null,
        props.ghost ? S.btnGhost : null,
        props.danger ? S.btnDanger : null,
        props.small ? { padding: '2px 7px', fontSize: 11.5 } : null,
        props.style || {}
      )
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled === true,
          onClick: props.onClick,
          title: props.title || '',
          style: Object.assign({}, style, props.disabled ? { opacity: 0.5, cursor: 'default' } : null)
        },
        props.children
      )
    }

    function Field(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: { color: C.faint, fontSize: 11 } }, props.hint) : null
      )
    }

    function Badge(props) {
      const tone = props.tone || 'neutral'
      const color = tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : tone === 'err' ? C.err : tone === 'brand' ? C.brand : C.dim
      return h('span', { style: Object.assign({}, S.badge, { color, borderColor: props.solid ? color : C.border }) }, props.children)
    }

    function Dot(props) {
      const color = props.tone === 'ok' ? C.ok : props.tone === 'warn' ? C.warn : props.tone === 'err' ? C.err : C.faint
      return h('span', { style: Object.assign({}, S.dot, { background: color, boxShadow: props.pulse ? '0 0 0 3px ' + color + '22' : 'none' }) })
    }

    function Section(props) {
      return h(
        'div',
        { style: { marginBottom: 16 } },
        h('div', { style: S.sectionTitle }, props.title),
        props.children
      )
    }

    function Empty(props) {
      return h('div', { style: S.empty }, props.children || '暂无内容')
    }

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
            h('pre', { style: S.pre }, String(this.state.error && this.state.error.stack ? this.state.error.stack : this.state.error)),
            h(Btn, { onClick: () => this.setState({ error: null }) }, '重试')
          )
        }
        return this.props.children
      }
    }

    // ---------------------------------------------------------------- helpers

    async function api(pathname, options) {
      const opts = options || {}
      const response = await fetch(PREFIX + pathname, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      })
      const text = await response.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch (err) {
        body = { raw: text }
      }
      if (!response.ok) {
        const message = (body && body.error && body.error.message) || body.raw || response.statusText
        const error = new Error(message || '请求失败')
        error.code = body && body.error && body.error.code
        error.status = response.status
        throw error
      }
      return body
    }

    function fmtBytes(value) {
      const bytes = Number(value) || 0
      if (bytes < 1024) return bytes + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = bytes
      let unit = -1
      do {
        size /= 1024
        unit += 1
      } while (size >= 1024 && unit < units.length - 1)
      return (size >= 10 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[unit]
    }

    function fmtTime(value) {
      if (!value) return '从未'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const diff = Date.now() - date.getTime()
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
      return date.toLocaleString()
    }

    function trustTone(trust) {
      return trust === 'trusted' ? 'ok' : trust === 'blocked' ? 'err' : 'warn'
    }

    function trustLabel(trust) {
      return trust === 'trusted' ? '已信任' : trust === 'blocked' ? '已阻止' : '待确认'
    }

    async function hostOpenSession(sessionId) {
      const workspace =
        HOST && (HOST.uiWorkspace || (typeof HOST.get === 'function' ? HOST.get('uiWorkspace') : null))
      if (!workspace || typeof workspace.openSession !== 'function') {
        return { ok: false, error: 'this DSH build does not expose uiWorkspace.openSession' }
      }
      try {
        workspace.openSession(sessionId)
        return { ok: true }
      } catch (err) {
        // A session written by the host may not be in the client's catalog yet.
        // Refresh the session list once and retry before falling back to the
        // sidebar hint.
        try {
          const sessions = HOST.sessions || (typeof HOST.get === 'function' ? HOST.get('sessions') : null)
          if (sessions && sessions.manager && typeof sessions.manager.refreshList === 'function') {
            await sessions.manager.refreshList()
            workspace.openSession(sessionId)
            return { ok: true }
          }
        } catch (retryError) {
          return { ok: false, error: String((retryError && retryError.message) || retryError) }
        }
        return { ok: false, error: String((err && err.message) || err) }
      }
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return true
        }
      } catch (err) {
        /* fall through */
      }
      return false
    }

    // A deliberately small markdown renderer for previews only. Native DSH
    // surfaces render the real thing; this is for a remote transcript preview.
    function Preview(props) {
      const text = String(props.text || '').slice(0, 200000)
      if (!text) return null
      const lines = text.split('\n')
      const nodes = []
      let buffer = []
      let code = []
      let inCode = false
      let key = 0
      function flush() {
        if (buffer.length) {
          nodes.push(h('div', { key: 'p' + key++, style: { margin: '0 0 6px', lineHeight: 1.6 } }, buffer.join('\n')))
          buffer = []
        }
      }
      for (const line of lines) {
        if (/^```/.test(line.trim())) {
          if (inCode) {
            nodes.push(h('pre', { key: 'c' + key++, style: S.pre }, code.join('\n')))
            code = []
            inCode = false
          } else {
            flush()
            inCode = true
          }
          continue
        }
        if (inCode) {
          code.push(line)
          continue
        }
        if (/^\s*$/.test(line)) {
          flush()
          continue
        }
        buffer.push(line)
      }
      if (inCode && code.length) nodes.push(h('pre', { key: 'c' + key++, style: S.pre }, code.join('\n')))
      flush()
      return h('div', { style: { fontSize: 12.5, color: C.text } }, nodes)
    }

    // ------------------------------------------------------------ data hooks

    function useStatus() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const mounted = useRef(true)
      const refresh = useCallback(function () {
        api('/status')
          .then(function (body) {
            if (mounted.current) {
              setStatus(body)
              setError('')
            }
          })
          .catch(function (err) {
            if (mounted.current) setError(String(err.message || err))
          })
      }, [])
      useEffect(function () {
        mounted.current = true
        refresh()
        const timer = setInterval(refresh, 7000)
        let stream = null
        try {
          stream = new EventSource(PREFIX + '/stream')
          stream.onmessage = function () {
            refresh()
          }
          stream.onerror = function () {
            /* polling keeps the UI alive */
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
      return { status, error, refresh }
    }

    async function waitTask(taskId) {
      for (let i = 0; i < 240; i += 1) {
        const row = await api('/task?id=' + encodeURIComponent(taskId))
        if (row.status === 'complete') return row.result
        if (row.status === 'failed') throw new Error(row.error || '任务失败')
        await new Promise(function (resolve) {
          setTimeout(resolve, 800)
        })
      }
      throw new Error('任务超时')
    }

    // ------------------------------------------------------------------ bits

    function DeviceCard(props) {
      const peer = props.peer
      return h(
        'div',
        { style: Object.assign({}, S.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
        h(
          'div',
          { style: S.row },
          h(Dot, { tone: peer.trust === 'trusted' ? 'ok' : peer.trust === 'blocked' ? 'err' : 'warn' }),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, peer.name || peer.nodeId),
            h('div', { style: S.sub },
              h('span', { style: S.mono }, peer.address ? peer.address + ':' + peer.port : '未发现地址'),
              h('span', null, fmtTime(peer.lastSeenAt))
            )
          ),
          h(Badge, { tone: trustTone(peer.trust) }, trustLabel(peer.trust))
        ),
        peer.sync && peer.sync.lastSummary ? h('div', { style: { color: C.faint, fontSize: 11.5 } }, peer.sync.lastSummary) : null,
        peer.lastError ? h('div', { style: S.err }, peer.lastError) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          peer.trust !== 'trusted'
            ? h(Btn, { small: true, primary: true, onClick: function () { props.onTrust(peer, 'trusted') } }, '信任')
            : null,
          peer.trust !== 'blocked'
            ? h(Btn, { small: true, danger: true, onClick: function () { props.onTrust(peer, 'blocked') } }, '阻止')
            : h(Btn, { small: true, onClick: function () { props.onTrust(peer, 'pending') } }, '解除阻止'),
          peer.trust === 'trusted'
            ? h(Btn, { small: true, onClick: function () { props.onBrowse(peer) } }, '浏览文件')
            : null,
          peer.trust === 'trusted'
            ? h(Btn, { small: true, onClick: function () { props.onChat(peer) } }, '对话')
            : null,
          h(Btn, { small: true, ghost: true, onClick: function () { props.onPing(peer) } }, 'Ping')
        )
      )
    }

    function TransferRow(props) {
      const row = props.row
      return h(
        'div',
        { style: Object.assign({}, S.card, { padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }) },
        h('div', { style: S.row },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.name),
            h('div', { style: S.sub },
              fmtBytes(row.size),
              row.kind === 'incoming' ? ' · 来自 ' + (row.from || '?') : ' · 发往 ' + (row.peer || '?'),
              ' · ' + row.status
            )
          ),
          row.kind === 'incoming' && row.status === 'pending'
            ? h(Btn, { small: true, primary: true, onClick: function () { props.onApprove(row) } }, '接收')
            : null,
          row.kind === 'incoming' && row.status === 'pending'
            ? h(Btn, { small: true, danger: true, onClick: function () { props.onReject(row) } }, '拒绝')
            : null
        ),
        row.status === 'receiving' && row.size
          ? h('div', { style: { height: 4, background: C.layer2, borderRadius: 4, overflow: 'hidden' } },
            h('div', { style: { height: '100%', width: Math.min(100, Math.round((row.bytes / row.size) * 100)) + '%', background: C.brand } }))
          : null,
        row.path ? h('div', { style: { color: C.faint, fontSize: 11.5, wordBreak: 'break-all' } }, row.path) : null,
        row.error ? h('div', { style: S.err }, row.error) : null
      )
    }

    // ------------------------------------------------------------------ home

    function HomeTab(props) {
      const status = props.status
      const [invite, setInvite] = useState('')
      const [note, setNote] = useState('')
      const peers = (status && status.peers) || []
      const trusted = peers.filter(function (peer) { return peer.trust === 'trusted' })
      const incoming = (status && status.transfers && status.transfers.incoming) || []
      const outgoing = (status && status.transfers && status.transfers.outgoing) || []
      const pending = incoming.filter(function (row) { return row.status === 'pending' })
      const active = incoming.filter(function (row) { return row.status !== 'pending' }).concat(outgoing)
      const current = status ? status.identity : null
      const transportOk = status && status.transport && status.transport.listening
      const discoveryOk = status && status.discovery && status.discovery.listening

      const trust = function (peer, level) {
        api('/peers/trust', { method: 'POST', body: { nodeId: peer.nodeId, trust: level } })
          .then(function () { props.refresh() })
          .catch(function (err) { setNote(String(err.message || err)) })
      }
      const ping = function (peer) {
        api('/ping', { method: 'POST', body: { node: peer.nodeId } })
          .then(function (body) { setNote('Ping ' + peer.name + ' · ' + body.latencyMs + 'ms') })
          .catch(function (err) { setNote('Ping 失败：' + String(err.message || err)) })
      }
      const makeInvite = function () {
        api('/invite')
          .then(function (body) {
            setInvite(body.code)
            if (copyText(body.code)) setNote('邀请码已复制')
            else setNote('邀请码已生成，请手动复制')
          })
          .catch(function (err) { setNote(String(err.message || err)) })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: Object.assign({}, S.card, { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', background: C.layer2, marginBottom: 16 }) },
          h('div', { style: { width: 42, height: 42, borderRadius: 12, background: C.brand, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h(Glyph, { name: 'device', size: 22, color: '#fff' })),
          h('div', { style: { flex: 1, minWidth: 180 } },
            h('div', { style: { fontWeight: 650, fontSize: 15 } }, current ? current.nodeName : '本机'),
            h('div', { style: S.sub },
              h('span', null, '空间 ' + (status && status.config ? status.config.spaceId : '')),
              h(Dot, { tone: transportOk ? 'ok' : 'err' }),
              h('span', null, transportOk ? '监听 ' + (status.transport.port) : '未监听'),
              h(Dot, { tone: discoveryOk ? 'ok' : 'warn' }),
              h('span', null, discoveryOk ? '发现已开启' : '发现已关闭')
            )
          ),
          h('div', { style: { display: 'flex', gap: 6 } },
            h(Btn, { onClick: function () { props.setTab('files') } }, '发送文件'),
            h(Btn, { onClick: function () { props.setTab('settings') } }, '设置'),
            h(Btn, { primary: true, onClick: makeInvite }, '邀请设备')
          )
        ),
        note ? h('div', { style: { marginBottom: 12, color: C.dim, fontSize: 12 } }, note) : null,
        invite
          ? h('div', { style: Object.assign({}, S.card, { marginBottom: 16 }) },
            h('div', { style: Object.assign({}, S.label, { marginBottom: 6 }) }, '把这段邀请码发给另一台电脑'),
            h('div', { style: Object.assign({}, S.pre, { maxHeight: 90 }) }, invite),
            h('div', { style: { marginTop: 8, display: 'flex', gap: 6 } },
              h(Btn, { small: true, onClick: function () { copyText(invite) } }, '复制'),
              h(Btn, { small: true, ghost: true, onClick: function () { setInvite('') } }, '收起')
            )
          )
          : null,
        pending.length
          ? h(Section, { title: '待接收 · ' + pending.length },
            h('div', { style: S.col }, pending.map(function (row) {
              return h(TransferRow, {
                key: row.id,
                row,
                onApprove: function (item) { props.approve(item) },
                onReject: function (item) { props.reject(item) }
              })
            }))
          )
          : null,
        active.length
          ? h(Section, { title: '传输中 / 最近' },
            h('div', { style: S.col }, active.map(function (row) {
              return h(TransferRow, {
                key: row.kind + row.id,
                row,
                onApprove: function (item) { props.approve(item) },
                onReject: function (item) { props.reject(item) }
              })
            }))
          )
          : null,
        h(Section, { title: '设备 · ' + trusted.length + ' 台已信任' },
          peers.length
            ? h('div', { style: S.grid }, peers.map(function (peer) {
              return h(DeviceCard, {
                key: peer.nodeId,
                peer,
                onTrust: trust,
                onPing: ping,
                onBrowse: function (item) {
                  props.setTarget(item.nodeId)
                  props.setTab('files')
                },
                onChat: function (item) {
                  props.setTarget(item.nodeId)
                  props.setTab('conversations')
                }
              })
            }))
            : h(Empty, null, '还没有发现设备。打开另一台电脑上的局域网面板，或使用邀请码加入。')
        ),
        h(Section, { title: '同步' },
          h('div', { style: Object.assign({}, S.card, { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }) },
            h('div', { style: { flex: 1, minWidth: 180 } },
              h('div', { style: { fontWeight: 600 } }, status && status.sync && status.sync.lastSummary ? status.sync.lastSummary : '尚未同步'),
              h('div', { style: S.sub }, '会话、记忆与插件清单会在已信任设备之间自动收敛'),
              status && status.sync && status.sync.lastError ? h('div', { style: S.err }, status.sync.lastError) : null
            ),
            h(Btn, { onClick: function () { api('/sync', { method: 'POST', body: {} }).then(props.refresh).catch(function (err) { setNote(String(err.message || err)) }) } }, '立即同步')
          )
        )
      )
    }

    // ----------------------------------------------------------------- files

    function FilesTab(props) {
      const status = props.status
      const peers = (status && status.peers || []).filter(function (peer) { return peer.trust === 'trusted' })
      const [node, setNode] = useState(props.target || '')
      const [roots, setRoots] = useState([])
      const [root, setRoot] = useState('')
      const [cwd, setCwd] = useState('')
      const [entries, setEntries] = useState([])
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [loading, setLoading] = useState(false)
      const [sendOpen, setSendOpen] = useState(false)
      const [sendPeer, setSendPeer] = useState(peers.length ? peers[0].nodeId : '')
      const [sendMode, setSendMode] = useState('inbox')
      const [sendRoots, setSendRoots] = useState([])
      const [sendRoot, setSendRoot] = useState('')

      useEffect(function () {
        if (!sendPeer) return
        api('/remote/workspaces?node=' + encodeURIComponent(sendPeer))
          .then(function (body) {
            const rows = body.roots || []
            setSendRoots(rows)
            setSendRoot(rows.length ? rows[0].id : '')
          })
          .catch(function () { setSendRoots([]) })
      }, [sendPeer])

      useEffect(function () {
        if (!sendPeer && peers.length) setSendPeer(peers[0].nodeId)
      }, [peers.length])

      useEffect(function () {
        if (props.target && props.target !== node) setNode(props.target)
      }, [props.target])

      useEffect(function () {
        let cancelled = false
        setError('')
        const path = node ? '/remote/workspaces?node=' + encodeURIComponent(node) : '/workspaces'
        api(path)
          .then(function (body) {
            if (cancelled) return
            const rows = body.roots || []
            setRoots(rows)
            const next = rows.length ? rows[0].id : ''
            setRoot(next)
            setCwd('')
            setEntries([])
            setPreview(null)
          })
          .catch(function (err) {
            if (!cancelled) setError(String(err.message || err))
          })
        return function () { cancelled = true }
      }, [node])

      const loadList = useCallback(function (nextRoot, nextPath) {
        if (!nextRoot) return
        setLoading(true)
        setError('')
        const prefix = node ? '/remote/files/list?node=' + encodeURIComponent(node) : '/files/list'
        api(prefix + '?root=' + encodeURIComponent(nextRoot) + '&path=' + encodeURIComponent(nextPath || ''))
          .then(function (body) {
            setEntries(body.entries || [])
            setCwd(body.path || '')
            setPreview(null)
          })
          .catch(function (err) { setError(String(err.message || err)) })
          .finally(function () { setLoading(false) })
      }, [node])

      useEffect(function () {
        if (root) loadList(root, '')
      }, [root, loadList])

      const openEntry = function (entry) {
        if (entry.dir) {
          loadList(root, entry.path)
          return
        }
        setLoading(true)
        const prefix = node ? '/remote/files/read?node=' + encodeURIComponent(node) : '/files/read'
        api(prefix + '?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(entry.path))
          .then(function (body) {
            if (body.binary) {
              setPreview({ name: entry.name, path: entry.path, binary: true, size: entry.size })
            } else {
              setPreview({ name: entry.name, path: entry.path, binary: false, size: entry.size, content: body.content || '' })
            }
          })
          .catch(function (err) { setError(String(err.message || err)) })
          .finally(function () { setLoading(false) })
      }

      const up = function () {
        const parts = cwd.split('/').filter(Boolean)
        parts.pop()
        loadList(root, parts.join('/'))
      }

      const download = function () {
        if (!preview) return
        setNote('正在下载…')
        api('/transfers/download', { method: 'POST', body: { node, root, path: preview.path } })
          .then(function (body) { return waitTask(body.taskId) })
          .then(function (result) { setNote('已保存到 ' + result.path) })
          .catch(function (err) { setNote('下载失败：' + String(err.message || err)) })
      }

      const send = function () {
        if (!preview || !sendPeer) return
        setNote('正在发送…')
        api('/transfers/send', {
          method: 'POST',
          body: {
            node: sendPeer,
            root,
            path: preview.path,
            mode: sendMode,
            destRoot: sendMode === 'workspace' ? sendRoot : '',
            destPath: ''
          }
        })
          .then(function (body) { return waitTask(body.taskId) })
          .then(function () { setNote('已发送'); setSendOpen(false) })
          .catch(function (err) { setNote('发送失败：' + String(err.message || err)) })
      }

      const sourceLabel = node
        ? (peers.find(function (peer) { return peer.nodeId === node }) || {}).name || node
        : '本机'
      const rootRow = roots.find(function (row) { return row.id === root })
      const trail = cwd ? cwd.split('/').filter(Boolean) : []

      return h(
        'div',
        null,
        h(
          'div',
          { style: Object.assign({}, S.card, { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }) },
          h(Field, { label: '来源' },
            h('select', {
              value: node,
              onChange: function (event) { setNode(event.target.value) },
              style: S.select
            },
              h('option', { value: '' }, '本机'),
              peers.map(function (peer) { return h('option', { key: peer.nodeId, value: peer.nodeId }, peer.name || peer.nodeId) })
            )
          ),
          h(Field, { label: '工作区' },
            h('select', {
              value: root,
              onChange: function (event) { setRoot(event.target.value) },
              style: S.select
            },
              roots.length ? roots.map(function (row) { return h('option', { key: row.id, value: row.id }, row.label + (row.kind === 'extra' ? ' · 手动' : '')) }) : h('option', { value: '' }, '没有共享工作区')
            )
          ),
          h('div', { style: { flex: 1 } }),
          h(Btn, { onClick: function () { loadList(root, cwd) }, disabled: loading }, loading ? '加载中…' : '刷新')
        ),
        error ? h('div', { style: Object.assign({}, S.err, { marginBottom: 10 }) }, error) : null,
        note ? h('div', { style: { color: C.dim, marginBottom: 10, fontSize: 12 } }, note) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h(
            'div',
            { style: { flex: '1 1 320px', minWidth: 280 } },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
              h('span', { style: { color: C.faint, fontSize: 12 } }, sourceLabel + ' / ' + (rootRow ? rootRow.label : '')),
              cwd ? h(Btn, { small: true, ghost: true, onClick: up }, '↑ 上一级') : null
            ),
            h('div', { style: Object.assign({}, S.card, { padding: 4 }) },
              h(
                'div',
                { style: Object.assign({}, S.row, { padding: '6px 8px', color: C.faint, fontSize: 11.5, borderBottom: '1px solid ' + C.border }) },
                h('span', { style: { flex: 1 } }, trail.length ? '/' + trail.join('/') : '根目录'),
                h('span', null, entries.length + ' 项')
              ),
              entries.length
                ? entries.map(function (entry) {
                  return h(
                    'button',
                    {
                      key: entry.path,
                      type: 'button',
                      onClick: function () { openEntry(entry) },
                      style: {
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                        border: 'none', background: 'transparent', color: C.text, padding: '6px 8px',
                        borderRadius: 5, cursor: 'pointer'
                      }
                    },
                    h(Glyph, { name: entry.dir ? 'folder' : 'file', size: 15, color: entry.dir ? C.warn : C.dim }),
                    h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
                    h('span', { style: { color: C.faint, fontSize: 11 } }, entry.dir ? '' : fmtBytes(entry.size)),
                    entry.denied ? h(Badge, { tone: 'err' }, '禁止') : null
                  )
                })
                : h(Empty, null, loading ? '读取中…' : '空目录')
            )
          ),
          h(
            'div',
            { style: { flex: '1 1 360px', minWidth: 300 } },
            preview
              ? h(
                'div',
                { style: S.card },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
                  h('div', { style: { flex: 1, minWidth: 120 } },
                    h('div', { style: { fontWeight: 600 } }, preview.name),
                    h('div', { style: S.sub }, fmtBytes(preview.size) + (node ? ' · 来自 ' + sourceLabel : ''))
                  ),
                  node ? h(Btn, { small: true, onClick: download }, '下载到本机') : null,
                  !node ? h(Btn, { small: true, primary: true, onClick: function () { setSendOpen(true) } }, '发送到设备') : null
                ),
                preview.binary
                  ? h(Empty, null, '二进制文件不在此处预览，可以下载或发送。')
                  : h(Preview, { text: preview.content }),
                sendOpen
                  ? h(
                    'div',
                    { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid ' + C.border, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' } },
                    h(Field, { label: '目标设备' },
                      h('select', { value: sendPeer, onChange: function (event) { setSendPeer(event.target.value) }, style: S.select },
                        peers.length ? peers.map(function (peer) { return h('option', { key: peer.nodeId, value: peer.nodeId }, peer.name || peer.nodeId) }) : h('option', { value: '' }, '没有已信任设备')
                      )
                    ),
                    h(Field, { label: '落地位置' },
                      h('select', { value: sendMode, onChange: function (event) { setSendMode(event.target.value) }, style: S.select },
                        h('option', { value: 'inbox' }, '接收方收件箱'),
                        h('option', { value: 'workspace' }, '接收方工作区')
                      )
                    ),
                    sendMode === 'workspace'
                      ? h(Field, { label: '目标工作区' },
                        h('select', { value: sendRoot, onChange: function (event) { setSendRoot(event.target.value) }, style: S.select },
                          sendRoots.length ? sendRoots.map(function (row) { return h('option', { key: row.id, value: row.id }, row.label) }) : h('option', { value: '' }, '对方没有共享工作区')
                        )
                      )
                      : null,
                    h(Btn, { primary: true, onClick: send, disabled: !sendPeer || (sendMode === 'workspace' && !sendRoot) }, '确认发送'),
                    h(Btn, { ghost: true, onClick: function () { setSendOpen(false) } }, '取消')
                  )
                  : null
              )
              : h(Empty, null, '选择左侧文件查看预览')
          )
        )
      )
    }

    // ---------------------------------------------------------- conversations

    function Transcript(props) {
      const rows = ((props.conversation && props.conversation.items) || []).slice(-200)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        rows.map(function (item, index) {
          if (!item) return null
          if (item.t === 'user') {
            return h('div', { key: index, style: { alignSelf: 'flex-end', maxWidth: '86%', background: C.layer2, padding: '6px 9px', borderRadius: 8, whiteSpace: 'pre-wrap' } },
              String(item.text || '').slice(0, 4000))
          }
          if (item.t === 'assistant') {
            const text = (item.blocks || []).filter(function (block) { return block && block.k === 'text' }).map(function (block) { return block.text }).join('\n\n')
            if (!text) return null
            return h('div', { key: index, style: { alignSelf: 'flex-start', maxWidth: '90%', color: C.text } }, h(Preview, { text: text.slice(0, 12000) }))
          }
          if (item.t === 'tool-call') {
            return h('div', { key: index, style: Object.assign({}, S.mono, { color: C.faint }) }, '⚙ ' + (item.name || 'tool'))
          }
          return null
        })
      )
    }

    function ConversationsTab(props) {
      const status = props.status
      const peers = (status && status.peers || []).filter(function (peer) { return peer.trust === 'trusted' })
      const [node, setNode] = useState(props.target || '')
      const [rows, setRows] = useState([])
      const [selected, setSelected] = useState(null)
      const [conversation, setConversation] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [workspace, setWorkspace] = useState('')
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(function () {
        if (props.target && props.target !== node) setNode(props.target)
      }, [props.target])

      useEffect(function () {
        api('/workspaces')
          .then(function (body) {
            const local = body.local || []
            setWorkspaces(local)
            if (local.length) setWorkspace(local[0].key)
          })
          .catch(function () {})
      }, [])

      useEffect(function () {
        setError('')
        setRows([])
        setSelected(null)
        setConversation(null)
        const path = node
          ? '/conversations?node=' + encodeURIComponent(node) + '&limit=50'
          : '/conversations?limit=50'
        api(path)
          .then(function (body) { setRows(body.conversations || []) })
          .catch(function (err) { setError(String(err.message || err)) })
      }, [node])

      const select = function (row) {
        setSelected(row)
        setConversation(null)
        const path = node
          ? '/conversation?node=' + encodeURIComponent(node) + '&session=' + encodeURIComponent(row.sessionId)
          : '/conversation?session=' + encodeURIComponent(row.sessionId)
        api(path)
          .then(function (body) { setConversation(body.conversation) })
          .catch(function (err) { setError(String(err.message || err)) })
      }

      const openNative = function () {
        if (!selected) return
        setBusy(true)
        setNote('正在 fork 到本机…')
        api('/fork', {
          method: 'POST',
          body: { node: node || undefined, session: selected.sessionId, workspace: workspace || undefined }
        })
          .then(function (body) {
            return hostOpenSession(body.sessionId).then(function (opened) {
              if (opened.ok) setNote('已在新会话中打开')
              else setNote('已写入本机，请从侧栏打开 ' + body.title + (opened.error ? '（' + opened.error + '）' : ''))
            })
          })
          .catch(function (err) { setNote('打开失败：' + String(err.message || err)) })
          .finally(function () { setBusy(false) })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: Object.assign({}, S.card, { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }) },
          h(Field, { label: '来源' },
            h('select', { value: node, onChange: function (event) { setNode(event.target.value) }, style: S.select },
              h('option', { value: '' }, '本机'),
              peers.map(function (peer) { return h('option', { key: peer.nodeId, value: peer.nodeId }, peer.name || peer.nodeId) })
            )
          ),
          h(Field, { label: 'fork 到本机工作区' },
            h('select', { value: workspace, onChange: function (event) { setWorkspace(event.target.value) }, style: S.select },
              workspaces.length ? workspaces.map(function (row) { return h('option', { key: row.key, value: row.key }, row.cwd) }) : h('option', { value: '' }, '没有本机工作区')
            )
          ),
          h('div', { style: { flex: 1 } }),
          h(Btn, { primary: true, onClick: openNative, disabled: !selected || busy }, busy ? '打开中…' : '在 DSH 中打开')
        ),
        error ? h('div', { style: Object.assign({}, S.err, { marginBottom: 10 }) }, error) : null,
        note ? h('div', { style: { color: C.dim, marginBottom: 10, fontSize: 12 } }, note) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h(
            'div',
            { style: { flex: '0 0 330px', minWidth: 280, maxWidth: '100%' } },
            h('div', { style: Object.assign({}, S.card, { padding: 4 }) },
              rows.length
                ? rows.map(function (row) {
                  return h(
                    'button',
                    {
                      key: row.nodeId + '/' + row.sessionId,
                      type: 'button',
                      onClick: function () { select(row) },
                      style: {
                        display: 'block', width: '100%', textAlign: 'left', border: 'none',
                        background: selected && selected.sessionId === row.sessionId ? C.layer2 : 'transparent',
                        color: C.text, padding: '8px 9px', borderRadius: 6, cursor: 'pointer'
                      }
                    },
                    h('div', { style: { fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title || row.sessionId),
                    h('div', { style: S.sub },
                      h('span', null, fmtTime(row.updatedAt)),
                      h('span', null, (row.cwd || '').split(/[\\/]/).pop() || '')
                    )
                  )
                })
                : h(Empty, null, '没有会话')
            )
          ),
          h(
            'div',
            { style: { flex: '1 1 400px', minWidth: 300 } },
            conversation
              ? h('div', { style: S.card },
                h('div', { style: { marginBottom: 10 } },
                  h('div', { style: { fontWeight: 650, fontSize: 14 } }, conversation.title || selected.title || conversation.sessionId),
                  h('div', { style: S.sub }, (conversation.cwd || '') + ' · ' + fmtTime(conversation.updatedAt))
                ),
                h('div', { style: { maxHeight: 480, overflow: 'auto', paddingRight: 4 } }, h(Transcript, { conversation }))
              )
              : h(Empty, null, '选择左侧会话预览。真正的对话会在 DSH 原生界面中打开。')
          )
        )
      )
    }

    // -------------------------------------------------------------------- ai

    function AiTab(props) {
      const status = props.status
      const peers = (status && status.peers || []).filter(function (peer) { return peer.trust === 'trusted' })
      const [node, setNode] = useState('')
      const [models, setModels] = useState([])
      const [model, setModel] = useState('')
      const [prompt, setPrompt] = useState('')
      const [answer, setAnswer] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [teamPrompt, setTeamPrompt] = useState('')
      const [teamNodes, setTeamNodes] = useState([])
      const [teamResult, setTeamResult] = useState(null)

      useEffect(function () {
        setModels([])
        setModel('')
        setError('')
        const path = node ? '/ai/models?node=' + encodeURIComponent(node) : '/ai/models'
        api(path)
          .then(function (body) {
            const rows = body.models || []
            setModels(rows)
            if (rows.length) setModel(rows[0].provider + '/' + rows[0].id)
          })
          .catch(function (err) { setError(String(err.message || err)) })
      }, [node])

      const ask = function () {
        if (!prompt.trim()) return
        setBusy(true)
        setError('')
        setAnswer(null)
        const selected = models.find(function (row) { return row.provider + '/' + row.id === model })
        api('/ai/ask', {
          method: 'POST',
          body: {
            node: node || undefined,
            prompt,
            provider: selected && selected.provider,
            model: selected && selected.id
          }
        })
          .then(function (body) { setAnswer(body) })
          .catch(function (err) { setError(String(err.message || err)) })
          .finally(function () { setBusy(false) })
      }

      const team = function () {
        if (!teamPrompt.trim() || !teamNodes.length) return
        setBusy(true)
        setError('')
        setTeamResult(null)
        api('/ai/team', { method: 'POST', body: { prompt: teamPrompt, nodes: teamNodes } })
          .then(function (body) { setTeamResult(body) })
          .catch(function (err) { setError(String(err.message || err)) })
          .finally(function () { setBusy(false) })
      }

      const toggleNode = function (id) {
        setTeamNodes(function (current) {
          return current.indexOf(id) >= 0 ? current.filter(function (row) { return row !== id }) : current.concat([id])
        })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: Object.assign({}, S.card, { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }) },
          h(Field, { label: '算力来源' },
            h('select', { value: node, onChange: function (event) { setNode(event.target.value) }, style: S.select },
              h('option', { value: '' }, '本机'),
              peers.map(function (peer) { return h('option', { key: peer.nodeId, value: peer.nodeId }, peer.name || peer.nodeId) })
            )
          ),
          h(Field, { label: '模型' },
            h('select', { value: model, onChange: function (event) { setModel(event.target.value) }, style: Object.assign({}, S.select, { maxWidth: 280 }) },
              models.length ? models.map(function (row) { return h('option', { key: row.provider + '/' + row.id, value: row.provider + '/' + row.id }, row.name + ' · ' + row.provider) }) : h('option', { value: '' }, '没有可用模型')
            )
          )
        ),
        error ? h('div', { style: Object.assign({}, S.err, { marginBottom: 10 }) }, error) : null,
        h(Section, { title: node ? '借用远端模型' : '本机模型' },
          h('div', { style: S.col },
            h('textarea', {
              value: prompt,
              onChange: function (event) { setPrompt(event.target.value) },
              placeholder: '问点什么…',
              rows: 4,
              style: Object.assign({}, S.input, { width: '100%', resize: 'vertical', fontFamily: C.mono })
            }),
            h('div', { style: { display: 'flex', gap: 6 } },
              h(Btn, { primary: true, onClick: ask, disabled: busy || !prompt.trim() }, busy ? '思考中…' : '发送'),
              h(Btn, { ghost: true, onClick: function () { setPrompt('') } }, '清空')
            ),
            answer
              ? h('div', { style: S.card },
                h('div', { style: S.sub }, answer.provider + ' / ' + answer.model + (answer.ms ? ' · ' + answer.ms + 'ms' : '')),
                h(Preview, { text: answer.text })
              )
              : null
          )
        ),
        h(Section, { title: '多机协作' },
          h('div', { style: S.col },
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              peers.length
                ? peers.map(function (peer) {
                  const on = teamNodes.indexOf(peer.nodeId) >= 0
                  return h(Btn, { key: peer.nodeId, small: true, primary: on, onClick: function () { toggleNode(peer.nodeId) } }, (on ? '✓ ' : '') + (peer.name || peer.nodeId))
                })
                : h('span', { style: S.note }, '没有已信任设备')
            ),
            h('textarea', {
              value: teamPrompt,
              onChange: function (event) { setTeamPrompt(event.target.value) },
              placeholder: '同一个问题发给多台设备…',
              rows: 3,
              style: Object.assign({}, S.input, { width: '100%', resize: 'vertical', fontFamily: C.mono })
            }),
            h('div', null, h(Btn, { primary: true, onClick: team, disabled: busy || !teamPrompt.trim() || !teamNodes.length }, busy ? '汇总中…' : '并行提问')),
            teamResult
              ? h('div', { style: S.grid }, (teamResult.results || []).map(function (row) {
                return h('div', { key: row.nodeId, style: S.card },
                  h('div', { style: S.row }, h(Dot, { tone: row.ok ? 'ok' : 'err' }), h('div', { style: { fontWeight: 600 } }, row.name || row.nodeId)),
                  row.ok ? h(Preview, { text: row.text }) : h('div', { style: S.err }, row.error)
                )
              }))
              : null
          )
        )
      )
    }

    // -------------------------------------------------------------- settings

    function SettingsTab(props) {
      const status = props.status
      const config = (status && status.config) || {}
      const [form, setForm] = useState({})
      const [note, setNote] = useState('')
      const [invite, setInvite] = useState('')
      const [join, setJoin] = useState('')
      const [bootstrap, setBootstrap] = useState('')
      const [extraRoot, setExtraRoot] = useState('')
      const [audit, setAudit] = useState([])
      const loadedForm = useRef(false)

      useEffect(function () {
        if (!status || !status.config || loadedForm.current) return
        loadedForm.current = true
        setForm({
          nodeName: config.nodeName || '',
          port: config.port || 47820,
          discoveryPort: config.discoveryPort || 47821,
          discovery: config.discovery !== false,
          syncIntervalMs: config.syncIntervalMs || 5000,
          autoAcceptTransfers: config.autoAcceptTransfers === true,
          allowRemoteRead: config.allowRemoteRead !== false,
          allowRemoteAi: config.allowRemoteAi === true,
          agentTools: config.agentTools !== false
        })
      }, [status])

      const set = function (key, value) {
        setForm(function (current) { return Object.assign({}, current, { [key]: value }) })
      }

      const save = function () {
        setNote('保存中…')
        api('/setup', { method: 'POST', body: form })
          .then(function () { setNote('已保存'); props.refresh() })
          .catch(function (err) { setNote('保存失败：' + String(err.message || err)) })
      }

      const makeInvite = function () {
        api('/invite')
          .then(function (body) {
            setInvite(body.code)
            if (!copyText(body.code)) setNote('邀请码已生成')
          })
          .catch(function (err) { setNote(String(err.message || err)) })
      }

      const doJoin = function () {
        if (!join.trim()) return
        setNote('加入中…')
        api('/join', { method: 'POST', body: { code: join.trim() } })
          .then(function () { setNote('已加入新空间'); setJoin(''); props.refresh() })
          .catch(function (err) { setNote('加入失败：' + String(err.message || err)) })
      }

      const addBootstrap = function () {
        if (!bootstrap.trim()) return
        api('/peers/bootstrap', { method: 'POST', body: { address: bootstrap.trim() } })
          .then(function () { setNote('已添加并尝试连接'); setBootstrap(''); props.refresh() })
          .catch(function (err) { setNote(String(err.message || err)) })
      }

      const addRoot = function () {
        if (!extraRoot.trim()) return
        api('/workspaces/add', { method: 'POST', body: { path: extraRoot.trim() } })
          .then(function () { setNote('已添加共享目录'); setExtraRoot(''); props.refresh() })
          .catch(function (err) { setNote(String(err.message || err)) })
      }

      const loadAudit = function () {
        api('/audit')
          .then(function (body) { setAudit(body.events || []) })
          .catch(function (err) { setNote(String(err.message || err)) })
      }

      const rows = (status && status.peers) || []

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        note ? h('div', { style: { color: C.dim, fontSize: 12 } }, note) : null,
        h(Section, { title: '本机' },
          h('div', { style: Object.assign({}, S.card, { marginBottom: 10, color: C.dim, fontSize: 12 }) },
            h('div', null, '节点 ID：' + ((status && status.identity && status.identity.nodeId) || '')),
            h('div', { style: S.sub }, '空间：' + ((status && status.config && status.config.spaceId) || '')),
            (status && status.network || []).map(function (row) {
              return h('div', { key: row.address, style: S.mono }, row.url)
            })
          ),
          h('div', { style: Object.assign({}, S.card, { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }) },
            h(Field, { label: '设备名称' }, h('input', { value: form.nodeName || '', onChange: function (e) { set('nodeName', e.target.value) }, style: S.input })),
            h(Field, { label: 'HTTP 端口' }, h('input', { type: 'number', value: form.port || '', onChange: function (e) { set('port', Number(e.target.value)) }, style: S.input })),
            h(Field, { label: '发现端口' }, h('input', { type: 'number', value: form.discoveryPort || '', onChange: function (e) { set('discoveryPort', Number(e.target.value)) }, style: S.input })),
            h(Field, { label: '同步间隔 ms' }, h('input', { type: 'number', value: form.syncIntervalMs || '', onChange: function (e) { set('syncIntervalMs', Number(e.target.value)) }, style: S.input }))
          ),
          h('div', { style: { marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap' } },
            h('label', { style: S.row }, h('input', { type: 'checkbox', checked: form.discovery === true, onChange: function (e) { set('discovery', e.target.checked) } }), h('span', null, '局域网发现')),
            h('label', { style: S.row }, h('input', { type: 'checkbox', checked: form.allowRemoteRead === true, onChange: function (e) { set('allowRemoteRead', e.target.checked) } }), h('span', null, '允许信任设备浏览文件')),
            h('label', { style: S.row }, h('input', { type: 'checkbox', checked: form.allowRemoteAi === true, onChange: function (e) { set('allowRemoteAi', e.target.checked) } }), h('span', null, '允许信任设备借用模型')),
            h('label', { style: S.row }, h('input', { type: 'checkbox', checked: form.autoAcceptTransfers === true, onChange: function (e) { set('autoAcceptTransfers', e.target.checked) } }), h('span', null, '自动接收文件')),
            h('label', { style: S.row }, h('input', { type: 'checkbox', checked: form.agentTools === true, onChange: function (e) { set('agentTools', e.target.checked) } }), h('span', null, '注册 AI 工具'))
          ),
          h('div', { style: { marginTop: 12 } }, h(Btn, { primary: true, onClick: save }, '保存设置')),
          h('div', { style: Object.assign({}, S.sub, { marginTop: 8 }) },
            '已注册 AI 工具：' + (((status && status.tools && status.tools.registered) || []).join(', ') || '无')
          )
        ),
        h(Section, { title: '配对' },
          h('div', { style: S.grid },
            h('div', { style: S.card },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '邀请另一台电脑'),
              h('div', { style: Object.assign({}, S.note, { marginBottom: 8 }) }, '邀请码包含本机地址和空间密钥，请只发给可信的人。'),
              h(Btn, { onClick: makeInvite }, '生成邀请码'),
              invite ? h('div', { style: Object.assign({}, S.pre, { marginTop: 8, maxHeight: 90 }) }, invite) : null
            ),
            h('div', { style: S.card },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '加入已有空间'),
              h('textarea', { value: join, onChange: function (e) { setJoin(e.target.value) }, rows: 3, placeholder: '粘贴邀请码', style: Object.assign({}, S.input, { width: '100%', fontFamily: C.mono, resize: 'vertical' }) }),
              h('div', { style: { marginTop: 8 } }, h(Btn, { primary: true, onClick: doJoin }, '加入'))
            )
          )
        ),
        h(Section, { title: '手动添加设备' },
          h('div', { style: Object.assign({}, S.card, { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }) },
            h(Field, { label: '地址' }, h('input', { value: bootstrap, onChange: function (e) { setBootstrap(e.target.value) }, placeholder: '192.168.1.20:47820', style: Object.assign({}, S.input, { minWidth: 220 }) })),
            h(Btn, { onClick: addBootstrap }, '连接')
          )
        ),
        h(Section, { title: '共享目录' },
          h('div', { style: Object.assign({}, S.card, { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }) },
            h(Field, { label: '额外目录' }, h('input', { value: extraRoot, onChange: function (e) { setExtraRoot(e.target.value) }, placeholder: 'D:\\work\\notes', style: Object.assign({}, S.input, { minWidth: 260 }) })),
            h(Btn, { onClick: addRoot }, '共享')
          ),
          h('div', { style: { marginTop: 8, color: C.faint, fontSize: 11.5 } }, 'DSH 工作区会自动出现在列表中；这里用于添加工作区之外、你愿意局域网共享的目录。')
        ),
        h(Section, { title: '信任设备' },
          rows.length
            ? h('div', { style: S.col }, rows.map(function (peer) {
              return h('div', { key: peer.nodeId, style: Object.assign({}, S.card, { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }) },
                h(Dot, { tone: trustTone(peer.trust) }),
                h('div', { style: { flex: 1, minWidth: 150 } },
                  h('div', { style: { fontWeight: 600 } }, peer.name || peer.nodeId),
                  h('div', { style: S.sub }, (peer.address || '无地址') + ' · ' + fmtTime(peer.lastSeenAt))
                ),
                h(Btn, { small: true, onClick: function () { api('/peers/trust', { method: 'POST', body: { nodeId: peer.nodeId, trust: 'trusted' } }).then(props.refresh).catch(function (err) { setNote(String(err.message || err)) }) } }, '信任'),
                h(Btn, { small: true, danger: true, onClick: function () { api('/peers/trust', { method: 'POST', body: { nodeId: peer.nodeId, trust: 'blocked' } }).then(props.refresh).catch(function (err) { setNote(String(err.message || err)) }) } }, '阻止')
              )
            }))
            : h(Empty, null, '暂无设备')
        ),
        h(Section, { title: '审计' },
          h('div', { style: { marginBottom: 8 } }, h(Btn, { small: true, onClick: loadAudit }, '加载最近事件')),
          audit.length
            ? h('div', { style: Object.assign({}, S.pre, { maxHeight: 220 }) }, audit.map(function (row) {
              return h('div', { key: row.at + row.action }, fmtTime(row.at) + '  ' + row.action + '  ' + JSON.stringify(row.detail || {}).slice(0, 160))
            }))
            : null
        )
      )
    }

    // ------------------------------------------------------------------ panel

    const TABS = [
      { key: 'home', label: '概览' },
      { key: 'files', label: '文件' },
      { key: 'conversations', label: '对话' },
      { key: 'ai', label: 'AI' },
      { key: 'settings', label: '设置' }
    ]

    function Panel() {
      const { status, error, refresh } = useStatus()
      const [tab, setTab] = useState('home')
      const [target, setTarget] = useState('')
      const [note, setNote] = useState('')

      const approve = function (row) {
        api('/transfers/approve', { method: 'POST', body: { id: row.id } })
          .then(function () { setNote('已接收 ' + row.name); refresh() })
          .catch(function (err) { setNote('接收失败：' + String(err.message || err)) })
      }
      const reject = function (row) {
        api('/transfers/reject', { method: 'POST', body: { id: row.id } })
          .then(function () { setNote('已拒绝 ' + row.name); refresh() })
          .catch(function (err) { setNote(String(err.message || err)) })
      }

      const peerCount = (status && status.peers || []).filter(function (peer) { return peer.trust === 'trusted' }).length
      const transportOk = status && status.transport && status.transport.listening

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.header },
          h(Glyph, { name: 'lan', size: 20, color: C.brand }),
          h('div', { style: { minWidth: 0 } },
            h('div', { style: S.title }, '局域网'),
            h('div', { style: S.sub },
              h(Dot, { tone: transportOk ? 'ok' : 'err' }),
              h('span', null, transportOk ? peerCount + ' 台设备在线' : '服务未监听'),
              status && status.config ? h('span', { style: S.mono }, status.config.spaceId) : null,
              status && status.version ? h('span', null, 'v' + status.version) : null
            )
          ),
          h('div', { style: { flex: 1 } }),
          note ? h('span', { style: { color: C.dim, fontSize: 11.5, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note) : null,
          h(Btn, { onClick: function () { api('/sync', { method: 'POST', body: {} }).then(function () { refresh() }).catch(function (err) { setNote(String(err.message || err)) }) } }, '同步')
        ),
        error ? h('div', { style: { color: C.err, padding: '6px 16px', fontSize: 12 } }, error) : null,
        status && status.bootError
          ? h('div', { style: { color: C.err, padding: '6px 16px', fontSize: 12 } }, '启动错误：' + status.bootError)
          : null,
        h(
          'div',
          { style: S.tabs },
          TABS.map(function (row) {
            return h(
              'button',
              {
                key: row.key,
                type: 'button',
                onClick: function () { setTab(row.key) },
                style: Object.assign({}, S.tab, tab === row.key ? S.tabOn : null)
              },
              row.label
            )
          })
        ),
        h(
          'div',
          { style: S.body },
          !status
            ? h(Empty, null, '正在连接本机服务…')
            : tab === 'home'
              ? h(HomeTab, { status, refresh, setTab, setTarget, approve, reject })
              : tab === 'files'
                ? h(FilesTab, { status, target })
                : tab === 'conversations'
                  ? h(ConversationsTab, { status, target })
                  : tab === 'ai'
                    ? h(AiTab, { status })
                    : h(SettingsTab, { status, refresh })
        )
      )
    }

    // ------------------------------------------------------------------ glyph

    function Glyph(props) {
      const size = props.size || 20
      const color = props.color || C.dim
      const name = props.name || 'lan'
      const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }
      if (name === 'folder') {
        return h('svg', common, h('path', { key: 'f', d: 'M3.5 7.5h6l1.8 2.2h9.2v9.3h-17z' }))
      }
      if (name === 'file') {
        return h('svg', common, h('path', { key: 'f', d: 'M6.5 3.5h7l4 4v13h-11z' }), h('path', { key: 'l', d: 'M13.5 3.5v4h4' }))
      }
      if (name === 'device') {
        return h('svg', common,
          h('rect', { key: 'r', x: 3.5, y: 4.5, width: 17, height: 11, rx: 1.5 }),
          h('path', { key: 's', d: 'M8 19.5h8M12 15.5v4' })
        )
      }
      if (name === 'chat') {
        return h('svg', common, h('path', { key: 'c', d: 'M4 5.5h16v10.5h-8l-4 3v-3H4z' }))
      }
      if (name === 'code') {
        return h('svg', common, h('path', { key: 'l', d: 'm8 8-4 4 4 4M16 8l4 4-4 4' }))
      }
      return h('svg', common,
        h('circle', { key: 'a', cx: 6, cy: 7, r: 2.2 }),
        h('circle', { key: 'b', cx: 18, cy: 17, r: 2.2 }),
        h('circle', { key: 'c', cx: 6, cy: 17, r: 2.2 }),
        h('path', { key: 'l', d: 'M8.1 8 15.8 15.8M8.1 16.2 15.8 8.2' })
      )
    }

    function PanelIcon(props) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' } },
        h(Glyph, { name: 'lan', size: (props && props.size) || 20, color: C.brand })
      )
    }

    function guarded(Component) {
      return function Guarded(props) {
        return h(ErrorBoundary, null, h(Component, props))
      }
    }

    return {
      inject: ['slots', 'uiWorkspace', 'sessions'],
      apply(ctx) {
        HOST = ctx
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
          /* host may not expose the sidebar slot */
        }
        try {
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: 'lan' }, guarded(Panel))
          })
        } catch (err) {
          /* host may not expose the main slot */
        }
      }
    }
  }
})
