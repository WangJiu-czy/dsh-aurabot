// AstrBot meme_manager 分类标记与公开联动调用的 Aurabot 原生移植。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mapMemeMarkers } from './meme-markers.js'
export default {
  id: 'astrbot-compat',
  name: 'AstrBot 联动接口',
  version: '0.1.0',
  api: 1,
  description: '兼容 meme_manager 的 &&分类&& 标记，并接入 Aurabot 表情库发送',
  setup(api) {
    const activeEvents = new WeakMap()
    const stickers = api.lazy('stickers')
    const mapText = (text) => mapMemeMarkers(text, (category) => {
      const item = stickers.match?.(category)
      return item ? `<sticker:${item.name || item.tags?.[0] || category}>` : null
    })
    const normalizeSegment = (part) => {
      if (typeof part === 'string') return { type: 'text', data: { text: part } }
      const kind = String(part?.type || '').toLowerCase()
      if (kind === 'plain') return { type: 'text', data: { text: String(part.text || '') } }
      if (kind === 'image' && !part.data) {
        const file = part.url || part.file || part.path
        return file ? { type: 'image', data: { file } } : part
      }
      return part
    }
    const segmentsOf = (message) => {
      if (typeof message === 'string') return [{ type: 'text', data: { text: message } }]
      if (Array.isArray(message)) return message.map(normalizeSegment)
      if (Array.isArray(message?.chain)) return message.chain.map(normalizeSegment)
      if (Array.isArray(message?.segments)) return message.segments.map(normalizeSegment)
      return []
    }
    const textOf = (message) => segmentsOf(message).filter((s) => s?.type === 'text').map((s) => s.data?.text || '').join('')
    const chain = (items) => ({ chain: items })
    const targetOf = (event) => activeEvents.get(event) || event || {}
    const chatOf = (event) => {
      const target = targetOf(event)
      return String(target.chatId || (target.group_id ? `group:${target.group_id}` : `private:${target.user_id || ''}`))
    }
    const registryPath = api.dataDir('installed-packs.json')
    const readRegistry = () => {
      try { return JSON.parse(readFileSync(registryPath, 'utf8')) } catch { return {} }
    }
    const boundedFetch = async (url, maxBytes) => {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Aurabot-meme-pack-adapter', accept: 'application/vnd.github+json' } })
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('下载响应没有内容')
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > maxBytes) { await reader.cancel(); throw new Error('下载内容超过大小限制') }
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks, size)
    }
    async function installPack(source, expectedPackId) {
      if (!source || source.type !== 'github' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(source.repo || ''))) throw new TypeError('source 需为 GitHub owner/repo')
      const [owner, repo] = source.repo.split('/')
      const ref = String(source.ref || '').trim()
      if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref) || ref.split('/').includes('..')) throw new TypeError('GitHub ref 格式无效')
      const subpath = String(source.subpath || '').trim()
      const base = subpath === '.' ? '' : subpath.replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '')
      if (base && base.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new TypeError('subpath 格式无效')
      const apiRoot = `https://api.github.com/repos/${owner}/${repo}`
      const treeBytes = await boundedFetch(`${apiRoot}/git/trees/${encodeURIComponent(ref)}?recursive=1`, 8 * 1024 * 1024)
      const tree = JSON.parse(treeBytes.toString('utf8'))
      if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub 文件树不完整或格式错误')
      const prefix = base ? `${base}/` : ''
      const manifestPath = `${prefix}manifest.json`
      const manifestUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${manifestPath.split('/').map(encodeURIComponent).join('/')}`
      const manifest = JSON.parse((await boundedFetch(manifestUrl, 256 * 1024)).toString('utf8'))
      const packId = String(manifest.id || '')
      const categories = manifest.categories
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(packId) || packId.endsWith('.') || !manifest.name || !manifest.version || !categories || typeof categories !== 'object' || Array.isArray(categories) || !Object.keys(categories).length) throw new Error('manifest.json 不符合表情包格式')
      if (expectedPackId && packId !== expectedPackId) throw new Error(`图包 ID 不匹配：${packId}`)
      const installed = readRegistry()
      if (installed[packId]) throw new Error(`图包 ${packId} 已安装`)
      const categoryNames = Object.keys(categories)
      if (categoryNames.length > 100 || categoryNames.some((name) => !name || name.length > 64 || name === '.' || name === '..' || /[\\/\\x00-\\x1f]/.test(name))) throw new Error('图包包含非法分类名')
      const imagePrefix = `${prefix}memes/`
      const allowedExt = /\.(?:png|jpe?g|gif|webp)$/i
      const files = tree.tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith(imagePrefix) && allowedExt.test(entry.path))
        .map((entry) => ({ ...entry, relative: entry.path.slice(imagePrefix.length).split('/') }))
        .filter((entry) => entry.relative.length === 2 && categoryNames.includes(entry.relative[0]))
      if (!files.length) throw new Error('图包 memes/<分类>/ 下没有可导入图片')
      if (files.length > 30) throw new Error('图包图片超过 30 张上限')
      let totalBytes = 0
      const ready = []
      for (const file of files) {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${file.path.split('/').map(encodeURIComponent).join('/')}`
        const bytes = await boundedFetch(rawUrl, 5 * 1024 * 1024)
        totalBytes += bytes.length
        if (totalBytes > 25 * 1024 * 1024) throw new Error('图包图片总大小超过 25 MB')
        ready.push({ category: file.relative[0], bytes })
      }
      const imported = []
      try {
        for (const image of ready) {
          const result = await stickers.addFromBuffer?.(image.bytes, { name: image.category, tags: [image.category], from: 'pack', toQQ: false })
          if (!result?.ok) throw new Error(result?.reason || '导入图包图片失败')
          if (!result.existed) imported.push(result.item.md5)
        }
        installed[packId] = { name: String(manifest.name), version: String(manifest.version), imported: ready.length, at: Date.now() }
        mkdirSync(api.dataDir(), { recursive: true })
        writeFileSync(registryPath, JSON.stringify(installed, null, 2))
      } catch (error) {
        for (const md5 of imported) await stickers.remove?.(md5)
        throw error
      }
      return { ok: true, id: packId, name: manifest.name, imported: ready.length }
    }
    api.rule(() => {
      const categories = [...new Set((stickers.library?.()?.items || []).flatMap((item) => item.tags || []))].filter(Boolean).slice(0, 80)
      return categories.length
        ? `- 可用表情分类：${categories.join('、')}。合适时在回复文字中写 &&分类名&& 发送一张对应表情；分类名必须从列表中选，没合适的表情就别加标记。`
        : ''
    })
    api.command({
      name: 'meme-pack',
      aliases: ['表情包导入'],
      desc: '导入 AstrBot meme_manager 格式的 GitHub 图包：/meme-pack owner/repo [ref] [subpath] [pack-id]',
      run: async (arg) => {
        const [repo, ref = 'main', subpath = '.', expectedPackId, ...extra] = String(arg || '').trim().split(/\s+/)
        if (!repo || extra.length) return '用法：/meme-pack owner/repo [ref] [subpath] [pack-id]'
        const result = await installPack({ type: 'github', repo, ref, subpath }, expectedPackId)
        return `已导入图包「${result.name}」，${result.imported} 张图片已加入表情库。回复可使用 &&分类&& 标记。`
      },
    })
    const plugin = {
      async compat_prepare_message(event, message) {
        const parts = segmentsOf(message).map((part) => part?.type === 'text'
          ? { ...part, data: { ...part.data, text: mapText(part.data?.text) } }
          : part)
        return { cleaned_chain: chain(parts), _aurabot: { chatId: chatOf(event), images: [] } }
      },
      async compat_send_prepared_message(event, prepared, { send_text = true, send_images = true } = {}) {
        if (!prepared?._aurabot || prepared._aurabot.chatId !== chatOf(event)) throw new TypeError('prepared 结果与当前会话不匹配')
        const chatId = prepared._aurabot.chatId
        if (send_text) {
          const body = textOf(prepared.cleaned_chain)
          if (body) await api.send(chatId, body)
        }
        if (send_images) for (const image of prepared._aurabot.images) await api.sendImage(chatId, image)
      },
      async compat_send_message(event, message, { send_images = true } = {}) {
        const prepared = await this.compat_prepare_message(event, message)
        await this.compat_send_prepared_message(event, prepared, { send_text: true, send_images })
        return prepared
      },
      async get_pack_status(packId) {
        const packs = readRegistry()
        if (packId) return packs[String(packId)] ? 'ready' : 'missing'
        return Object.keys(packs).length || stickers.library?.()?.items?.length ? 'ready' : 'missing'
      },
      async install_pack(source, expectedPackId) { return installPack(source, expectedPackId) },
    }
    api.on('reply', (text) => {
      const mapped = mapText(text)
      return mapped === text ? undefined : mapped
    })

    const context = {
      get_registered_star(name) { return name === 'meme_manager' ? { star_cls: plugin } : null },
      event(message) {
        const event = {
          message_str: String(message?.text || ''),
          get_sender_id: () => String(message?.userId || ''),
          get_group_id: () => String(message?.groupId || ''),
          get_message_type: () => message?.kind || 'private',
          send: async (value) => {
            const parts = segmentsOf(value)
            if (parts.every((part) => part?.type === 'text')) return api.send(message.chatId, mapText(textOf(value)))
            return api.sendSegments(message.chatId, parts, '[AstrBot 兼容接口]')
          },
        }
        activeEvents.set(event, message)
        return event
      },
    }
    api.onDispose(() => activeEvents.clear())
    return { context, plugin, event: context.event }
  },
}
