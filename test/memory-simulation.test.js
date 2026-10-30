import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { normalizeImMessage } from '../src/chat/im-context.js'

const DAY = 86_400_000
const TEXT = 'I prefer jasmine tea after meeting at platform 7 at 14:32.'
const GIST = 'I prefer jasmine tea'
const chatFor = (accountId = 'A') => normalizeImMessage({ platform: 'douyin', accountId, conversation: { kind: 'direct', id: 'conversation-1' }, sender: { id: 'person-1' }, messageId: 'message-1', parts: [] })

function setup(t, { output, initial, enabled = true } = {}) {
  const prior = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-simulation-test-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (prior === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prior
    // This exact directory was created by this fixture, never a derived user path.
    rmSync(dir, { recursive: true, force: true })
  })
  const file = join(dir, 'memories.json')
  if (initial !== undefined) writeFileSync(file, initial)
  const cfg = { model: { provider: 'mock-memory', model: 'mock-memory' }, memory: { enabled: true, simulation: { enabled }, recallCount: 6 } }
  const prompts = []
  const dsh = { get: () => null, llm: { async *stream(params) {
    prompts.push(params)
    yield { type: 'text-delta', text: typeof output === 'function' ? await output(params) : output || '{"memories":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const chat = chatFor()
  const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub: { lastTextOf: () => 'jasmine tea', speakersOf: () => ['person-1'] }, log: { info() {}, warn() {} } })
  const input = { text: TEXT, gist: GIST, kind: 'episode', source: 'auto', about: 'person-1', aboutName: 'Alice', chat, chatId: chat.chatId, evidence: { quote: TEXT }, sourceRefs: [{ id: 'original-message', quote: TEXT, senderId: 'person-1', at: Date.now() }] }
  const saved = () => JSON.parse(readFileSync(file, 'utf8'))
  return { memory, chat, cfg, file, prompts, input, saved }
}

test('simulation projects fresh text then gist without leaking stored source originals', t => {
  const f = setup(t)
  f.memory.add(f.input)
  let hit = f.memory.recall('jasmine tea', { chat: f.chat })[0]
  assert.equal(hit.clarity, 'clear')
  assert.equal(hit.it.text, TEXT)
  assert.equal('sourceRefs' in hit.it, false)
  assert.equal('evidence' in hit.it, false)
  const data = f.saved()
  data.items[0].at = Date.now() - 3 * DAY
  writeFileSync(f.file, JSON.stringify(data))
  hit = f.memory.recall('jasmine tea', { chat: f.chat })[0]
  assert.equal(hit.clarity, 'gist')
  assert.equal(hit.it.text, GIST)
  assert.doesNotMatch(JSON.stringify(hit), /14:32|platform 7|original-message|"quote"|sourceRefs|evidence/)
  assert.match(f.memory.contextFor(f.chat, 's'), /只记得大概/)
  assert.doesNotMatch(f.memory.contextFor(f.chat, 's'), /14:32|platform 7/)
  assert.equal(f.saved().items[0].text, TEXT, 'projection never erases stored source')
})

test('visible-scope filtering excludes same sender on another account before recall', t => {
  const f = setup(t)
  f.memory.add(f.input)
  assert.equal(f.memory.recall('jasmine tea', { chat: chatFor('B') }).length, 0)
  assert.doesNotMatch(f.memory.contextFor(chatFor('B'), 's'), /jasmine|platform/)
  assert.equal(f.memory.recall('jasmine tea', { chat: f.chat }).length, 1)
})

test('retrieval, absent receipt and false-use response never strengthen a memory', t => {
  const f = setup(t)
  f.memory.add(f.input)
  f.memory.contextFor(f.chat, 's')
  assert.equal(f.saved().items[0].stability, 1)
  for (const status of [undefined, 'pending', 'failed']) {
    assert.deepEqual(f.memory.confirmUse({ chat: f.chat, reply: TEXT, messageId: 'reply-1', status }), [])
  }
  assert.deepEqual(f.memory.confirmUse({ chat: f.chat, reply: 'Let us discuss coffee instead.', messageId: 'reply-2', status: 'confirmed' }), [])
  assert.equal(f.saved().items[0].stability, 1)
  assert.equal(f.saved().items[0].lastUsedAt, undefined)
})

test('confirmed exact injected phrase strengthens at most once per day without moving event date', t => {
  const f = setup(t)
  f.memory.add(f.input)
  const originalAt = f.saved().items[0].at
  f.memory.contextFor(f.chat, 's')
  assert.equal(f.memory.confirmUse({ chat: f.chat, reply: `I remember: ${TEXT}`, messageId: 'receipt-1', status: 'confirmed' }).length, 1)
  const first = f.saved().items[0]
  assert.equal(first.stability, 1.25)
  assert.equal(first.useDays, 1)
  assert.equal(first.at, originalAt)
  f.memory.contextFor(f.chat, 's')
  assert.deepEqual(f.memory.confirmUse({ chat: f.chat, reply: TEXT, messageId: 'receipt-2', status: 'confirmed' }), [])
  assert.equal(f.saved().items[0].stability, 1.25)
  assert.equal(f.saved().items[0].useDays, 1)
})

test('multi-bubble receipt ignores acknowledgement then strengthens actual injected phrase once', t => {
  const f = setup(t)
  f.memory.add(f.input)
  f.memory.contextFor(f.chat, 's')
  assert.deepEqual(f.memory.confirmUse({ chat: f.chat, reply: '嗯嗯', messageId: 'bubble-1', status: 'confirmed' }), [])
  assert.equal(f.saved().items[0].stability, 1)
  assert.equal(f.memory.confirmUse({ chat: f.chat, reply: TEXT, messageId: 'bubble-2', status: 'confirmed' }).length, 1)
  assert.equal(f.saved().items[0].stability, 1.25)
  assert.deepEqual(f.memory.confirmUse({ chat: f.chat, reply: TEXT, messageId: 'bubble-3', status: 'confirmed' }), [])
  assert.equal(f.saved().items[0].useDays, 1)
})

test('deletion tombstones prevent replay of the same source even with different wording', t => {
  const f = setup(t)
  const { id } = f.memory.add(f.input)
  assert.equal(f.memory.remove(id).ok, true)
  assert.equal(f.memory.recall('jasmine tea', { chat: f.chat }).length, 0)
  assert.equal(f.memory.add(f.input).code, 'SOURCE_DELETED')
  assert.equal(f.memory.add({ ...f.input, text: 'jasmine tea' }).code, 'SOURCE_DELETED')
  assert.equal(f.saved().items.length, 0)
  assert.equal(f.saved().tombstones.length, 1)
})

test('encode validates mocked model output and binds sender and time from human source', async t => {
  const messages = [{ id: 'human-source', uid: 'person-1', who: 'Alice', t: Date.now() - DAY, text: TEXT }]
  const output = JSON.stringify({ memories: [
    { text: TEXT, gist: GIST, quote: TEXT, sourceId: 'human-source', kind: 'episode', importance: 0.8, about: 'forged-person', occurredAt: 1 },
  ] })
  const f = setup(t, { output })
  const result = await f.memory.encode(f.chat.chatId, messages, f.chat)
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(f.prompts.length, 1)
  const [stored] = f.saved().items
  assert.equal(stored.about, 'person-1')
  assert.equal(stored.source, 'auto')
  assert.equal(stored.kind, 'episode')
  assert.equal(stored.at, messages[0].t, 'encoding preserves trusted source timestamp rather than ingestion time')
  assert.equal(stored.occurredAt, undefined)
  assert.deepEqual(stored.sourceRefs, [{ id: 'human-source', quote: TEXT, senderId: 'person-1', at: messages[0].t }])
  assert.equal(f.memory.recall('jasmine tea', { chat: f.chat }).length, 1)
})

test('encode rejects an entire mixed grounded and invented batch without partial writes', async t => {
  const messages = [{ id: 'human-source', uid: 'person-1', who: 'Alice', t: Date.now(), text: TEXT }]
  const output = JSON.stringify({ memories: [
    { text: TEXT, gist: GIST, quote: TEXT, sourceId: 'human-source', kind: 'episode', importance: 0.8 },
    { text: 'invented diagnosis', gist: '', quote: TEXT, sourceId: 'human-source', kind: 'impression', importance: 0.9 },
  ] })
  const f = setup(t, { output })
  const result = await f.memory.encode(f.chat.chatId, messages, f.chat)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNGROUNDED_ENCODING')
  assert.equal(existsSync(f.file), false)
})

test('old data migration keeps an exact once-only backup without discarding legacy records', t => {
  const initial = JSON.stringify({ items: [{ id: 'legacy', text: 'legacy quiet preference', at: Date.now() - 20 * DAY, importance: 0.6 }], rev: 4 })
  const f = setup(t, { initial })
  f.memory.add(f.input)
  assert.equal(existsSync(f.file + '.pre-simulation.bak'), true)
  assert.equal(readFileSync(f.file + '.pre-simulation.bak', 'utf8'), initial)
  assert.equal(f.saved().version, 2)
  assert.ok(f.saved().items.some(m => m.id === 'legacy'))
  f.memory.add({ ...f.input, text: 'I prefer jasmine tea', sourceRefs: [{ ...f.input.sourceRefs[0], id: 'second-message' }] })
  assert.equal(readFileSync(f.file + '.pre-simulation.bak', 'utf8'), initial)
})

test('legacy behavior stays gated while simulation is disabled', t => {
  const f = setup(t, { enabled: false })
  f.memory.add(f.input)
  const hit = f.memory.recall('jasmine tea', { chat: f.chat })[0]
  assert.equal(hit.it.text, TEXT)
  assert.equal(hit.clarity, undefined)
  assert.equal(f.saved().version, undefined)
  assert.equal(existsSync(f.file + '.pre-simulation.bak'), false)
})
