import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { defineTool, str } from '../../tools/tools.js'
import { localDate, parseSchedule, resolveTimeZone, scheduleLine } from './schedule.js'

const SYSTEM = '你是虚拟人生的日程生成器。只返回 JSON，不要 Markdown。结构为 {"theme":"主题","mood":"心情","timeline":[{"start":"00:00","end":"08:00","activity":"活动","location":"地点","state":"状态","availability":"normal"}]}。timeline 必须连续覆盖 00:00 至 24:00，使用 HH:MM，最后结束时间为 24:00；按人格设定生成真实、日常、不过度戏剧化的一天。'

function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { byDate: {}, requirements: {} } }
}

export default {
  id: 'virtual-life',
  name: '虚拟人生',
  version: '0.1.0',
  api: 1,
  description: '将 AstrBot Virtual Life 核心能力移植为 Aurabot 原生模块：每日生活日程、状态注入与查询。',
  defaults: { enabled: true, generateAt: '07:00', timeZone: 'Asia/Shanghai' },
  settings: [
    { key: 'enabled', label: '启用虚拟人生', type: 'switch' },
    { key: 'generateAt', label: '每日生成时间', type: 'text', hint: '本地时间 HH:MM' },
    { key: 'timeZone', label: '时区', type: 'text', hint: '例如 Asia/Shanghai' },
  ],
  setup(api) {
    const file = api.dataDir('state.json')
    mkdirSync(api.dataDir(), { recursive: true })
    const state = read(file)
    state.byDate ||= {}
    state.requirements ||= {}
    let running = Promise.resolve()
    let lastAttemptAt = 0
    const save = () => writeFileSync(file, JSON.stringify(state, null, 2))
    const dateNow = () => localDate(new Date(), resolveTimeZone(api.settings().timeZone))
    const scheduleFor = (date) => state.byDate[date] || null

    async function generate(date = dateNow(), requirement = '') {
      if (!api.settings().enabled) return { ok: false, message: '虚拟人生模块已关闭' }
      lastAttemptAt = Date.now()
      const persona = String(api.core.personas?.current?.() || '').slice(0, 6000)
      const previous = state.byDate[date]
      const text = await api.ask({ system: SYSTEM, text: `日期：${date}\n人格设定：${persona || '自然、亲切的虚拟伙伴'}\n管理员要求：${requirement || state.requirements[date] || '无'}\n${previous ? '请生成一份有变化但保持生活连续性的日程。' : ''}`, maxTokens: 1800 })
      const parsed = parseSchedule(text)
      state.byDate[date] = { ...parsed, date, generatedAt: Date.now() }
      delete state.requirements[date]
      state.byDate = Object.fromEntries(Object.entries(state.byDate).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14))
      save()
      return { ok: true, schedule: state.byDate[date] }
    }
    const enqueue = (fn) => { running = running.then(fn).catch((error) => api.log.error(`虚拟人生：${error.message}`)); return running }

    api.context(({ chat }) => chat.kind === 'system' ? '' : scheduleLine(scheduleFor(dateNow()), resolveTimeZone(api.settings().timeZone)))
    api.later(1_000, () => {
      const date = dateNow()
      if (api.settings().enabled && !state.byDate[date]) enqueue(() => generate(date))
    })
    api.every(60_000, () => {
      if (!api.settings().enabled) return
      const now = new Intl.DateTimeFormat('en-GB', { timeZone: resolveTimeZone(api.settings().timeZone), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
      const date = dateNow()
      const generateAt = String(api.settings().generateAt || '07:00')
      if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(generateAt) && now === generateAt && !state.byDate[date] && Date.now() - lastAttemptAt >= 15 * 60_000) enqueue(() => generate(date))
    }, '虚拟人生日程')

    api.command({
      name: '虚拟人生',
      aliases: ['v-life'],
      desc: '查看或管理虚拟人生日程：查看 / 生成 [要求] / 要求 <日期> <内容>',
      run: async (arg, msg) => {
        const [action = '查看', first, ...rest] = String(arg || '').trim().split(/\s+/)
        if (action === '查看') {
          const schedule = scheduleFor(dateNow())
          return schedule ? `${scheduleLine(schedule, resolveTimeZone(api.settings().timeZone))}\n${schedule.timeline.map((x) => `${x.start}-${x.end} ${x.activity}（${x.location}）`).join('\n')}` : '今天还没有日程。主人可发 /虚拟人生 生成'
        }
        if (!api.isOwner(msg.userId)) return '这个操作只给主人用'
        if (action === '生成') {
          try { const r = await generate(dateNow(), [first, ...rest].filter(Boolean).join(' ')); return r.ok ? `今天的虚拟日程已更新：${r.schedule.theme || '日常'}` : r.message } catch (error) { return `生成失败：${error.message}` }
        }
        if (action === '要求') {
          const date = first
          const text = rest.join(' ').slice(0, 500)
          const dateValue = new Date(`${date}T00:00:00Z`)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date || date <= dateNow() || !text) return '用法：/虚拟人生 要求未来日期 YYYY-MM-DD 要求内容'
          state.requirements[date] = text
          save()
          return `已保存 ${date} 的日程要求。`
        }
        return '用法：/虚拟人生 查看|生成 [要求]|要求 YYYY-MM-DD 内容'
      },
    })

    api.tool(({ chat }) => chat.kind === 'system' ? [] : defineTool({
      name: 'get_virtual_daily_schedule',
      description: '查询当前虚拟人生的今日日程与活动状态。',
      properties: { date: str('日期 YYYY-MM-DD，可选，默认今天') },
      execute: async ({ date }) => {
        const schedule = scheduleFor(String(date || dateNow()))
        return schedule ? { ok: true, message: `${scheduleLine(schedule, resolveTimeZone(api.settings().timeZone))}\n${schedule.timeline.map((x) => `${x.start}-${x.end} ${x.activity}（${x.location}）`).join('\n')}` } : { ok: true, message: '该日期还没有已生成的虚拟日程。' }
      },
    }))

    api.route('/virtual-life/status', async () => ({ ok: true, schedule: scheduleFor(dateNow()), dates: Object.keys(state.byDate) }))
    return { generate, scheduleFor, state }
  },
}
