import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryPending } from '../src/features/memory-pending.js'

function setup(encode = async () => ({ ok: true })) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-memory-pending-'))
  let now = 1_000_000
  const cfg = { memory: { simulation: { enabled: true } } }
  const options = { getConfig: () => cfg, encode, clock: () => now, log: { warn() {} } }
  return { queue: createMemoryPending(options), restart: () => createMemoryPending(options), cfg,
    advance: ms => { now += ms }, file: join(process.env.AURABOT_DATA_DIR, 'memory-pending.json') }
}
const activity = (id, chatId = 'private:A', extra = {}) => ({ kind: 'in', messageId: String(id), chatId,
  userId: 'user-A', nickname: 'User', text: `text ${id}`, chat: { kind: 'private', chatId }, ...extra })
const add = (q, n, chatId = 'private:A', offset = 0) => {
  for (let i = 0; i < n; i++) assert.equal(q.observe(activity(i + offset, chatId)).ok, true)
}

test('opt-in only and trusted inbound IDs/scope; bounded message fields, duplicate replay', async () => {
  const batches = [], s = setup(async (...args) => { batches.push(args); return { ok: true } })
  const q = s.queue
  for (const simulation of [undefined, false, true, {}, { enabled: false }]) {
    s.cfg.memory.simulation = simulation
    assert.equal(q.observe(activity('disabled')).ignored, true)
  }
  s.cfg.memory.simulation = { enabled: true }
  for (const extra of [{ kind: 'out' }, { messageId: '' }, { chatId: '' }, { userId: '' }, { userId: 'system' },
    { system: true }, { isSystem: true }, { chat: undefined }, { chat: {} }, { text: ' ' }, { chat: { chatId: 'OTHER' } }]) {
    assert.equal(q.observe(activity('invalid', 'private:A', extra)).ignored, true)
  }
  const a = activity('trusted', 'private:A', { text: 'x'.repeat(6000), timestamp: 123 })
  assert.equal(q.observe(a).ok, true)
  a.chat.chatId = 'changed'
  assert.equal(q.observe(activity('trusted')).duplicate, true)
  const disk = JSON.parse(readFileSync(s.file))
  assert.deepEqual(disk.conversations[0].messages[0], { id: 'trusted', text: 'x'.repeat(5000), uid: 'user-A',
    who: 'User', t: 123, chatId: 'private:A', chat: { kind: 'private', chatId: 'private:A' } })
  assert.doesNotMatch(JSON.stringify(q.status()), /xxxxx|text |nickname|user-A/)
  await q.tick()
  assert.equal(batches.length, 1, 'oldest message due at ten minutes')
  assert.equal(s.restart().observe(activity('trusted')).duplicate, true, 'dedup survives success/restart')
})

test('controlled due threshold, failures and restart preserve pending and attempt history', async () => {
  let fail = true, calls = 0
  const s = setup(async () => { calls++; if (fail) throw new Error('private transcript'); return { ok: true } })
  add(s.queue, 7)
  await s.queue.tick()
  assert.equal(calls, 0)
  s.advance(10 * 60_000 - 1)
  await s.queue.tick()
  assert.equal(calls, 0)
  s.advance(1)
  await s.queue.tick()
  assert.equal(s.queue.status().pending, 7)
  assert.equal(s.restart().status().conversations[0].attemptsLastHour, 1)
  fail = false
  const fresh = s.restart()
  await fresh.tick()
  assert.equal(fresh.status().pending, 0)
  assert.equal(calls, 2)
})

test('eight messages trigger; batches capped at forty; every result requires explicit ok true', async () => {
  const sizes = [], s = setup(async (_id, messages) => { sizes.push(messages.length); return { ok: sizes.length > 1 } })
  add(s.queue, 81)
  await s.queue.tick()
  assert.equal(s.queue.status().pending, 81)
  await s.queue.tick()
  assert.equal(s.queue.status().pending, 41)
  await s.queue.tick()
  assert.deepEqual(sizes, [40, 40, 40])
  assert.equal(s.queue.status().pending, 1)
})

test('tick is serial and acknowledgement reloads disk, preserving midflight arrivals', async () => {
  let finish, calls = 0
  const s = setup(async () => { calls++; return new Promise(resolve => { finish = resolve }) })
  add(s.queue, 8)
  const first = s.queue.tick()
  assert.strictEqual(s.queue.tick(), first)
  assert.equal(s.queue.status().busy, true)
  // Another instance mutates the same single-process store while encode awaits.
  s.restart().observe(activity('new'))
  finish({ ok: true })
  await first
  assert.equal(calls, 1)
  assert.equal(s.queue.status().pending, 1)
  assert.deepEqual(JSON.parse(readFileSync(s.file)).conversations[0].messages.map(m => m.id), ['new'])
})

test('source deletion requires explicit conversation; same IDs isolate scope and cancel inflight', async () => {
  let finish
  const s = setup(async () => new Promise(resolve => { finish = resolve }))
  add(s.queue, 8)
  s.queue.observe(activity('0', 'private:B'))
  assert.deepEqual(s.queue.removeSources(['0']), { ok: false, code: 'INVALID_SCOPE' })
  assert.deepEqual(s.queue.removeSources(['0'], ''), { ok: false, code: 'INVALID_SCOPE' })
  const task = s.queue.tick()
  assert.deepEqual(s.queue.removeSources(['0', '1'], 'private:A'), { ok: true, removed: 2 })
  s.queue.observe(activity('new'))
  finish({ ok: true })
  await task
  const disk = JSON.parse(readFileSync(s.file))
  assert.deepEqual(disk.conversations.find(c => c.chatId === 'private:A').messages.map(m => m.id), ['new'])
  assert.deepEqual(disk.conversations.find(c => c.chatId === 'private:B').messages.map(m => m.id), ['0'])
  assert.equal(s.restart().observe(activity('0')).duplicate, true, 'deleted source is not resurrected by replay')
})

test('six attempts/hour includes failures, success and restart; exact boundary resets', async () => {
  let calls = 0
  const s = setup(async () => { calls++; return { ok: false } })
  add(s.queue, 8)
  for (let i = 0; i < 10; i++) await s.restart().tick()
  assert.equal(calls, 6)
  s.advance(60 * 60_000 - 1)
  await s.restart().tick()
  assert.equal(calls, 6)
  s.advance(1)
  await s.restart().tick()
  assert.equal(calls, 7)
  assert.equal(s.queue.status().pending, 8)

  const success = setup(async () => { calls++; return { ok: true } })
  for (let i = 0; i < 7; i++) { add(success.queue, 8, 'private:A', i * 8); await success.restart().tick() }
  assert.equal(success.queue.status().pending, 8)
  assert.equal(success.queue.status().conversations[0].attemptsLastHour, 6)
})

test('queue bounds report overflow without eviction, including duplicate at capacity', () => {
  const s = setup()
  add(s.queue, 200)
  assert.deepEqual(s.queue.observe(activity('overflow')), { ok: false, code: 'QUEUE_FULL' })
  assert.equal(s.queue.observe(activity('0')).duplicate, true)
  assert.equal(s.restart().status().pending, 200)
  for (let i = 1; i < 100; i++) s.queue.observe(activity('same', `private:${i}`))
  assert.deepEqual(s.queue.observe(activity('same', 'private:overflow')), { ok: false, code: 'QUEUE_FULL' })
  assert.equal(s.queue.status().conversations.length, 100)
  assert.equal(s.queue.status().pending, 299)
})

test('malformed durable JSON fails closed without replacing queued data', () => {
  const s = setup()
  writeFileSync(s.file, '{broken')
  assert.throws(() => s.queue.observe(activity('a')), /MEMORY_PENDING_READ_FAILED/)
  assert.equal(readFileSync(s.file, 'utf8'), '{broken')
})
