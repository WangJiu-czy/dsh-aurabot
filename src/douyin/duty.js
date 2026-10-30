// 刷抖音：定时打开推荐，一个个点开看（真的播放、停留），读标题、分类、抖音给的内容摘要和热评，
// 再按她的人格决定点不点赞、评不评论、要不要分享给主人（抖音私信 / QQ）、记住什么。别人发来抖音链接，她也能点开看完再聊。
// 点赞 / 评论都按视频 id 在弹层播放器里点，点完等抖音的接口回应才算成功；遇到验证码当天就停手。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { isSilence } from '../chat/reply.js'
import { permOf } from '../chat/access.js'
import { createBrowser } from './browser.js'
import { createSite, findAwemeId, resolveShort, digestOf, videoLink } from './site.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const between = (lo, hi) => Math.floor(lo + Math.random() * (Math.max(lo, hi) - lo + 1))
const clip = (t, max) => [...String(t ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')
// 这些错误说明今天别再动手了：验证码、操作太频繁、账号被限制
const STOP_RE = /验证|频繁|稍后再试|异常|限制|风控/
const NAME = { like: '点赞', comment: '评论' }

/** 从模型输出里取 JSON（对象或数组），取不到返回 fallback。 */
export function pickJson(out, fallback) {
  const s = String(out || '')
  const m = s.match(/\[[\s\S]*\]/) || s.match(/\{[\s\S]*\}/)
  if (!m) return fallback
  try { return JSON.parse(m[0]) } catch (error) { return fallback }
}

const emptyDay = () => ({ day: '', runs: 0, watched: 0, like: 0, comment: 0, share: 0, atOwner: 0, writes: 0 })
const emptyState = () => ({
  ...emptyDay(),
  lastRun: 0, nextDueAt: 0, lastSkipReason: '', lastWriteAt: 0, refreshIndex: 1,
  pauseDay: '', pauseReason: '', notifiedDay: '',
  loginAt: 0, account: null, // 上次查到的登录状态（面板只读这个，不为了显示状态去开浏览器）
  seen: [], history: [],
  uncertainDy: [], // Await explicit receipt reconciliation; never auto-resend unknown webpage shares.
  sharedDy: [], // 在抖音里分享给主人过的视频 id：同一个视频绝不分享第二次（页面上的「已分享」状态刷新就没了，靠不住）
})

export function createDouyin({ getConfig, setOwner, hub, memory, log, site: injected, browser: injectedBrowser, getImState = () => null, now = Date.now, wait } = {}) {
  const cfg = () => getConfig().douyin
  const sleep = wait || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const browser = injectedBrowser || (!injected ? createBrowser({ backend: cfg().browserTransport || 'ego-lite', profileDir: dataDir('douyin', 'edge-profile'), browserPath: () => cfg().browserPath, log }) : null)
  const site = injected || createSite({ browser, log })
  const verifiedUid = value => typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : ''
  function identity(account) {
    const sdk = getImState(), uid = verifiedUid(account?.uid)
    const sdkUid = verifiedUid(sdk?.accountId)
    const ok = Boolean(uid && sdkUid && uid === sdkUid && ['online', 'recovering', 'waiting-contacts', 'recovery-pending'].includes(sdk?.status))
    return { ok, code: ok ? 'UID_MATCHED' : !uid || !sdkUid ? 'UID_REQUIRED' : 'UID_MISMATCH' }
  }
  const file = () => dataDir('douyin.json')
  const load = () => {
    const raw = readJson(file(), emptyState)
    const s = { ...emptyState(), ...(raw && raw.version === 2 ? raw : {}), version: 2 } // 旧版的记录格式对不上，直接从头记
    for (const key of ['dmSeen', 'dmInit', 'lastDmCheck', 'dmTries']) delete s[key]
    if (s.day !== dayKey(new Date(now()))) Object.assign(s, emptyDay(), { day: dayKey(new Date(now())) })
    return s
  }
  const save = (s) => writeJson(file(), s)
  const record = (s, item) => { s.history.unshift({ at: now(), ...item }); s.history = s.history.slice(0, 40) }
  const owner = () => getConfig().ownerName || '主人'
  // 主人的抖音号核对过、面板里的输入也没改过，才能真·@
  const ownerDy = () => {
    const o = cfg().owner || {}
    return o.secUid && o.input && o.confirmedInput === o.input ? o : null
  }
  const paused = (s) => s.pauseDay === dayKey(new Date(now()))
  let busy = false

  // 刚登录的号前几天上限减半：新号一上来就猛点赞猛评论最容易被风控
  const isNew = (s) => {
    const days = cfg().gate.newAccountDays
    return Boolean(days && s.loginAt && now() - s.loginAt < days * 86400_000)
  }
  const capOf = (s, kind) => (isNew(s) ? Math.floor(cfg().caps[kind] / 2) : cfg().caps[kind])
  const left = (s, kind) => Math.max(0, capOf(s, kind) - (s[kind] || 0))
  const writesLeft = (s) => Math.max(0, (isNew(s) ? Math.floor(cfg().gate.maxWritesPerDay / 2) : cfg().gate.maxWritesPerDay) - s.writes)

  /** 今天不再在抖音上动手（看还能看）；当天第一次停时在 QQ 上跟主人说一声。 */
  function pauseAll(s, why) {
    s.pauseDay = dayKey(new Date(now()))
    s.pauseReason = clip(why, 60) || '被风控了'
    log.warn(`今天先不在抖音上点赞评论了：${s.pauseReason}`)
    const qq = getConfig().ownerQQ
    if (qq && s.notifiedDay !== s.pauseDay) {
      s.notifiedDay = s.pauseDay
      const note = `抖音那边要验证 / 被限制了，今天我先不点赞评论了：${s.pauseReason}。请在手机抖音检查账号安全或实名状态；也可以在面板「抖音」页点「显示浏览器窗口」查看。`
      Promise.resolve(hub.sendText?.(`private:${qq}`, note)).catch(() => {})
      // 顺手把当前页面截图发给主人：有些验证网页上不显示，截图能看清到底弹了什么（每天只发一次）
      Promise.resolve().then(() => site.screenshot?.()).then((shot) => {
        const b64 = String(shot || '').replace(/^data:image\/png;base64,/, '')
        if (!b64) return null
        return hub.sendSegments?.(`private:${qq}`, [{ type: 'image', data: { file: 'base64://' + b64 } }], '[抖音验证页面截图]')
      }).catch(() => {})
    }
  }

  /** 写操作闸门：暂停、单项上限、总上限、间隔。能做返回 ''，不能做返回原因。 */
  function blocked(s, kind) {
    if (paused(s)) return '今天暂停了：' + s.pauseReason
    if (left(s, kind) <= 0) return `今天${NAME[kind]}次数用完了`
    if (writesLeft(s) <= 0) return '今天在抖音上动手的次数用完了'
    const gap = cfg().gate.minWriteGapSec * 1000 - (now() - (s.lastWriteAt || 0))
    if (gap > 0) return `动作太密了，再等 ${Math.ceil(gap / 1000)} 秒`
    return ''
  }

  /** 做一次写操作（点赞 / 评论）。试运行只记日志不占次数；出错是验证码 / 风控就停一天。刷流里间隔不够就等够再做。 */
  async function doWrite(s, kind, meta, act, { waitGap = false } = {}) {
    if (waitGap) {
      const gap = cfg().gate.minWriteGapSec * 1000 - (now() - (s.lastWriteAt || 0))
      if (gap > 0) await sleep(gap + between(500, 3000))
    }
    const why = blocked(s, kind)
    if (why) return { ok: false, message: why }
    if (getConfig().dryRun) {
      log.info(`试运行：本来要在抖音${NAME[kind]}`, meta.title || meta.awemeId, meta.text || '')
      record(s, { kind: 'dry:' + kind, ...meta })
      return { ok: true, dryRun: true }
    }
    try {
      const r = await act()
      s.lastWriteAt = now()
      if (!r?.already) { s[kind]++; s.writes++ }
      record(s, { kind, ...meta, ...(r?.atOwner ? { atOwner: true } : {}) })
      return { ok: true, already: Boolean(r?.already), atOwner: Boolean(r?.atOwner) }
    } catch (error) {
      log.warn(`抖音${NAME[kind]}失败：`, error.message)
      record(s, { kind: 'error', ...meta, text: `${NAME[kind]}没成功：${error.message}` })
      if (error.code === 'verify' || error.code === 'login' || STOP_RE.test(error.message)) pauseAll(s, error.message)
      return { ok: false, message: error.message }
    }
  }

  /** 打开浏览器、确认登录了、页面上没验证码。 */
  async function ready(s) {
    const r = await site.ensure()
    if (!r.ok) return r
    const me = await site.self().catch((error) => ({ error: error.message }))
    s.account = { at: now(), loggedIn: Boolean(me?.secUid), nickname: me?.nickname || '', secUid: me?.secUid || '', uid: verifiedUid(me?.uid), error: me?.error || '' }
    if (me?.error) return { ok: false, message: '查不了抖音登录状态：' + me.error }
    if (!me) return { ok: false, message: '抖音还没登录，先在面板「抖音」页扫码登录' }
    if (cfg().im?.enabled && !identity(s.account).ok) return { ...identity(s.account), message: '网页与SDK账号UID等待核对' }
    if (!s.loginAt) s.loginAt = now()
    const why = await site.verify()
    if (why) {
      pauseAll(s, why)
      return { ok: false, message: '抖音要验证：' + why }
    }
    return { ok: true }
  }

  function shareHint() {
    const b = cfg().shareBias
    if (b === 'stingy') return `觉得${owner()}一定会喜欢才写 share，拿不准就空着。`
    if (b === 'normal') return `觉得${owner()}会喜欢才写 share，不然空字符串。`
    return `好看、有趣、值得${owner()}一看的就写 share，别太吝啬。`
  }

  async function think(prompt) {
    const out = await hub.runSystemTurn('douyin', 'QQ · 刷抖音', `【刷抖音，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 })
    return typeof out === 'string' ? out : String(out?.text ?? out ?? '')
  }

  /** 真·@主人用的信息：按 sec_uid 现查一次昵称（主人改了名也认得出）；查不到就用核对时记下的。 */
  async function ownerMention() {
    const o = ownerDy()
    if (!o) return null
    const u = await site.user(o.secUid).catch(() => null)
    return { secUid: o.secUid, uid: u?.uid || o.uid, nickname: u?.nickname || o.nickname }
  }

  /**
   * 把视频分享给主人：按面板设置在抖音里私信分享（视频卡片）、在 QQ 私聊发（她的话 + 链接），或两边都发。
   * 抖音那边没核对主人 / 发不出去时改发 QQ，免得白看。返回 { ok, via: ['douyin', 'qq'] }。
   */
  async function shareToOwner(s, v, text) {
    const g = getConfig()
    const mode = cfg().shareTo
    const via = []
    let uncertainDy = false
    const dy = ownerDy()
    if (s.uncertainDy.includes(v.awemeId)) return { ok: false, code: 'dm_uncertain', via: [] }
    if ((mode === 'douyin' || mode === 'both') && dy && s.sharedDy.includes(v.awemeId)) {
      via.push('douyin') // 之前就在抖音里分享过了
    } else if ((mode === 'douyin' || mode === 'both') && dy) {
      if (g.dryRun) {
        log.info(`试运行：本来要在抖音里把《${v.title}》分享给${owner()}`)
        via.push('douyin')
      } else {
        const gap = cfg().gate.minWriteGapSec * 1000 - (now() - (s.lastWriteAt || 0))
        if (gap > 0) await sleep(gap + between(500, 3000))
        try {
          const who = await ownerMention()
          await site.share(v.awemeId, { secUid: who.secUid, uid: who.uid, nickname: who.nickname })
          s.lastWriteAt = now()
          s.sharedDy = [...s.sharedDy, v.awemeId].slice(-300)
          via.push('douyin')
        } catch (error) {
          uncertainDy = error.code === 'dm_uncertain' || error.mayHaveLateEffects === true
          if (uncertainDy) s.uncertainDy = [...s.uncertainDy, v.awemeId].slice(-300)
          log.warn('抖音里分享给主人失败：', error.message)
          record(s, { kind: 'error', awemeId: v.awemeId, title: v.title, author: v.author, text: `抖音里分享没成功：${error.message}${g.ownerQQ && !uncertainDy ? '，改发 QQ' : ''}` })
          if (error.code === 'verify' || STOP_RE.test(error.message)) pauseAll(s, error.message)
        }
      }
    }
    if (g.ownerQQ && (mode === 'qq' || mode === 'both' || (!via.length && !uncertainDy))) {
      try {
        const sent = await hub.sendText(`private:${g.ownerQQ}`, `${text}\n${videoLink(v.awemeId)}`)
        if (sent || g.dryRun) via.push('qq')
        else log.warn('QQ 上分享抖音视频失败：网关没有确认发送')
      } catch (error) {
        log.warn('QQ 上分享抖音视频失败：', error.message)
      }
    }
    if (via.length) memory?.addEvent?.({ text: `把抖音上《${v.title}》分享给了${owner()}${via.includes('douyin') ? '（抖音私信）' : ''}：${text.slice(0, 40)}`, tags: ['抖音'], importance: 0.45 })
    return { ok: via.length > 0, via }
  }

  /** 核对主人的抖音号：填抖音号或主页链接，查到这个人后把 sec_uid 等记进配置。 */
  async function confirmOwner(input) {
    const raw = String(input || '').trim()
    const sec = raw.match(/douyin\.com\/user\/(MS4w[\w-]+)/)?.[1] || (/^MS4w[\w-]+$/.test(raw) ? raw : '')
    const douyinId = sec ? '' : raw.replace(/^@/, '').replace(/^抖音号[:：]?\s*/, '')
    if (!sec && !/^[\w.]{2,30}$/.test(douyinId)) return { ok: false, message: '填你的抖音号，或者主页链接（douyin.com/user/…）' }
    const s = load()
    try {
      const r = await ready(s)
      if (!r.ok) return r
      const u = sec ? await site.user(sec) : await site.findByDouyinId(douyinId)
      setOwner?.({ input: raw, secUid: u.secUid, uid: u.uid, nickname: u.nickname, confirmedInput: raw })
      return { ok: true, message: `核对好了：${u.nickname}${u.douyinId ? '（抖音号 ' + u.douyinId + '）' : ''}`, owner: u }
    } catch (error) {
      return { ok: false, message: '没核对上：' + error.message }
    } finally {
      save(s)
    }
  }

  /** 从推荐里挑 want 个没看过的；一页不够就再拉一页。 */
  async function pick(s, want) {
    const seen = new Set(s.seen)
    const out = []
    for (let i = 0; i < 4 && out.length < want; i++) {
      const page = await site.feed(s.refreshIndex)
      s.refreshIndex = (s.refreshIndex % 50) + 1
      for (const v of page) if (!seen.has(v.awemeId) && !out.some((x) => x.awemeId === v.awemeId) && out.length < want) out.push(v)
    }
    return out
  }

  /**
   * 刷一轮。force = 面板里手动点的 / 主人让她去刷的（不占每天的轮数）。
   * ownerAsked = 主人开口要她找视频：这轮至少分享一个给主人，她挑剔到一个都不分享时自动挑一个。
   */
  async function run({ force = false, ownerAsked = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (!c.enabled) return { ok: false, message: '抖音没打开' }
    busy = true
    const s = load()
    try {
      // 主人亲口让她去找视频：不受「每天看多少个」的限制（点赞评论分享那些写操作的上限照旧）
      const want = ownerAsked ? Math.max(Math.min(c.perRun, c.maxWatchPerDay - s.watched), Math.min(c.perRun, 3)) : Math.min(c.perRun, c.maxWatchPerDay - s.watched)
      if (want <= 0) return { ok: false, message: `今天已经看了 ${s.watched} 个（上限 ${c.maxWatchPerDay}）` }
      const r = await ready(s)
      if (!r.ok) { s.lastSkipReason = r.message; return r }
      const list = await pick(s, want)
      if (!list.length) { s.lastSkipReason = '这次推荐里没刷到新视频'; return { ok: false, message: s.lastSkipReason } }

      // 一个个点开看：真的播放、停一会儿，同时拿热评
      const looked = []
      for (const v of list) {
        try {
          const comments = await site.comments(v.awemeId).catch(() => [])
          await site.watch(v.awemeId, between(c.dwellMin, c.dwellMax) * 1000)
          looked.push({ v, comments })
          s.watched++
          s.seen = [...s.seen.filter((x) => x !== v.awemeId), v.awemeId].slice(-500)
        } catch (error) {
          log.debug(`看 ${v.awemeId} 失败：`, error.message)
          if (error.code === 'verify') { pauseAll(s, error.message); break }
        }
        save(s)
      }
      if (!looked.length) { s.lastSkipReason = '视频都没打开'; return { ok: false, message: s.lastSkipReason } }

      const canWrite = !paused(s)
      const g = getConfig()
      const likeLeft = canWrite && permOf(g, 'douyinLike') !== 'off' ? Math.min(left(s, 'like'), writesLeft(s)) : 0
      const commentLeft = canWrite && permOf(g, 'douyinComment') !== 'off' ? Math.min(left(s, 'comment'), writesLeft(s)) : 0
      const shareLeft = (g.ownerQQ || ownerDy()) && permOf(g, 'douyinShareOwner') !== 'off' ? left(s, 'share') : 0
      const atLeft = commentLeft && ownerDy() ? left(s, 'atOwner') : 0
      const atRule = atLeft
        ? ` 特别想让${owner()}看到的，把 "at" 设成 true 并写 comment：系统会在评论里真的 @${owner()}（${owner()}会收到抖音通知），comment 里别自己打 @。这次最多 @ ${atLeft} 次。`
        : ''
      let out = ''
      try {
        out = await think(`你在抖音刷到了这几个视频：\n\n${looked.map((x, i) => `【${i + 1}】${digestOf(x.v, x.comments)}`).join('\n\n')}\n\n` +
        `看完说说你的想法。对每个视频给一个对象：{"i":序号, "feeling":"一句你的真实感受", "like":true/false, "comment":"想在视频下发的评论（像普通观众，一两句、别打广告，不想评就空字符串）", ${atLeft ? '"at":true/false, ' : ''}"share":"想分享给${owner()}时说的话（不想分享就空字符串）", "remember":"值得记住的一件事（没有就空字符串）"}。` +
        `这次最多点赞 ${likeLeft} 个、评论 ${commentLeft} 个、分享 ${shareLeft} 个。${atRule}${shareLeft ? (ownerAsked ? `${owner()}刚才专门让你找视频给他，这轮至少挑一个最合适的写 share，别全空着。` : shareHint()) : ''}只输出 JSON 数组。`)
      } catch (error) {
        if (!ownerAsked || !shareLeft) throw error
        // 主人明确要视频，模型挑选超时也别让已看完的一轮白费；后面只走已有的单视频兜底。
        log.warn('挑视频的模型没回，改从已经看过的视频里挑一个：', error.message)
      }
      const decisions = pickJson(out, [])
      const byI = new Map((Array.isArray(decisions) ? decisions : []).map((d) => [Number(d?.i) || 0, d]))

      let liked = 0
      let commented = 0
      let shared = 0
      let atted = 0
      const sharedList = [] // 这轮分享给主人的 { title, via }，刷完告诉她
      for (let i = 0; i < looked.length; i++) {
        const { v } = looked[i]
        const d = byI.get(i + 1) || {}
        const meta = { awemeId: v.awemeId, title: v.title, author: v.author }
        const feeling = clip(d.feeling, 80)
        memory?.addEvent?.({ text: `在抖音看了${v.author ? ' ' + v.author + ' 的' : ''}《${v.title}》${feeling ? '：' + feeling : ''}`, tags: ['抖音'], importance: 0.4 })
        if (d.remember && !isSilence(d.remember)) memory?.add?.({ text: clip(d.remember, 200), tags: ['抖音'], importance: 0.5, source: 'event' })
        record(s, { kind: 'watch', ...meta, text: feeling })

        if (d.like === true && liked < likeLeft) {
          const w = await doWrite(s, 'like', meta, () => site.like(v.awemeId), { waitGap: true })
          if (w.ok && !w.already) liked++
        }
        // 模型自己打的 @xxx 是假 @（对方收不到通知），去掉；要 @ 主人走下面的真·@
        const comment = clip(String(d.comment || '').replace(/@\S+\s*/g, ''), 100)
        if (comment && !isSilence(comment) && commented < commentLeft) {
          const at = d.at === true && atted < atLeft ? await ownerMention() : null
          const w = await doWrite(s, 'comment', { ...meta, text: comment }, () => site.comment(v.awemeId, comment, at ? { at } : {}), { waitGap: true })
          if (w.ok) {
            commented++
            if (w.atOwner) { atted++; s.atOwner++ }
            if (!w.dryRun) memory?.addEvent?.({ text: `在抖音《${v.title}》下评论${w.atOwner ? `（@了${owner()}）` : ''}：${comment.slice(0, 60)}`, tags: ['抖音'], importance: 0.4 })
          }
        }
        const share = clip(d.share, 120)
        if (share && !isSilence(share) && shared < shareLeft) {
          const r = await shareToOwner(s, v, share)
          if (r.ok) {
            shared++
            s.share++
            sharedList.push({ title: v.title, via: r.via })
            record(s, { kind: 'share', ...meta, text: share, via: r.via })
          }
        }
        save(s)
      }

      // 主人开口要了，她却一个都没分享：挑她点了赞的（没有就第一个）分享过去，免得主人白等
      if (ownerAsked && !shared && shareLeft) {
        const pickI = Math.max(0, looked.findIndex((x, i) => (byI.get(i + 1) || {}).like === true))
        const { v } = looked[pickI]
        const text = clip((byI.get(pickI + 1) || {}).feeling, 80) || `${owner()}你要的，这个还行`
        const r = await shareToOwner(s, v, text)
        if (r.ok) {
          shared++
          s.share++
          sharedList.push({ title: v.title, via: r.via })
          record(s, { kind: 'share', awemeId: v.awemeId, title: v.title, author: v.author, text, via: r.via })
        }
        save(s)
      }

      if (ownerAsked && !shared) {
        s.lastSkipReason = shareLeft ? '分享未确认成功' : '今天的分享次数用完了，或分享权限已关闭'
        return { ok: false, message: s.lastSkipReason, watched: looked.length, liked, commented, shared, sharedList }
      }
      if (!force) {
        s.runs++
        s.nextDueAt = now() + Math.round(c.intervalHours * 3600_000 * (0.8 + Math.random() * 0.5))
      }
      s.lastRun = now()
      s.lastSkipReason = ''
      const msg = `看了 ${looked.length} 个视频，点赞 ${liked}，评论 ${commented}${atted ? `（@了${owner()} ${atted} 次）` : ''}，分享 ${shared} 个`
      log.info('刷了一轮抖音：' + msg)
      return { ok: true, message: msg, watched: looked.length, liked, commented, shared, sharedList }
    } catch (error) {
      log.warn('刷抖音出错：', error.message)
      s.lastSkipReason = error.message
      if (error.code === 'verify') pauseAll(s, error.message)
      return { ok: false, message: error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  /** 最近真正看过的视频：从已有记录按视频 id 去重；没有 id 的旧记录不编造链接。 */
  function recentVideos(limit = 10) {
    const seen = new Set()
    const out = []
    for (const item of load().history) {
      const id = String(item.awemeId || '')
      if (!['watch', 'look', 'share'].includes(item.kind) || !/^\d{15,}$/.test(id) || seen.has(id)) continue
      seen.add(id)
      out.push({ awemeId: id, title: item.title || '', author: item.author || '', url: videoLink(id), at: item.at })
      if (out.length >= Math.max(1, Math.min(20, Number(limit) || 10))) break
    }
    return out
  }

  /** 链接 / 短链 / 视频 id → 视频 id。 */
  async function idOf(link) {
    const id = findAwemeId(link)
    if (!id) return ''
    if (id.awemeId) return id.awemeId
    return resolveShort(id.short).catch(() => '')
  }

  /** 她看一个视频（别人发来的链接），返回给她看的内容。 */
  async function watch(link) {
    const id = await idOf(link)
    if (!id) return { ok: false, message: '没认出抖音视频链接' }
    const s = load()
    try {
      const r = await ready(s)
      if (!r.ok) return r
      const [v, comments] = await Promise.all([site.detail(id), site.comments(id).catch(() => [])])
      memory?.addEvent?.({ text: `看了别人发来的抖音视频《${v.title}》`, tags: ['抖音'], importance: 0.4 })
      record(s, { kind: 'look', awemeId: id, title: v.title, author: v.author })
      return { ok: true, message: digestOf(v, comments), awemeId: id, title: v.title }
    } catch (error) {
      return { ok: false, message: '这个视频没打开：' + error.message }
    } finally {
      save(s)
    }
  }

  /** 主人让她点赞 / 评论某个视频。 */
  async function act(kind, link, text) {
    const id = await idOf(link)
    if (!id) return { ok: false, message: '没认出抖音视频链接' }
    if (busy) return { ok: false, message: '正在刷抖音，等这一轮刷完再说' }
    busy = true
    const s = load()
    try {
      const r = await ready(s)
      if (!r.ok) return r
      const v = await site.detail(id).catch(() => ({ title: '', author: '' }))
      const title = v.title || id
      const w = await doWrite(s, kind, { awemeId: id, title: v.title, author: v.author, ...(text ? { text } : {}) }, () => (kind === 'like' ? site.like(id) : site.comment(id, text)))
      if (!w.ok) return w
      if (w.dryRun) return { ok: true, message: `试运行：本来要${NAME[kind]}《${title}》` }
      if (w.already) return { ok: true, message: `《${title}》之前就赞过了` }
      memory?.addEvent?.({ text: kind === 'like' ? `在抖音给《${title}》点了赞` : `在抖音《${title}》下评论：${text.slice(0, 60)}`, tags: ['抖音'], importance: 0.4 })
      return { ok: true, message: kind === 'like' ? `点赞了（《${title}》）` : `评论发出去了（《${title}》）` }
    } finally {
      save(s)
      busy = false
    }
  }

  /**
   * 主人明确要求给某个人发抖音私信：主页 / 抖音号 → 认人 → 打开会话（列表里没有就从主页「私信」发起）→ 发一句。
   * 只主动找主人指定的对象；别人的私信照样只回主人。试运行只记日志。
   */
  async function directDm({ target, text }) {
    const who = String(target || '').trim()
    const say = clip(text, 300)
    if (!who) return { ok: false, message: '要发给谁？给个抖音主页链接或抖音号' }
    if (!say) return { ok: false, message: '要说什么？' }
    if (busy) return { ok: false, message: '正在刷抖音，等这一轮刷完再说' }
    busy = true
    const s = load()
    try {
      const r = await ready(s)
      if (!r.ok) return r
      // 主页链接 / v.douyin.com 短链 / secUid / 抖音号都行（短链会在浏览器里跳一下取主页）
      const u = await site.profileOf(who)
      await site.dms(u.uid, { secUid: u.secUid }) // 列表里没有会话时会从主页发起
      if (getConfig().dryRun) {
        log.info(`试运行：本来要给抖音上的 ${u.nickname} 发私信：${say}`)
        record(s, { kind: 'dry:dm-out', text: say, title: u.nickname })
        return { ok: true, message: `试运行：本来要发给「${u.nickname}」`, nickname: u.nickname }
      }
      await site.sendDm(say)
      record(s, { kind: 'dm-out', text: say, title: u.nickname })
      memory?.addEvent?.({ text: `在抖音给${u.nickname}发了私信：${say.slice(0, 50)}`, tags: ['抖音'], importance: 0.4 })
      return { ok: true, message: `发给「${u.nickname}」了`, nickname: u.nickname }
    } catch (error) {
      log.warn('主动发抖音私信没成：', error.message)
      record(s, { kind: 'error', text: '主动私信没发成：' + error.message })
      return { ok: false, message: '没发成：' + error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  /** 主人明确要求分享指定视频时，复用相同的额度、收件人核对和分享记录。 */
  async function shareVideo(link) {
    const id = await idOf(link)
    if (!id) return { ok: false, message: '没认出抖音视频链接' }
    if (busy) return { ok: false, message: '正在刷抖音，等这一轮刷完再说' }
    busy = true
    const s = load()
    try {
      if (left(s, 'share') <= 0) return { ok: false, message: '今天分享次数用完了' }
      const readyResult = await ready(s)
      if (!readyResult.ok) return readyResult
      const v = await site.detail(id)
      const text = `${owner()}，你要的这个视频`
      const result = await shareToOwner(s, v, text)
      if (!result.ok) return { ok: false, message: '分享没有确认成功，请检查抖音私信和 QQ 网关' }
      s.share++
      record(s, { kind: getConfig().dryRun ? 'dry:share' : 'share', awemeId: id, title: v.title, author: v.author, text, via: result.via })
      return { ok: true, message: `${getConfig().dryRun ? '试运行：本来要分享' : '已分享'}《${v.title || id}》`, via: result.via }
    } catch (error) {
      return { ok: false, message: '分享没成功：' + error.message }
    } finally { save(s); busy = false }
  }

  const likeVideo = (link) => act('like', link)
  async function commentVideo(link, text) {
    const t = clip(text, 100)
    if (!t) return { ok: false, message: '评论不能是空的' }
    return act('comment', link, t)
  }

  /** 刷完的结果写成一段给她看的话（照实说，没分享就是没分享）。 */
  function resultNote(r) {
    if (!r.ok) return `【系统消息，不是对方说的】你刚才去刷抖音没刷成：${r.message}。照实跟对方说一声。`
    const where = (via) => via.map((x) => (x === 'douyin' ? '抖音私信' : 'QQ')).join('和')
    const shares = (r.sharedList || []).map((x) => `《${x.title}》（发到了${where(x.via)}）`)
    const recent = recentVideos(5).map((v) => `《${v.title || '无标题'}》${v.url}`).join('；')
    return `【系统消息，不是对方说的】你刚刷完一轮抖音：看了 ${r.watched} 个，点赞 ${r.liked}，评论 ${r.commented}。` +
      (shares.length ? `分享给${owner()}的：${shares.join('、')}。` : `这轮没有分享给${owner()}的视频。`) +
      (recent ? `最近看过的视频：${recent}。` : '') + '照实跟对方说一两句，别说没做到的事。'
  }

  /**
   * 让她去刷一会儿：后台刷，马上返回（一轮要好几分钟）。
   * report = 从哪个聊天叫的：刷完把结果塞回那个聊天，让她照实说（不然她容易先说「已经发你了」）。
   */
  function browse({ ownerAsked = false, report = null } = {}) {
    if (busy) return { ok: false, message: '已经在刷了，等这一轮刷完会告诉你结果' }
    if (!cfg().enabled) return { ok: false, message: '抖音没打开' }
    const c = cfg()
    run({ force: true, ownerAsked }).then((r) => {
      if (report) return hub.pushToSession?.(report, [{ type: 'text', text: resultNote(r) }], '')
    }).catch((error) => log.warn('刷完报告结果出错：', error.message))
    return { ok: true, message: `刚开始刷，这一轮看 ${c.perRun} 个左右，大概 ${Math.ceil((c.perRun * (c.dwellMin + c.dwellMax)) / 2 / 60) + 1} 分钟。现在还什么都没分享，刷完系统会把结果告诉你，在那之前别跟对方说「已经发了」。` }
  }

  /** 每分钟调一次：醒着、到点了就刷一轮。 */
  async function tick() {
    const g = getConfig()
    const c = g.douyin
    if (!g.enabled || !c.enabled || busy) return
    const h = new Date(now()).getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    const s = load()
    if (!c.autoBrowse) return
    if (s.runs >= c.maxRunsPerDay || s.watched >= c.maxWatchPerDay) return
    const due = s.nextDueAt || (s.lastRun ? s.lastRun + c.intervalHours * 3600_000 : 0)
    if (now() < due) return
    await run()
  }

  /** 登录状态。force = 真去浏览器里查（会打开浏览器）；不 force 只给上次查到的。 */
  async function account(force = false) {
    const s = load()
    if (!force) return s.account || { loggedIn: false, unknown: true }
    try {
      const r = await ready(s)
      return { ...(s.account || { loggedIn: false }), ...(r.ok ? {} : { message: r.message }) }
    } catch (error) {
      return { loggedIn: false, error: error.message }
    } finally {
      save(s)
    }
  }

  /** 扫码登录：开始 / 轮询。返回 { loggedIn, shot }（shot 是登录弹窗截图）。 */
  async function loginStep(start) {
    const s = load()
    try {
      const r = start ? await site.loginStart() : await site.loginPoll()
      if (!r.ok) return r
      if (r.loggedIn) {
        s.account = { at: now(), loggedIn: true, nickname: r.me.nickname, secUid: r.me.secUid, uid: verifiedUid(r.me.uid), error: '' }
        if (!s.loginAt) s.loginAt = now()
        if (paused(s) && /登录/.test(s.pauseReason)) s.pauseDay = ''
        await site.show(false).catch(() => {})
        return { ok: true, loggedIn: true, message: `已登录：${r.me.nickname}` }
      }
      return { ok: true, loggedIn: false, shot: r.shot, message: '用抖音 App 扫码；扫完要验证的话点「显示浏览器窗口」在窗口里完成' }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally {
      save(s)
    }
  }

  /** 把浏览器窗口挪到屏幕里给人看（处理验证码、短信验证）/ 挪回去。 */
  async function showWindow(visible) {
    const r = await site.ensure()
    if (!r.ok) return r
    await site.show(Boolean(visible))
    return { ok: true, message: visible ? '浏览器窗口挪到屏幕上了，处理完点「收起窗口」' : '窗口收起来了' }
  }

  /** 面板读的状态。只读文件，不碰浏览器。 */
  function state() {
    const s = load()
    const c = cfg()
    return {
      runs: s.runs, watched: s.watched, like: s.like, comment: s.comment, share: s.share, writes: s.writes,
      atOwner: s.atOwner, owner: ownerDy() ? { nickname: ownerDy().nickname } : null,
      caps: { like: capOf(s, 'like'), comment: capOf(s, 'comment'), share: capOf(s, 'share'), atOwner: capOf(s, 'atOwner'), writes: isNew(s) ? Math.floor(c.gate.maxWritesPerDay / 2) : c.gate.maxWritesPerDay },
      newAccount: isNew(s), lastRun: s.lastRun, nextDueAt: s.nextDueAt, lastSkipReason: s.lastSkipReason,
      pauseReason: paused(s) ? s.pauseReason : '', account: s.account, identity: identity(s.account), busy, browserOpen: site.connected(),
      history: s.history.slice(0, 30),
    }
  }

  return { run, browse, watch, recentVideos, shareVideo, directDm, likeVideo, commentVideo, confirmOwner, tick, account, loginStep, showWindow, state, dispose: () => browser?.close() }
}
