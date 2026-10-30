export function resolveTimeZone(timeZone) {
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); return timeZone } catch { return 'Asia/Shanghai' }
}

export function localDate(now = new Date(), timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: resolveTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function parseSchedule(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  const data = JSON.parse(text)
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.timeline)) throw new TypeError('模型输出必须包含 timeline 数组')
  let previousEnd = '00:00'
  const timeline = data.timeline.map((item, i) => {
    if (!item || typeof item !== 'object') throw new TypeError(`第 ${i + 1} 项格式无效`)
    const start = String(item.start || ''), end = String(item.end || '')
    const validStart = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start)
    const validEnd = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(end)
    if (!validStart || !validEnd || start >= end || start !== previousEnd) throw new TypeError(`第 ${i + 1} 项时间不连续或格式无效`)
    if (![item.activity, item.location, item.state].every((v) => typeof v === 'string')) throw new TypeError(`第 ${i + 1} 项缺少活动、地点或状态`)
    previousEnd = end
    return { start, end, activity: item.activity.slice(0, 160), location: item.location.slice(0, 100), state: item.state.slice(0, 100), availability: String(item.availability || 'normal') }
  })
  if (previousEnd !== '24:00' || !timeline.length) throw new TypeError('timeline 必须从 00:00 连续覆盖至 24:00')
  return { theme: String(data.theme || '').slice(0, 80), mood: String(data.mood || '').slice(0, 80), timeline }
}

export function currentItem(schedule, time = new Date().toTimeString().slice(0, 5)) {
  return schedule?.timeline?.find((item) => item.start <= time && time < item.end) || null
}

export function scheduleLine(schedule, timeZone, now = new Date()) {
  if (!schedule) return ''
  const item = currentItem(schedule, new Intl.DateTimeFormat('en-GB', { timeZone: resolveTimeZone(timeZone), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now))
  return `【虚拟人生｜${schedule.date}】主题：${schedule.theme || '日常'}；心情：${schedule.mood || '平常'}。${item ? `现在 ${item.start}-${item.end}：${item.activity}，在${item.location}，状态：${item.state}。` : '当前时段待更新。'}`
}

export function demo() {
  const s = parseSchedule(JSON.stringify({ timeline: [
    { start: '00:00', end: '12:00', activity: '休息', location: '家', state: '放松' },
    { start: '12:00', end: '24:00', activity: '生活', location: '附近', state: '普通' },
  ] }))
  if (currentItem(s, '13:00')?.activity !== '生活') throw new Error('schedule lookup failed')
  try { parseSchedule('{"timeline":[]}'); throw new Error('invalid schedule accepted') } catch (e) { if (e.message === 'invalid schedule accepted') throw e }
}
if (import.meta.url === `file://${process.argv[1]}`) demo()
