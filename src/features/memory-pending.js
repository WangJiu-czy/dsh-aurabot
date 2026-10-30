import { dataDir, readJson, writeJson, existsSync } from '../core/store.js'

const HOUR = 60 * 60_000
const IDLE = 10 * 60_000
const idOf = value => typeof value === 'string' ? value.trim() : Number.isSafeInteger(value) ? String(value) : ''

// Single-process, synchronous read/modify/write; never retain a disk snapshot across await.
export function createMemoryPending({ getConfig, encode, clock = Date.now, log }) {
  const file = () => dataDir('memory-pending.json')
  const enabled = () => getConfig()?.memory?.simulation?.enabled === true
  let running = null
  let flight = null

  function load() {
    const state = readJson(file(), () => {
      if (existsSync(file())) throw new Error('MEMORY_PENDING_READ_FAILED')
      return { version: 1, conversations: [] }
    })
    if (state?.version !== 1 || !Array.isArray(state.conversations) || state.conversations.some(c =>
      !idOf(c?.chatId) || !Array.isArray(c.messages) || !Array.isArray(c.attempts) || !Array.isArray(c.seen))) {
      throw new Error('MEMORY_PENDING_INVALID')
    }
    return state
  }

  function observe(a) {
    if (!enabled()) return { ok: true, ignored: true }
    const chatId = idOf(a?.chatId), id = idOf(a?.messageId), uid = idOf(a?.userId)
    if (a?.kind !== 'in' || !chatId || !id || !uid || uid === 'system' || a.system || a.isSystem ||
      typeof a.text !== 'string' || !a.text.trim() || !a.chat || typeof a.chat !== 'object' ||
      Array.isArray(a.chat) || !Object.keys(a.chat).length || a.chat.kind === 'system' ||
      (a.chat.chatId && a.chat.chatId !== chatId)) return { ok: true, ignored: true }
    // Keep caller mutation (including encode mutation) outside the durable queue.
    let chat
    try { chat = JSON.parse(JSON.stringify(a.chat)) } catch { return { ok: false, code: 'INVALID_CHAT' } }
    const state = load()
    let conversation = state.conversations.find(c => c.chatId === chatId)
    if (conversation && (conversation.seen.includes(id) || conversation.messages.some(m => m.id === id))) return { ok: true, duplicate: true }
    if ((!conversation && state.conversations.length >= 100) || conversation?.messages.length >= 200) {
      return { ok: false, code: 'QUEUE_FULL' }
    }
    if (!conversation) {
      conversation = { chatId, messages: [], attempts: [], seen: [] }
      state.conversations.push(conversation)
    }
    conversation.messages.push({ id, text: a.text.slice(0, 5000), uid,
      who: typeof a.nickname === 'string' ? a.nickname : '',
      t: Number.isFinite(a.timestamp) && a.timestamp ? a.timestamp : clock(), chatId, chat })
    // ponytail: recent 400 IDs per conversation; durable full replay protection needs an upstream event ledger.
    conversation.seen = [...conversation.seen, id].slice(-400)
    writeJson(file(), state)
    return { ok: true }
  }

  function removeSources(ids, chatId) {
    chatId = idOf(chatId)
    if (!chatId || !Array.isArray(ids)) return { ok: false, code: 'INVALID_SCOPE' }
    const wanted = new Set(ids.map(idOf).filter(Boolean))
    const state = load()
    const conversation = state.conversations.find(c => c.chatId === chatId)
    if (!conversation) return { ok: true, removed: 0 }
    const before = conversation.messages.length
    conversation.messages = conversation.messages.filter(m => !wanted.has(m.id))
    if (flight?.chatId === chatId) for (const id of wanted) flight.canceled.add(id)
    writeJson(file(), state)
    return { ok: true, removed: before - conversation.messages.length }
  }

  async function drain() {
    if (!enabled()) return { ok: true, skipped: true }
    let attempted = 0, completed = 0
    // At most one batch per conversation per tick. Callers choose the tick frequency.
    const chatIds = load().conversations.map(c => c.chatId)
    for (const chatId of chatIds) {
      if (!enabled()) break
      const now = clock(), state = load()
      const c = state.conversations.find(c => c.chatId === chatId)
      if (!c?.messages.length) continue
      const recent = c.attempts.filter(t => Number.isFinite(t) && t > now - HOUR)
      if (recent.length >= 6 || (c.messages.length < 8 && now - Math.max(...c.messages.map(m => m.t)) < IDLE)) continue
      const messages = structuredClone(c.messages.slice(0, 40))
      const submitted = new Set(messages.map(m => m.id))
      c.attempts = [...recent, now]
      writeJson(file(), state) // Failures/crashes consume budget too.
      flight = { chatId, canceled: new Set() }
      attempted++
      try {
        // encode must recheck source retention/deletion generation at its OWN final store commit.
        // This queue can cancel acknowledgement, not undo independent encoder writes.
        const result = await encode(chatId, messages, structuredClone(messages[0].chat))
        if (result?.ok === true) {
          const latest = load()
          const retained = latest.conversations.find(c => c.chatId === chatId)
          if (retained) {
            retained.messages = retained.messages.filter(m => !submitted.has(m.id) || flight.canceled.has(m.id))
            writeJson(file(), latest)
          }
          completed++
        }
      } catch {
        log?.warn?.('Memory pending encoding failed') // Never log transcript or model errors.
      } finally { flight = null }
    }
    return { ok: true, attempted, completed }
  }

  function tick() {
    if (running) return running
    running = drain().finally(() => { running = null })
    return running
  }

  function status() {
    const now = clock()
    const conversations = load().conversations.map(c => ({ chatId: c.chatId, count: c.messages.length,
      attemptsLastHour: c.attempts.filter(t => Number.isFinite(t) && t > now - HOUR).length }))
    return { enabled: enabled(), busy: Boolean(running), pending: conversations.reduce((sum, c) => sum + c.count, 0), conversations }
  }

  return { observe, tick, status, removeSources }
}
