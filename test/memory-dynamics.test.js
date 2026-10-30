import test from 'node:test'
import assert from 'node:assert/strict'
import { simulationOptions, memoryState, validateCandidates } from '../src/features/memory-dynamics.js'

const DAY = 86_400_000
const START = Date.UTC(2026, 0, 1)
const item = { text: 'We met at platform 7 at 14:32 for tea.', gist: 'We met for tea.', details: 'platform 7 at 14:32', at: START }
const state = (days, patch = {}, options = {}) => memoryState({ ...item, ...patch }, options, START + days * DAY)
const source = { id: 'message-1', text: 'I prefer jasmine tea without sugar.', uid: 'user-7', who: 'Alice', t: START }
const candidate = { text: 'I prefer jasmine tea without sugar.', gist: 'jasmine tea', quote: source.text, sourceId: source.id, kind: 'preference', importance: 0.6 }
const parse = (patch = {}, messages = [source]) => validateCandidates({ memories: [{ ...candidate, ...patch }] }, messages)

test('options expose exact requested defaults', () => {
  assert.deepEqual(simulationOptions(), { enabled: false, detailHalfLifeDays: 3, gistHalfLifeDays: 21, importantHalfLifeDays: 180, semanticHalfLifeDays: 120, emotionHalfLifeHours: 48, clearThreshold: 0.55, gistThreshold: 0.12, archiveThreshold: 0.03, maxChars: 1200, privateCount: 3, groupCount: 1 })
})
test('options require explicit boolean opt-in', () => {
  assert.equal(simulationOptions({ enabled: 'true' }).enabled, false)
  assert.equal(simulationOptions({ enabled: true }).enabled, true)
})
test('options reject malformed half lives and counts', () => {
  assert.equal(simulationOptions({ detailHalfLifeDays: NaN, gistHalfLifeDays: -1, groupCount: Infinity }).detailHalfLifeDays, 3)
  assert.equal(simulationOptions({ gistHalfLifeDays: -1 }).gistHalfLifeDays, 21)
  assert.equal(simulationOptions({ privateCount: 2.8 }).privateCount, 2)
  assert.deepEqual(simulationOptions(null), simulationOptions())
})
test('thresholds are bounded and ordered', () => {
  const o = simulationOptions({ clearThreshold: 0.2, gistThreshold: 0.9, archiveThreshold: 2 })
  assert.equal(o.clearThreshold, 0.2)
  assert.equal(o.gistThreshold, 0.2)
  assert.equal(o.archiveThreshold, 0.2)
})
test('new event recalls original text rather than concatenated details', () => {
  assert.equal(state(0).clarity, 'clear')
  assert.equal(state(0).recallText, item.text)
})
test('detail is exactly half retained at day 3', () => assert.equal(state(3).detailRetention, 0.5))
test('gist is exactly half retained at day 21', () => assert.equal(state(21).gistRetention, 0.5))
test('emotion is exactly half retained at 48 hours', () => assert.equal(state(2).emotionRetention, 0.5))
test('day 3 is gist without old time or platform', () => {
  const s = state(3)
  assert.equal(s.clarity, 'gist')
  assert.equal(s.recallText, item.gist)
  assert.doesNotMatch(s.recallText, /14:32|platform 7/)
})
test('day 30 keeps the explicit core', () => assert.equal(state(30).clarity, 'gist'))
test('fully faded episode is not recalled', () => assert.equal(state(365).clarity, 'not-recalled'))
test('old record without gist does not invent one', () => {
  const s = state(30, { gist: undefined })
  assert.equal(s.clarity, 'not-recalled')
  assert.equal(s.recallText, '')
})
test('gist identical to original cannot re-expose dimmed detail', () => assert.equal(state(30, { gist: item.text }).clarity, 'not-recalled'))
test('gist containing declared old details is withheld', () => assert.equal(state(30, { gist: `Tea at ${item.details}` }).clarity, 'not-recalled'))
test('importance extends core to important half life', () => assert.equal(state(180, { importance: 0.8 }).gistRetention, 0.5))
test('commitment extends core regardless of importance', () => assert.equal(state(180, { kind: 'commitment', importance: 0 }).gistRetention, 0.5))
test('fact uses semantic half life', () => assert.equal(state(120, { kind: 'fact' }).gistRetention, 0.5))
test('preference uses semantic half life', () => assert.equal(state(120, { kind: 'preference' }).gistRetention, 0.5))
test('protected core never decays but details do', () => {
  const s = state(1000, { protected: true })
  assert.equal(s.gistRetention, 1)
  assert.ok(s.detailRetention < 0.001)
  assert.equal(s.clarity, 'gist')
})
test('stability increases retention with minimum one', () => {
  assert.equal(state(3, { stability: 2 }).detailRetention, 2 ** -0.5)
  assert.equal(state(3, { stability: 0 }).detailRetention, state(3).detailRetention)
})
test('lastUsed reinforces activation without resetting event age or detail', () => {
  const reinforced = state(30, { lastUsedAt: START + 30 * DAY })
  assert.ok(reinforced.activation > state(30).activation)
  assert.equal(reinforced.ageDays, 30)
  assert.equal(reinforced.detailRetention, state(30).detailRetention)
  assert.equal(reinforced.clarity, 'gist')
})
test('occurredAt takes priority over later ingestion date', () => assert.equal(state(30, { occurredAt: START - 10 * DAY, at: START + 20 * DAY }).ageDays, 40))
test('future event dates clamp age to zero', () => assert.equal(state(0, { at: START + DAY }).ageDays, 0))
test('future lastUsed does not reinforce', () => assert.equal(state(30, { lastUsedAt: START + 40 * DAY }).activation, state(30).activation))
test('invalid dates do not turn into new memories', () => {
  assert.equal(state(0, { at: 'nonsense' }).clarity, 'not-recalled')
  assert.equal(memoryState(null, {}, START).clarity, 'not-recalled')
})
test('invalidAt even at epoch excludes a record', () => assert.equal(state(0, { invalidAt: 0 }).clarity, 'not-recalled'))
test('inactive statuses exclude records', () => {
  for (const status of ['invalid', 'superseded', 'archived', 'deleted']) assert.equal(state(0, { status }).clarity, 'not-recalled')
})
test('relevance zero blocks fresh and protected memories despite effort and mood', () => {
  for (const days of [0, 30, 1000]) {
    const s = state(days, { protected: true, emotion: { valence: -1, arousal: 1 } }, { relevance: 0, effort: 1, mood: -1 })
    assert.equal(s.clarity, 'not-recalled')
    assert.equal(s.activation, 0)
  }
})
test('weak relevance does not pass the cue gate', () => assert.equal(state(0, {}, { relevance: 0.19, effort: 1 }).clarity, 'not-recalled'))
test('negative mood cannot alter recall or rescue old detail', () => {
  assert.deepEqual(state(30, {}, { mood: -1 }), state(30, {}, { mood: 1 }))
  assert.equal(state(30, {}, { effort: 1 }).clarity, 'gist')
})
test('activation responds to cue and effort deterministically', () => {
  assert.ok(state(1, {}, { relevance: 0.8 }).activation > state(1, {}, { relevance: 0.4 }).activation)
  assert.ok(state(3, {}, { effort: 1 }).activation > state(3).activation)
  assert.deepEqual(state(3), state(3))
})
test('recall text respects character budget and inputs are untouched', () => {
  const m = structuredClone(item)
  const o = { maxChars: 4 }
  assert.equal(memoryState(m, o, START).recallText, item.text.slice(0, 4))
  assert.deepEqual(m, item)
  assert.deepEqual(o, { maxChars: 4 })
})
test('parser accepts grounded JSON and binds all provenance to source', () => {
  const [c] = validateCandidates(JSON.stringify({ memories: [candidate] }), [source])
  assert.equal(c.about, source.uid)
  assert.equal(c.aboutName, source.who)
  assert.equal(c.source, 'auto')
  assert.equal(c.at, START)
  assert.deepEqual(c.evidence, { quote: source.text })
  assert.deepEqual(c.sourceRefs, [{ id: source.id, quote: source.text, senderId: source.uid, at: START }])
  assert.equal('occurredAt' in c, false)
})
test('parser ignores invented metadata and source identities', () => {
  const [c] = parse({ about: 'victim', source: 'manual', occurredAt: 123, protected: true, sourceRefs: [{ id: 'forged' }] })
  assert.equal(c.about, source.uid)
  assert.equal(c.source, 'auto')
  assert.equal('protected' in c, false)
  assert.equal('occurredAt' in c, false)
})
test('parser rejects malformed JSON and root shapes', () => {
  for (const out of ['broken', '```json\n{"memories":[]}\n```', null, [], {}, { memories: null }]) assert.deepEqual(validateCandidates(out, [source]), [])
})
test('parser caps valid candidates at three', () => assert.equal(validateCandidates({ memories: Array(8).fill(candidate) }, [source]).length, 3))
test('parser rejects quote from the wrong corresponding source', () => assert.deepEqual(parse({ sourceId: 'other' }, [source, { ...source, id: 'other', text: 'Unrelated talk.' }]), []))
test('parser rejects unknown source and invalid identities', () => {
  for (const sourceId of ['missing', '', {}, null, NaN]) assert.deepEqual(parse({ sourceId }), [])
  for (const uid of ['', null, {}, Infinity]) assert.deepEqual(parse({}, [{ ...source, uid }]), [])
})
test('parser rejects bot and system sources', () => {
  for (const who of ['bot', 'BOT', 'assistant', 'system', 'tool']) assert.deepEqual(parse({}, [{ ...source, who }]), [])
})
test('parser rejects ambiguous duplicate source IDs', () => assert.deepEqual(parse({}, [source, { ...source, who: 'Bob' }]), []))
test('parser quote must be exact and between 2 and 500 characters', () => {
  for (const quote of ['I', 'invented quote', 'x'.repeat(501)]) assert.deepEqual(parse({ quote }), [])
  assert.deepEqual(parse({ quote: source.text.toUpperCase() }), [])
})
test('parser requires grounded text and gist rather than inferred facts', () => {
  assert.deepEqual(parse({ text: 'Alice lives in Tokyo.' }), [])
  assert.deepEqual(parse({ gist: 'Alice hates coffee.' }), [])
  assert.equal(parse({ gist: undefined }).length, 1)
})
test('parser rejects unknown kind and invalid importance numbers', () => {
  assert.deepEqual(parse({ kind: 'diagnosis' }), [])
  for (const importance of ['0.7', NaN, Infinity, -0.1, 1.1, null]) assert.deepEqual(parse({ importance }), [])
})
test('emotion remains bounded subjective metadata only', () => {
  const [c] = parse({ emotion: { valence: -1, arousal: 1, diagnosis: 'fabricated' } })
  assert.deepEqual(c.emotion, { valence: -1, arousal: 1 })
  for (const emotion of [{ valence: -1.1, arousal: 0 }, { valence: 0, arousal: 1.1 }, { valence: '0', arousal: 0 }, { valence: 0 }, null]) assert.deepEqual(parse({ emotion }), [])
})
test('entities are bounded evidence substrings and deduplicated', () => {
  assert.deepEqual(parse({ entities: ['jasmine tea', 'jasmine tea'] })[0].entities, ['jasmine tea'])
  assert.deepEqual(parse({ entities: ['Tokyo'] }), [])
  assert.deepEqual(parse({ entities: [123] }), [])
})
test('source timestamp must exist and model date never overrides it', () => {
  assert.deepEqual(parse({}, [{ ...source, t: 'unknown' }]), [])
  assert.equal(parse({ at: 999 }, [{ ...source, t: new Date(START).toISOString() }])[0].at, START)
})
test('parser does not mutate output or messages', () => {
  const out = { memories: [structuredClone(candidate)] }
  const messages = [structuredClone(source)]
  validateCandidates(out, messages)
  assert.deepEqual(out, { memories: [candidate] })
  assert.deepEqual(messages, [source])
})
test('configuration caps bound prompt and decay resource budgets', () => {
  const o = simulationOptions({ maxChars: 100000, privateCount: 100, groupCount: 100, detailHalfLifeDays: 100000, emotionHalfLifeHours: 100000 })
  assert.equal(o.maxChars, 2400)
  assert.equal(o.privateCount, 8)
  assert.equal(o.groupCount, 3)
  assert.equal(o.detailHalfLifeDays, 36500)
  assert.equal(o.emotionHalfLifeHours, 36500)
})
test('episode and impression are accepted prompt kinds', () => {
  for (const kind of ['episode', 'impression']) assert.equal(parse({ kind }).length, 1)
})
test('empty gist is absent, overlong gist is rejected', () => {
  assert.equal('gist' in parse({ gist: '' })[0], false)
  assert.deepEqual(parse({ gist: 'x'.repeat(301) }), [])
})
test('entities enforce count and length limits', () => {
  assert.deepEqual(parse({ entities: ['I'] }), [])
  assert.deepEqual(parse({ entities: Array(5).fill('tea') }), [])
  assert.deepEqual(parse({ entities: [source.text] }), [])
})
test('replay logs day0/day3/day30 outcomes', () => {
  const replay = [0, 3, 30].map(day => ({ day, ...state(day) }))
  console.log('memory replay:', JSON.stringify(replay.map(({ day, clarity, detailRetention, gistRetention, recallText }) => ({ day, clarity, detailRetention, gistRetention, recallText }))))
  assert.deepEqual(replay.map(s => s.clarity), ['clear', 'gist', 'gist'])
})
