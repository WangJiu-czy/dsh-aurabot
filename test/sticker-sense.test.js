import assert from 'node:assert/strict'
import { test } from 'node:test'
import stickerSense, { classifyImage } from '../src/modules/sticker-sense/index.js'

function png(width, height) {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47], 0)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

test('Sticker Sense uses image dimensions and explicit protocol cues', () => {
  assert.equal(classifyImage({ data: png(320, 320) }, 1).kind, 'sticker')
  assert.equal(classifyImage({ data: png(1600, 1200) }, 1).kind, 'photo')
  assert.equal(classifyImage({ data: png(1600, 1200) }, 1, { explicitSticker: true }).kind, 'sticker')
})

test('prompt hook adds image guidance without changing image payload', () => {
  let hook
  const api = {
    on: (name, fn) => { assert.equal(name, 'prompt'); hook = fn },
    settings: () => ({ promptStyle: 'humorous' }),
  }
  stickerSense.setup(api)
  const image = { type: 'image', data: png(1600, 1200).toString('base64'), mediaType: 'image/png', isSticker: true }
  const result = hook([{ type: 'text', text: '[表情包]' }, image])
  assert.match(result.at(-1).text, /机智接梗/)
  assert.equal(result[1], image)
})
