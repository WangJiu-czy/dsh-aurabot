import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { imagePaths } from '../src/modules/blue-fat-fish-image/index.js'

const response = (body, status = 200) => new Response(body, { status })

test('filters supported image paths from GitHub tree', () => {
  assert.deepEqual(imagePaths({ tree: [
    { type: 'blob', path: 'image/fish.gif' },
    { type: 'blob', path: 'README.md' },
    { type: 'tree', path: 'image/nested' },
    { type: 'blob', path: 'image/fish.svg' },
  ] }), ['image/fish.gif'])
})

test('command downloads a random upstream image and sends it through Aurabot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-blue-fish-'))
  const originalFetch = globalThis.fetch
  const sent = []
  const commands = []
  globalThis.fetch = async (url) => String(url).includes('/git/trees/')
    ? response(JSON.stringify({ tree: [{ type: 'blob', path: 'image/fish.png' }] }))
    : response(Buffer.from('image-fixture'))
  try {
    const api = {
      dataDir: () => root,
      command: (command) => commands.push(command),
      sendImage: async (...args) => sent.push(args),
      log: { warn: () => {} },
    }
    const exported = plugin.setup(api)
    const result = await commands[0].run('', { chatId: 'group:123' })
    assert.equal(result, '')
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'group:123')
    assert.equal(readFileSync(sent[0][1]).toString(), 'image-fixture')
    assert.equal(typeof exported.fetchImage, 'function')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})
