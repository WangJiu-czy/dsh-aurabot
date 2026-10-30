// ego-lite transport. Each CLI round is a new process; only the own TaskSpace/p1 persist.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const PREFIX = 'AURABOT_EGO:'
const MAX_SCRIPT = 128 * 1024
const MAX_OUTPUT = 8 * 1024 * 1024
const errorOf = (code, late = false) => Object.assign(new Error(code), { code, executionStopped: false, mayHaveLateEffects: late })

/** Fixed executable/argv, never a shell. Neither stderr nor upstream exception text escapes. */
export function runEgoScript(script, { timeoutMs = 30_000, spawnImpl = spawn } = {}) {
  if (typeof script !== 'string' || Buffer.byteLength(script) > MAX_SCRIPT) return Promise.reject(errorOf('EGO_INPUT_LIMIT'))
  return new Promise((resolve, reject) => {
    const streams = [0, 1].map(() => ({ decoder: new StringDecoder('utf8'), line: '' }))
    const frames = []
    let child, bytes = 0, settled = false
    const collect = line => { if (line.startsWith(PREFIX)) frames.push(line.replace(/\r$/, '')) }
    const finish = (error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) { child?.kill(); reject(error); return }
      for (const state of streams) { state.line += state.decoder.end(); if (state.line) collect(state.line) }
      try {
        if (frames.length !== 1) throw new Error()
        const frame = JSON.parse(frames[0].slice(PREFIX.length))
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.ok !== 'boolean' || Object.keys(frame).some(k => !['ok', 'spaceId', 'result', 'code', 'executionStopped', 'mayHaveLateEffects'].includes(k)) || (frame.spaceId !== undefined && (!Number.isInteger(frame.spaceId) || frame.spaceId <= 0)) || (frame.code !== undefined && !/^EGO_[A-Z_]+$/.test(frame.code)) || ['executionStopped', 'mayHaveLateEffects'].some(k => frame[k] !== undefined && typeof frame[k] !== 'boolean')) throw new Error()
        resolve(frames[0] + '\n')
      } catch { reject(errorOf('EGO_PROTOCOL_ERROR', true)) }
    }
    const timer = setTimeout(() => finish(errorOf('EGO_TIMEOUT', true)), timeoutMs)
    try {
      child = spawnImpl('ego-browser', ['nodejs'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child.on('error', () => finish(errorOf('EGO_PROCESS_ERROR', true)))
      for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', chunk => {
        if (settled) return
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_OUTPUT) return finish(errorOf('EGO_OUTPUT_LIMIT', true))
        const state = streams[index]
        state.line += state.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        let newline
        while ((newline = state.line.indexOf('\n')) >= 0) { collect(state.line.slice(0, newline)); state.line = state.line.slice(newline + 1) }
        if (frames.length > 1) finish(errorOf('EGO_PROTOCOL_ERROR', true))
      })
      child.on('close', code => finish(code === 0 ? null : errorOf('EGO_PROCESS_ERROR', true)))
      child.stdin.on('error', () => finish(errorOf('EGO_PROCESS_ERROR', true)))
      child.stdin.end(script)
    } catch { finish(errorOf('EGO_PROCESS_ERROR', true)) }
  })
}

// Only a fresh server ID from the exact self/peer conversation is application evidence.
export function findConfirmation(before, messages, expected, startedAt) {
  const normalize = text => String(text || '').normalize('NFC').replace(/[\s\u00a0\u200b\u200d\ufe0f]|\p{Extended_Pictographic}|\p{Emoji_Modifier}/gu, '')
  if (!expected || !/^\d+$/.test(expected.accountId || '') || !/^\d+$/.test(expected.targetUid || '') || !Array.isArray(before) || !Array.isArray(messages)) return ''
  const ids = new Set(before.map(m => m.id))
  return messages.find(m => m.mine === true && /^\d+$/.test(m.id || '') && BigInt(m.id) > 0n && !ids.has(m.id) && m.uid === expected.accountId && m.at >= startedAt &&
    [JSON.stringify(['0','1',expected.accountId,expected.targetUid]), JSON.stringify(['0','1',expected.targetUid,expected.accountId])].includes(JSON.stringify(String(m.conversationId || '').split(':'))) &&
    (expected.awemeId ? m.card?.awemeId === expected.awemeId : normalize(expected.text) && normalize(m.text) === normalize(expected.text)))?.id || ''
}

// This function is serialized as a complete round, not executed in the host.
async function egoRound(input) {
  let task, result
  try {
    task = await taskSpace(input.space)
    if (task.ownership !== 'agent') throw Object.assign(new Error(), { code: 'EGO_USER_CONTROL' })
    const page = task.page('p1')
    const a = input.args
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const box = selector => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,left:r.x,top:r.y,state:n.getAttribute('data-e2e-state')||'',text:(n.innerText||'').slice(0,200)} : null })()`)
    const action = async act => {
      if (act.type === 'enter') { await page.keyboard.press('Enter'); return true }
      if (act.type !== 'press') throw Object.assign(new Error(), { code: 'EGO_ACTION_INVALID' })
      if (!await box(act.selector)) return false
      await page.click(act.selector)
      return true
    }
    switch (input.op) {
      case 'open': result = { ok: true }; break
      case 'evaluate': result = await page.evaluate(a.expression); break // No evaluate timeout option exists.
      case 'goto': await page.goto(a.url, { timeout: a.ms }); result = true; break
      case 'waitFor': {
        const end = Date.now() + a.ms
        result = null
        do { result = await box(a.selector); if (result) break; await pause(100) } while (Date.now() < end)
        break
      }
      case 'click': await page.mouse.click(a.x, a.y); result = true; break
      case 'press': result = await action({ type: 'press', selector: a.selector }); break
      case 'type': await page.keyboard.insertText(a.text); result = true; break
      case 'clearFocused': await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); result = true; break
      case 'pressEnter': await page.keyboard.press('Enter'); result = true; break
      case 'runAction': {
        await page.cdp('Network.enable', { maxResourceBufferSize: 1024 * 1024, maxTotalBufferSize: 4 * 1024 * 1024 })
        await page.events() // Drain before dispatch; events() is a buffer, not an EventEmitter.
        if (!await action(a.action)) { result = { status: 'failed', code: 'ACTION_TARGET_MISSING' }; break }
        const end = Date.now() + a.ms, ids = new Map(), finished = new Set()
        const re = new RegExp(a.source, a.flags)
        result = { status: 'uncertain', code: 'RESPONSE_TIMEOUT' }
        while (Date.now() < end) {
          const events = await page.events()
          if (!Array.isArray(events) || events.length > 2048) throw Object.assign(new Error(), { code: 'EGO_EVENT_LIMIT' })
          for (const event of events) {
            const p = event.params || {}
            if (event.method === 'Network.responseReceived' && re.test(p.response?.url || '')) {
              if (ids.size >= 32) throw Object.assign(new Error(), { code: 'EGO_EVENT_LIMIT' })
              ids.set(p.requestId, { status: p.response.status, headers: p.response.headers || {} })
            }
            if (event.method === 'Network.loadingFinished') finished.add(p.requestId)
          }
          const id = [...ids.keys()].find(id => finished.has(id))
          if (id) {
            const body = await page.cdp('Network.getResponseBody', { requestId: id })
            if (typeof body.body !== 'string' || body.body.length > 1024 * 1024) throw Object.assign(new Error(), { code: 'EGO_BODY_LIMIT' })
            let json = null
            try { json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body) } catch {}
            result = { status: 'observed', response: { ...ids.get(id), json } }
            break
          }
          if (finished.size > 2048) throw Object.assign(new Error(), { code: 'EGO_EVENT_LIMIT' })
          await pause(50)
        }
        break
      }
      case 'screenshot': {
        const fs = await import('node:fs/promises'), { constants } = await import('node:fs')
        const { join } = await import('node:path'), { tmpdir } = await import('node:os')
        const dir = await fs.mkdtemp(join(tmpdir(), 'aurabot-ego-')), file = join(dir, 'shot.png')
        let handle
        try {
          if (a.clip) {
            const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { ...a.clip, scale: 1 } })
            if (typeof shot.data !== 'string' || shot.data.length > 6 * 1024 * 1024) throw new Error()
            await fs.writeFile(file, Buffer.from(shot.data, 'base64'), { flag: 'wx', mode: 0o600 })
          } else await page.screenshot({ path: file })
          handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error()
          const bytes = Buffer.alloc(stat.size + 1), read = await handle.read(bytes, 0, bytes.length, 0)
          if (read.bytesRead !== stat.size || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error()
          result = 'data:image/png;base64,' + bytes.subarray(0, stat.size).toString('base64')
        } finally {
          await handle?.close()
          // Exact generated leaf in our private mkdtemp, never the path returned by screenshot().
          await fs.unlink(file).catch(() => {}); await fs.rmdir(dir).catch(() => {})
        }
        break
      }
      case 'show':
        if (a.visible) { await task.handOff(); result = { handedOff: true } }
        else result = { handedOff: false } // Hiding a window never reclaims user control.
        break
      case 'close': {
        const tabs = await task.tabs()
        await task.finish({ keep: tabs.filter(t => t.label !== 'p1' || t.openedBy !== 'agent').map(t => t.label).filter(Boolean) })
        result = true; break
      }
      default: throw Object.assign(new Error(), { code: 'EGO_ACTION_INVALID' })
    }
    console.log('AURABOT_EGO:' + JSON.stringify({ ok: true, spaceId: task.spaceId, result }))
  } catch (error) {
    const control = /CONTROL|INACTIVE|UNASSIGNED|NAME_IN_USE|NOT_OWNER/.test(String(error?.code || ''))
    console.log('AURABOT_EGO:' + JSON.stringify({ ok: false, spaceId: task?.spaceId, code: control ? 'EGO_USER_CONTROL' : 'EGO_PAGE_ERROR', executionStopped: error?.executionStopped === true, mayHaveLateEffects: error?.mayHaveLateEffects === true }))
  }
}

export function createEgoBrowser({ runner = runEgoScript, spaceName, profileDir = 'douyin', timeoutMs = 30_000 } = {}) {
  const name = spaceName || 'aurabot-douyin-' + createHash('sha256').update(profileDir).digest('hex').slice(0, 16)
  let spaceId, connected = false, paused = false, late = false, executionUnknown = false, closed = false
  let tail = Promise.resolve(), pending = 0
  const invoke = (op, args = {}, unsafe = true, ms = timeoutMs) => {
    if (pending >= 32) return Promise.reject(errorOf('EGO_QUEUE_LIMIT'))
    pending++
    const run = async () => {
      if (closed) throw errorOf('EGO_CLOSED')
      if (paused) throw errorOf('EGO_USER_CONTROL')
      if (late && unsafe && (op !== 'goto' || executionUnknown)) throw errorOf('EGO_LATE_EFFECTS', true)
      const script = `await (${egoRound.toString()})(${JSON.stringify({ op, args, space: spaceId ?? name })});`
      if (Buffer.byteLength(script) > MAX_SCRIPT) throw errorOf('EGO_INPUT_LIMIT')
      let timer
      try {
        const output = await Promise.race([runner(script, { timeoutMs: Math.min(60_000, Math.max(1, ms)) }), new Promise((_, reject) => { timer = setTimeout(() => reject(errorOf('EGO_TIMEOUT', true)), Math.min(60_000, Math.max(1, ms))) })])
        if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT) throw errorOf('EGO_OUTPUT_LIMIT', true)
        const lines = output.split(/\r?\n/).filter(s => s.startsWith(PREFIX))
        if (lines.length !== 1) throw errorOf('EGO_PROTOCOL_ERROR', true)
        const r = JSON.parse(lines[0].slice(PREFIX.length))
        if (Number.isInteger(r.spaceId) && r.spaceId > 0) spaceId = r.spaceId
        if (!r.ok) {
          if (r.code === 'EGO_USER_CONTROL') paused = true
          throw errorOf(r.code === 'EGO_USER_CONTROL' ? r.code : 'EGO_PAGE_ERROR', !r.executionStopped || r.mayHaveLateEffects)
        }
        connected = true
        if (op === 'goto') late = false
        if (op === 'runAction' && r.result?.status === 'uncertain') late = true
        if (r.result?.handedOff) { paused = true; connected = false }
        if (op === 'close') { closed = true; connected = false }
        return r.result
      } catch (error) {
        connected = false
        if (['EGO_TIMEOUT', 'EGO_PROCESS_ERROR', 'EGO_OUTPUT_LIMIT', 'EGO_PROTOCOL_ERROR', 'EGO_TRANSPORT_ERROR'].includes(error.code)) executionUnknown = true
        if (unsafe && error.mayHaveLateEffects !== false) late = true
        throw errorOf(/^EGO_[A-Z_]+$/.test(error.code || '') ? error.code : 'EGO_TRANSPORT_ERROR', late)
      } finally { clearTimeout(timer) }
    }
    const result = tail.then(run)
    tail = result.catch(() => {}).finally(() => { pending-- })
    return result
  }
  const msOf = ms => Math.min(45_000, Math.max(1, Number(ms) || 10_000))
  return {
    connected: () => connected && !paused && !closed,
    open: () => invoke('open', {}, false).catch(error => ({ ok: false, code: error.code, message: error.message })),
    evaluate: (expression, ms = timeoutMs) => invoke('evaluate', { expression }, true, ms),
    goto: (url, ms = 8000) => invoke('goto', { url, ms: msOf(ms) }),
    waitFor: (selector, ms = 10_000) => invoke('waitFor', { selector, ms: msOf(ms) }, false, msOf(ms) + 5000),
    click: (x, y) => invoke('click', { x, y }),
    press: selector => invoke('press', { selector }),
    type: text => invoke('type', { text }),
    clearFocused: () => invoke('clearFocused'),
    pressEnter: () => invoke('pressEnter'),
    runAction: ({ urlRe, action, timeoutMs: ms = 10_000 }) => invoke('runAction', { source: urlRe.source, flags: urlRe.flags.replace(/[gy]/g, ''), action, ms: msOf(ms) }, true, msOf(ms) + 5000),
    screenshot: clip => invoke('screenshot', { clip }, false),
    show: visible => invoke('show', { visible: Boolean(visible) }, false),
    close: () => spaceId === undefined ? Promise.resolve() : invoke('close', {}, false),
  }
}
