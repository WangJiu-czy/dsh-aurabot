import { imId } from '../chat/im-context.js'

const PLATFORM_RE = /^[a-z][a-z0-9-]{1,39}$/

/** Future IM adapters are isolated by platform and logged-in account. */
export function createImAdapterRegistry() {
  const adapters = new Map()
  const listeners = new Set()
  let generation = 0
  const keyOf = ({ platform, accountId } = {}) => {
    if (!PLATFORM_RE.test(String(platform || ''))) throw new Error('IM 平台标识不合法')
    if (accountId === undefined || accountId === null || String(accountId) === '') throw new Error('IM accountId 不能为空')
    return JSON.stringify([String(platform), imId(accountId, 'accountId')])
  }
  const requireAdapter = (identity) => {
    const entry = adapters.get(keyOf(identity))
    if (!entry) throw new Error(`没有注册 IM adapter：${identity.platform}/${identity.accountId}`)
    return entry
  }

  return {
    subscribe(handler) {
      if (typeof handler !== 'function') throw new TypeError('IM handler must be a function')
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    generation(identity) { return adapters.get(keyOf(identity))?.generation },
    register(identity, adapter) {
      const key = keyOf(identity)
      if (!adapter || typeof adapter.send !== 'function') throw new Error('IM adapter 必须提供 send()')
      if (adapters.has(key)) throw new Error(`IM adapter 已注册：${identity.platform}/${identity.accountId}`)
      const entry = { platform: String(identity.platform), accountId: String(identity.accountId), adapter, listeners: new Set(), generation: ++generation }
      adapters.set(key, entry)
      return () => { if (adapters.get(key) === entry) adapters.delete(key) }
    },
    onMessage(identity, handler) {
      if (typeof handler !== 'function') throw new TypeError('IM message handler 必须是函数')
      const entry = requireAdapter(identity)
      entry.listeners.add(handler)
      return () => entry.listeners.delete(handler)
    },
    send({ platform, accountId, conversation }, message) {
      if (!conversation || conversation.id === undefined || conversation.id === null || String(conversation.id) === '') throw new Error('IM conversation.id 不能为空')
      const entry = requireAdapter({ platform, accountId })
      return entry.adapter.send({ platform: entry.platform, accountId: entry.accountId, conversation: { ...conversation, id: imId(conversation.id, 'conversation.id') } }, message)
    },
    async receive({ platform, accountId, conversation, ...event }) {
      if (!conversation || conversation.id === undefined || conversation.id === null || String(conversation.id) === '') throw new Error('IM conversation.id 不能为空')
      const entry = requireAdapter({ platform, accountId })
      const message = { ...event, platform: entry.platform, accountId: entry.accountId, generation: entry.generation, conversation: { ...conversation, id: imId(conversation.id, 'conversation.id') } }
      for (const listener of [...entry.listeners, ...listeners]) {
        if (adapters.get(keyOf(entry)) !== entry) return false
        await listener(message)
      }
      return entry.listeners.size + listeners.size > 0
    },
  }
}
