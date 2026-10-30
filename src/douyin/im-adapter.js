import { createHash, randomUUID } from 'node:crypto'
import { constants, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { createDouyinImClient } from './im-sdk.js'
import { conversationKey, imId } from '../chat/im-context.js'
import { createDouyinMedia } from './im-media.js'

const SYNC_SCOPE = 'sdk-default-all'
const fail = code => ({ ok: false, code })
const uncertain = () => ({ status: 'uncertain' })
const digest = value => createHash('sha256').update(value).digest('hex')
const sequence = m => { const s = m.indexInConversationV2 || m.indexInConversation; return typeof s === 'string' && s.length <= 128 ? s : '' }
const sdkId = (value, field = 'id') => { if (typeof value !== 'string' || value.length > 128) throw new TypeError(field); return imId(value, field) }
const validSequence = s => /^\d+$/.test(s)
const compare = (a, b) => BigInt(sequence(a)) < BigInt(sequence(b)) ? -1 : BigInt(sequence(a)) > BigInt(sequence(b)) ? 1 : 0
const capabilities = Object.freeze({ text: true, mention: true, quote: true, quoteMention: false, image: true, emoji: true, sticker: true, share: true, photos: true, link: true, file: true, video: true, nativeVoice: false })

export function classifyDouyinReceipt(value) {
  // 1.1.0 content.js:273-335: 8610 is an explicit rejection; 10502 is pending audit.
  // confirmed means server acceptance, never that the peer read the message.
  if (value?.checkCode === 8610 && Number.isInteger(value.statusCode)) return { status: 'failed', code: 'SDK_CONTENT_REJECTED' }
  if (value?.statusCode === 0 && typeof value.serverMessageId === 'string' && value.serverMessageId.length <= 128 && /^\d+$/.test(value.serverMessageId) && BigInt(value.serverMessageId) > 0n && [undefined, 0, 8101].includes(value.checkCode)) return { status: 'confirmed', messageId: value.serverMessageId }
  return uncertain()
}

/** Explicit login only. The SDK syncs all contacts internally; this adapter consumes only the trusted allow table. */
export function createDouyinImAdapter({ registry, getConfig, dataDir, createClient = createDouyinImClient, pollMs = 10_000, sendTimeoutMs = 30_000, media } = {}) {
  const mediaIO = createDouyinMedia(media)
  let generation = 0
  let current
  let cache = { status: 'disabled', runtimeNode: 'unknown', sqlite: 'unknown', syncScope: SYNC_SCOPE, syncScopeConfirmationRequired: true, capabilities }
  const state = () => ({ ...cache, capabilities: { ...capabilities } })
  const rowFor = uid => getConfig().imAccounts?.find(a => a.platform === 'douyin' && a.accountId === uid && a.enabled === true)
  const enabled = () => getConfig().enabled === true && getConfig().douyin?.enabled === true && getConfig().douyin?.im?.enabled === true
  const live = s => current === s && s.generation === generation && enabled() && Boolean(rowFor(s.uid))
  const save = s => {
    if (!live(s)) return
    // ponytail: bounded JSON cursor ledger (256 conversations/256 IDs each); use a database for larger allow lists.
    const entries = Object.entries(s.disk.cursors)
    if (entries.length > 256) throw new Error('CURSOR_LIMIT')
    const tmp = `${s.file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(s.disk), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, s.file)
  }
  const load = s => {
    try {
      const info = lstatSync(s.file)
      if (!info.isFile() || info.size > 16_000_000 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('CURSOR_INVALID')
      const disk = JSON.parse(readFileSync(s.file, { encoding: 'utf8', flag: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) }))
      if (disk.version !== 1 || !disk.cursors || typeof disk.cursors !== 'object' || Array.isArray(disk.cursors) || !disk.outbox || typeof disk.outbox !== 'object' || Array.isArray(disk.outbox) || Object.keys(disk.cursors).length > 256 || Object.keys(disk.outbox).length > 256) throw new Error('CURSOR_INVALID')
      for (const c of Object.values(disk.cursors)) if (!c || typeof c.seq !== 'string' || c.seq.length > 128 || !validSequence(c.seq) || (c.scan !== undefined && (typeof c.scan !== 'string' || c.scan.length > 128 || !validSequence(c.scan))) || !Array.isArray(c.ids) || c.ids.length > 256 || c.ids.some(id => typeof id !== 'string' || !id || id.length > 128)) throw new Error('CURSOR_INVALID')
      for (const r of Object.values(disk.outbox)) if (!r || !/^[a-f0-9]{64}$/.test(r.hash) || !['confirmed', 'failed', 'uncertain'].includes(r.receipt?.status) || (r.receipt.status === 'confirmed' && classifyDouyinReceipt({ statusCode: 0, serverMessageId: r.receipt.messageId }).status !== 'confirmed')) throw new Error('CURSOR_INVALID')
      s.disk = disk
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('CURSOR_INVALID')
      s.disk = { version: 1, cursors: {}, outbox: {} }
    }
  }
  function queue(s, fn) {
    // Dropped triggers are recovered from the persisted sequence by the next poll, not discarded messages.
    if ((s.queued || 0) >= 256) return s.tail
    s.queued = (s.queued || 0) + 1
    s.tail = s.tail.then(async () => { if (live(s)) await fn() }).catch(error => {
      if (live(s)) cache = { ...cache, status: 'recovery-pending', code: ['CURSOR_LIMIT', 'MISSING_SEQUENCE', 'CURSOR_STALLED', 'BASELINE_PENDING'].includes(error?.message) ? error.message : 'RECOVERY_PENDING' }
    }).finally(() => { s.queued-- })
    return s.tail
  }
  function allowedContact(s, contact, kind, peer) {
    const row = rowFor(s.uid)
    if (!row || !contact || typeof contact.threadId !== 'string') return false
    return kind === 'group' ? row.allow?.groups?.includes(contact.id) : peer === row.ownerId || row.allow?.private?.includes(peer)
  }
  function selected(s) {
    const row = rowFor(s.uid)
    const result = []
    for (const peer of new Set([row?.ownerId, ...(row?.allow?.private || [])].filter(Boolean))) {
      const contact = s.account.pickFriend(peer) || s.account.pickStranger(peer)
      if (allowedContact(s, contact, 'direct', peer)) result.push({ contact, kind: 'direct', peer })
    }
    for (const id of row?.allow?.groups || []) {
      const contact = s.account.pickGroup(id)
      if (allowedContact(s, contact, 'group')) result.push({ contact, kind: 'group' })
    }
    return result
  }
  function target(s, item) { return { platform: 'douyin', accountId: s.uid, conversation: { kind: item.kind, id: sdkId(item.contact.threadId) } } }
  async function partsOf(m) {
    // Preserve the cheap verified text-history path; public protocol stays lazy (node:sqlite).
    if (m.msgType === 7 && typeof m.content === 'string') {
      try { return [{ type: 'text', text: String(JSON.parse(m.content).text || '') }] } catch { return [] }
    }
    return mediaIO.receive(m)
  }
  async function consume(s, item, m, advance = true) {
    if (!live(s) || !allowedContact(s, item.contact, item.kind, item.peer) || m.threadId !== item.contact.threadId) return
    const connection = s.connection
    const t = target(s, item)
    const key = conversationKey(t)
    const c = s.disk.cursors[key]
    const id = sdkId(m.serverMessageId || m.msgId || m.clientMessageId, 'messageId')
    const seq = sequence(m)
    if (!validSequence(seq)) throw new Error('MISSING_SEQUENCE')
    if (BigInt(seq) < BigInt(c.seq)) return
    if (c.ids.includes(id)) {
      if (advance && BigInt(seq) > BigInt(c.seq)) { c.seq = seq; save(s) }
      return
    }
    const sender = sdkId(m.senderUid, 'senderUid')
    const row = rowFor(s.uid)
    const authorized = item.kind === 'group' || sender === row.ownerId || row.allow?.private?.includes(sender)
    if (authorized && sender !== s.uid && sender !== s.account.imUid) {
      const parts = await partsOf(m)
      if (!live(s) || !s.registered || s.connection !== connection || !allowedContact(s, item.contact, item.kind, item.peer)) return
      const quote = { messageId: id, referencedMessageType: m.messageType ?? m.msgType, referencedUid: sender, referencedText: parts.filter(p => p.type === 'text').map(p => p.text).join('') }
      s.quotes.set(JSON.stringify([key, id]), quote)
      if (s.quotes.size > 256) s.quotes.delete(s.quotes.keys().next().value)
      let mentioned = m.isMentionMe === true
      if (!mentioned && m.msgType === 7) {
        try { mentioned = JSON.parse(m.content).richTextInfos?.some(r => Number(r.infoType) === 1 && Number.isInteger(Number(r.location)) && Number(r.location) >= 0 && Number.isInteger(Number(r.length)) && Number(r.length) > 0 && [s.uid, s.account.imUid].includes(r.info?.uid)) === true } catch {}
      }
      await registry.receive({ ...t, sender: { id: sender }, messageId: id, parts, mentioned,
        ...(m.referenceInfo?.refMessageId ? { replyTo: { messageId: imId(m.referenceInfo.refMessageId) } } : {}),
        timestamp: Number(m.createTime) * (Number(m.createTime) < 1e12 ? 1000 : 1) || Date.now() })
      if (!live(s) || s.connection !== connection || !allowedContact(s, item.contact, item.kind, item.peer)) return
    }
    if (advance) c.seq = BigInt(seq) > BigInt(c.seq) ? seq : c.seq
    c.ids = [...c.ids, id].slice(-256)
    save(s)
  }
  async function recoverContact(s, item) {
    if (!live(s) || !s.registered || !allowedContact(s, item.contact, item.kind, item.peer)) return false
    const connection = s.connection
    const key = conversationKey(target(s, item))
    s.contacts.set(key, item)
    let c = s.disk.cursors[key]
    if (!c) {
      const page = await item.contact.getHistory({ direction: 'older', count: 50 })
      if (!live(s) || !s.registered || s.connection !== connection || !allowedContact(s, item.contact, item.kind, item.peer)) return false
      if (page.statusCode !== 0 || !Array.isArray(page.messages)) throw new Error('BASELINE_PENDING')
      const messages = page.messages.filter(m => m.threadId === item.contact.threadId)
      if (messages.some(m => !validSequence(sequence(m)))) throw new Error('MISSING_SEQUENCE')
      // Commit the entire first snapshot atomically; an invalid/partial baseline never becomes a recovery cursor.
      const ids = messages.sort(compare).map(m => sdkId(m.serverMessageId || m.msgId || m.clientMessageId, 'messageId'))
      c = { seq: messages.length ? sequence(messages.at(-1)) : '0', ids: [...new Set(ids)].slice(-256) }
      s.disk.cursors[key] = c
      try { save(s) } catch (error) { delete s.disk.cursors[key]; throw error }
      return true
    }
    // Advance only through fetched pages before accepting a live event, so reconnect gaps are never skipped.
    for (let pages = 0; pages < 100; pages++) {
      const cursor = c.scan || c.seq
      const page = await item.contact.getHistory({ direction: 'newer', cursor, count: 50, includeCurrent: true })
      if (!live(s) || !s.registered || s.connection !== connection || !allowedContact(s, item.contact, item.kind, item.peer)) return false
      if (page.statusCode !== 0 || !Array.isArray(page.messages)) throw new Error('RECOVERY_PENDING')
      if (page.messages.some(m => !validSequence(sequence(m)))) throw new Error('MISSING_SEQUENCE')
      for (const m of [...page.messages].sort(compare)) {
        if (!live(s) || !s.registered || s.connection !== connection || !allowedContact(s, item.contact, item.kind, item.peer)) return false
        await consume(s, item, m)
      }
      if (!live(s) || !s.registered || s.connection !== connection || !allowedContact(s, item.contact, item.kind, item.peer)) return false
      if (!page.hasMore) { delete c.scan; save(s); return true }
      if (!validSequence(page.cursor) || BigInt(page.cursor) <= BigInt(cursor)) throw new Error('CURSOR_STALLED')
      c.scan = page.cursor
      save(s)
    }
    return false
  }
  async function refreshSession(s) {
    if (!s.registered || !live(s)) return
    const connection = s.connection
    const items = selected(s)
    const row = rowFor(s.uid)
    const wanted = new Set([row.ownerId, ...(row.allow?.private || [])].filter(Boolean)).size + new Set(row.allow?.groups || []).size
    let complete = true
    for (const item of items) if (!await recoverContact(s, item)) complete = false
    if (live(s) && s.registered && s.connection === connection) cache = { ...cache, code: undefined, status: !complete ? 'recovery-pending' : items.length < wanted ? 'waiting-contacts' : 'online' }
  }
  function removeRegistration(s) {
    s.connection = (s.connection || 0) + 1
    s.unregister?.(); s.unregister = undefined; s.registered = false
    for (const cancel of s.pending) cancel()
  }
  const logout = () => stop()
  async function stop(status = 'logged-out', code) {
    const s = current
    current = undefined; generation++
    cache = { ...cache, status, code, accountId: undefined, qrcodeBase64: undefined, syncScopeConfirmationRequired: true }
    if (s) {
      removeRegistration(s)
      clearInterval(s.timer)
      for (const [event, handler] of s.listeners) s.account.off(event, handler)
      for (const cancel of s.pending) cancel()
      s.contacts.clear(); s.quotes.clear()
      // No close() exists in 1.1.0; logout tears down SDK connections/timers.
      await s.client.logout().catch(() => {})
    }
    return { ok: true }
  }
  async function login({ accountId, syncScope } = {}) {
    if (syncScope !== SYNC_SCOPE) return { ...fail('SYNC_SCOPE_CONFIRMATION_REQUIRED'), ...state() }
    if (!enabled()) return fail('DISABLED')
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128 || !rowFor(accountId)) return fail('ACCOUNT_NOT_ALLOWED')
    const row = rowFor(accountId)
    if (new Set([row.ownerId, ...(row.allow?.private || [])].filter(Boolean)).size + new Set(row.allow?.groups || []).size > 256) return fail('TARGET_LIMIT')
    await logout()
    const token = ++generation
    cache = { ...cache, status: 'initializing', runtimeNode: process.versions.node, sqlite: 'unknown', syncScopeConfirmationRequired: false }
    let root, result
    try {
      root = typeof dataDir === 'function' ? dataDir() : dataDir
      result = await createClient({ enabled: true, dataDir: root })
    } catch {
      if (token === generation) cache = { ...cache, status: 'error', code: 'SDK_INIT_FAILED' }
      return fail('SDK_INIT_FAILED')
    }
    if (token !== generation) { if (result.ok) await result.client.logout().catch(() => {}); return fail('STALE_LOGIN') }
    if (!result.ok) { cache = { ...cache, status: 'error', code: result.code, sqlite: result.code === 'SQLITE_UNAVAILABLE' ? 'unavailable' : 'unknown' }; return result }
    if (!enabled() || !rowFor(accountId)) { await result.client.logout().catch(() => {}); return fail('DISABLED') }
    cache = { ...cache, sqlite: result.sqlite || 'unknown', status: 'logging-in', code: undefined }
    const s = { uid: accountId, generation: token, client: result.client, listeners: [], tail: Promise.resolve(), contacts: new Map(), quotes: new Map(), pending: new Set(), registered: false, file: join(root, `cursors-${digest(accountId)}.json`) }
    current = s
    try {
      load(s)
      s.account = s.client.createAccount({ accountId, login: { method: 'qr' }, localState: false })
      const on = (event, handler) => { s.account.on(event, handler); s.listeners.push([event, handler]) }
      on('system.online', payload => {
        if (!live(s)) return
        if (s.account.uid !== accountId || payload?.platformUid !== accountId) {
          void stop('identity-mismatch', 'SELF_UID_MISMATCH'); return
        }
        if (!s.registered) {
          s.unregister = registry.register({ platform: 'douyin', accountId }, { send: (t, m) => send(s, t, m), capabilities })
          s.registered = true
        }
        cache = { ...cache, accountId, qrcodeBase64: undefined, status: 'recovering' }
        queue(s, () => refreshSession(s))
      })
      on('system.reconnecting', () => { if (live(s)) { removeRegistration(s); cache = { ...cache, status: 'reconnecting' } } })
      on('system.offline', () => { if (live(s)) void stop('offline') })
      on('system.login.error', () => { if (live(s)) cache = { ...cache, status: 'login-error', code: 'LOGIN_ERROR' } })
      on('system.login.qrcode', payload => { if (live(s)) cache = { ...cache, status: 'waiting-qr', qrcodeBase64: typeof payload?.qrcodeBase64 === 'string' ? payload.qrcodeBase64 : undefined } })
      on('system.login.verification', () => { if (live(s)) cache = { ...cache, status: 'verification-required' } })
      on('message', e => {
        if (!live(s) || !s.registered) return
        const kind = e.conversationType === 2 ? 'group' : 'direct'
        const contact = kind === 'group' ? s.account.pickGroup(e.threadId) : s.account.pickFriend(e.senderUid) || s.account.pickStranger(e.senderUid)
        if (!allowedContact(s, contact, kind, e.senderUid) || contact.threadId !== e.threadId) return
        const connection = s.connection
        queue(s, async () => { if (!s.registered || s.connection !== connection) return; const item = { contact, kind, peer: e.senderUid }; if (await recoverContact(s, item)) await consume(s, item, e, false) })
      })
      Promise.resolve(s.account.login()).catch(() => { if (live(s)) cache = { ...cache, status: 'login-error', code: 'LOGIN_ERROR' } })
      if (pollMs > 0) { s.timer = setInterval(() => { if (live(s)) queue(s, () => refreshSession(s)); else void logout() }, pollMs); s.timer.unref?.() }
      return { ok: true, ...state() }
    } catch {
      await logout()
      cache = { ...cache, status: 'error', code: 'ACCOUNT_INIT_FAILED' }
      return fail('ACCOUNT_INIT_FAILED')
    }
  }
  async function send(s, t, message) {
    const rejected = code => ({ status: 'failed', code })
    if (!live(s) || !s.registered) return rejected('STALE_IDENTITY')
    if (getConfig().dryRun) return rejected('DRY_RUN')
    if (s.pending.size >= 128) return rejected('SEND_QUEUE_FULL')
    let key
    try {
      if (t.platform !== 'douyin' || t.accountId !== s.uid || typeof t.conversation.id !== 'string') return rejected('INVALID_TARGET')
      key = conversationKey(t)
    } catch { return rejected('INVALID_TARGET') }
    const item = s.contacts.get(key)
    if (!item || !allowedContact(s, item.contact, item.kind, item.peer)) return rejected('TARGET_NOT_ALLOWED')
    const parts = message?.parts
    if (!Array.isArray(parts) || !parts.length || parts.length > 100) return rejected('INVALID_MESSAGE')
    let payload
    for (const p of parts) {
      if (!p || typeof p !== 'object') return rejected('INVALID_MESSAGE')
      if (['record', 'voice', 'audio'].includes(p.type)) return rejected('NATIVE_VOICE_GAP')
      if (!['text', 'mention', 'image', 'emoji', 'sticker', 'share', 'photos', 'link', 'video', 'file'].includes(p.type)) return rejected('CAPABILITY_GAP')
      if (p.type === 'text' && (typeof p.text !== 'string' || p.text.length > 10_000)) return rejected('INVALID_MESSAGE')
      if (p.type === 'mention' && (typeof p.id !== 'string' || !/^\d{1,40}$/.test(p.id))) return rejected('INVALID_MENTION')
    }
    if (message.replyTo) {
      const q = s.quotes.get(JSON.stringify([key, message.replyTo.messageId]))
      if (!q) return rejected('QUOTE_NOT_AVAILABLE')
      if (parts.some(p => p.type !== 'text')) return rejected(parts.some(p => p.type === 'mention') ? 'QUOTE_MENTION_GAP' : 'QUOTE_MEDIA_GAP')
      payload = { type: 'reply', text: parts.map(p => p.text).join(''), referencedMessageId: q.messageId, referencedMessageType: q.referencedMessageType, referencedUid: q.referencedUid, referencedText: q.referencedText }
    } else if (parts.some(p => !['text','mention'].includes(p.type))) {
      // SDK accepts exactly one rich object, not mixed rich arrays. Preflight before any dispatch.
      if (parts.length !== 1) return rejected('MEDIA_COMBINATION_GAP')
      try { payload = await mediaIO.send(parts[0], t) } catch (error) { return rejected(error.code || 'MEDIA_PREPARATION_FAILED') }
    } else payload = parts.map(p => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'at', uid: p.id, name: String(p.name || p.id) })
    let requestKey
    let hash
    if (message.requestId !== undefined) {
      if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 200) return rejected('INVALID_REQUEST_ID')
      requestKey = digest(JSON.stringify([key, message.requestId]))
      hash = digest(JSON.stringify(payload, (_key, value) => value instanceof Uint8Array ? { bytes: value.byteLength, sha256: digest(value) } : value))
      const prior = s.disk.outbox[requestKey]
      if (prior) return prior.hash === hash ? prior.receipt : rejected('REQUEST_ID_CONFLICT')
      // Persist uncertain before transport: a crash or timeout must not permit an automatic retry.
      s.disk.outbox[requestKey] = { hash, receipt: uncertain() }
      const keys = Object.keys(s.disk.outbox)
      for (const k of keys.slice(0, Math.max(0, keys.length - 256))) delete s.disk.outbox[k]
      try { save(s) } catch { return rejected('OUTBOX_PERSIST_FAILED') }
    }
    const connection = s.connection
    let cancel
    let timer
    const interrupted = new Promise(resolve => { cancel = () => resolve(uncertain()); s.pending.add(cancel); timer = setTimeout(cancel, sendTimeoutMs) })
    let receipt
    try {
      receipt = await Promise.race([Promise.resolve().then(() => {
        if (!live(s) || !s.registered || connection !== s.connection || !allowedContact(s, item.contact, item.kind, item.peer)) return uncertain()
        return item.contact.sendMsg(payload).then(classifyDouyinReceipt, error => classifyDouyinReceipt(error?.response))
      }), interrupted])
      if (!live(s) || !s.registered || connection !== s.connection || !allowedContact(s, item.contact, item.kind, item.peer)) return uncertain()
      if (requestKey) { s.disk.outbox[requestKey].receipt = receipt; save(s) }
      return receipt
    } catch { return uncertain() }
    finally { clearTimeout(timer); s.pending.delete(cancel) }
  }
  async function reconcile() {
    const s = current
    if (s && !live(s)) return logout()
    return s ? queue(s, () => refreshSession(s)) : undefined
  }
  async function continueLogin({ smsCode, secUid } = {}) {
    const s = current
    if (!s || !live(s)) return fail('NO_LOGIN')
    try {
      if (smsCode !== undefined) {
        if (typeof smsCode !== 'string' || !/^\d{4,8}$/.test(smsCode)) return fail('INVALID_SMS_CODE')
        await s.account.continueLoginWithSms(smsCode)
      } else if (secUid !== undefined) {
        if (typeof secUid !== 'string' || !secUid || secUid.length > 400) return fail('INVALID_SUBACCOUNT')
        await s.account.continueLoginWithSubAccount({ secUid })
      } else await s.account.continueLogin()
      return live(s) ? { ok: true, ...state() } : fail('STALE_LOGIN')
    } catch { return fail('LOGIN_CONTINUE_FAILED') }
  }
  const targets = () => {
    const s = current
    return s && live(s) && s.registered ? [...s.contacts.values()].filter(i => allowedContact(s, i.contact, i.kind, i.peer)).map(i => target(s, i)) : []
  }
  return { state, login, continueLogin, logout, dispose: logout, reconcile, targets, refresh: () => { const s = current; return s ? queue(s, () => refreshSession(s)) : Promise.resolve() } }
}
