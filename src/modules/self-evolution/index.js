// Aurabot 移植的 Persona Sim：与现有心情、记忆和主动搭话模块协作，不重复保存它们的数据。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { scoreText } from '../../features/companion.js'
import { createPersonaState, tickPersonaState, applyPersonaInteraction, snapshotPersona } from './persona-sim.js'

const MAX_SCOPES = 200
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const qualities = new Set(['good', 'normal', 'bad', 'brief', 'awkward', 'relief'])

export default {
  id: 'self-evolution',
  name: '自我进化（Persona Sim）',
  version: '1.0.0',
  description: '基于互动和时间推演 Persona Sim 状态；状态卡显示在「心情与记忆」页，并轻量注入上下文',
  tab: 'mood',
  files: ['features/companion.js'],
  setup(api) {
    const file = api.dataDir('persona-sim.json')
    const mood = api.lazy('mood')
    let db = { version: 1, scopes: Object.create(null) }
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (saved?.version === 1 && saved.scopes && typeof saved.scopes === 'object') {
        for (const [key, value] of Object.entries(saved.scopes)) {
          if (/^[a-f0-9]{64}$/.test(key) && value?.state && Number.isFinite(value.usedAt) && Date.now() - value.usedAt < MAX_AGE_MS) db.scopes[key] = value
        }
      }
    } catch {}

    const keyOf = (chatId) => createHash('sha256').update(String(chatId || '')).digest('hex')
    function persist() {
      const now = Date.now()
      for (const [key, value] of Object.entries(db.scopes)) {
        if (now - value.usedAt >= MAX_AGE_MS) delete db.scopes[key]
      }
      const keys = Object.keys(db.scopes)
      if (keys.length > MAX_SCOPES) {
        keys.sort((a, b) => db.scopes[a].usedAt - db.scopes[b].usedAt)
        for (const key of keys.slice(0, keys.length - MAX_SCOPES)) delete db.scopes[key]
      }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(db))
      renameSync(tmp, file)
    }
    function getState(chatId, now = Date.now()) {
      if (!chatId) return createPersonaState(now)
      const key = keyOf(chatId)
      const record = db.scopes[key]
      const state = record ? tickPersonaState(record.state, now) : createPersonaState(now)
      db.scopes[key] = { state, usedAt: now }
      return state
    }
    function saveState(chatId, state, now = Date.now()) {
      if (!chatId) return
      db.scopes[keyOf(chatId)] = { state, usedAt: now }
      persist()
    }
    function resetState(chatId) {
      if (!chatId) return
      delete db.scopes[keyOf(chatId)]
      persist()
    }
    function currentMood() { return mood.current?.() ?? 60 }
    function snapshot(chatId, now = Date.now()) {
      const state = getState(chatId, now)
      const result = snapshotPersona(state, currentMood(), now)
      if (chatId) db.scopes[keyOf(chatId)] = { state: result.state, usedAt: now }
      return result
    }
    function formatStatus(s) {
      const { state, effects, todos } = s
      return [
        `Persona Sim：活力 ${Math.round(state.energy)}/100 · 心情 ${Math.round(state.mood)}/100 · 社交需求 ${Math.round(state.socialNeed)}/100 · 饱腹感 ${Math.round(state.satiety)}/100`,
        `当前效果：${effects.length ? effects.map((e) => e.name).join('、') : '平稳'}`,
        `脑内待办：${todos.length ? todos.map((t) => t.title).join('；') : '暂时没有'}`,
      ].join('\n')
    }

    api.context(({ chat }) => {
      if (!chat?.chatId || chat.kind === 'system') return ''
      return snapshot(chat.chatId).prompt
    })
    api.on('activity', (event) => {
      const chatId = event?.chatId
      if (!chatId || String(chatId).startsWith('system:')) return
      const now = Number(event.timestamp) || Date.now()
      let state = getState(chatId, now)
      if (event.kind === 'in') {
        if (event.direct) state = { ...state, lastInteractionAt: now }
      } else if (event.kind === 'out' && event.reply && !String(event.reply).includes('[沉默]')) {
        const score = scoreText(event.userText || '')
        state = applyPersonaInteraction(state, score >= 6 ? 'good' : score <= -8 ? 'bad' : 'normal', now)
      }
      saveState(chatId, state, now)
    })
    api.command({
      name: 'ps',
      aliases: ['personasim'],
      desc: 'Persona Sim 状态：/ps status、/ps todo、/ps tick [good|normal|bad]、/ps reset',
      run: (arg, msg) => {
        const [action = 'status', quality = 'normal'] = String(arg || '').trim().split(/\s+/)
        if (action === 'help') return '用法：/ps status 查看状态；/ps todo 查看待办；/ps tick good|normal|bad 手动模拟一次互动；/ps reset 清除当前会话状态。'
        if (action === 'reset') { resetState(msg.chatId); return '当前会话的 Persona Sim 状态已重置。' }
        const s = snapshot(msg.chatId)
        if (action === 'todo') return s.todos.length ? s.todos.map((t, i) => `${i + 1}. ${t.title}`).join('\n') : '现在没有 Persona Sim 待办。'
        if (action === 'tick') {
          if (!qualities.has(quality)) return '互动类型请用 good、normal、bad、brief、awkward 或 relief。'
          saveState(msg.chatId, applyPersonaInteraction(s.state, quality), Date.now())
          return formatStatus(snapshot(msg.chatId))
        }
        if (action !== 'status') return '用法：/ps status、/ps todo、/ps tick good|normal|bad'
        return formatStatus(s)
      },
    })

    return {
      snapshot: (chatId) => snapshot(chatId),
      interact: (chatId, quality = 'normal') => {
        if (!chatId) return { ok: false, message: 'chatId 必填' }
        if (!qualities.has(quality)) return { ok: false, message: '互动类型无效' }
        const state = applyPersonaInteraction(getState(chatId), quality)
        saveState(chatId, state)
        return { ok: true, ...snapshot(chatId) }
      },
    }
  },
}
