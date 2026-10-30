import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEgoBrowser, runEgoScript, findConfirmation } from '../src/douyin/ego-browser.js'
import { createBrowser } from '../src/douyin/browser.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { writeFile } from 'node:fs/promises'
import { createSite } from '../src/douyin/site.js'
import { createDouyin } from '../src/douyin/duty.js'
import { normalize } from '../src/core/config.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Execute each complete CLI round in a fresh scope; only TaskSpace/Page survive.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
function fixture() {
  const calls = [], rounds = [], spaces = []
  const page = {
    openedBy: 'agent', label: 'p1',
    evaluate: async e => { calls.push(['evaluate', e]); return e === 'location.href' ? 'https://www.douyin.com/' : 42 },
    goto: async url => calls.push(['goto', url]),
    keyboard: { insertText: async t => calls.push(['type', t]), press: async k => calls.push(['key', k]) },
    mouse: { click: async (x, y) => calls.push(['click', x, y]) },
    click: async s => calls.push(['press', s]),
    cdp: async (m, p) => { calls.push([m, p]); return {} },
    events: async () => [],
    screenshot: async ({ path }) => { await writeFile(path, Buffer.from([137,80,78,71,13,10,26,10,0])); return '/untrusted/returned/path.png' },
  }
  const task = { spaceId: 17, ownership: 'agent', page: label => { assert.equal(label, 'p1'); return page }, tabs: async () => [{ label: 'p1', openedBy: 'agent' }], handOff: async () => { calls.push(['handOff']); task.ownership = 'user' }, finish: async o => calls.push(['finish', o]) }
  const runner = async (script, options) => {
    rounds.push({ script, options })
    let output = ''
    await new AsyncFunction('taskSpace', 'console', script)(async id => { spaces.push(id); return task }, { log: s => { output += String(s) + '\n' } })
    return output
  }
  return { calls, rounds, spaces, page, task, runner }
}

test('ego lazy state, persistent own space/p1, fresh rounds and keyboard mapping', async () => {
  const f = fixture(), b = createEgoBrowser({ runner: f.runner, spaceName: 'test-douyin' })
  assert.equal(b.connected(), false)
  assert.equal(f.rounds.length, 0)
  await b.close()
  assert.equal(f.rounds.length, 0, 'dispose before open never launches a CLI round')
  assert.deepEqual(await b.open(), { ok: true })
  assert.equal(await b.evaluate('6*7'), 42)
  await b.type('你好'); await b.clearFocused(); await b.pressEnter()
  assert.deepEqual(f.calls.filter(c => ['type', 'key'].includes(c[0])), [['type', '你好'], ['key', 'ControlOrMeta+A'], ['key', 'Backspace'], ['key', 'Enter']])
  assert.deepEqual(f.spaces, ['test-douyin', 17, 17, 17, 17])
  assert.ok(f.rounds.every(r => !r.script.includes('targetId')))
  assert.equal(b.connected(), true)
})

test('production browser factory defaults to ego with injected runner, never silently launches legacy Chrome', async () => {
  const f = fixture(), b = createBrowser({ runner: f.runner, spaceName: 'production-wiring' })
  assert.deepEqual(await b.open(), { ok: true })
  assert.equal(f.spaces[0], 'production-wiring')
  assert.equal(await b.evaluate('6*7'), 42)
})

test('ego waitFor/goto/screenshot preserve contracts; handoff pauses without claiming user spaces', async () => {
  const f = fixture(), b = createEgoBrowser({ runner: f.runner })
  await b.open(); await b.goto('https://www.douyin.com/')
  f.page.evaluate = async () => ({ x: 10, y: 20, state: 'digged', text: 'like' })
  assert.equal((await b.waitFor('button', 5)).state, 'digged')
  assert.match(await b.screenshot(), /^data:image\/png;base64,iVBORw0KGgo/)
  await b.show(true)
  const rounds = f.rounds.length
  assert.equal((await b.open()).code, 'EGO_USER_CONTROL')
  await assert.rejects(b.show(false), { code: 'EGO_USER_CONTROL' })
  assert.equal(f.rounds.length, rounds)
  assert.equal(f.calls.filter(c => c[0] === 'handOff').length, 1)
  const other = fixture(); other.task.ownership = 'user'
  const stopped = createEgoBrowser({ runner: other.runner })
  assert.equal((await stopped.open()).code, 'EGO_USER_CONTROL')
  assert.equal((await stopped.open()).code, 'EGO_USER_CONTROL')
  assert.equal(other.spaces.length, 1)
})

test('runner timeout/page error is redacted; late effects block unsafe retry, explicit goto recovers same space', async () => {
  const f = fixture(), b = createEgoBrowser({ runner: f.runner })
  await b.open()
  f.page.evaluate = async () => { throw Object.assign(new Error('cookie=TOP_SECRET'), { mayHaveLateEffects: true }) }
  await assert.rejects(b.evaluate('unsafe()'), e => e.code === 'EGO_PAGE_ERROR' && !e.message.includes('SECRET'))
  const rounds = f.rounds.length
  await assert.rejects(b.pressEnter(), { code: 'EGO_LATE_EFFECTS' })
  assert.equal(f.rounds.length, rounds)
  await b.goto('https://www.douyin.com/')
  await b.pressEnter()
  assert.ok(f.spaces.slice(1).every(id => id === 17))
  const timeout = createEgoBrowser({ runner: async () => new Promise(() => {}), timeoutMs: 5 })
  await assert.rejects(timeout.evaluate('unsafe()'), e => e.code === 'EGO_TIMEOUT' && e.executionStopped === false && e.mayHaveLateEffects)
  await assert.rejects(timeout.pressEnter(), { code: 'EGO_LATE_EFFECTS' })
  await assert.rejects(timeout.goto('https://www.douyin.com/'), { code: 'EGO_LATE_EFFECTS' })
})

test('CLI runner uses fixed spawn argv/stdin with no shell, bounds input/output and redacts errors', async () => {
  let killed = 0, seen
  const fakeSpawn = (...args) => {
    seen = args
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed++ }
    child.stdin.on('data', script => { assert.equal(script.toString(), 'complete script') })
    child.stdin.on('finish', () => { child.stdout.end('unrelated output\n'); child.stderr.end('private diagnostic discarded\nAURABOT_EGO:{"ok":true}\n\n'); child.emit('close', 0) })
    return child
  }
  assert.equal(await runEgoScript('complete script', { spawnImpl: fakeSpawn }), 'AURABOT_EGO:{"ok":true}\n')
  assert.equal(seen[0], 'ego-browser'); assert.deepEqual(seen[1], ['nodejs']); assert.equal(seen[2].shell, false)
  await assert.rejects(runEgoScript('x'.repeat(129 * 1024), { spawnImpl: () => assert.fail('oversize spawn') }), { code: 'EGO_INPUT_LIMIT' })
  await assert.rejects(runEgoScript('complete script', { timeoutMs: 5, spawnImpl: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed++ }; return child
  } }), { code: 'EGO_TIMEOUT' })
  assert.equal(killed, 1)
  for (const [stdout, stderr] of [['AURABOT_EGO:{"ok":true}\n', 'AURABOT_EGO:{"ok":true}\n'], ['', 'AURABOT_EGO:{"ok":'], ['', 'secret diagnostic only']]) {
    await assert.rejects(runEgoScript('complete script', { spawnImpl: () => {
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}
      child.stdin.on('finish', () => { child.stdout.end(stdout); child.stderr.end(stderr); child.emit('close', 0) }); return child
    } }), { code: 'EGO_PROTOCOL_ERROR' })
  }
  await assert.rejects(runEgoScript('complete script', { spawnImpl: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}
    child.stdin.on('finish', () => child.stderr.end('secret'.repeat(2 * 1024 * 1024)))
    return child
  } }), { code: 'EGO_OUTPUT_LIMIT' })
})

test('site likes/comments/DM use the atomic seam and never retry an uncertain send', async () => {
  const writes = [], id = '7000000000000000001'
  let typed = '', uncertain = false, messages = [], rawResponse
  const browser = {
    evaluate: async expression => {
      if (expression.includes('user/profile/self')) return { status: 200, text: JSON.stringify({ user: { uid: '9007199254740993001', sec_uid: 'MS4wSELF' } }) }
      if (expression.includes('const want = "MS4wOWNER"')) return { found: true, done: false }
      if (expression.includes('const out = [], seen')) return messages.slice()
      if (expression.includes('captcha_container')) return ''
      if (expression.includes('return e ? e.innerText')) return typed
      if (expression.includes('.innerText ||')) return ''
      return true
    },
    goto: async () => {}, waitFor: async () => ({ state: 'no-digged' }),
    press: async () => true, clearFocused: async () => { typed = '' }, type: async t => { typed += t },
    pressEnter: async () => assert.fail('cross-round send'),
    waitResponse: () => assert.fail('cross-round response Promise'),
    runAction: async options => {
      writes.push(options)
      if (!uncertain && options.action.type === 'enter') messages.push({ id: String(9000 + writes.length), uid: '9007199254740993001', conversationId: '0:1:9007199254740993001:4182', mine: true, text: typed, at: Date.now() })
      return rawResponse || (uncertain ? { status: 'uncertain' } : { status: 'observed', response: { status: 200, json: { status_code: 0, comment: { cid: '9007199254740993999' } } } })
    },
  }
  const site = createSite({ browser, log: {}, wait: async () => {} })
  await site.self(); await site.dms('4182')
  assert.equal((await site.like(id)).ok, true)
  assert.equal((await site.comment(id, 'comment')).cid, '9007199254740993999')
  assert.equal((await site.sendDm('hello')).ok, true)
  assert.deepEqual(writes.map(w => w.action.type), ['press', 'press', 'enter'])
  assert.match(writes[0].urlRe.source, /digg/); assert.match(writes[1].urlRe.source, /publish/); assert.match(writes[2].urlRe.source, /message/)
  uncertain = true
  await assert.rejects(site.sendDm('hello'), { code: 'dm_uncertain' })
  assert.equal(writes.length, 4, 'no second Enter/button attempt after unknown delivery')
  await assert.rejects(site.like(id), { code: 'dm_uncertain' })
  assert.equal(writes.length, 5)
  for (const receipt of [{ status: 'uncertain' }, { status: 'observed', response: { status: 200, json: null } }, { status: 'observed', response: { status: 200, json: null, binary: true } }]) {
    rawResponse = receipt
    const before = writes.length
    await assert.rejects(site.sendDm('hello'), { code: 'dm_uncertain' })
    await assert.rejects(site.share(id, { secUid: 'MS4wOWNER', uid: '4182' }), { code: 'dm_uncertain' })
    assert.equal(writes.length, before + 2, 'one dispatch each for no response, empty 200 and binary 200')
  }
})

test('application confirmation requires exact account/peer, new server ID and post-start self message', () => {
  const expected = { accountId: '9007199254740993001', targetUid: '4182', text: 'hello' }
  const m = { id: '9007199254740993999', conversationId: '0:1:4182:9007199254740993001', uid: expected.accountId, mine: true, text: 'hello', at: 100 }
  assert.equal(findConfirmation([], [m], expected, 99), m.id)
  for (const patch of [{ id: '' }, { id: 'local-id' }, { uid: '4182' }, { mine: false }, { conversationId: '0:1:4183:9007199254740993001' }, { at: 98 }, { text: 'hell' }]) assert.equal(findConfirmation([], [{ ...m, ...patch }], expected, 99), '')
  assert.equal(findConfirmation([m], [m], expected, 99), '')
  assert.equal(findConfirmation([], [m], { ...expected, accountId: '' }, 99), '')
  assert.equal(findConfirmation([], [{ ...m, card: { awemeId: '7000000000000000001' } }], { ...expected, awemeId: '7000000000000000001' }, 99), m.id)
})

test('duty caches string webpage UID on ready/login; SDK matching is fail-closed and cached state is read-only', async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-t4-uid-'))
  const uid = '9007199254740993001'
  let me = { uid, secUid: 'MS4wSELF', nickname: 'self' }, sdk = { status: 'online', accountId: uid }, opens = 0, likes = 0
  const cfg = normalize({ douyin: { enabled: true, im: { enabled: true }, gate: { minWriteGapSec: 0, newAccountDays: 0 } } })
  const site = { ensure: async () => { opens++; return { ok: true } }, self: async () => me, verify: async () => '', connected: () => false, detail: async () => ({}), like: async () => { likes++; return { ok: true } }, loginPoll: async () => ({ ok: true, loggedIn: true, me }), show: async () => {} }
  const dy = createDouyin({ getConfig: () => cfg, site, getImState: () => sdk, hub: {}, log: { info() {}, warn() {} } })
  assert.equal(dy.state().identity.ok, false); await dy.account(); assert.equal(opens, 0)
  await dy.account(true); assert.equal(dy.state().account.uid, uid); assert.equal(dy.state().identity.ok, true)
  sdk = { status: 'online', accountId: '4183' }
  assert.equal(dy.state().identity.code, 'UID_MISMATCH')
  assert.equal((await dy.likeVideo('7000000000000000001')).ok, false); assert.equal(likes, 0)
  sdk = { status: 'online', accountId: uid }; me = { secUid: 'MS4wSELF', imUid: uid }
  assert.equal((await dy.likeVideo('7000000000000000001')).code, 'UID_REQUIRED'); assert.equal(likes, 0)
  me = { uid, secUid: 'MS4wSELF', nickname: 'self' }; await dy.loginStep(false)
  assert.equal(dy.state().account.uid, uid)
  me = { uid: Number(uid), secUid: 'MS4wSELF' }; await dy.account(true)
  assert.equal(dy.state().account.uid, '', 'precision-losing numeric UID never becomes verified')
})

test('uncertain webpage share never falls back to QQ or auto-retries; explicit both is preselected', async () => {
  for (const shareTo of ['douyin', 'both']) {
    process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-t4-share-'))
    let shares = 0, qq = 0
    const owner = { input: 'owner', confirmedInput: 'owner', secUid: 'MS4wOWNER', uid: '4182' }
    const cfg = normalize({ dryRun: false, ownerQQ: '12345', douyin: { enabled: true, owner, shareTo, gate: { minWriteGapSec: 0, newAccountDays: 0 } } })
    const site = { ensure: async () => ({ ok: true }), self: async () => ({ secUid: 'MS4wSELF', uid: '111' }), verify: async () => '', detail: async () => ({ awemeId: '7000000000000000001', title: 'test' }), user: async () => owner, share: async () => { shares++; throw Object.assign(new Error('uncertain'), { code: 'dm_uncertain' }) }, connected: () => false }
    const dy = createDouyin({ getConfig: () => cfg, site, hub: { sendText: async () => { qq++; return { message_id: 1 } } }, log: { info() {}, warn() {} } })
    await dy.shareVideo('7000000000000000001'); await dy.shareVideo('7000000000000000001')
    assert.equal(shares, 1); assert.equal(qq, shareTo === 'both' ? 1 : 0)
  }
})

test('ego action listens/drains, clicks and verifies buffered CDP response in one fresh CLI round', async () => {
  const f = fixture(), b = createEgoBrowser({ runner: f.runner })
  let clicked = false
  f.page.click = async () => { clicked = true; f.calls.push(['dispatch']) }
  f.page.cdp = async method => { f.calls.push([method]); return method === 'Network.getResponseBody' ? { body: '{"status_code":0}', base64Encoded: false } : {} }
  f.page.events = async () => { f.calls.push(['events']); return clicked ? [{ method: 'Network.responseReceived', params: { requestId: 'own', response: { url: 'https://www.douyin.com/write', status: 200 } } }, { method: 'Network.loadingFinished', params: { requestId: 'own' } }] : [{ method: 'Network.loadingFinished', params: { requestId: 'stale' } }] }
  const r = await b.runAction({ urlRe: /\/write/, action: { type: 'press', selector: 'button' }, timeoutMs: 5 })
  assert.equal(r.status, 'observed'); assert.equal(r.response.json.status_code, 0)
  assert.deepEqual(f.calls.map(c => c[0]), ['Network.enable', 'events', 'evaluate', 'dispatch', 'events', 'Network.getResponseBody'])
  assert.equal(f.rounds.length, 1)
  clicked = false; f.page.events = async () => []
  assert.equal((await b.runAction({ urlRe: /write/, action: { type: 'enter' }, timeoutMs: 1 })).status, 'uncertain')
  await assert.rejects(b.pressEnter(), { code: 'EGO_LATE_EFFECTS' })
})
