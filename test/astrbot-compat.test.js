import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import compat from '../src/modules/astrbot-compat/index.js'
import { mapMemeMarkers } from '../src/modules/astrbot-compat/meme-markers.js'

const fixture = (path, body, status = 200) => new Response(body, { status, headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'image/png' } })

test('meme_manager marker mapping leaves code and escaped markers unchanged', () => {
  const resolve = (key) => key === 'happy' ? '<sticker:开心>' : null
  assert.equal(mapMemeMarkers('hi &&happy&&', resolve), 'hi <sticker:开心>')
  assert.equal(mapMemeMarkers('`&&happy&&`', resolve), '`&&happy&&`')
  assert.equal(mapMemeMarkers('```txt\n&&happy&&\n```', resolve), '```txt\n&&happy&&\n```')
  assert.equal(mapMemeMarkers('\\&&happy&&', resolve), '\\&&happy&&')
  assert.equal(mapMemeMarkers('&&missing&&', resolve), '&&missing&&')
})

test('compat module imports a GitHub resource pack locally and maps the original category token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-meme-'))
  const originalFetch = globalThis.fetch
  const added = []
  const sent = []
  const listeners = new Map()
  const manifest = { id: 'demo-pack', name: 'Demo', version: '1.0.0', categories: { happy: { description: '开心' } } }
  const tree = { truncated: false, tree: [
    { type: 'blob', path: 'manifest.json' },
    { type: 'blob', path: 'memes/happy/a.png' },
  ] }
  globalThis.fetch = async (url) => {
    const value = String(url)
    if (value.includes('/git/trees/')) return fixture(value, JSON.stringify(tree))
    if (value.endsWith('/manifest.json')) return fixture(value, JSON.stringify(manifest))
    if (value.endsWith('/a.png')) return fixture(value, Buffer.from([137, 80, 78, 71]))
    throw new Error(`unexpected fetch: ${value}`)
  }
  try {
    const stickers = {
      match: (query) => query === 'happy' ? { name: '开心', tags: ['happy'] } : null,
      library: () => ({ items: added }),
      addFromBuffer: async (bytes, opts) => {
        added.push({ md5: 'a'.repeat(32), bytes, ...opts })
        return { ok: true, existed: false, item: { md5: 'a'.repeat(32) } }
      },
      remove: async () => ({ ok: true }),
    }
    const api = {
      lazy: () => stickers,
      dataDir: (...parts) => join(root, ...parts),
      on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
      onDispose: () => {},
      send: async (_chatId, text) => sent.push(text),
      sendImage: async () => {},
      sendSegments: async () => {},
    }
    const result = compat.setup(api)
    const installed = await result.plugin.install_pack({ type: 'github', repo: 'owner/repo', ref: 'main', subpath: '.' }, 'demo-pack')
    assert.equal(installed.ok, true)
    assert.equal(installed.imported, 1)
    assert.equal((await result.plugin.get_pack_status('demo-pack')), 'ready')
    assert.equal(added[0].tags[0], 'happy')
    assert.equal(added[0].toQQ, false)

    const reply = listeners.get('reply')('你好 &&happy&&', { chatId: 'private:1' })
    assert.equal(reply, '你好 <sticker:开心>')
    const event = result.event({ kind: 'private', chatId: 'private:1', userId: '1', text: '' })
    await result.plugin.compat_send_message(event, '来自 &&happy&&')
    assert.deepEqual(sent, ['来自 <sticker:开心>'])
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})
