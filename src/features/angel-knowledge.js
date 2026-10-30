import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJson } from '../core/store.js'
import { tokenize } from './memory.js'

const MAX_NOTES = 500
const MAX_CONTENT = 12_000
const validScope = (value) => value === 'shared' || /^(?:private|group):\d{1,32}$/.test(String(value || ''))
const visibleTo = (note, chat) => note.scope === 'shared' || (['private', 'group'].includes(chat?.kind) && note.scope === chat.chatId)

export function createAngelKnowledgeStore({ root }) {
  const file = join(root, 'knowledge.json')
  const load = () => {
    if (!existsSync(file)) return { version: 1, items: [] }
    const state = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!state || !Array.isArray(state.items) || state.items.length > MAX_NOTES || state.items.some((item) => !item || !/^[a-f0-9]{12}$/.test(item.id) || typeof item.title !== 'string' || typeof item.domain !== 'string' || typeof item.content !== 'string' || item.content.length > MAX_CONTENT || !validScope(item.scope) || !Number.isFinite(item.at))) throw new Error('Invalid Angel Memory knowledge store')
    return state
  }
  const save = (state) => writeJson(file, state)

  function add(input = {}) {
    if (typeof input.title !== 'string') return { ok: false, code: 'INVALID_TITLE' }
    if (input.domain !== undefined && typeof input.domain !== 'string') return { ok: false, code: 'INVALID_DOMAIN' }
    if (typeof input.content !== 'string') return { ok: false, code: 'INVALID_CONTENT' }
    const title = input.title.trim()
    const domain = (input.domain === undefined ? '通用' : input.domain).trim() || '通用'
    const content = input.content.trim()
    const scope = typeof input.scope === 'string' ? input.scope : ''
    if (!title || title.length > 120) return { ok: false, code: 'INVALID_TITLE' }
    if (domain.length > 80) return { ok: false, code: 'INVALID_DOMAIN' }
    if (!validScope(scope)) return { ok: false, code: 'INVALID_SCOPE' }
    if (!content) return { ok: false, code: 'EMPTY_CONTENT' }
    if (content.length > MAX_CONTENT) return { ok: false, code: 'CONTENT_TOO_LARGE' }

    const state = load()
    if (state.items.length >= MAX_NOTES) return { ok: false, code: 'KNOWLEDGE_FULL' }
    const item = { id: randomUUID().replaceAll('-', '').slice(0, 12), title, domain, content, scope, at: Date.now() }
    state.items.push(item)
    save(state)
    return { ok: true, id: item.id }
  }

  // ponytail: linear token scans suit the 500-note cap; add an inverted index if the corpus grows.
  function search(query, chat, { domain = '', limit = 3 } = {}) {
    const terms = [...new Set(tokenize(String(query || '').slice(0, 300)))]
    if (!terms.length) return []
    const wantedDomain = String(domain || '').trim()
    const cap = Math.max(1, Math.min(10, Number(limit) || 3))
    return load().items.filter((item) => visibleTo(item, chat) && (!wantedDomain || item.domain === wantedDomain)).map((item) => {
      const title = new Set(tokenize(item.title))
      const category = new Set(tokenize(item.domain))
      const body = new Set(tokenize(item.content))
      const score = terms.reduce((n, term) => n + (title.has(term) ? 4 : 0) + (category.has(term) ? 2 : 0) + (body.has(term) ? 1 : 0), 0)
      return { id: item.id, title: item.title, domain: item.domain, scope: item.scope, excerpt: item.content.slice(0, 1000), score, at: item.at }
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.at - a.at).slice(0, cap)
  }

  function list(query = '') {
    const terms = [...new Set(tokenize(String(query || '').slice(0, 300)))]
    const items = load().items.map((item) => {
      const tokens = new Set(tokenize(`${item.title} ${item.domain} ${item.content}`))
      return { item, score: terms.reduce((n, term) => n + Number(tokens.has(term)), 0) }
    }).filter((row) => !terms.length || row.score > 0)
    items.sort((a, b) => b.score - a.score || b.item.at - a.item.at)
    return items.map(({ item }) => ({ ...item, content: item.content.slice(0, 360) }))
  }

  function read(id, chat) {
    const item = load().items.find((entry) => entry.id === String(id || ''))
    return item && visibleTo(item, chat) ? { ...item } : null
  }

  function remove(id) {
    const state = load()
    const before = state.items.length
    state.items = state.items.filter((item) => item.id !== String(id || ''))
    if (state.items.length === before) return { ok: false, code: 'NOT_FOUND' }
    save(state)
    return { ok: true }
  }

  return { add, search, list, read, remove, stats: () => ({ count: load().items.length }) }
}
