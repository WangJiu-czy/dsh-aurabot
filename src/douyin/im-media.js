// SDK media seam: remote input never reads local paths or falls back to OneBot.
import { lookup } from 'node:dns/promises'
import { isIP, BlockList } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

const MiB = 1024 * 1024
const blocked = new BlockList()
for (const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip,bits,'ipv4')
const publicIp = ip => isIP(ip) === 4 ? !blocked.check(ip,'ipv4') : isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:(?:db8|0):/i.test(ip)
const error = code => Object.assign(new Error(code), { code })
export function mediaMime(data) {
  const b = Buffer.from(data)
  if (b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WAVE') return 'audio/wav'
  if (b.length >= 24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (b.length >= 10 && ['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))) return 'image/gif'
  if (b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && b[0]===255 && b[1]===216 && b[2]===255) return 'image/jpeg'
  if (b.subarray(0,3).toString() === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224)) return 'audio/mpeg'
  if (b.subarray(0,4).toString() === 'OggS') return 'audio/ogg'
  if (b.length >= 12 && b.toString('ascii',4,8) === 'ftyp') return 'video/mp4'
  if (b.subarray(0,5).toString() === '%PDF-') return 'application/pdf'
  return 'application/octet-stream'
}
export function createDouyinMedia({ loadProtocol = () => import('douyin-im/protocol'), roots = () => [], fetchRemote } = {}) {
  let protocol
  const sdk = () => protocol ||= Promise.resolve().then(loadProtocol)
  async function url(raw) {
    let u
    try { u = new URL(raw) } catch { throw error('MEDIA_SOURCE_INVALID') }
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw error('MEDIA_SOURCE_INVALID')
    const host = u.hostname.replace(/^\[|\]$/g,'')
    // Trusted platform CDNs or literal public addresses; arbitrary DNS names are not inbound media authorities.
    if (!isIP(host) && !['douyincdn.com','byteimg.com','ibytedtos.com','pstatp.com','bytecdn.cn','douyinpic.com'].some(d => host.endsWith('.'+d))) throw error('MEDIA_SOURCE_UNTRUSTED')
    const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await lookup(host,{all:true})
    if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw error('MEDIA_SOURCE_PRIVATE')
    return { u, address: addresses[0] }
  }
  async function remote(src, maxBytes, encrypted = false) {
    const {u,address} = await url(src)
    const options = { maxBytes, encrypted, redirect:'error', address }
    const result = fetchRemote ? await fetchRemote(u.href,options) : await new Promise((resolve,reject) => {
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { lookup: (_h,o,cb) => cb(null, o?.all ? [address] : address.address, address.family), signal: AbortSignal.timeout(20_000) }, res => {
        // Every redirect is rejected before its Location is followed.
        if (res.statusCode !== 200 || Number(res.headers['content-length'] || 0) > maxBytes) { res.destroy(); reject(error('MEDIA_HTTP_OR_SIZE')); return }
        const chunks=[]; let size=0
        res.on('data',b => { size+=b.length; if(size>maxBytes) res.destroy(error('MEDIA_TOO_LARGE')); else chunks.push(b) })
        res.on('error',reject); res.on('end',() => resolve({bytes:Buffer.concat(chunks),mime:String(res.headers['content-type'] || '').split(';')[0]}))
      })
      req.on('error',reject); req.end()
    })
    if (!(result?.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > maxBytes) throw error('MEDIA_TOO_LARGE')
    const bytes=Buffer.from(result.bytes), mime=mediaMime(bytes)
    if (!encrypted && (!result.mime || result.mime !== mime) && !(mime === 'audio/wav' && ['audio/x-wav','audio/wave'].includes(result.mime))) throw error('MEDIA_MIME_MISMATCH')
    if (encrypted && !['application/octet-stream','binary/octet-stream',...['image/png','image/jpeg','image/webp','image/gif']].includes(result.mime)) throw error('MEDIA_MIME_MISMATCH')
    return bytes
  }
  async function bytes(source, kind = 'image') {
    const limit = kind === 'image' ? 8*MiB : 30*MiB
    let b
    if (source instanceof Uint8Array) b=Buffer.from(source)
    else if (typeof source === 'string' && source.startsWith('base64://')) {
      if (source.length > Math.ceil(limit/3)*4+9) throw error('MEDIA_TOO_LARGE')
      b=Buffer.from(source.slice(9),'base64')
    } else if (typeof source === 'string' && /^https?:\/\//i.test(source)) b=await remote(source,limit)
    else if (typeof source === 'string' && isAbsolute(source)) {
      const path=realpathSync(source)
      const allowed=roots().some(root => { try { const r=relative(realpathSync(root),path); return r && !r.startsWith('..') && !isAbsolute(r) } catch { return false } })
      if (!allowed || lstatSync(source).isSymbolicLink()) throw error('MEDIA_LOCAL_SOURCE_DENIED')
      const fd=openSync(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try { const st=fstatSync(fd); if(!st.isFile() || st.size>limit) throw error('MEDIA_TOO_LARGE'); b=readFileSync(fd) } finally { closeSync(fd) }
    } else throw error('MEDIA_SOURCE_INVALID')
    if (!b.length || b.length>limit) throw error('MEDIA_TOO_LARGE')
    const mime=mediaMime(b)
    if (kind !== 'file' && !mime.startsWith(kind+'/')) throw error('MEDIA_MIME_MISMATCH')
    return new Uint8Array(b)
  }
  async function send(part, target) {
    const p=part
    if (p.type === 'image') return {type:'image',data:await bytes(p.data ?? p.file ?? p.url)}
    if (p.type === 'file') {
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length>200 || /[\\/\x00-\x1f]/.test(p.name) || ['.','..'].includes(p.name)) throw error('MEDIA_FILENAME_INVALID')
      return {type:'file-upload',data:await bytes(p.data ?? p.file ?? p.url,'file'),name:p.name}
    }
    if (p.type === 'video') return {type:'video',data:await bytes(p.data ?? p.file,'video'),cover:await bytes(p.cover,'image'),...(p.width ? {width:p.width}:{}),...(p.height ? {height:p.height}:{})}
    if (p.type === 'emoji') {
      await url(p.url)
      return {type:'emoji',url:p.url,...(typeof p.displayName === 'string' ? {displayName:p.displayName.slice(0,100)}:{})}
    }
    // A QQ mface ID is not a Douyin collection ID. Require an explicitly account-scoped SDK resource.
    if (p.type === 'sticker') {
      if (p.origin?.platform !== 'douyin' || p.origin.accountId !== target?.accountId || typeof p.sticker?.id !== 'string' || !/^\d{1,40}$/.test(p.sticker.id)) throw error('COLLECTED_STICKER_PROVENANCE_GAP')
      const sticker={id:p.sticker.id}
      for(const k of ['width','height','animate_type','origin_package_id']) if(Number.isSafeInteger(p.sticker[k]) && p.sticker[k]>=0) sticker[k]=p.sticker[k]
      for(const k of ['animate_url','static_url']) if(p.sticker[k]) {
        const urls=p.sticker[k].url_list
        if(!Array.isArray(urls) || !urls.length || urls.length>4) throw error('MEDIA_SOURCE_INVALID')
        for(const src of urls) await url(src)
        sticker[k]={uri:String(p.sticker[k].uri || '').slice(0,1000),url_list:[...urls]}
      }
      if(!sticker.animate_url && !sticker.static_url) throw error('MEDIA_SOURCE_INVALID')
      return {type:'sticker',sticker}
    }
    if (['share','photos'].includes(p.type)) {
      if (!/^\d{1,40}$/.test(p.work?.itemId || '')) throw error('MEDIA_CARD_INVALID')
      const work={itemId:p.work.itemId}
      for(const k of ['title','authorUid','authorSecUid','authorName']) if(typeof p.work[k]==='string') work[k]=p.work[k].slice(0,1000)
      if(p.work.coverUrl) { await url(p.work.coverUrl); work.coverUrl=p.work.coverUrl }
      if(Number.isSafeInteger(p.work.imageCount) && p.work.imageCount>0) work.imageCount=p.work.imageCount
      return {type:p.type,work}
    }
    if (p.type === 'link') {
      let u
      try { u=new URL(p.link?.url) } catch { throw error('MEDIA_CARD_INVALID') }
      if(!['http:','https:'].includes(u.protocol) || u.username || u.password) throw error('MEDIA_CARD_INVALID')
      const link={url:u.href}
      for(const k of ['title','description']) if(typeof p.link[k]==='string') link[k]=p.link[k].slice(0,1000)
      if(p.link.coverUrl) { await url(p.link.coverUrl); link.coverUrl=p.link.coverUrl }
      return {type:'link',link}
    }
    throw error('CAPABILITY_GAP')
  }
  async function receive(m) {
    let c=m.content
    if (!c || typeof c !== 'object') {
      if (typeof m.rawContent === 'string' || typeof c === 'string') c=(await sdk()).parseMessageContent(m.rawContent || c,m.messageType ?? m.msgType)
      else return [{type:'text',text:typeof m.text==='string' ? m.text : ''}]
    }
    if (c.kind === 'text') return [{type:'text',text:String(c.text || '')}]
    const origin={platform:'douyin',kind:c.kind,observation:'unobserved'}
    try {
      if(c.kind === 'image' || c.kind === 'emoji') {
        const image=c.image
        const source=c.kind==='emoji' ? c.url : [image?.originUrls,image?.largeUrls,image?.mediumUrls,image?.thumbUrls].flat().find(x=>typeof x==='string' && x)
        let data=await remote(source,8*MiB+28,Boolean(image?.skey))
        if(image?.skey) data=Buffer.from((await sdk()).decryptImage(data,image.skey))
        if(data.length>8*MiB || !mediaMime(data).startsWith('image/')) throw error('MEDIA_MIME_MISMATCH')
        return [{type:c.kind==='emoji'?'emoji':'image',data:new Uint8Array(data),mediaType:mediaMime(data),mediaOrigin:{...origin,observation:'bytes-validated'}}]
      }
      if(c.kind === 'audio') {
        const data=await remote(c.audio?.urls?.[0],30*MiB)
        if(!mediaMime(data).startsWith('audio/')) throw error('MEDIA_MIME_MISMATCH')
        return [{type:'audio',data:new Uint8Array(data),mediaType:mediaMime(data),mediaOrigin:{...origin,observation:'bytes-validated'}}]
      }
      if(c.kind === 'share') return [{type:'share',work:{...c.share},text:`[分享作品：${String(c.share?.title || '').slice(0,1000)} https://www.douyin.com/video/${/^\d+$/.test(c.share?.itemId || '')?c.share.itemId:''}；尚未观看]`,mediaOrigin:origin,gap:'RECEIVE_VIDEO_OBSERVATION_GAP'}]
      if(c.kind === 'video') {
        const parts=[{type:'video',text:'[收到视频：尚未解密播放或观看]',gap:'RECEIVE_VIDEO_OBSERVATION_GAP',mediaOrigin:origin}]
        if(c.video?.poster) { const poster=await receive({content:{kind:'image',image:c.video.poster}}); for(const p of poster) parts.push({...p,mediaOrigin:{...p.mediaOrigin,kind:'video-cover',observation:'cover-only'}}) }
        return parts
      }
      if(c.kind === 'file') {
        if(/^https?:\/\//i.test(c.file?.uri || '')) {
          const data=await remote(c.file.uri,30*MiB,Boolean(c.file.skey))
          if(c.file.skey) throw error('RECEIVE_FILE_DECRYPTION_GAP')
          return [{type:'file',name:String(c.file.name || '').slice(0,200),data:new Uint8Array(data),mediaType:mediaMime(data),text:'[文件附件：已取到有界字节，正文尚未解析]',mediaOrigin:{...origin,observation:'bytes-validated'}}]
        }
        throw error('RECEIVE_FILE_RESOLUTION_GAP')
      }
      if(c.kind === 'link') return [{type:'link',link:c.link,text:`[链接卡片：${String(c.link?.title || '').slice(0,1000)} ${String(c.link?.url || '').slice(0,2000)}；未读取链接正文]`,mediaOrigin:origin}]
      return [{type:c.kind || 'unknown',text:`[${c.kind || '未知'}消息：尚未观察内容]`,mediaOrigin:origin}]
    } catch(e) { return [{type:c.kind || 'unknown',text:`[${c.kind || '媒体'}内容未取得：${e.code || 'MEDIA_OBSERVATION_FAILED'}]`,gap:e.code || 'MEDIA_OBSERVATION_FAILED',mediaOrigin:origin}] }
  }
  return {send,receive,bytes}
}
