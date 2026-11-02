/**
 * Remote model invocation (v2).
 *
 * A peer can borrow another node's *model*, never its tools or filesystem: the
 * request is a plain chat completion executed with the target's own provider
 * credentials. This is deliberately narrower than running an agent remotely,
 * because DSH's permission model is attached to a local session and cannot be
 * imposed on a caller from another machine.
 */

const DEFAULT_TIMEOUT_MS = 120000
const MAX_PROMPT_CHARS = 120000

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const message of input) {
    if (!message || typeof message !== 'object') continue
    const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
    const text = textOf(message.content).slice(0, MAX_PROMPT_CHARS)
    if (!text) continue
    out.push({ role, content: [{ type: 'text', text }] })
  }
  // GenerateOptions accepts request-only inputs only for the user role. Fold a
  // system instruction into the first user turn instead of sending a role the
  // provider adapter would reject for lacking a durable message id.
  const systems = out.filter((message) => message.role === 'system').map((message) => textOf(message.content))
  const rest = out.filter((message) => message.role !== 'system')
  if (systems.length) {
    const prefix = systems.join('\n\n')
    if (rest.length && rest[0].role === 'user') {
      rest[0] = {
        role: 'user',
        content: [{ type: 'text', text: prefix + '\n\n' + textOf(rest[0].content) }]
      }
    } else {
      rest.unshift({ role: 'user', content: [{ type: 'text', text: prefix }] })
    }
  }
  return rest
}

export function createAi(options) {
  const getContext = options.getContext
  const getConfig = options.getConfig
  const transport = options.transport
  const getPeers = options.getPeers
  let modelCache = null
  let modelCacheAt = 0
  const counters = new Map()

  function llm() {
    const ctx = getContext()
    return ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null
  }

  function today() {
    return new Date().toISOString().slice(0, 10)
  }

  function allowedModels() {
    const config = getConfig()
    return Array.isArray(config.aiModelAllowlist) ? config.aiModelAllowlist : []
  }

  function modelAllowed(provider, model) {
    const allow = allowedModels()
    if (!allow.length) return true
    const key = provider + '/' + model
    return allow.indexOf(key) >= 0 || allow.indexOf(model) >= 0
  }

  async function models(force) {
    if (!force && modelCache && Date.now() - modelCacheAt < 30000) return modelCache
    const service = llm()
    if (!service) return []
    const out = []
    let providers = []
    try {
      providers = await service.listProviders()
    } catch (err) {
      providers = []
    }
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = typeof provider === 'string' ? provider : provider.id || provider.provider || provider.name
      if (!id) continue
      try {
        const list = await service.listModels(id)
        for (const model of Array.isArray(list) ? list : []) {
          const modelId = typeof model === 'string' ? model : model.id || model.model
          if (!modelId || !modelAllowed(id, modelId)) continue
          out.push({
            provider: id,
            id: modelId,
            name: (model && model.name) || modelId,
            description: (model && model.description) || '',
            inputModalities: (model && model.inputModalities) || ['text']
          })
        }
      } catch (err) {
        /* provider may be offline */
      }
    }
    modelCache = out
    modelCacheAt = Date.now()
    return out
  }

  async function ask(requestOptions) {
    const opts = requestOptions || {}
    const service = llm()
    if (!service || typeof service.stream !== 'function') {
      const error = new Error('this node has no model provider configured')
      error.code = 'NO_LLM'
      throw error
    }
    const messages = normalizeMessages(opts.messages)
    if (!messages.length) {
      const error = new Error('the request has no prompt')
      error.code = 'EMPTY_PROMPT'
      throw error
    }
    const modelsList = await models()
    let provider = opts.provider
    let model = opts.model
    if (!provider || !model) {
      if (!modelsList.length) {
        const error = new Error('this node exposes no models; pass provider and model explicitly')
        error.code = 'NO_MODEL'
        throw error
      }
      const first = modelsList[0]
      provider = provider || first.provider
      const sameProvider = modelsList.find((row) => row.provider === provider)
      model = model || (sameProvider && sameProvider.id) || first.id
    }
    if (!modelAllowed(provider, model)) {
      const error = new Error('model is not on this node\'s allow list')
      error.code = 'MODEL_DENIED'
      throw error
    }
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS)
    let text = ''
    let reasoning = ''
    let usage = null
    let finish = null
    try {
      const stream = service.stream({
        provider,
        model,
        messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        signal: controller.signal
      })
      for await (const chunk of stream) {
        if (!chunk || !chunk.type) continue
        if (chunk.type === 'text-delta') text += chunk.text || ''
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text || ''
        else if (chunk.type === 'usage') usage = chunk.usage || chunk
        else if (chunk.type === 'finish') {
          finish = chunk
          if (chunk.kind === 'error' || chunk.kind === 'aborted') {
            const error = new Error((chunk.failure && chunk.failure.message) || 'model call failed')
            error.code = 'MODEL_FAILED'
            throw error
          }
        }
      }
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        const error = new Error('model call timed out')
        error.code = 'MODEL_TIMEOUT'
        throw error
      }
      if (err && err.code === 'MODEL_FAILED') throw err
      const error = new Error((err && err.message) || 'model call failed')
      error.code = 'MODEL_FAILED'
      throw error
    } finally {
      clearTimeout(timer)
    }
    return {
      ok: true,
      provider,
      model,
      text,
      reasoning,
      usage,
      finish,
      ms: Date.now() - started
    }
  }

  function limitFor(peerId) {
    const config = getConfig()
    const key = peerId + ':' + today()
    const count = counters.get(key) || 0
    return { key, count, limit: Math.max(1, Number(config.maxAiCallsPerDay) || 200) }
  }

  function consume(peerId) {
    const info = limitFor(peerId)
    if (info.count >= info.limit) {
      const error = new Error('daily remote model quota reached')
      error.status = 429
      error.code = 'QUOTA'
      throw error
    }
    counters.set(info.key, info.count + 1)
    if (counters.size > 5000) {
      for (const key of counters.keys()) {
        if (!key.endsWith(today())) counters.delete(key)
      }
    }
  }

  async function handleRemote(context) {
    const config = getConfig()
    if (!config.allowRemoteAi) {
      const error = new Error('remote model access is disabled on this node')
      error.status = 403
      error.code = 'REMOTE_AI_OFF'
      throw error
    }
    if (!context.peer || context.peer.trust !== 'trusted') {
      const error = new Error('only trusted peers can use this node\'s models')
      error.status = 403
      error.code = 'PEER_NOT_TRUSTED'
      throw error
    }
    const body = context.json
    consume(context.nodeId)
    const result = await ask({
      provider: body.provider,
      model: body.model,
      messages: body.messages,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      timeoutMs: Math.min(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 180000)
    })
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      text: result.text,
      usage: result.usage,
      ms: result.ms
    }
  }

  async function askPeer(peer, requestOptions) {
    const body = {
      provider: requestOptions.provider,
      model: requestOptions.model,
      messages: requestOptions.messages,
      maxTokens: requestOptions.maxTokens,
      temperature: requestOptions.temperature
    }
    return transport.request(peer, 'POST', '/api/v2/ai/ask', { json: body, timeoutMs: 180000 })
  }

  async function team(peerIds, prompt, options) {
    const config = getConfig()
    const list = (await getPeers().list()).filter((peer) => {
      if (peer.trust !== 'trusted') return false
      if (Array.isArray(peerIds) && peerIds.length) return peerIds.indexOf(peer.nodeId) >= 0
      return true
    })
    const messages = [{ role: 'user', content: [{ type: 'text', text: String(prompt || '') }] }]
    const tasks = list.map(async (peer) => {
      try {
        const result = await askPeer(peer, Object.assign({ messages }, options || {}))
        return { ok: true, nodeId: peer.nodeId, name: peer.name, text: result.text, model: result.model, provider: result.provider, ms: result.ms }
      } catch (err) {
        return { ok: false, nodeId: peer.nodeId, name: peer.name, error: String((err && err.message) || err), code: err && err.code }
      }
    })
    const results = await Promise.all(tasks)
    return { ok: true, results, count: results.length }
  }

  return { models, ask, handleRemote, askPeer, team, status: () => ({ models: modelCache ? modelCache.length : 0, cachedAt: modelCacheAt }) }
}
