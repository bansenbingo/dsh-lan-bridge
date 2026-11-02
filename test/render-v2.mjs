import assert from 'node:assert/strict'

let mod = null
const registrations = []

globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      assert.equal(options.id, 'dsh-lan-bridge')
      mod = options.factory(requireFake)
    }
  }
}

function requireFake(name) {
  assert.equal(name, 'react', 'client only requires react')
  return ReactFake
}

const ReactFake = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function () {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
  Component: class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState() {}
  }
}

await import('../client.js')
assert(mod, 'client factory ran')
assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'client injects slots')
assert(mod.inject.includes('uiWorkspace') && mod.inject.includes('sessions'), 'client injects native conversation services')

mod.apply({
  slots: {
    inject(name, callback) {
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return { dispose() {} }
    }
  },
  uiWorkspace: {
    openSession() {
      return true
    }
  }
})

assert.equal(registrations.length, 2, 'sidebar and main slots are registered')
assert.equal(registrations[0].options.name, 'sidebar.panellist')
assert.equal(registrations[0].options.id, 'lan')
assert.equal(registrations[1].options.name, 'main')
assert.equal(registrations[1].options.key, 'lan')

// The icon component is pure; render it once to catch a broken style or glyph.
const icon = registrations[0].component({ size: 20 })
assert(icon && icon.type, 'icon renders a node')

console.log('render-v2 ok · slots=', registrations.map((row) => row.options.name).join(','))
