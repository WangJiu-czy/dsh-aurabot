import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import virtualLife from '../src/modules/virtual-life/index.js'
import { currentItem, localDate, parseSchedule, scheduleLine } from '../src/modules/virtual-life/schedule.js'

test('parses a full-day timeline and finds the current item', () => {
  const plan = parseSchedule(JSON.stringify({ theme: '宅家', mood: '放松', timeline: [
    { start: '00:00', end: '08:00', activity: '睡觉', location: '家', state: '休息' },
    { start: '08:00', end: '24:00', activity: '生活', location: '家', state: '普通' },
  ] }))
  assert.equal(currentItem(plan, '09:30').activity, '生活')
  assert.match(scheduleLine({ ...plan, date: '2026-10-30' }, 'Asia/Tokyo', new Date('2026-10-30T03:00:00Z')), /宅家/)
})

test('rejects gaps, invalid clocks and incomplete days', () => {
  for (const timeline of [
    [{ start: '00:00', end: '23:00', activity: 'x', location: 'y', state: 'z' }],
    [{ start: '00:00', end: '08:00', activity: 'x', location: 'y', state: 'z' }, { start: '09:00', end: '24:00', activity: 'x', location: 'y', state: 'z' }],
    [{ start: '99:00', end: '24:00', activity: 'x', location: 'y', state: 'z' }],
  ]) assert.throws(() => parseSchedule(JSON.stringify({ timeline })))
})

test('formats local calendar date and falls back from an invalid timezone', () => {
  assert.equal(localDate(new Date('2026-10-30T15:00:00Z'), 'Asia/Tokyo'), '2026-10-31')
  assert.equal(localDate(new Date('2026-10-30T00:00:00Z'), 'Bad/Zone'), '2026-10-30')
})

test('module persists generated schedules and exposes schedule lookup tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-virtual-life-'))
  const tools = []
  const api = {
    dataDir: (...parts) => join(dir, ...parts),
    settings: () => ({ enabled: true, timeZone: 'Asia/Tokyo' }),
    config: () => ({}),
    core: { personas: { current: () => '测试人格' }, http: { body: async () => ({}) } },
    ask: async () => JSON.stringify({ theme: '休闲', mood: '平静', timeline: [
      { start: '00:00', end: '24:00', activity: '休息', location: '家', state: '放松' },
    ] }),
    log: { error() {} }, isOwner: () => true,
    context() {}, every() {}, later() {}, command() {}, route() {}, tool(fn) { tools.push(fn) },
    defineTool: (spec) => spec,
  }
  try {
    const mod = virtualLife.setup(api)
    const result = await mod.generate('2026-10-30')
    assert.equal(result.ok, true)
    assert.equal(mod.scheduleFor('2026-10-30').theme, '休闲')
    const tool = tools[0]({ chat: { kind: 'private' } })
    const lookup = await tool.execute({ date: '2026-10-30' })
    assert.match(lookup.message, /休闲/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
