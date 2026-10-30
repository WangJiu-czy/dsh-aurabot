import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImMessage, conversationKey, personKey, targetFromChatId, normalizeReceipt } from '../src/chat/im-context.js'

const event = (platform = 'douyin', accountId = 'A', kind = 'direct') => ({ platform, accountId, conversation: { kind, id: '9007199254740993123:a' }, sender: { id: '9007199254740993124:b' }, messageId: '9007199254740993125:c', parts: [{ type: 'text', text: 'hello' }] })
test('tuple identities isolate platforms, accounts, kinds and delimiter-bearing large IDs', () => {
  const msgs = [event('qq'), event(), event('douyin', 'B'), event('douyin', 'A', 'group')].map(normalizeImMessage)
  assert.equal(new Set(msgs.map(m => m.chatId)).size, 4)
  for (const m of msgs) {
    assert.equal(m.userId, '9007199254740993124:b')
    assert.equal(m.conversation.id, '9007199254740993123:a')
    assert.equal(conversationKey(m), m.chatId)
    assert.notEqual(personKey(m), m.chatId)
    assert.deepEqual(targetFromChatId(m.chatId), { platform: m.platform, accountId: m.accountId, conversation: m.conversation })
  }
  assert.equal(msgs[1].kind, 'private')
  assert.equal(msgs[1].conversation.kind, 'direct')
  assert.deepEqual(targetFromChatId('private:123'), { kind: 'private', id: '123' })
  assert.throws(() => normalizeImMessage({ ...event(), sender: { id: 9007199254740992 } }), /string|safe/i)
  assert.throws(() => normalizeImMessage({ ...event(), conversation: { kind: 'oops', id: '1' } }), /kind/)
})
test('receipt requires explicit confirmed evidence, uncertain is never success', () => {
  assert.equal(normalizeReceipt({ status: 'confirmed', messageId: '123' }).status, 'confirmed')
  for (const receipt of [null, {}, { statusCode: 0 }, { status: 'confirmed' }, { status: 'uncertain', messageId: '123' }]) assert.equal(normalizeReceipt(receipt).status, 'uncertain')
  assert.equal(normalizeReceipt({ status: 'failed', code: 'NOT_SENT' }).status, 'failed')
})

test('explicit owner binding has no QQ, other-account or group privilege fallback', async () => {
  const { checkAllowed, actorIsOwner, levelFor, isOwner } = await import('../src/chat/access.js')
  const cfg = { ownerQQ: '9007199254740993124:b', ownerLevel: 'full', imAccounts: [{ platform: 'douyin', accountId: 'A', enabled: true, ownerId: '9007199254740993124:b', allow: { private: [], groups: ['9007199254740993123:a'] } }] }
  const a = normalizeImMessage(event()), b = normalizeImMessage(event('douyin', 'B')), group = normalizeImMessage(event('douyin', 'A', 'group'))
  assert.equal(isOwner(cfg, a.userId), true, 'old signature stays QQ-only')
  assert.equal(actorIsOwner(cfg, a), true)
  assert.equal(actorIsOwner(cfg, b), false)
  assert.equal(checkAllowed(cfg, b).allowed, false)
  assert.equal(levelFor(cfg, group), 'social')
  assert.equal(levelFor(cfg, a), 'full')
  cfg.imAccounts[0].ownerId = ''
  assert.equal(actorIsOwner(cfg, a), false)
  assert.equal(checkAllowed(cfg, a).allowed, false)
})

test('model keys are complete tuples and do not inherit same-digit QQ model defaults', async () => {
  const { normalizeChatModels, resolveChatModel } = await import('../src/chat/chat-model.js')
  const a = normalizeImMessage(event()), b = normalizeImMessage(event('douyin', 'B'))
  const selection = { provider: 'p', model: 'dy' }
  const cfg = { chatModels: normalizeChatModels({ privateDefault: { provider: 'p', model: 'qq' }, privates: { '9007199254740993124': { provider: 'p', model: 'qq-person' } }, conversations: { [a.chatId]: selection } }) }
  assert.equal(resolveChatModel(cfg, a).model, 'dy')
  assert.equal(resolveChatModel(cfg, b), null)
  const { normalize, mergeFromPanel } = await import('../src/core/config.js')
  const cleared = mergeFromPanel(normalize(cfg), { chatModels: { conversations: {} } })
  assert.equal(resolveChatModel(cleared, a), null)
  assert.equal(resolveChatModel(cfg, { kind: 'private', userId: '9007199254740993124' }).model, 'qq-person')
})
