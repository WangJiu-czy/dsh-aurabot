import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createImAdapterRegistry } from '../src/core/im-adapters.js'

test('IM adapters isolate platform/account, route send and receive, and reject invalid registration or unknown identities', async () => {
  const registry = createImAdapterRegistry()
  const qqIdentity = { platform: 'qq', accountId: 'same-account' }
  const otherIdentity = { platform: 'example-im', accountId: 'same-account' }
  const sent = []
  const received = []
  const unregisterQq = registry.register(qqIdentity, { send: async (target, message) => sent.push([target, message, 'qq']) })
  registry.register(otherIdentity, { send: async (target, message) => sent.push([target, message, 'other']) })
  assert.throws(() => registry.register(qqIdentity, { send() {} }), /已注册/)
  registry.onMessage(qqIdentity, (event) => received.push(['qq', event]))
  registry.onMessage(otherIdentity, (event) => received.push(['other', event]))

  await registry.send({ ...qqIdentity, conversation: { kind: 'direct', id: '42' } }, { text: 'QQ' })
  await registry.send({ ...otherIdentity, conversation: { kind: 'direct', id: '42' } }, { text: 'IM' })
  assert.equal(await registry.receive({ ...qqIdentity, conversation: { kind: 'direct', id: '42' }, message: 'qq inbound' }), true)
  assert.equal(await registry.receive({ ...otherIdentity, conversation: { kind: 'direct', id: '42' }, message: 'im inbound' }), true)
  assert.deepEqual(sent.map(([, message, route]) => [message.text, route]), [['QQ', 'qq'], ['IM', 'other']])
  assert.deepEqual(received.map(([route, event]) => [route, event.platform, event.accountId, event.conversation.id, event.message]), [
    ['qq', 'qq', 'same-account', '42', 'qq inbound'],
    ['other', 'example-im', 'same-account', '42', 'im inbound'],
  ])

  assert.throws(() => registry.send({ platform: 'missing-im', accountId: 'x', conversation: { id: '42' } }, 'x'), /没有注册/)
  await assert.rejects(registry.receive({ platform: 'missing-im', accountId: 'x', conversation: { id: '42' }, message: 'x' }), /没有注册/)
  assert.throws(() => registry.register({ platform: 'bad platform', accountId: 'x' }, { send() {} }), /不合法/)
  assert.throws(() => registry.register({ platform: 'valid-im', accountId: 'x' }, {}), /send/)
  unregisterQq()
  assert.throws(() => registry.send({ ...qqIdentity, conversation: { id: '42' } }, 'x'), /没有注册/)
})
