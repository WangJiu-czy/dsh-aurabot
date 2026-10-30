import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { createImAdapterRegistry } from '../src/core/im-adapters.js'

const tick = () => new Promise(r => setImmediate(r))
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick() } assert.fail('expected state') }
const event = (accountId = 'A', kind = 'direct', text = 'hello', messageId = '1') => ({ platform: 'douyin', accountId, conversation: { kind, id: '123:90071992547409931' }, sender: { id: '10000001' }, messageId, parts: [{ type: 'text', text }], mentioned: true })
function fixture(brain = async () => 'reply', extra = {}, probe = async () => ({ ok: true })) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-im-'))
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', workspaceDir: join(dir, 'ws'), merge: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false }, imAccounts: ['A', 'B'].map(accountId => ({ platform: 'douyin', accountId, enabled: true, ownerId: accountId === 'A' ? '10000001' : '', allow: { private: ['10000001'], groups: ['123:90071992547409931'] } })), ...extra })
  const fake = createFakeDsh({ brain })
  const registry = createImAdapterRegistry()
  const sent = []
  let receipt = { status: 'confirmed', messageId: 'reply-1' }
  const register = accountId => registry.register({ platform: 'douyin', accountId }, { send: async (target, message) => { sent.push({ target, message }); return receipt } })
  const offA = register('A'), offB = register('B')
  const tools = []
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log: { info() {}, debug() {}, warn() {}, error() {} }, imAdapters: registry, onebot: { call() { assert.fail('DY called OneBot') } }, stickers: {}, tts: {}, contextProviders: [() => 'persona mood context'], buildTools: where => { tools.push(where); return [{ name: 'probe', execute: probe }] } })
  const off = fake.ctx.on('session/event', hub.onSessionEvent)
  return { hub, cfg, fake, registry, sent, tools, offA, offB, register, receipt: r => { receipt = r }, close() { off(); hub.dispose(); fake.dispose() } }
}
test('normal IM messages use shared hub followup, tools/context, isolated sessions and owner long preset', async () => {
  const f = fixture(async ({ callTool, ctxText }) => { assert.match(ctxText, /persona mood/); assert.equal((await callTool('probe', {})).ok, true); return 'reply' }, { longTasks: true })
  try {
    await f.registry.receive(event())
    await until(() => f.sent.length === 1)
    await f.registry.receive(event('B'))
    await until(() => f.sent.length === 2)
    await f.registry.receive(event('A', 'group'))
    await until(() => f.sent.length === 3)
    assert.deepEqual(f.fake.turns.map(t => t.preset), ['aurabot-private-long', 'aurabot-social', 'aurabot-social'])
    assert.equal(new Set(f.fake.turns.map(t => t.sessionId)).size, 3)
    assert.equal(f.hub.canExecute(f.fake.turns[0].sessionId, 'bash'), true)
    for (const turn of f.fake.turns.slice(1)) {
      assert.equal(f.hub.canExecute(turn.sessionId, 'bash'), false, 'social has no host terminal even if invoked directly')
      assert.equal(f.hub.canExecute(turn.sessionId, 'probe'), true)
    }
    assert.deepEqual(f.sent.map(x => [x.target.accountId, x.target.conversation.kind]), [['A', 'direct'], ['B', 'direct'], ['A', 'group']])
    assert.equal(f.tools[0].chat.actor.senderId, '10000001')
    assert.notEqual(f.tools[0].chat.userId, f.tools[0].chat.conversation.id)
    await f.registry.receive(event())
    assert.equal(f.fake.turns.length, 3, 'duplicate is not replayed')
  } finally { f.close() }
})
test('uncertain delivery does not log success or resend; stale generation is suppressed', async () => {
  const f = fixture()
  try {
    f.receipt({ status: 'uncertain' })
    await f.registry.receive(event())
    await until(() => f.sent.length === 1)
    assert.equal(f.hub.stats().sent, 0)
    assert.equal(f.hub.chatLogOf(f.hub.chatLogDays()[0], { allScopes: true }).filter(x => x.who === 'bot').length, 0)
    const generation = f.registry.generation(event())
    f.offA(); f.register('A')
    await f.hub.onImMessage({ ...event('A', 'direct', 'late', 'late'), generation })
    assert.equal(f.fake.turns.length, 1)
  } finally { f.close() }
})
test('queued messages recheck account permission before execution', async () => {
  const f = fixture(undefined, { merge: { enabled: true, waitSec: 0.01, maxSec: 0.01 } })
  try {
    await f.registry.receive(event())
    f.cfg.imAccounts[0].enabled = false
    await new Promise(r => setTimeout(r, 30))
    assert.equal(f.fake.turns.length, 0)
    assert.equal(f.sent.length, 0)
  } finally { f.close() }
})

test('actor permissions survive busy steer and revoke before tool execution', async () => {
  let entered, release
  const start = new Promise(r => { entered = r })
  const barrier = new Promise(r => { release = r })
  const f = fixture(async ({ text, callTool }) => {
    if (text.includes('slow')) { entered(); await barrier }
    return JSON.stringify(await callTool('probe', {}))
  })
  try {
    const first = f.registry.receive(event('A', 'direct', 'slow', 'slow'))
    await start
    const second = f.registry.receive(event('A', 'direct', 'steer', 'steer'))
    await until(() => [...f.fake.agents.values()][0].steered.length === 1)
    const sid = [...f.fake.agents.keys()][0]
    assert.equal(f.hub.turnSendersAllOwner(sid), true)
    f.cfg.imAccounts[0].ownerId = ''
    assert.equal(f.hub.turnSendersAllOwner(sid), false)
    assert.equal(f.hub.canExecute(sid), false)
    release()
    await Promise.all([first, second])
    await until(() => f.fake.turns.length > 0)
    assert.equal(f.fake.turns[0].toolCalls[0].result.code, 'STALE_PERMISSION')
    assert.equal([...f.fake.agents.values()][0].steered.length, 1)
  } finally { release(); f.close() }
})
test('late completion from old account generation cannot deliver through new registration', async () => {
  let entered, release
  const start = new Promise(r => { entered = r })
  const barrier = new Promise(r => { release = r })
  const f = fixture(async ({ text }) => { if (text.includes('old')) { entered(); await barrier } return text.includes('old') ? 'OLD' : 'NEW' })
  try {
    const old = f.registry.receive(event('A', 'direct', 'old', 'old'))
    await start
    f.offA(); f.register('A')
    await f.registry.receive(event('A', 'direct', 'new', 'new'))
    release(); await old
    await until(() => f.sent.length > 0)
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].message.parts[0].text, 'NEW')
  } finally { release(); f.close() }
})

test('revoked known IM sessions stay fail-closed after generation reset, manual reset and hub reload', async () => {
  let entered, release
  const start = new Promise(r => { entered = r }), barrier = new Promise(r => { release = r })
  const f = fixture(async ({ text }) => { if (text.includes('old')) { entered(); await barrier } return text.includes('old') ? 'OLD' : 'NEW' })
  try {
    const old = f.registry.receive(event('B', 'direct', 'old', 'old'))
    await start
    const sid = [...f.fake.agents.keys()][0]
    assert.equal(f.hub.canExecute(sid, 'bash'), false)
    assert.equal(f.hub.canExecute('unrelated-local-session', 'bash'), true)
    f.offB()
    f.registry.register({ platform: 'douyin', accountId: 'B' }, { send: async () => ({ status: 'confirmed', messageId: 'new' }) })
    await f.registry.receive(event('B', 'direct', 'new', 'new'))
    assert.equal(f.hub.canExecute(sid, 'bash'), false, 'reset of old turn state must not grant local DSH permissions')
    assert.equal(f.hub.canExecute(sid, 'probe'), false, 'no tools from a revoked origin')
    release(); await old; await tick()
    assert.equal(f.sent.length, 0, 'old completion never uses the new registration')
    const newSid = [...f.fake.agents.keys()].at(-1)
    const chatId = f.hub.chatOfSession(newSid)
    f.hub.resetChat(chatId)
    assert.equal(f.hub.canExecute(newSid, 'bash'), false)
    f.hub.dispose()
    const reloaded = createHub({ dsh: f.fake.ctx, getConfig: () => f.cfg, log: { info() {}, debug() {}, warn() {} }, onebot: {}, stickers: {}, tts: {} })
    try { assert.equal(reloaded.canExecute(sid, 'bash'), false); assert.equal(reloaded.canExecute(newSid, 'bash'), false); assert.equal(reloaded.canExecute('unknown-local', 'bash'), true) } finally { reloaded.dispose() }
  } finally { release(); f.close() }
})

test('host uses one injected registry and real module tools/persona/mood/memory with fake DSH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-im-host-'))
  process.env.AURABOT_DATA_DIR = dir
  const cfg = { enabled: true, dryRun: false, setupDone: true, ownerQQ: '10000001', workspaceDir: join(dir, 'ws'), longTasks: true, merge: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false }, snowluma: { autoStart: false, autoAttach: false }, imAccounts: [{ platform: 'douyin', accountId: 'A', enabled: true, ownerId: '10000001' }] }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
  let api
  const fake = createFakeDsh({ brain: async ({ preset, persona, ctxText, toolNames, callTool }) => {
    assert.equal(preset, 'aurabot-private-long')
    assert.match(persona, /大肥鱼/)
    assert.ok(ctxText.length > 0)
    assert.ok(toolNames.includes('remember'))
    assert.ok(!toolNames.includes('qq_chat_history'))
    assert.ok(!toolNames.includes('qq_get_profile'))
    assert.equal((await callTool('remember', { text: 'DY secret owner fact' })).ok, true)
    return 'host reply'
  } })
  try {
    const { apply } = await import('../src/host.js')
    api = apply(fake.ctx)
    await api.ready
    api.mood.nudge(40, 'offline test')
    api.onebot.call = () => assert.fail('DY module path called OneBot')
    const sent = []
    api.imAdapters.register({ platform: 'douyin', accountId: 'A' }, { send: async (target, message) => { sent.push({ target, message }); return { status: 'confirmed', messageId: 'host-message' } } })
    await api.imAdapters.receive(event())
    await until(() => sent.length === 1)
    const scoped = api.memory.list('', { allScopes: true }).find(m => m.text.includes('DY secret'))
    assert.equal(scoped.scope.platform, 'douyin')
    assert.equal(api.memory.list('').some(m => m.text.includes('DY secret')), false, 'QQ/Bili preference default excludes DY secret')
    const day = api.hub.chatLogDays()[0]
    assert.equal(api.hub.chatLogOf(day).some(l => l.text.includes('DY secret') || l.chatId.startsWith('[')), false, 'QQ diary default excludes DY logs')
    assert.equal(api.hub.chatLogOf(day, { allScopes: true }).length, 2)
  } finally { fake.dispose() }
})

test('hub dispose unregisters agent-scoped tools before plugin reload', async () => {
  const f = fixture()
  try {
    await f.registry.receive(event())
    await until(() => f.sent.length === 1)
    const agent = [...f.fake.agents.values()][0]
    assert.ok(agent.tools.has('probe'))
    f.hub.dispose()
    assert.equal(agent.tools.has('probe'), false)
  } finally { f.close() }
})

test('tool delivery uncertainty overrides legacy truthy success and prevents success memory', async () => {
  const { normalizeImMessage } = await import('../src/chat/im-context.js')
  const { createMemoryStore } = await import('../src/features/memory.js')
  let memory, result
  const f = fixture(async ({ callTool }) => { result = await callTool('probe', {}); return '[沉默]' }, {}, async () => {
    await f.hub.sendText(normalizeImMessage(event()).chatId, 'from tool')
    const saved = memory.addEvent({ text: 'sent successfully' })
    assert.equal(saved.ok, false)
    return { ok: true, message: 'legacy falsely claimed success' }
  })
  memory = createMemoryStore({ getConfig: () => f.cfg, dsh: {}, hub: f.hub, log: { info() {}, warn() {} } })
  try {
    f.receipt({ status: 'uncertain' })
    await f.registry.receive(event())
    await until(() => Boolean(result))
    assert.equal(result.ok, false)
    assert.equal(result.status, 'uncertain')
    assert.equal(f.sent.length, 1)
    assert.deepEqual(memory.list('', { allScopes: true }), [])
  } finally { f.close() }
})
