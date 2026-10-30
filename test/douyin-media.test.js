import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createDouyinImAdapter } from '../src/douyin/im-adapter.js'
import { createImAdapterRegistry } from '../src/core/im-adapters.js'
import { createHub } from '../src/chat/hub.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { buildWav } from '../src/voice/wav.js'
import { conversationKey, memoryScopeFor } from '../src/chat/im-context.js'
import { createDouyinMedia } from '../src/douyin/im-media.js'
import imagegenModule from '../src/modules/imagegen/index.js'
import stickersModule from '../src/modules/stickers/index.js'
import qqToolsModule from '../src/modules/qq-tools/index.js'
import songModule from '../src/modules/song/index.js'
import { createSongStudio } from '../src/song/studio.js'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
for (const [obj,key] of [[net.Socket.prototype,'connect'],[tls,'connect'],[http,'request'],[https,'request'],[globalThis,'fetch']]) test.mock.method(obj,key,() => assert.fail('offline media test attempted network'))

const A = '9007199254740993123', U = '9007199254740993456', T = '0:1:media'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KgAAAABJRU5ErkJggg==', 'base64')
const URL = 'https://93.184.216.34/image'
const tick = () => new Promise(r => setImmediate(r))
async function until(fn) { for (let i=0;i<200;i++) { if (fn()) return; await tick() } assert.fail('expected media state') }
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-media-'))
  process.env.AURABOT_DATA_DIR = root
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: join(root, 'ws'), merge: { enabled: false }, voice: { enabled: false, asr: true }, stickers: { enabled: false }, files: { enabled: true }, douyin: { enabled: true, im: { enabled: true } }, imAccounts: [{ platform: 'douyin', accountId: A, enabled: true, ownerId: U, allow: { private: [], groups: ['777'] } }] })
  const registry = createImAdapterRegistry(), received = [], sends = [], fetches = []
  registry.subscribe(e => { received.push(e) })
  const account = new EventEmitter()
  Object.assign(account, { uid: A, imUid: 'self', login: async () => account.emit('system.online', { platformUid: A }) })
  const contact = { id: U, threadId: T, getHistory: async () => ({ statusCode: 0, messages: [], hasMore: false }), sendMsg: async p => { sends.push(p); return { statusCode: 0, serverMessageId: String(900+sends.length) } } }
  account.pickFriend = id => id === U ? contact : undefined
  account.pickStranger = () => undefined; account.pickGroup = () => undefined
  const protocol = { parseMessageContent: s => JSON.parse(s), decryptImage: b => { assert.equal(Buffer.from(b).toString(), 'encrypted'); return PNG } }
  const media = { loadProtocol: async () => protocol, roots: () => [root], fetchRemote: async (url, opts) => { fetches.push({ url, opts }); return { bytes: PNG, mime: 'image/png' } }, ...options.media }
  const im = createDouyinImAdapter({ registry, getConfig: () => cfg, dataDir: root, pollMs: 0, sendTimeoutMs: 10, createClient: async () => ({ ok: true, client: { createAccount: () => account, logout: async () => {} } }), media })
  const target = { platform: 'douyin', accountId: A, conversation: { kind: 'direct', id: T } }
  let seq = 0
  const receive = async content => { seq++; account.emit('message', { threadId: T, senderUid: U, serverMessageId: String(1000+seq), indexInConversation: String(seq), conversationType: 1, text: 'SDK fallback text', content, messageType: 2 }); await im.refresh() }
  return { root, cfg, registry, received, sends, fetches, im, account, contact, protocol, target, receive, send: m => registry.send(target,m), async start() { await im.login({ accountId: A, syncScope: 'sdk-default-all' }); await im.refresh() } }
}

test('installed public SDK contract: rich messages are single objects, byte images and file-upload supported', () => {
  const dts = readFileSync('node_modules/douyin-im/lib/sdk/messaging/message.d.ts','utf8')
  assert.match(dts, /SendableText\[\] \| RichMessage/)
  for (const type of ['image','video','emoji','sticker','file-upload']) assert.ok(dts.includes(`type: '${type}'`))
  assert.match(readFileSync('node_modules/douyin-im/lib/services/index.d.ts','utf8'), /decryptImage.*parseMessageContent/)
})
test('image travels registry to SDK as bounded bytes, not arbitrary SDK path; receipt and request ledger retained', async () => {
  const f=fixture(); await f.start()
  try {
    const message={parts:[{type:'image',data:PNG}],requestId:'image-1'}
    assert.equal((await f.send(message)).status,'confirmed')
    assert.equal(f.sends[0].type,'image'); assert.deepEqual(Buffer.from(f.sends[0].data),PNG)
    await f.send(message); assert.equal(f.sends.length,1)
  } finally { await f.im.dispose() }
})

test('each SDK rich shape is dispatched as one object; mixed and quote-media preflight sends nothing', async () => {
  const f=fixture(); await f.start()
  try {
    const mp4=Buffer.from('000000186674797069736f6d0000000069736f6d','hex')
    const cases=[
      [{type:'emoji',url:URL,displayName:'笑'}, {type:'emoji',url:URL,displayName:'笑'}],
      [{type:'sticker',origin:{platform:'douyin',accountId:A},sticker:{id:'123',static_url:{uri:'resource',url_list:[URL]}}}, {type:'sticker',sticker:{id:'123',static_url:{uri:'resource',url_list:[URL]}}}],
      [{type:'share',work:{itemId:'123',title:'作品'}}, {type:'share',work:{itemId:'123',title:'作品'}}],
      [{type:'photos',work:{itemId:'123',imageCount:2}}, {type:'photos',work:{itemId:'123',imageCount:2}}],
      [{type:'link',link:{url:'https://example.com/',title:'链接'}}, {type:'link',link:{url:'https://example.com/',title:'链接'}}],
      [{type:'file',data:Buffer.from('attachment'),name:'note.txt'}, {type:'file-upload',data:new Uint8Array(Buffer.from('attachment')),name:'note.txt'}],
      [{type:'video',data:mp4,cover:PNG,width:32,height:24}, {type:'video',data:new Uint8Array(mp4),cover:new Uint8Array(PNG),width:32,height:24}],
    ]
    for(const [part,want] of cases) { assert.equal((await f.send({parts:[part]})).status,'confirmed'); assert.deepEqual(f.sends.at(-1),want) }
    const n=f.sends.length
    assert.equal((await f.send({parts:[{type:'text',text:'caption'},{type:'image',data:PNG}]})).code,'MEDIA_COMBINATION_GAP')
    await f.receive({kind:'text',text:'quote me'})
    assert.equal((await f.send({parts:[{type:'image',data:PNG}],replyTo:{messageId:'1001'}})).code,'QUOTE_MEDIA_GAP')
    assert.equal((await f.send({parts:[{type:'text',text:'quote'}],replyTo:{messageId:'other-account-message'}})).code,'QUOTE_NOT_AVAILABLE')
    assert.equal(f.sends.length,n)
  } finally { await f.im.dispose() }
})

test('untrusted/local/oversize/sniff/symlink/traversal/cross-account media is rejected before dispatch', async () => {
  const f=fixture(); await f.start()
  try {
    const outside=join(tmpdir(),'outside-media.png'); writeFileSync(outside,PNG)
    const inside=join(f.root,'ok.png'); writeFileSync(inside,PNG)
    const link=join(f.root,'link.png'); symlinkSync(outside,link)
    const bad=[
      {type:'image',file:outside},{type:'image',file:link},{type:'image',url:'file:///etc/passwd'},
      {type:'image',url:'http://127.0.0.1/x'},{type:'image',url:'https://example.com/x'},
      {type:'image',data:Buffer.alloc(8*1024*1024+1)},{type:'image',data:Buffer.from('not-image')},
      {type:'file',data:PNG,name:'../escape.png'},
      {type:'sticker',origin:{platform:'douyin',accountId:'B'},sticker:{id:'123'}},
      {type:'record',file:inside},
    ]
    for(const part of bad) assert.equal((await f.send({parts:[part]})).status,'failed',part.type)
    assert.equal(f.sends.length,0); assert.equal(f.fetches.length,0)
    assert.equal((await f.send({parts:[{type:'image',file:inside}]})).status,'confirmed')
    assert.ok(f.sends[0].data instanceof Uint8Array)
  } finally { await f.im.dispose() }
})

test('SDK parsed image/audio kind wins over its text; encrypted bytes are decrypted before shared hub observation', async () => {
  const wav=buildWav(Int16Array.from([0,100,-100,0]),16000), admitted=[], activities=[], asr=[]
  const f=fixture({media:{fetchRemote:async (url,opts) => opts.encrypted ? {bytes:Buffer.from('encrypted'),mime:'application/octet-stream'} : url.endsWith('/audio') ? {bytes:wav,mime:'audio/wav'} : {bytes:PNG,mime:'image/png'}}})
  const fake=createFakeDsh({brain:async () => '看到了'})
  fake.ctx.attachments={admitPromptContent:async c => { admitted.push(c); return c }}
  const get=fake.ctx.get.bind(fake.ctx)
  fake.ctx.get=k => k==='speechToText' ? {resolve:({audio}) => {asr.push(audio); return {audio}},transcribe:async () => ({text:'今天的真实音频fixture'})} : get(k)
  const hub=createHub({dsh:fake.ctx,getConfig:()=>f.cfg,imAdapters:f.registry,log:{info(){},debug(){},warn(){}},onebot:{call(){assert.fail('Douyin called OneBot')}},stickers:{},tts:{},onActivity:e=>activities.push(e)})
  const off=fake.ctx.on('session/event',hub.onSessionEvent)
  await f.start()
  try {
    await f.receive({kind:'image',text:'this is NOT text',image:{skey:'ab'.repeat(32),originUrls:[URL],largeUrls:[],mediumUrls:[],thumbUrls:[]}})
    await until(()=>fake.turns.length===1)
    assert.equal(f.received[0].parts[0].type,'image')
    assert.deepEqual(Buffer.from(f.received[0].parts[0].data),PNG)
    assert.equal(admitted[0].find(x=>x.type==='image').data,PNG.toString('base64'))
    await until(()=>f.sends.length===1)
    await f.receive({kind:'audio',text:'not transcript',audio:{urls:['https://93.184.216.34/audio'],uri:''}})
    await until(()=>fake.turns.length===2)
    assert.ok(asr[0], JSON.stringify({parts:f.received.at(-1).parts,voice:f.cfg.voice,turn:fake.turns[1]}))
    assert.deepEqual(Buffer.from(asr[0]),wav)
    assert.match(fake.turns[1].userText,/今天的真实音频fixture/)
    assert.doesNotMatch(fake.turns[1].userText,/not transcript/)
    assert.ok(activities.find(e=>e.kind==='in' && e.mediaOrigin?.[0]?.kind==='audio'))
  } finally {off();hub.dispose();fake.dispose();await f.im.dispose()}
})

function moduleApi(f, hub, events=[]) {
  const factories=[]
  return {factories, config:()=>f.cfg, log:{info(){},debug(){},warn(){}}, dsh:{get(){}}, lazy:()=>({addEvent:e=>events.push(e)}), tool:fn=>factories.push(fn), route(){}, rule(){}, emit(){}, core:{hub,local:{active:k=>k==='image',call:async()=>PNG},http:{}}}
}
test('media tool callers require confirmed delivery before success/events, with complete memory chat and scope', async () => {
  const f=fixture(), events=[]
  f.cfg.imageGen.enabled=true; f.cfg.imageGen.ownerOnly=false
  f.cfg.stickers.enabled=true
  let receipt={status:'uncertain'}
  const chat={...f.target,chatId:conversationKey(f.target),kind:'private',userId:U}
  const hub={sendSegments:async()=>receipt,sendSticker:async()=>receipt,sendFile:async()=>receipt,canSeeImages:async()=>false}
  const api=moduleApi(f,hub,events)
  imagegenModule.setup(api); stickersModule.setup(api); qqToolsModule.setup(api)
  const tools=api.factories.flatMap(fn=>fn({chat,level:'full',sessionId:'s'}))
  const draw=tools.find(t=>t.name==='qq_draw_image'), sticker=tools.find(t=>t.name==='qq_send_sticker'), file=tools.find(t=>t.name==='qq_send_file')
  assert.equal((await draw.execute({prompt:'猫'})).ok,false)
  assert.equal((await sticker.execute({name:'猫'})).ok,false)
  assert.equal((await file.execute({file:'/not-read',name:'attachment'})).ok,false)
  assert.equal(events.length,0)
  receipt={status:'failed',code:'SDK_CONTENT_REJECTED'}
  assert.equal((await draw.execute({prompt:'猫'})).ok,false); assert.equal(events.length,0)
  receipt={status:'confirmed',messageId:'123'}
  assert.equal((await draw.execute({prompt:'猫'})).ok,true)
  assert.equal(events.length,1); assert.deepEqual(events[0].chat,chat); assert.deepEqual(events[0].scope,memoryScopeFor(chat))
})

test('song nativeVoice capability is checked before any expensive status/generation and preserves origin callback seam', () => {
  const f=fixture(); f.cfg.song.enabled=true
  let captures=0
  const studio=createSongStudio({getConfig:()=>f.cfg,log:{info(){},warn(){}},supportsNativeVoice:()=>false,captureDelivery:()=>{captures++; return {valid:()=>true}}})
  assert.equal(studio.request({song:'test',chatId:conversationKey(f.target)}).code,'NATIVE_VOICE_GAP')
  assert.equal(captures,0)
  assert.equal(studio.status().queue.length,0)
})
