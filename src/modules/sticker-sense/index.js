// Native Aurabot adaptation of astrbot_plugin_sticker_sense (MIT, upstream aa6245fc in ../../vendor).
import { imageSize, mimeOf } from '../../chat/inbound.js'

function bytesOf(image) {
  const value = image?.data
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') {
    const encoded = value.replace(/^data:image\/[^;]+;base64,/i, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return Buffer.alloc(0)
    return Buffer.from(encoded, 'base64')
  }
  return Buffer.alloc(0)
}

function gifFrames(buf) {
  if (buf.length < 13 || !buf.subarray(0, 3).equals(Buffer.from('GIF'))) return 0
  let i = 13
  const packed = buf[10]
  if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1))
  let frames = 0
  const skipBlocks = () => {
    while (i < buf.length) {
      const size = buf[i++]
      if (!size) return true
      i += size
    }
    return false
  }
  while (i < buf.length) {
    const marker = buf[i++]
    if (marker === 0x3b) break
    if (marker === 0x21) { i++; if (!skipBlocks()) break }
    else if (marker === 0x2c) {
      if (i + 9 > buf.length) break
      const localPacked = buf[i + 8]
      i += 9
      if (localPacked & 0x80) i += 3 * (1 << ((localPacked & 7) + 1))
      if (i >= buf.length) break
      i++ // LZW minimum code size
      if (!skipBlocks()) break
      frames++
    } else break
  }
  return frames
}

function animated(buf, mime) {
  if (mime === 'image/gif') return gifFrames(buf) > 1
  if (mime !== 'image/webp' || buf.length < 16) return false
  for (let i = 12; i + 4 <= buf.length;) {
    const kind = buf.toString('ascii', i, i + 4)
    if (kind === 'ANIM' || kind === 'ANMF') return true
    if (i + 8 > buf.length) break
    const size = buf.readUInt32LE(i + 4)
    i += 8 + size + (size & 1)
  }
  return false
}

export function classifyImage(image, index, { explicitSticker = false, maxDimension = 640 } = {}) {
  const buf = bytesOf(image)
  const mime = mimeOf(buf)
  const { width, height } = imageSize(buf)
  const isAnimated = animated(buf, mime)
  const maxEdge = Math.max(width, height)
  const aspect = maxEdge ? Math.min(width, height) / maxEdge : 0
  const heuristicSticker = isAnimated || (maxEdge > 0 && maxEdge <= maxDimension && aspect >= 0.4 && buf.length <= 2.5 * 1024 * 1024)
  return {
    index,
    kind: explicitSticker || heuristicSticker ? 'sticker' : 'photo',
    explicitSticker,
    isAnimated,
    width,
    height,
  }
}

const GUIDES = {
  natural: '结合语境，把表情包当作情绪、打趣或社交回应，自然接话；除非对方问图意，不逐项描述画面。',
  humorous: '把表情包当作斗图或幽默互动，机智接梗，保持大肥鱼原有人设，不要机械描述画面。',
  gentle: '留意表情包表达的情绪，温柔体察并自然回应，避免生硬看图说话。',
  roast: '可以轻松互怼或吐槽接梗，但保持大肥鱼人设与分寸，不把玩笑升级成人身攻击。',
}

export default {
  id: 'sticker-sense',
  name: '表情感知',
  version: '1.0.0',
  description: '移植 Sticker Sense：区分表情包与普通图片，为图片互动补充临时语境。',
  setup(api) {
    const style = () => GUIDES[api.settings().promptStyle] || GUIDES.natural
    api.on('prompt', (content) => {
      const images = content.filter((part) => part?.type === 'image').slice(0, 4)
      if (!images.length) return
      const results = images.map((image, index) => classifyImage(image, index + 1, {
        explicitSticker: image.isSticker === true,
        maxDimension: Number(api.settings().maxDimension) || 640,
      }))
      const stickerCount = results.filter((r) => r.kind === 'sticker').length
      const photoCount = results.length - stickerCount
      const lines = ['【图片与表情互动提示】']
      if (stickerCount) {
        lines.push(`识别到 ${stickerCount} 张表情包或梗图${results.some((r) => r.isAnimated) ? '（动图应按连贯动作理解，不要当成九宫格）' : ''}。${style()}`)
      }
      if (photoCount) lines.push(`识别到 ${photoCount} 张普通图片，按对方分享、求助或展示内容来理解并正常回应。`)
      if (!content.some((part) => part?.type === 'text' && String(part.text || '').trim())) lines.push('对方这条没有文字，结合图片内容自然回应。')
      return [...content, { type: 'text', text: lines.join('\n') }]
    })
    return { classifyImage }
  },
}
