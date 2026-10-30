// Adapted from Renyus/astrbot_plugin_self_evolution (CC BY-NC 4.0); rules rewritten for Aurabot.
const clamp = (value) => Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 0))
const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback

export function createPersonaState(now = Date.now()) {
  return { energy: 80, socialNeed: 50, satiety: 80, lastTickAt: now, lastInteractionAt: now }
}

export function tickPersonaState(input, now = Date.now()) {
  const state = {
    energy: clamp(numberOr(input?.energy, 80)),
    socialNeed: clamp(numberOr(input?.socialNeed, 50)),
    satiety: clamp(numberOr(input?.satiety, 80)),
    lastTickAt: numberOr(input?.lastTickAt, now),
    lastInteractionAt: numberOr(input?.lastInteractionAt, now),
  }
  const hours = Math.max(0, (now - state.lastTickAt) / 3_600_000)
  if (hours) {
    const idleHours = Math.max(0, (now - state.lastInteractionAt) / 3_600_000)
    const recentlySocial = idleHours < 6
    state.energy = clamp(state.energy - 1.5 * hours + (recentlySocial ? 0.5 * hours : Math.max(0, hours - 3)))
    state.socialNeed = clamp(state.socialNeed + hours * (recentlySocial ? 0.5 : 2))
    state.satiety = clamp(state.satiety - hours)
  }
  state.lastTickAt = now
  return state
}

const INTERACTION_DELTA = {
  good: [2, -20, -2],
  normal: [-3, -15, -2],
  bad: [-5, -10, -2],
  brief: [0, -5, -2],
  awkward: [-2, -5, -2],
  relief: [3, -10, -2],
}

export function applyPersonaInteraction(input, quality = 'normal', now = Date.now()) {
  const state = tickPersonaState(input, now)
  const [energy, socialNeed, satiety] = INTERACTION_DELTA[quality] || INTERACTION_DELTA.normal
  return {
    ...state,
    energy: clamp(state.energy + energy),
    socialNeed: clamp(state.socialNeed + socialNeed),
    satiety: clamp(state.satiety + satiety),
    lastTickAt: now,
    lastInteractionAt: now,
  }
}

export function snapshotPersona(input, moodValue = 60, now = Date.now()) {
  const state = tickPersonaState(input, now)
  const mood = clamp(moodValue)
  const idleHours = Math.max(0, (now - state.lastInteractionAt) / 3_600_000)
  const effects = []
  const todos = []
  if (state.energy < 30) {
    effects.push({ id: 'low-energy', name: '疲惫', hint: '有点累，想缓一缓' })
    todos.push({ id: 'rest', title: '想找机会休息一会儿', priority: 8 })
  }
  if (mood < 30) {
    effects.push({ id: 'low-mood', name: '低落', hint: '心情有点低落' })
    todos.push({ id: 'quiet', title: '想安静一会儿', priority: 6 })
  }
  if (state.socialNeed > 70 && idleHours > 2) {
    effects.push({ id: 'lonely', name: '想念聊天', hint: '有点想找人聊聊' })
    todos.push({ id: 'social', title: '想找人说几句话', priority: 7 })
  }
  if (state.satiety < 30) {
    effects.push({ id: 'hungry', name: '饿了', hint: '有点饿，惦记着吃点东西' })
    todos.push({ id: 'eat', title: '想找点好吃的', priority: 9 })
  }
  todos.sort((a, b) => b.priority - a.priority)
  const parts = effects.slice(0, 2).map((effect) => effect.hint)
  if (todos.length && !parts.length) parts.push(todos[0].title)
  return {
    state: { ...state, mood },
    effects,
    todos: todos.slice(0, 3),
    prompt: parts.length ? `【Persona Sim 近况】${parts.join('；')}。只作为内在背景，不必主动提及状态数值。` : '',
    snapshotAt: now,
  }
}
