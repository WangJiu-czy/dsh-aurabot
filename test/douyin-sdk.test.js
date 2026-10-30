import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { createDouyinImClient } from '../src/douyin/im-sdk.js'
import { createFakeDouyinIm } from './helpers/fake-douyin-im.js'

// No SDK/platform network is permitted, including accidental future regressions.
for (const [target, key] of [[net.Socket.prototype, 'connect'], [tls, 'connect'], [http, 'request'], [https, 'request'], [globalThis, 'fetch']]) {
  test.mock.method(target, key, () => assert.fail('network forbidden in offline SDK tests'))
}
const root = mkdtempSync(join(tmpdir(), 'aurabot-sdk-test-'))
after(() => {
  assert.ok(root.startsWith(join(tmpdir(), 'aurabot-sdk-test-')))
  rmSync(root, { recursive: true })
})
const dataDir = join(root, 'douyin')
const sqlite = async () => ({ DatabaseSync: class {} })
const settings = (fake) => ({ enabled: true, dataDir, loadSdk: fake.loadSdk, loadSqlite: sqlite, nodeVersion: '24.19.0' })

test('disabled SDK never imports, probes sqlite, creates a client or logs in', async () => {
  const fake = createFakeDouyinIm()
  const result = await createDouyinImClient({ ...settings(fake), enabled: false, loadSqlite: () => assert.fail('sqlite loaded') })
  assert.equal(result.code, 'DISABLED')
  assert.deepEqual(fake.calls, { imports: 0, creates: [], logins: 0, logouts: 0, sends: [] })
  assert.equal((await createDouyinImClient()).code, 'DISABLED')
  assert.equal((await createDouyinImClient({ ...settings(fake), enabled: 'true' })).code, 'DISABLED')
})

test('runtime and data path diagnostics precede all SDK initialization', async () => {
  const fake = createFakeDouyinIm()
  for (const nodeVersion of ['20.19.0', '22.12.0', 'unknown', '24.0.0-pre']) {
    assert.equal((await createDouyinImClient({ ...settings(fake), nodeVersion })).code, 'UNSUPPORTED_RUNTIME')
  }
  for (const dataDir of [undefined, '', 'relative', '/']) {
    assert.equal((await createDouyinImClient({ ...settings(fake), dataDir })).code, 'INVALID_DATA_DIR')
  }
  assert.equal(fake.calls.imports, 0)
  const result = await createDouyinImClient({ ...settings(fake), loadSqlite: async () => { throw new Error('private details') } })
  assert.equal(result.code, 'SQLITE_UNAVAILABLE')
  assert.equal(fake.calls.imports, 0)
})

test('dependency/export/factory failures are contained and redact upstream errors', async () => {
  const fake = createFakeDouyinIm()
  for (const [loadSdk, code] of [
    [async () => { throw Object.assign(new Error('secret cookie'), { code: 'ERR_MODULE_NOT_FOUND' }) }, 'SDK_NOT_FOUND'],
    [async () => { throw new Error('secret cookie') }, 'SDK_LOAD_FAILED'],
    [async () => ({}), 'SDK_EXPORT_MISMATCH'],
    [async () => ({ createClient() { throw new Error('secret cookie') } }), 'SDK_INIT_FAILED'],
  ]) {
    const result = await createDouyinImClient({ ...settings(fake), loadSdk })
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.ok(!JSON.stringify(result).includes('secret'))
  }
})

test('explicit enabled fake uses isolated path, disables autoload, never logs in', async () => {
  const fake = createFakeDouyinIm()
  for (const nodeVersion of ['22.13.0', '23.0.0', '24.19.0']) {
    const result = await createDouyinImClient({ ...settings(fake), nodeVersion })
    assert.equal(result.ok, true)
    assert.equal(result.client, fake.client)
  }
  assert.deepEqual(fake.calls.creates[0], { dataDir, autoLoad: false, localState: false })
  if (process.platform !== 'win32') assert.equal(statSync(dataDir).mode & 0o777, 0o700)
  assert.equal(fake.calls.logins, 0)
  assert.equal(fake.client.accounts.length, 0)
})

test('existing broad permissions and symlink data directories never reach the factory', async () => {
  if (process.platform === 'win32') return
  const fake = createFakeDouyinIm()
  const broad = mkdtempSync(join(root, 'broad-'))
  chmodSync(broad, 0o755)
  assert.equal((await createDouyinImClient({ ...settings(fake), dataDir: broad })).code, 'INVALID_DATA_DIR')
  assert.equal(statSync(broad).mode & 0o777, 0o755)
  const link = join(root, 'link')
  symlinkSync(broad, link)
  assert.equal((await createDouyinImClient({ ...settings(fake), dataDir: link })).code, 'INVALID_DATA_DIR')
  assert.equal(fake.calls.creates.length, 0)
})

test('fake private/group events, large IDs, errors and logout are controllable without network', async () => {
  const fake = createFakeDouyinIm()
  const { client } = await createDouyinImClient(settings(fake))
  const id = '9223372036854775806'
  const account = client.createAccount({ accountId: id })
  assert.equal(client.createAccount({ accountId: id }), account)
  assert.equal(client.pickAccount(id), account)
  assert.throws(() => client.pickAccount('missing'), /missing/)
  const messages = []
  client.on('message', (event) => messages.push(event))
  for (const type of ['message.private', 'message.group', 'message.stranger']) {
    fake.emitMessage(account, { type, threadId: id, senderUid: id, serverMessageId: id, text: 'fixture' })
  }
  assert.equal(messages.length, 3)
  assert.ok(messages.every((event) => event.account === account && event.threadId === id && event.serverMessageId === id))
  let error
  client.on('system.handler.error', (event) => { error = event.error })
  fake.emitSystem(account, 'system.handler.error', { event: 'message', error: new Error('fixture') })
  assert.equal(error.message, 'fixture')
  fake.queueSendResponse({ statusCode: 0, statusMsg: '', serverMessageId: id })
  assert.equal((await account.pickFriend(id).sendMsg('offline fixture')).serverMessageId, id)
  fake.queueSendResponse({ statusCode: 0, statusMsg: '' }) // no server ID is not delivery confirmation
  assert.equal((await account.pickGroup(id).sendMsg('offline fixture')).serverMessageId, undefined)
  fake.queueSendResponse(new Error('fixture failure'))
  await assert.rejects(account.pickGroup(id).sendMsg('offline fixture'), /fixture failure/)
  let offline = 0
  account.on('system.offline', () => offline++)
  await client.logout() // upstream exposes logout, not close
  client.removeAllListeners()
  assert.equal(offline, 1)
  assert.equal(client.pickAccount(id), account) // logout does not remove registered accounts
  assert.equal(client.listenerCount('message'), 0)
  assert.equal(fake.calls.logins, 0)
})
