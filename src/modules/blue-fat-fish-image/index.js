// Aurabot 原生移植：从上游蓝色大肥鱼图库随机取图，使用 Aurabot 的命令和图片发送接口。
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'ZHYSNAKE/plugin_only'
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i
const MAX_BYTES = 8 * 1024 * 1024

export function imagePaths(tree) {
  return (Array.isArray(tree?.tree) ? tree.tree : [])
    .filter((entry) => entry.type === 'blob' && IMAGE_EXT.test(entry.path || ''))
    .map((entry) => entry.path)
}

export default {
  id: 'blue-fat-fish-image',
  name: '蓝色大肥鱼图片',
  version: '1.0.0',
  api: 1,
  description: '发送 /来点蓝色大肥鱼，从图库随机发一张蓝色大肥鱼图片',
  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })

    async function fetchImage() {
      const treeResponse = await fetch(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Aurabot-blue-fat-fish-image' },
        signal: AbortSignal.timeout(20000),
      })
      if (!treeResponse.ok) throw new Error(`图库索引读取失败（HTTP ${treeResponse.status}）`)
      const paths = imagePaths(await treeResponse.json())
      if (!paths.length) throw new Error('图库里暂时没有图片')

      const cached = readdirSync(dir).filter((file) => IMAGE_EXT.test(file))
      const candidates = paths.filter((path) => !cached.includes(path.split('/').at(-1)))
      const path = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : paths[Math.floor(Math.random() * paths.length)]
      const url = `https://raw.githubusercontent.com/${REPO}/main/${path.split('/').map(encodeURIComponent).join('/')}`
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('图片为空或超过 8 MB')
      const file = path.split('/').at(-1).replace(/[^\w.-]/g, '_')
      writeFileSync(join(dir, file), bytes)
      return join(dir, file)
    }

    api.command({
      name: '来点蓝色大肥鱼',
      aliases: ['来点大肥鱼'],
      desc: '从蓝色大肥鱼图库随机发一张图片',
      run: async (_arg, msg) => {
        try {
          await api.sendImage(msg.chatId, await fetchImage())
          return ''
        } catch (error) {
          api.log.warn(`蓝色大肥鱼图库：${error.message}`)
          return '图库暂时没取到图片，等会儿再试试～'
        }
      },
    })
    return { fetchImage }
  },
}
