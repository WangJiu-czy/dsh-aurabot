// Pure simulation only: callers gate this with simulationOptions(...).enabled.
const DAY = 86_400_000
const DEFAULTS = Object.freeze({
  enabled: false,
  detailHalfLifeDays: 3,
  gistHalfLifeDays: 21,
  importantHalfLifeDays: 180,
  semanticHalfLifeDays: 120,
  emotionHalfLifeHours: 48,
  clearThreshold: 0.55,
  gistThreshold: 0.12,
  archiveThreshold: 0.03,
  maxChars: 1200,
  privateCount: 3,
  groupCount: 1,
})
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const finite = x => typeof x === 'number' && Number.isFinite(x)
const unit = (x, fallback = 0) => finite(x) ? Math.max(0, Math.min(1, x)) : fallback
const timestamp = x => finite(x) && x >= 0 ? x : typeof x === 'string' && x.trim() && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null

export function simulationOptions(raw = {}) {
  const input = record(raw) ? raw : {}
  const out = { ...DEFAULTS, enabled: input.enabled === true }
  for (const key of Object.keys(DEFAULTS)) {
    if (key.endsWith('Threshold')) out[key] = unit(input[key], DEFAULTS[key])
    else if (key !== 'enabled' && finite(input[key]) && input[key] > 0) {
      out[key] = ['maxChars', 'privateCount', 'groupCount'].includes(key)
        ? Math.min({ maxChars: 2400, privateCount: 8, groupCount: 3 }[key], Math.max(1, Math.floor(input[key])))
        : Math.min(36500, input[key])
    }
  }
  out.gistThreshold = Math.min(out.clearThreshold, out.gistThreshold)
  out.archiveThreshold = Math.min(out.gistThreshold, out.archiveThreshold)
  return out
}

export function memoryState(item, options = {}, now = Date.now()) {
  const m = record(item) ? item : {}
  const cues = record(options) ? options : {}
  const o = simulationOptions(options)
  const clock = timestamp(now) ?? 0
  const eventAt = timestamp(m.occurredAt) ?? timestamp(m.at)
  const ageDays = eventAt === null ? 0 : Math.max(0, (clock - eventAt) / DAY)
  const empty = { clarity: 'not-recalled', detailRetention: 0, gistRetention: 0, emotionRetention: 0, activation: 0, recallText: '', ageDays }
  if (eventAt === null || typeof m.text !== 'string' || !m.text.trim()
    || (m.invalidAt !== undefined && m.invalidAt !== null && m.invalidAt !== false)
    || (m.status !== undefined && !['active', 'valid'].includes(m.status))) return empty

  const stability = finite(m.stability) ? Math.max(1, m.stability) : 1
  const coreHalfLife = unit(m.importance) >= 0.8 || m.kind === 'commitment' ? o.importantHalfLifeDays
    : ['fact', 'preference'].includes(m.kind) ? o.semanticHalfLifeDays : o.gistHalfLifeDays
  const detailRetention = 2 ** (-ageDays / (o.detailHalfLifeDays * stability))
  const gistRetention = m.protected === true ? 1 : 2 ** (-ageDays / (coreHalfLife * stability))
  const emotionRetention = 2 ** (-ageDays * 24 / o.emotionHalfLifeHours)
  const relevance = unit(cues.relevance, 1)
  const lastUsed = timestamp(m.lastUsedAt)
  // Retrieval helps access, never repairs an old event's detail or changes its date.
  const reinforcement = lastUsed !== null && lastUsed >= eventAt && lastUsed <= clock
    ? 0.15 * 2 ** (-(clock - lastUsed) / (7 * DAY)) : 0
  const activation = unit(relevance * (0.65 * detailRetention + 0.35 * gistRetention)
    * (1 + reinforcement + 0.1 * unit(cues.effort)))
  let clarity = 'not-recalled'
  let recallText = ''
  if (relevance >= 0.2 && activation >= o.archiveThreshold) {
    if (detailRetention >= o.clearThreshold) {
      clarity = 'clear'
      recallText = m.text
    } else if (gistRetention >= o.gistThreshold && typeof m.gist === 'string' && m.gist.trim()
      // A copy of the original is not a detail-dimmed gist.
      && (m.gist.trim() !== m.text.trim() || m.coreOnly === true && ['panel', 'import'].includes(m.source)) && (typeof m.details !== 'string' || !m.details.trim() || !m.gist.includes(m.details.trim()))) {
      clarity = 'gist'
      recallText = m.gist
    }
  }
  return { clarity, detailRetention, gistRetention, emotionRetention, activation, recallText: recallText.slice(0, o.maxChars), ageDays }
}

const identity = x => (typeof x === 'string' && x.trim().length > 0 && x.length <= 200)
  || (Number.isSafeInteger(x) && x !== 0)
const KINDS = new Set(['event', 'episode', 'episodic', 'impression', 'fact', 'preference', 'commitment'])
const boundedText = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max

/** Extractive grounding is deliberately conservative: no local heuristic proves paraphrase entailment. */
export function validateCandidates(output, messages) {
  let parsed = output
  if (typeof output === 'string') {
    if (output.length > 100_000) return []
    try { parsed = JSON.parse(output) } catch { return [] }
  }
  if (!record(parsed) || !Array.isArray(parsed.memories) || !Array.isArray(messages)) return []
  const sources = new Map()
  for (const m of messages) {
    if (!record(m) || !identity(m.id)) continue
    const key = String(m.id)
    // Ambiguous IDs never identify a source, even if only one copy is a human.
    sources.set(key, sources.has(key) ? null : m)
  }
  const results = []
  for (const c of parsed.memories) {
    if (results.length === 3) break
    if (!record(c) || !identity(c.sourceId) || !boundedText(c.text, 500)
      || !boundedText(c.quote, 500) || c.quote.trim().length < 2
      || !KINDS.has(c.kind) || !finite(c.importance) || c.importance < 0 || c.importance > 1) continue
    const m = sources.get(String(c.sourceId))
    if (!m || !identity(m.uid) || !boundedText(m.who, 200)
      || ['bot', 'assistant', 'system', 'tool'].includes(m.who.trim().toLowerCase())
      || typeof m.text !== 'string' || !m.text.includes(c.quote) || timestamp(m.t) === null
      || !c.quote.includes(c.text.trim())) continue
    if (c.gist !== undefined && (typeof c.gist !== 'string' || c.gist.length > 300 || !c.quote.includes(c.gist.trim()))) continue
    if (c.emotion !== undefined && (!record(c.emotion) || !finite(c.emotion.valence)
      || c.emotion.valence < -1 || c.emotion.valence > 1 || !finite(c.emotion.arousal)
      || c.emotion.arousal < 0 || c.emotion.arousal > 1)) continue
    if (c.entities !== undefined && (!Array.isArray(c.entities) || c.entities.length > 4
      || c.entities.some(e => !boundedText(e, 20) || e.trim().length < 2 || !c.quote.includes(e)))) continue
    results.push({
      text: c.text.trim(),
      ...(c.gist?.trim() ? { gist: c.gist.trim() } : {}),
      kind: c.kind,
      importance: c.importance,
      ...(c.emotion !== undefined ? { emotion: { valence: c.emotion.valence, arousal: c.emotion.arousal } } : {}),
      ...(c.entities !== undefined ? { entities: [...new Set(c.entities)] } : {}),
      about: String(m.uid),
      aboutName: m.who,
      at: timestamp(m.t),
      source: 'auto',
      evidence: { quote: c.quote },
      sourceRefs: [{ id: String(m.id), quote: c.quote, senderId: String(m.uid), at: timestamp(m.t) }],
    })
  }
  return results
}
