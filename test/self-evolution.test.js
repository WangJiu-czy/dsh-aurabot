import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonaState, tickPersonaState, applyPersonaInteraction, snapshotPersona } from '../src/modules/self-evolution/persona-sim.js'

const HOUR = 60 * 60 * 1000

test('Persona Sim：按空闲时长推进状态并限制在 0 到 100', () => {
  const state = tickPersonaState(createPersonaState(0), 12 * HOUR)
  assert.deepEqual([state.energy, state.socialNeed, state.satiety], [71, 74, 68])
  const exhausted = tickPersonaState(state, 1000 * HOUR)
  assert.ok([exhausted.energy, exhausted.socialNeed, exhausted.satiety].every((n) => n >= 0 && n <= 100))
})

test('Persona Sim：互动调整状态，Snapshot 生成效果、待办和短提示', () => {
  const state = applyPersonaInteraction(createPersonaState(0), 'good', HOUR)
  assert.deepEqual([state.energy, state.socialNeed, state.satiety, state.lastInteractionAt], [81, 30.5, 77, HOUR])

  const snapshot = snapshotPersona({ ...state, energy: 20, socialNeed: 90, satiety: 20 }, 25, 10 * HOUR)
  assert.deepEqual(snapshot.effects.map((e) => e.id), ['low-energy', 'low-mood', 'lonely', 'hungry'])
  assert.equal(snapshot.todos.length, 3)
  assert.match(snapshot.prompt, /有点累/)
  assert.doesNotMatch(snapshot.prompt, /活力.*\d|心情.*\d|饱腹.*\d/)
})
