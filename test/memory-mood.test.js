import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMood } from '../src/features/companion.js'

function setup(t) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-memory-mood-'))
  let now = new Date(2026, 9, 30, 1).getTime()
  t.mock.method(Date, 'now', () => now)
  const file = join(process.env.AURABOT_DATA_DIR, 'mood.json')
  const baseline = { value: 60, at: now, reason: '', history: [] }
  writeFileSync(file, JSON.stringify(baseline))
  const cfg = { memory: { enabled: true, simulation: { enabled: true } }, mood: { enabled: true, halfLifeHours: 6 } }
  const mood = createMood({ getConfig: () => cfg })
  return { mood, cfg, baseline, file, advance: ms => { now += ms },
    disk: () => JSON.parse(readFileSync(file, 'utf8')) }
}
const echo = (id = 'memory1', chatId = 'private:A', extra = {}) => ({ id, chatId, valence: 1, arousal: 1, ...extra })

test('recall echo is scoped, transient, persisted and never nudges global mood', t => {
  const s = setup(t), before = s.mood.effects()
  assert.equal(s.mood.recallEcho(echo()), true)
  assert.match(s.mood.contextLine({ chatId: 'private:A' }), /暖意/)
  assert.equal(s.mood.contextLine({ chatId: 'private:B' }), '')
  assert.equal(s.mood.contextLine(), '')
  assert.equal(s.mood.current(), 60)
  assert.deepEqual(s.mood.effects(), before)
  for (const key of ['value', 'at', 'reason', 'history']) assert.deepEqual(s.disk()[key], s.baseline[key])
  const reloaded = createMood({ getConfig: () => s.cfg })
  assert.match(reloaded.contextLine({ chatId: 'private:A' }), /暖意/)
  assert.equal(reloaded.recallEcho(echo()), false, 'cooldown persists through restart')
  s.advance(24 * 3600_000)
  assert.equal(reloaded.contextLine({ chatId: 'private:A' }), '', 'echo decays without touching baseline')
})

test('per-memory six-hour cooldown is conversation scoped and expires at exact boundary', t => {
  const s = setup(t)
  assert.equal(s.mood.recallEcho(echo()), true)
  assert.equal(s.mood.recallEcho(echo()), false)
  assert.equal(s.mood.recallEcho(echo('memory1', 'private:B')), true)
  s.advance(6 * 3600_000 - 1)
  assert.equal(s.mood.recallEcho(echo()), false)
  s.advance(1)
  assert.equal(s.mood.recallEcho(echo()), true)
  assert.equal(s.disk().recallEchoes['private:A'].spent, 6)
})

test('daily magnitude budget is nine per conversation including negative echoes and resets next day', t => {
  const s = setup(t)
  assert.equal(s.mood.recallEcho(echo('one')), true)
  assert.equal(s.mood.recallEcho(echo('two', 'private:A', { valence: -1 })), true)
  assert.equal(s.mood.recallEcho(echo('three')), true)
  assert.equal(s.disk().recallEchoes['private:A'].spent, 9)
  assert.equal(s.mood.recallEcho(echo('four')), false)
  assert.equal(s.mood.recallEcho(echo('four', 'private:B')), true)
  s.advance(24 * 3600_000)
  assert.equal(s.mood.recallEcho(echo('four')), true)
  assert.equal(s.disk().recallEchoes['private:A'].spent, 3)
})

test('disabled simulation, memory or mood blocks new echoes and hides existing echo context', t => {
  const s = setup(t)
  assert.equal(s.mood.recallEcho(echo()), true)
  for (const target of [s.cfg.memory.simulation, s.cfg.memory, s.cfg.mood]) {
    target.enabled = false
    const disk = readFileSync(s.file, 'utf8')
    assert.equal(s.mood.recallEcho(echo('disabled')), false)
    assert.equal(s.mood.contextLine({ chatId: 'private:A' }), '')
    assert.equal(readFileSync(s.file, 'utf8'), disk)
    target.enabled = true
  }
})

test('invalid or neutral echoes have no durable effect', t => {
  const s = setup(t), before = readFileSync(s.file, 'utf8')
  for (const extra of [{ id: '' }, { chatId: '' }, { valence: NaN }, { arousal: Infinity },
    { valence: 0 }, { arousal: 0 }, { arousal: -1 }]) {
    assert.equal(s.mood.recallEcho(echo('invalid', 'private:A', extra)), false)
  }
  assert.equal(readFileSync(s.file, 'utf8'), before)
})
