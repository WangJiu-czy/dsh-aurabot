import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDouyinIm } from './helpers/fake-douyin-im.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createDouyinImAdapter, classifyDouyinReceipt } from '../src/douyin/im-adapter.js'
import { createImAdapterRegistry } from '../src/core/im-adapters.js'
import douyinModule from '../src/modules/douyin/index.js'
import douyinBridgeModule from '../src/modules/douyin-bridge/index.js'
import { BUILTINS } from '../src/modules/index.js'
import { createDouyin } from '../src/douyin/duty.js'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
for (const [target, key] of [[net.Socket.prototype, 'connect'], [tls, 'connect'], [http, 'request'], [https, 'request'], [globalThis, 'fetch']]) test.mock.method(target, key, () => assert.fail('network forbidden in offline T3 tests'))

const A = '9007199254740993123'
const U = '9007199254740993456'
const thread = '0:1:' + A + ':' + U
function fixture(options = {}) {
  const registry = createImAdapterRegistry()
  const received = []
  registry.subscribe(e => { received.push(e) })
  const cfg = { enabled: true, dryRun: false, douyin: { enabled: true, im: { enabled: true } }, imAccounts: [{ platform: 'douyin', accountId: A, enabled: true, ownerId: U, allow: { private: [], groups: ['777'] } }] }
  const calls = { creates: 0, login: 0, logout: 0, sends: [], history: [] }
  const fake = createFakeDouyinIm()
  const client = fake.client
  const account = client.createAccount({ accountId: A })
  account.uid = A
  account.imUid = 'im-self'
  account.login = async () => { calls.login++; account.emit('system.online', { platformUid: A }) }
  account.logout = async () => { calls.logout++ }
  const pages = new Map()
  const contacts = new Map()
  for (const [id, t, type] of [[U, thread, 1], ['777', '777', 2]]) {
    const contact = { id, threadId: t, conversationType: type, getHistory: async opts => {
      if (!Number.isSafeInteger(opts.count) || opts.count < 1 || opts.count > 50) throw new RangeError('message page size must be an integer between 1 and 50')
      calls.history.push({ id, ...opts })
      const messages = pages.get(t) || []
      return { statusCode: 0, messages: opts.direction === 'newer' ? messages.filter(m => BigInt(m.indexInConversation) > BigInt(opts.cursor)) : messages, hasMore: false, cursor: '0' }
    }, sendMsg: async message => { calls.sends.push({ id, message }); return { statusCode: 0, serverMessageId: '999', checkCode: 8101 } } }
    contacts.set(t, contact)
  }
  account.pickFriend = id => id === U ? contacts.get(thread) : undefined
  account.pickStranger = () => undefined
  account.pickGroup = id => contacts.get(id)
  const createAccount = client.createAccount
  client.createAccount = opts => { calls.creates++; return createAccount(opts) }
  const root = mkdtempSync(join(tmpdir(), 'aurabot-t3-'))
  let imports = 0
  const im = createDouyinImAdapter({ registry, getConfig: () => cfg, dataDir: () => root, pollMs: 0, createClient: async () => { imports++; return { ok: true, client } }, ...options })
  const msg = (seq, t = thread, sender = U) => ({ threadId: t, senderUid: sender, msgId: String(1000 + seq), indexInConversation: String(seq), createTime: Date.now(), content: JSON.stringify({ text: 'hello' }), msgType: 7, conversationType: t === '777' ? 2 : 1 })
  return { im, cfg, calls, account, client, root, registry, received, pages, contacts, msg, imports: () => imports }
}
test('verified account registers once; first baseline, selected private/group events, echo filtering and restart recovery', async () => {
  const f = fixture()
  f.pages.set(thread, [f.msg(1)])
  assert.equal((await f.im.login({ accountId: A, syncScope: 'sdk-default-all' })).ok, true)
  await f.im.refresh()
  assert.equal(f.im.state().accountId, A)
  assert.ok(f.registry.generation({ platform: 'douyin', accountId: A }))
  assert.equal(f.received.length, 0)
  f.pages.set(thread, [f.msg(1), f.msg(3), f.msg(2)])
  f.account.emit('system.reconnecting', { attempt: 1 })
  f.account.emit('system.online', { platformUid: A })
  await f.im.refresh()
  assert.deepEqual(f.received.map(m => m.messageId), ['1002', '1003'])
  assert.equal(f.received[0].conversation.id, thread)
  assert.equal(f.received[0].sender.id, U)
  const event = { type: 'message.group', threadId: '777', senderUid: U, serverMessageId: '1004', indexInConversation: '4', text: '@self hi', messageType: 7, isMentionMe: true, conversationType: 2, referenceInfo: { refMessageId: '1001' }, group: f.contacts.get('777') }
  f.account.emit('message.group', event) // Not subscribed at both levels.
  f.account.emit('message', event)
  f.account.emit('message', { ...event, threadId: 'OTHER', serverMessageId: '1005' })
  f.account.emit('message', { ...event, senderUid: A, serverMessageId: '1006' })
  await f.im.refresh()
  assert.equal(f.received.length, 3)
  assert.equal(f.received[2].mentioned, true)
  assert.equal(f.received[2].replyTo.messageId, '1001')
  await f.im.logout()
  assert.equal(f.account.listenerCount('message'), 0)
  assert.equal(f.registry.generation({ platform: 'douyin', accountId: A }), undefined)
  f.pages.set(thread, [f.msg(1), f.msg(2), f.msg(3), f.msg(5)])
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' })
  await f.im.refresh()
  assert.deepEqual(f.received.map(m => m.messageId), ['1002', '1003', '1004', '1005'])
  await f.im.logout()
})

test('SDK 1.1.0 page width contract is respected for initial baseline and newer recovery', async () => {
  const f = fixture()
  await assert.rejects(f.contacts.get(thread).getHistory({ direction: 'older', count: 51 }), RangeError)
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  assert.equal(f.im.state().status, 'online')
  assert.ok(f.calls.history.some(c => c.direction === 'older' && c.count === 50))
  assert.ok(f.calls.history.some(c => c.direction === 'newer' && c.count === 50))
  assert.ok(f.calls.history.every(c => c.count <= 50))
  await f.im.dispose()
})

test('SDK receipt is server acceptance only; uncertain is never inferred failed', () => {
  assert.deepEqual(classifyDouyinReceipt({ statusCode: 0, serverMessageId: '999', checkCode: 8101 }), { status: 'confirmed', messageId: '999' })
  for (const value of [undefined, new Error('timeout'), { statusCode: 0 }, { statusCode: 0, serverMessageId: '0' }, { statusCode: 0, serverMessageId: '999', checkCode: 10502 }, { statusCode: 0, serverMessageId: '999', checkCode: 98765 }, { statusCode: -3 }]) assert.equal(classifyDouyinReceipt(value).status, 'uncertain')
  assert.equal(classifyDouyinReceipt({ statusCode: 0, checkCode: 8610 }).status, 'failed')
})

test('exact target text/@/quote and bounded request id ledger; no capability fiction', async () => {
  const f = fixture()
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  const target = { platform: 'douyin', accountId: A, conversation: { kind: 'direct', id: thread } }
  const send = message => f.registry.send(target, message)
  assert.equal((await send({ parts: [{ type: 'text', text: 'hi' }, { type: 'mention', id: U }], requestId: 'r1' })).status, 'confirmed')
  assert.deepEqual(f.calls.sends[0], { id: U, message: [{ type: 'text', text: 'hi' }, { type: 'at', uid: U, name: U }] })
  await send({ parts: [{ type: 'text', text: 'hi' }, { type: 'mention', id: U }], requestId: 'r1' })
  assert.equal(f.calls.sends.length, 1)
  assert.equal((await f.registry.send({ ...target, conversation: { kind: 'direct', id: U } }, { parts: [{ type: 'text', text: 'wrong' }] })).status, 'failed')
  assert.equal((await send({ parts: [{ type: 'record', file: 'voice' }] })).code, 'NATIVE_VOICE_GAP')
  f.pages.set(thread, [f.msg(1)]); await f.im.refresh()
  assert.equal((await send({ parts: [{ type: 'text', text: 'reply' }], replyTo: { messageId: '1001' } })).status, 'confirmed')
  assert.deepEqual(f.calls.sends[1].message, { type: 'reply', text: 'reply', referencedMessageId: '1001', referencedMessageType: 7, referencedUid: U, referencedText: 'hello' })
  await f.im.logout()
})

test('timeout/exception and logout late ACK remain uncertain; request IDs survive restart', async () => {
  const f = fixture()
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  let release
  f.contacts.get(thread).sendMsg = () => new Promise(r => { release = r })
  const target = { platform: 'douyin', accountId: A, conversation: { kind: 'direct', id: thread } }
  const message = { requestId: 'pending', parts: [{ type: 'text', text: 'one' }] }
  const sending = f.registry.send(target, message)
  await new Promise(r => setImmediate(r))
  const oldOnline = f.account.listeners('system.online')[0]
  await f.im.logout()
  assert.equal((await sending).status, 'uncertain')
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  release({ statusCode: 0, serverMessageId: '111' })
  oldOnline({ platformUid: 'other' })
  assert.equal(f.im.state().accountId, A)
  assert.equal((await f.registry.send(target, message)).status, 'uncertain')
  f.cfg.douyin.im.enabled = false
  await f.im.reconcile()
  assert.equal(f.registry.generation(target), undefined)
  assert.equal(f.account.listenerCount('message'), 0)
  await f.im.logout()
})

test('self UID mismatch and revoked/unknown account never register or initialize an unapproved account', async () => {
  const f = fixture()
  assert.equal((await f.im.login({ accountId: 'other', syncScope: 'sdk-default-all' })).code, 'ACCOUNT_NOT_ALLOWED')
  assert.equal(f.imports(), 0)
  f.account.uid = 'other'
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  assert.equal(f.registry.generation({ platform: 'douyin', accountId: A }), undefined)
  assert.equal(f.im.state().code, 'SELF_UID_MISMATCH')
  await f.im.logout()
})

test('Douyin bridge starts before the browser module that reads its state', () => {
  assert.ok(BUILTINS.findIndex(m => m.id === 'douyin-bridge') < BUILTINS.findIndex(m => m.id === 'douyin'))
})

test('Douyin bridge owns IM routes, cached state, config cleanup and disposal', async () => {
  const f = fixture()
  process.env.AURABOT_DATA_DIR = f.root
  Object.assign(f.cfg, normalize(f.cfg))
  const routes = new Map(), disposals = [], events = new Map()
  const bridge = douyinBridgeModule.setup({ core: { http: { body: async () => ({ accountId: A }) }, imAdapters: f.registry }, config: () => f.cfg, log: { warn() {}, info() {} }, route: (p, fn) => routes.set(p, fn), onDispose: fn => disposals.push(fn), on: (p, fn) => events.set(p, fn), dataDir: () => { assert.fail('ordinary module setup/state created SDK data directory') } })
  assert.equal((await routes.get('/douyin/im/state')()).runtimeNode, 'unknown')
  assert.equal((await routes.get('/douyin/im/login')({})).code, 'SYNC_SCOPE_CONFIRMATION_REQUIRED')
  assert.equal(typeof bridge.login, 'function')
  assert.equal(events.has('config'), true)
  for (const dispose of disposals) await dispose()
  assert.equal((await routes.get('/douyin/im/state')()).status, 'logged-out')
})

test('browser module no longer consumes messages through legacy inbox polling', () => {
  const dy = createDouyin({ getConfig: () => ({ douyin: { im: { enabled: true } } }), site: {}, hub: {}, log: {} })
  assert.equal(dy.checkOwnerDms, undefined)
})

test('production adapter -> registry -> existing shared hub normal private/group DSH sessions -> SDK send', async () => {
  const f = fixture()
  process.env.AURABOT_DATA_DIR = f.root
  Object.assign(f.cfg, normalize({ ...f.cfg, workspaceDir: join(f.root, 'ws'), merge: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false }, longTasks: true }))
  const fake = createFakeDsh({ brain: async () => 'offline reply' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => f.cfg, imAdapters: f.registry, onebot: { call() { assert.fail('SDK message called QQ') } }, log: { info() {}, debug() {}, warn() {}, error() {} }, stickers: {}, tts: {}, contextProviders: [() => 'persona mood'], buildTools: () => [] })
  const off = fake.ctx.on('session/event', hub.onSessionEvent)
  try {
    await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
    f.pages.set(thread, [f.msg(1)])
    f.pages.set('777', [{ ...f.msg(1, '777'), content: JSON.stringify({ text: 'group @self', richTextInfos: [{ infoType: 1, location: 6, length: 5, info: { uid: A } }] }) }])
    await f.im.refresh()
    for (let i = 0; i < 200 && f.calls.sends.length < 2; i++) await new Promise(r => setImmediate(r))
    assert.equal(f.calls.sends.length, 2, JSON.stringify({ turns: fake.turns, received: f.received, sends: f.calls.sends, state: f.im.state() }))
    assert.deepEqual(fake.turns.map(t => t.preset), ['aurabot-private-long', 'aurabot-social'])
    assert.deepEqual(f.calls.sends.map(s => s.id), [U, '777'])
    assert.equal(hub.stats().sent, 2)
    assert.equal(f.calls.sends[1].message.type, 'reply', 'automatic group reply uses one real quote without an extra @ bubble')
    const groupChat = JSON.stringify(['douyin', A, 'group', '777'])
    assert.equal((await hub.sendText(groupChat, `<at:${U}> explicit`)).status, 'confirmed')
    assert.deepEqual(f.calls.sends.at(-1).message[0], { type: 'at', uid: U, name: U })
    const before = f.calls.sends.length
    assert.equal((await hub.sendText(groupChat, `<at:${U}> combined`, '1001')).code, 'QUOTE_MENTION_GAP')
    assert.equal(f.calls.sends.length, before, 'unsupported quote+true@ is rejected before any transport send')
    await hub.sendText(groupChat, '<at:not-a-uid> literal @nickname')
    assert.deepEqual(f.calls.sends.at(-1).message, [{ type: 'text', text: '<at:not-a-uid> literal @nickname' }])
    await hub.sendText(JSON.stringify(['douyin', A, 'direct', thread]), `<at:${U}> private literal`)
    assert.deepEqual(f.calls.sends.at(-1).message, [{ type: 'text', text: `<at:${U}> private literal` }])
  } finally { await f.im.dispose(); off(); hub.dispose(); fake.dispose() }
})

test('smoke without explicit targets/scope is WAITING_TARGETS with zero data writes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'aurabot-t3-smoke-'))
  const script = new URL('../scripts/douyin-im-smoke.mjs', import.meta.url).pathname
  assert.equal(JSON.parse(execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' })).code, 'WAITING_TARGETS')
  assert.match(execFileSync(process.execPath, [script, '--help'], { cwd, encoding: 'utf8' }), /ALL friends/)
  assert.equal(JSON.parse(execFileSync(process.execPath, [script, '--login-only', '--account', A, '--data-dir', join(cwd, 'sdk')], { cwd, encoding: 'utf8' })).code, 'SYNC_SCOPE_CONFIRMATION_REQUIRED')
  assert.deepEqual(readdirSync(cwd), [])
})

test('actual timeout never retries and SDK explicit errors alone do not become failed', async () => {
  const f = fixture({ sendTimeoutMs: 5 })
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  const t = f.im.targets()[0]
  let sends = 0
  f.contacts.get(thread).sendMsg = async () => { sends++; return new Promise(() => {}) }
  const m = { requestId: 'timeout', parts: [{ type: 'text', text: 'timeout' }] }
  assert.equal((await f.registry.send(t, m)).status, 'uncertain')
  assert.equal((await f.registry.send(t, m)).status, 'uncertain')
  assert.equal(sends, 1)
  f.contacts.get(thread).sendMsg = async () => { throw new Error('sensitive upstream error') }
  assert.equal((await f.registry.send(t, { parts: [{ type: 'text', text: 'error' }] })).status, 'uncertain')
  f.account.emit('system.offline')
  assert.equal(f.account.listenerCount('message'), 0)
  assert.equal(f.registry.generation(t), undefined)
  await f.im.dispose()
})

test('selected newer history paginates in order with bounded persistent cursor IDs, not message bodies', async () => {
  const f = fixture()
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  const messages = Array.from({ length: 300 }, (_, i) => f.msg(i + 1))
  f.contacts.get(thread).getHistory = async opts => {
    assert.equal(opts.direction, 'newer')
    const remaining = messages.filter(m => BigInt(m.indexInConversation) >= BigInt(opts.cursor))
    if (!Number.isSafeInteger(opts.count) || opts.count < 1 || opts.count > 50) throw new RangeError('message page size must be an integer between 1 and 50')
    const page = remaining.slice(0, opts.count)
    return { statusCode: 0, messages: page, hasMore: remaining.length > page.length, cursor: page.at(-1)?.indexInConversation || opts.cursor }
  }
  await f.im.refresh()
  assert.equal(f.received.length, 300)
  assert.deepEqual(f.received.map(m => m.messageId), messages.map(m => m.msgId))
  await f.im.refresh()
  assert.equal(f.received.length, 300)
  const file = readdirSync(f.root).find(n => n.startsWith('cursors-'))
  const text = readFileSync(join(f.root, file), 'utf8')
  const ledger = JSON.parse(text)
  const c = ledger.cursors[JSON.stringify(['douyin', A, 'direct', thread])]
  assert.equal(c.seq, '300')
  assert.equal(c.ids.length, 256)
  assert.ok(!text.includes('hello'))
  f.contacts.get(thread).getHistory = async () => ({ statusCode: 0, messages: [{ ...f.msg(301), content: JSON.stringify({ text: 'not a valid SDK mention', richTextInfos: [{ info: { uid: A } }] }) }], hasMore: false, cursor: '301' })
  await f.im.refresh()
  assert.equal(f.received.at(-1).mentioned, false, 'malformed richTextInfos do not become true @')
  await f.im.dispose()
})

test('a live event ahead of history never advances recovery past a delayed gap', async () => {
  const f = fixture()
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  f.account.emit('message', { type: 'message.private', threadId: thread, senderUid: U, serverMessageId: '1003', indexInConversation: '3', text: 'live', messageType: 7, conversationType: 1 })
  await f.im.refresh()
  f.pages.set(thread, [f.msg(1), f.msg(2), f.msg(3)])
  await f.im.refresh()
  assert.deepEqual(f.received.map(m => m.messageId), ['1003', '1001', '1002'])
  await f.im.logout()
})

test('group authorization revoked during baseline/recovery await neither delivers nor advances the cursor', async () => {
  for (const baseline of [true, false]) {
    const f = fixture()
    if (!baseline) { await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh() }
    let release, entered
    const started = new Promise(r => { entered = r })
    const contact = f.contacts.get('777'), original = contact.getHistory
    contact.getHistory = async opts => { entered(); return new Promise(r => { release = r }) }
    const running = baseline ? f.im.login({ accountId: A, syncScope: 'sdk-default-all' }) : f.im.refresh()
    await started
    f.cfg.imAccounts[0].allow.groups = []
    release({ statusCode: 0, messages: [f.msg(1, '777')], hasMore: false, cursor: '1' })
    await running; await f.im.refresh()
    assert.equal(f.received.length, 0, 'revoked group must not reach registry.receive')
    const file = readdirSync(f.root).find(n => n.startsWith('cursors-'))
    const cursor = JSON.parse(readFileSync(join(f.root, file), 'utf8')).cursors[JSON.stringify(['douyin', A, 'group', '777'])]
    assert.equal(cursor?.seq || '0', '0', 'no revoked baseline or recovery commit')
    assert.deepEqual(cursor?.ids || [], [])
    f.cfg.imAccounts[0].allow.groups = ['777']
    contact.getHistory = original
    // A new authorized first baseline is still historical and intentionally not delivered.
    if (baseline) await f.im.refresh()
    f.pages.set('777', [f.msg(1, '777')])
    await f.im.refresh()
    assert.deepEqual(f.received.map(m => m.messageId), ['1001'], 'authorized recovery can replay the undelivered message')
    await f.im.dispose()
  }
})

test('revoking an exact conversation between enqueue and transport blocks send; legacy owner config grants nothing', async () => {
  const f = fixture()
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  const t = f.im.targets().find(t => t.conversation.kind === 'direct')
  const sending = f.registry.send(t, { parts: [{ type: 'text', text: 'revoked' }] })
  f.cfg.imAccounts[0].ownerId = ''
  f.cfg.douyin.owner = { uid: U, input: 'changed', confirmedInput: 'old', secUid: 'not-an-owner-proof' }
  assert.equal((await sending).status, 'uncertain')
  assert.equal(f.calls.sends.length, 0)
  f.account.emit('message', { type: 'message.private', threadId: thread, senderUid: U, serverMessageId: '1001', indexInConversation: '1', text: 'not authorized', messageType: 7, conversationType: 1 })
  await f.im.refresh()
  assert.equal(f.received.length, 0)
  await f.im.dispose()
})

test('logout during asynchronous SDK initialization never creates/logs in the stale account', async () => {
  let release, client
  const gate = new Promise(r => { release = r })
  const f = fixture({ createClient: async () => { await gate; return { ok: true, client } } })
  client = f.client
  const login = f.im.login({ accountId: A, syncScope: 'sdk-default-all' })
  await new Promise(r => setImmediate(r))
  await f.im.logout()
  release()
  assert.equal((await login).code, 'STALE_LOGIN')
  assert.equal(f.calls.creates, 0)
  assert.equal(f.calls.login, 0)
  assert.equal(f.im.state().status, 'logged-out')
})

test('switching SDK accounts unregisters the old identity and rejects old-generation callbacks/ACKs', async () => {
  const f = fixture()
  const B = '9007199254740993999'
  await f.im.login({ accountId: A, syncScope: 'sdk-default-all' }); await f.im.refresh()
  let release
  f.contacts.get(thread).sendMsg = () => new Promise(r => { release = r })
  const sending = f.registry.send(f.im.targets()[0], { parts: [{ type: 'text', text: 'old account' }] })
  await new Promise(r => setImmediate(r))
  const oldQr = f.account.listeners('system.login.qrcode')[0]
  f.cfg.imAccounts.push({ platform: 'douyin', accountId: B, enabled: true, allow: { private: [], groups: [] } })
  const b = f.client.createAccount({ accountId: B })
  b.uid = B
  b.login = async () => b.emit('system.online', { platformUid: B })
  await f.im.login({ accountId: B, syncScope: 'sdk-default-all' }); await f.im.refresh()
  release({ statusCode: 0, serverMessageId: '999' })
  oldQr({ qrcodeBase64: 'stale-qr', token: 'never-log-token' })
  assert.equal((await sending).status, 'uncertain')
  assert.equal(f.im.state().accountId, B)
  assert.equal(f.im.state().qrcodeBase64, undefined)
  assert.equal(f.registry.generation({ platform: 'douyin', accountId: A }), undefined)
  assert.ok(f.registry.generation({ platform: 'douyin', accountId: B }))
  assert.equal(f.account.listenerCount('message'), 0)
  await f.im.dispose()
})

test('disabled/read-only state and unconfirmed sync scope never initialize SDK', async () => {
  const f = fixture()
  assert.equal(f.im.state().runtimeNode, 'unknown')
  assert.equal((await f.im.login({ accountId: A })).code, 'SYNC_SCOPE_CONFIRMATION_REQUIRED')
  assert.equal(f.imports(), 0)
  assert.equal(f.calls.creates, 0)
  await f.im.logout()
})
