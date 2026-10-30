#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

const help = `Douyin IM explicit-target smoke (no live test has been run)
No arguments: WAITING_TARGETS, zero SDK initialization / connections / writes.
--login-only | --listen-only | --send-test (mutually exclusive)
--account SELF_UID --data-dir ABSOLUTE_PRIVATE_DIRECTORY
--direct PEER_UID / --group GROUP_ID (explicit allow list, not a recent chat)
--confirm-sdk-default-sync: SDK 1.1.0 login automatically synchronizes ALL friends,
  groups, stranger conversations and history internally. autoLoad/localState=false
  do not disable this. This flag confirms that wider SDK sync; consumption remains
  restricted to the explicit targets. Without it, NO login is started.
--send-test requires --text TEXT and exactly one --direct or --group target.
--listen-only requires a target; --seconds 60 bounds the listen window.
Login-only does not call selected-contact history or send any message.
Server confirmed = accepted, NOT read by the peer. Uncertain is never retried.
Native voice: gap. SDK/ego independent logins; runtime is checked in this process.
`
let values
try {
  ;({ values } = parseArgs({ options: { help: { type: 'boolean' }, 'login-only': { type: 'boolean' }, 'listen-only': { type: 'boolean' }, 'send-test': { type: 'boolean' }, account: { type: 'string' }, direct: { type: 'string' }, group: { type: 'string' }, text: { type: 'string' }, 'data-dir': { type: 'string' }, 'confirm-sdk-default-sync': { type: 'boolean' }, seconds: { type: 'string' } }, strict: true }))
} catch { console.error('INVALID_ARGUMENTS; use --help'); process.exit(2) }
if (values.help) { console.log(help); process.exit(0) }
const modes = ['login-only', 'listen-only', 'send-test'].filter(m => values[m])
if (modes.length !== 1 || !values.account || !values['data-dir'] || !isAbsolute(values['data-dir']) || (values['listen-only'] && !values.direct && !values.group) || (values['send-test'] && (!values.text || Boolean(values.direct) === Boolean(values.group)))) {
  console.log(JSON.stringify({ ok: false, code: 'WAITING_TARGETS', runtimeNode: 'unknown', sqlite: 'unknown', message: 'Explicit mode, account, data directory and mode-specific targets/content are required; no connection or writes.' }))
  process.exit(0)
}
console.error('SDK 1.1.0 login synchronizes ALL friends/groups/strangers/history internally; this cannot be scoped by its public login interface.')
if (!values['confirm-sdk-default-sync']) { console.log(JSON.stringify({ ok: false, code: 'SYNC_SCOPE_CONFIRMATION_REQUIRED' })); process.exit(0) }
const seconds = Number(values.seconds || 60)
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) { console.error('INVALID_SECONDS (1..600)'); process.exit(2) }
// Imports and SDK initialization are below every opt-in gate. No browser automation.
const { createImAdapterRegistry } = await import('../src/core/im-adapters.js')
const { createDouyinImAdapter } = await import('../src/douyin/im-adapter.js')
const registry = createImAdapterRegistry()
const config = { enabled: true, dryRun: false, douyin: { enabled: true, im: { enabled: true } }, imAccounts: [{ platform: 'douyin', accountId: values.account, enabled: true, allow: { private: values['login-only'] ? [] : [values.direct].filter(Boolean), groups: values['login-only'] ? [] : [values.group].filter(Boolean) } }] }
const off = registry.subscribe(e => {
  console.log(JSON.stringify({ event: 'message', accountId: e.accountId, conversation: e.conversation, messageId: e.messageId }))
})
const im = createDouyinImAdapter({ registry, getConfig: () => config, dataDir: values['data-dir'] })
let stopping = false
let stopPromise
const stop = () => stopPromise ||= (async () => { stopping = true; off(); await im.dispose() })()
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
try {
  const result = await im.login({ accountId: values.account, syncScope: 'sdk-default-all' })
  if (!result.ok) { console.log(JSON.stringify(result)); process.exitCode = 1 }
  else {
    const deadline = Date.now() + 180_000
    let lastQr
    while (!stopping && Date.now() < deadline && im.state().status !== 'online') {
      const s = im.state()
      if (s.qrcodeBase64 && s.qrcodeBase64 !== lastQr) { lastQr = s.qrcodeBase64; console.log(JSON.stringify({ event: 'login.qrcode', qrcodeBase64: lastQr })) }
      if (['identity-mismatch', 'login-error', 'error'].includes(s.status)) break
      await new Promise(r => setTimeout(r, 500))
    }
    const s = im.state()
    console.log(JSON.stringify({ ...s, qrcodeBase64: undefined }))
    if (s.status === 'online' && values['send-test'] && !stopping) {
      // Resolve only the explicitly selected SDK contact; never guess a thread ID from the UID.
      const target = im.targets().find(t => t.conversation.kind === (values.direct ? 'direct' : 'group'))
      if (!target) console.log(JSON.stringify({ code: 'WAITING_TARGETS', message: 'Selected contact not loaded; no send.' }))
      else console.log(JSON.stringify(await registry.send(target, { requestId: randomUUID(), parts: [{ type: 'text', text: values.text }] })))
    } else if (s.status === 'online' && values['listen-only'] && !stopping) await new Promise(r => { const timer = setTimeout(r, seconds * 1000); process.once('SIGINT', () => { clearTimeout(timer); r() }); process.once('SIGTERM', () => { clearTimeout(timer); r() }) })
  }
} finally { await stop() }
