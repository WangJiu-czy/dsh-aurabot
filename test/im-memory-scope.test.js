import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, search, createMemoryStore } from '../src/features/memory.js'
import { normalizeImMessage, memoryScopeFor } from '../src/chat/im-context.js'
const chat = (accountId = 'A', kind = 'direct') => normalizeImMessage({ platform: 'douyin', accountId, conversation: { kind, id: '1' }, sender: { id: '1' }, messageId: '1', parts: [] })
test('scope filter runs before ranking/limit; binding does not expose private or legacy QQ records', () => {
  const a = chat(), b = chat('B'), group = chat('A', 'group')
  const items = [
    { id: 'legacy', text: 'secret secret secret', importance: 1 },
    { id: 'A', text: 'secret', scope: memoryScopeFor(a) },
    { id: 'B', text: 'secret', scope: memoryScopeFor(b) },
    { id: 'person', text: 'secret', scope: { kind: 'person-private', platform: 'douyin', accountId: 'A', senderId: '1' } },
    { id: 'shared', text: 'secret', scope: { kind: 'shared', audience: 'all-conversations' } },
  ]
  const idx = buildIndex(items)
  assert.deepEqual(search(idx, 'secret', { chat: b, limit: 10, minScore: 0 }).map(h => h.it.id).sort(), ['B', 'shared'])
  assert.deepEqual(search(idx, 'secret', { chat: group, limit: 10, minScore: 0 }).map(h => h.it.id), ['shared'])
  assert.equal(search(idx, 'secret', { chat: b, limit: 1, minScore: 0 }).length, 1)
  assert.ok(search(idx, 'secret', { limit: 10, minScore: 0 }).some(h => h.it.id === 'legacy'))
})
test('store dedup, recall/context, profile and topic consistently isolate scope', () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-im-memory-'))
  const a = chat(), b = chat('B')
  const cfg = { memory: { enabled: true, recallCount: 1 }, personBindings: [{ personId: 'same-person', identities: [a.actor, b.actor] }] }
  const memory = createMemoryStore({ getConfig: () => cfg, dsh: {}, hub: { lastTextOf: () => 'secret', speakersOf: () => ['1'] }, log: { info() {}, warn() {} } })
  memory.add({ text: 'secret legacy private', importance: 1, about: '1' })
  memory.add({ text: 'secret A private', scope: memoryScopeFor(a), about: '1' })
  memory.add({ text: 'secret B private', scope: memoryScopeFor(b), about: '1' })
  assert.equal(memory.list('', { allScopes: true }).length, 3, 'cross-scope duplicates are separate')
  assert.equal(memory.recall('secret', { chat: b, about: '1', limit: 1 })[0].it.text, 'secret B private')
  memory.setProfile('1', 'QQ private profile')
  memory.setProfile('1', 'A private profile', '', a)
  assert.doesNotMatch(memory.contextFor(b, 's'), /legacy|A private|QQ private/)
  assert.doesNotMatch(memory.contextFor(a, 's'), /A private profile/, 'unprovenanced IM manual/legacy profile is hidden')
  assert.match(memory.contextFor({ kind: 'private', userId: '1' }, 's'), /QQ private profile/, 'legacy QQ manual profile remains compatible')
  assert.equal(memory.topicScore('legacy', b), 0)
  cfg.personBindings = []
  assert.doesNotMatch(memory.contextFor(b, 's'), /legacy|A private|QQ private/)
})

test('owner-private sharing permits bound owner recall, not background/publication or same-digit stranger', () => {
  const a = chat(), b = chat('B'), group = chat('A', 'group')
  const cfg = { imAccounts: [{ platform: 'douyin', accountId: 'A', ownerId: '1', enabled: true }] }
  const idx = buildIndex([{ text: 'secret', about: '1', scope: { kind: 'shared', audience: 'owner-private' } }])
  assert.equal(search(idx, 'secret', { chat: a, cfg, about: '1' }).length, 1)
  for (const context of [undefined, b, group]) assert.equal(search(idx, 'secret', { chat: context, cfg, about: '1' }).length, 0)
  cfg.imAccounts[0].ownerId = ''
  assert.equal(search(idx, 'secret', { chat: a, cfg, about: '1' }).length, 0)
})

test('explicit person binding boosts only visible shared facts and unbinding revokes association', () => {
  const a = chat(), b = chat('B')
  const ia = { platform: 'douyin', accountId: 'A', senderId: '1' }
  const ib = { platform: 'douyin', accountId: 'B', senderId: '1' }
  const cfg = { personBindings: [{ personId: 'person-1', identities: [ia, ib] }] }
  const idx = buildIndex([{ text: 'likes apples', about: '1', aboutIdentity: ia, scope: { kind: 'shared', audience: 'all-conversations' } }, { text: 'private apples', about: '1', aboutIdentity: ia, scope: memoryScopeFor(a) }])
  assert.deepEqual(search(idx, 'unmatched', { chat: b, about: '1', cfg }).map(h => h.it.text), ['likes apples'])
  cfg.personBindings = []
  assert.deepEqual(search(idx, 'unmatched', { chat: b, about: '1', cfg }), [])
})

test('derived IM profiles recheck source audience, binding, deletion, invalidation and content at read/build', async () => {
  for (const revoke of ['owner', 'binding', 'delete', 'invalid', 'edit']) {
    process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-profile-source-'))
    const a = chat(), foreign = { platform: 'douyin', accountId: 'B', senderId: '1' }
    const cfg = { model: { provider: 'fake', model: 'fake' }, memory: { enabled: true, recallCount: 1 }, imAccounts: [{ platform: 'douyin', accountId: 'A', ownerId: '1', enabled: true }], personBindings: [{ personId: 'same', identities: [a.actor, foreign] }] }
    const prompts = []
    const dsh = { get: () => null, llm: { async *stream({ messages }) {
      prompts.push(messages[0].content[0].text)
      yield { type: 'text-delta', text: 'PROFILE SECRET' }; yield { type: 'finish', reason: { kind: 'completed' } }
    } } }
    const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub: {}, log: { info() {}, warn() {} } })
    const ids = ['alpha likes cats', 'beta works nights', 'gamma lives abroad'].map(text => memory.add({ text, about: '1', aboutIdentity: revoke === 'binding' ? foreign : a.actor, scope: { kind: 'shared', audience: 'owner-private' } }).id)
    assert.equal(await memory.buildProfile('1', a), true)
    assert.match(memory.contextFor(a, 's'), /PROFILE SECRET/)
    if (revoke === 'owner') cfg.imAccounts[0].ownerId = 'OTHER'
    if (revoke === 'binding') cfg.personBindings = []
    if (revoke === 'delete') memory.remove(ids[0])
    if (revoke === 'invalid') {
      const file = join(process.env.AURABOT_DATA_DIR, 'memories.json'), saved = JSON.parse(readFileSync(file, 'utf8'))
      saved.items.find(m => m.id === ids[0]).invalidAt = Date.now()
      writeFileSync(file, JSON.stringify(saved))
    }
    if (revoke === 'edit') memory.update(ids[0], { text: 'changed fact' })
    assert.doesNotMatch(memory.contextFor(a, 's'), /PROFILE SECRET/, revoke)
    // Add enough new local facts to trigger another build, but never feed the invalid old profile.
    for (const text of ['delta likes rain', 'epsilon loves walking', 'zeta learns piano']) memory.add({ text, about: '1', chat: a })
    const before = prompts.length
    await memory.buildProfile('1', a)
    assert.ok(prompts.length > before)
    assert.doesNotMatch(prompts.at(-1), /PROFILE SECRET/)
  }
})

test('consolidation reads all scopes only internally and models never receive a mixed transcript', async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-im-consolidate-'))
  const a = chat(), b = chat('B')
  const prompts = []
  const cfg = { model: { provider: 'fake', model: 'fake' }, ownerQQ: '1', memory: { enabled: true, recallCount: 2 } }
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const text = messages[0].content[0].text
    prompts.push({ system, text })
    let out = '[]'
    if (system.includes('整理长期记忆')) out = JSON.stringify([{ text: text.includes('ALPHA') ? 'ALPHA stored secret' : 'BETA stored secret', about: 'person', about_id: '1' }])
    yield { type: 'text-delta', text: out }; yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const logs = [a, b].flatMap((c, i) => [1, 2, 3].map(() => ({ chatId: c.chatId, uid: '1', who: 'person', text: i ? 'BETA private' : 'ALPHA private' })))
  const hub = { chatLogDays: () => ['2000-01-01'], chatLogOf: (_day, options) => { assert.equal(options.allScopes, true); return logs }, deleteChatLog() {} }
  const memory = createMemoryStore({ dsh, hub, getConfig: () => cfg, log: { info() {}, warn() {} } })
  memory.add({ text: 'legacy QQ secret ALPHA', about: '1' })
  assert.equal((await memory.consolidate()).ok, true)
  for (const p of prompts) {
    assert.ok(!(p.text.includes('ALPHA') && p.text.includes('BETA')), 'each model request is scoped')
    if (p.text.includes('BETA')) assert.doesNotMatch(p.text, /legacy QQ/)
  }
  const rows = memory.list('', { allScopes: true })
  assert.ok(rows.some(m => m.text === 'ALPHA stored secret' && m.scope.accountId === 'A'))
  assert.ok(rows.some(m => m.text === 'BETA stored secret' && m.scope.accountId === 'B'))
  assert.equal(memory.list('').some(m => m.scope?.platform === 'douyin'), false)
})
