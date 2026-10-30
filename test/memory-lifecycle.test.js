import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

const DAY = 86400000
function fixture(t, extra = {}) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'memory-life-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  const cfg = { model: { provider: 'mock', model: 'mock' }, memory: { enabled: true, recallCount: 6, simulation: { enabled: true } } }
  const chat = { kind: 'private', chatId: 'private:12345', userId: '12345' }
  let output = '{"memories":[]}'
  const dsh = { get: () => null, llm: { async *stream() { yield { type: 'text-delta', text: typeof output === 'function' ? await output() : output }; yield { type: 'finish', reason: { kind: 'completed' } } } } }
  const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub: { lastTextOf: () => '咖啡' }, log: { info() {}, warn() {} }, ...extra })
  const add = (text, id, at = Date.now(), more = {}) => memory.add({ text, gist: text.slice(0, -1), kind: 'preference', about: '12345', aboutName: '小明', source: 'auto', chatId: chat.chatId, chat, at, sourceRefs: [{ id, quote: text, senderId: '12345', at }], ...more })
  const data = () => JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8'))
  return { dir, cfg, chat, memory, add, data, output: value => { output = value } }
}

test('new exact opposite preference retires old claim without merging independent events', t => {
  const f = fixture(t)
  const old = f.add('我喜欢喝咖啡', 'a', Date.now() - DAY)
  const newer = f.add('我不喜欢喝咖啡', 'b')
  assert.equal(f.data().items.find(m => m.id === old.id).supersededBy, newer.id)
  assert.equal(f.memory.recall('咖啡', { chat: f.chat })[0].it.text, '我不喜欢喝咖啡')
  const first = f.add('昨天一起吃火锅', 'e1', Date.now(), { kind: 'event' })
  const second = f.add('昨天一起吃火锅', 'e2', Date.now(), { kind: 'event' })
  assert.notEqual(first.id, second.id)
})

test('explicit manual core stays retrievable after details fade, protected core stays after years', t => {
  const f = fixture(t)
  const r = f.memory.add({ text: '小明对花生过敏', source: 'panel', chat: f.chat, protected: true })
  const s = f.data(); s.items.find(m => m.id === r.id).at = Date.now() - 1000 * DAY
  writeFileSync(join(f.dir, 'memories.json'), JSON.stringify(s))
  const hits = f.memory.recall('花生过敏', { chat: f.chat })
  assert.equal(hits[0].clarity, 'gist')
  assert.equal(hits[0].it.text, '小明对花生过敏')
})

test('deletion during model await cancels final encoding and never recreates removed source', async t => {
  const f = fixture(t)
  const r = f.add('我喜欢喝咖啡', 'old')
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  f.output(async () => { entered(); return await new Promise(resolve => { release = resolve }) })
  const task = f.memory.encode(f.chat.chatId, [{ id: 'new', uid: '12345', who: '小明', t: Date.now(), text: '我喜欢喝茶' }], f.chat)
  await ready
  f.memory.remove(r.id)
  release('{"memories":[{"text":"我喜欢喝茶","gist":"喜欢喝茶","quote":"我喜欢喝茶","sourceId":"new","kind":"preference","importance":0.5}]}')
  assert.equal((await task).code, 'MEMORY_CHANGED')
  assert.equal(f.data().items.length, 0)
})

test('revoked encoding permission after await rejects grounded result', async t => {
  let allowed = true
  const f = fixture(t, { canEncode: () => allowed })
  f.output(async () => { allowed = false; return '{"memories":[]}' })
  const r = await f.memory.encode(f.chat.chatId, [], f.chat)
  assert.equal(r.code, 'MEMORY_CHANGED')
})

test('derived emotional impressions require independent days and disappear on source deletion', async t => {
  const f = fixture(t)
  const first = f.add('昨天你陪我喝咖啡', 'a', Date.now() - DAY, { kind: 'impression', emotion: { valence: 0.8, arousal: 0.5 } })
  f.add('今天你陪我喝咖啡', 'b', Date.now(), { kind: 'impression', emotion: { valence: 0.7, arousal: 0.5 } })
  f.add('下午你陪我喝咖啡', 'c', Date.now(), { kind: 'impression', emotion: { valence: 0.9, arousal: 0.5 } })
  await f.memory.consolidate()
  assert.match(f.memory.contextFor(f.chat, 's'), /偏温暖/)
  f.memory.remove(first.id)
  assert.doesNotMatch(f.memory.contextFor(f.chat, 's'), /偏温暖/)
})

test('corrupt memory fails closed without replacing the original file', t => {
  const f = fixture(t)
  writeFileSync(join(f.dir, 'memories.json'), 'broken json')
  assert.throws(() => f.add('我喜欢喝咖啡', 'a'))
  assert.equal(readFileSync(join(f.dir, 'memories.json'), 'utf8'), 'broken json')
})

test('legacy consolidation keeps failed conversation and successful per-chat cursor for retry', async t => {
  let failure = true, callsA = 0
  const f = fixture(t)
  f.cfg.memory.simulation.enabled = false
  const day = new Date(Date.now() - DAY).toLocaleDateString('sv-SE')
  const logs = [{ chatId: 'private:12345', who: '小明', text: '咖啡' }, { chatId: 'private:12345', who: '小明', text: '真香' }, { chatId: 'private:12345', who: '小明', text: '喜欢' }, { chatId: 'private:23456', who: '小红', text: '茶叶' }, { chatId: 'private:23456', who: '小红', text: '真香' }, { chatId: 'private:23456', who: '小红', text: '喜欢' }]
  let deleted = false
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const text = JSON.stringify(messages)
    if (system.includes('整理长期记忆')) {
      if (text.includes('咖啡')) callsA++
      if (text.includes('茶叶') && failure) throw new Error('offline')
    }
    yield { type: 'text-delta', text: '[]' }; yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const memory = createMemoryStore({ dsh, getConfig: () => f.cfg, hub: { chatLogDays: () => [day], chatLogOf: () => logs, deleteChatLog: () => { deleted = true } }, log: { info() {}, warn() {} } })
  assert.equal((await memory.consolidate()).ok, false)
  assert.equal(deleted, false)
  failure = false
  assert.equal((await memory.consolidate()).ok, true)
  assert.equal(callsA, 1)
  assert.equal(deleted, true)
})
