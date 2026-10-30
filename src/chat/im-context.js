import { AsyncLocalStorage } from 'node:async_hooks'
import { actorIsOwner } from './access.js'

export const imExecution = new AsyncLocalStorage()

// Platform identity seam. QQ legacy chat IDs remain untouched; explicit IM IDs are tuples.
export function imId(value, field = 'id') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`${field} must be a string or safe integer`)
  if (!['string', 'number', 'bigint'].includes(typeof value) || String(value) === '') throw new TypeError(`${field} is required`)
  return String(value)
}
export function imTarget(value) {
  const platform = imId(value?.platform, 'platform')
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(platform)) throw new TypeError('invalid platform')
  const accountId = imId(value?.accountId, 'accountId')
  const raw = value?.conversation
  const kind = raw?.kind === 'private' ? 'direct' : raw?.kind
  if (!['direct', 'group'].includes(kind)) throw new TypeError('invalid conversation.kind')
  return { platform, accountId, conversation: { kind, id: imId(raw.id, 'conversation.id') } }
}
export function conversationKey(value) {
  const { platform, accountId, conversation } = imTarget(value)
  return JSON.stringify([platform, accountId, conversation.kind, conversation.id])
}
export function personKey(value, senderId = value?.sender?.id ?? value?.userId) {
  const { platform, accountId } = imTarget(value)
  return JSON.stringify([platform, accountId, imId(senderId, 'sender.id')])
}
export function messageKey(value, id = value?.messageId) {
  return JSON.stringify([conversationKey(value), imId(id, 'messageId')])
}
export function targetFromChatId(chatId) {
  const text = String(chatId)
  if (text.startsWith('[')) {
    try {
      const [platform, accountId, kind, id, ...rest] = JSON.parse(text)
      if (rest.length) return null
      return imTarget({ platform, accountId, conversation: { kind, id } })
    } catch { return null }
  }
  const match = /^(private|group):(.+)$/.exec(text)
  return match ? { kind: match[1], id: match[2] } : null
}
export function normalizeImMessage(event) {
  const target = imTarget(event)
  const sender = Object.freeze({ id: imId(event?.sender?.id, 'sender.id'), name: String(event?.sender?.name || event?.sender?.id || '') })
  const parts = Array.isArray(event.parts) ? event.parts.map(p => ({ ...p })) : []
  const actor = Object.freeze({ platform: target.platform, accountId: target.accountId, senderId: sender.id })
  const kind = target.conversation.kind === 'direct' ? 'private' : 'group'
  return {
    ...target, sender, actor, parts, kind, chatId: conversationKey(target),
    userId: sender.id, groupId: kind === 'group' ? conversationKey(target) : '',
    nickname: sender.name, messageId: imId(event.messageId, 'messageId'),
    timestamp: Number(event.timestamp) || Date.now(), text: parts.map(p => p.type === 'text' ? String(p.text || '') : p.text || (p.type === 'image' ? '[图片]' : p.type === 'emoji' ? '[表情]' : '')).join(''),
    mentioned: event.mentioned === true, replyId: event.replyTo?.messageId ? imId(event.replyTo.messageId) : '',
    // Only adapter-produced bounded bytes cross into shared observation; never feed remote paths to OneBot.
    images: parts.filter(p => p.type === 'image' && p.data instanceof Uint8Array).map(p => ({ type: 'image', data: { bytes: p.data }, mediaOrigin: p.mediaOrigin })),
    stickers: parts.filter(p => p.type === 'emoji' && p.data instanceof Uint8Array).map(p => ({ type: 'image', data: { bytes: p.data }, mediaOrigin: p.mediaOrigin })),
    records: parts.filter(p => p.type === 'audio' && p.data instanceof Uint8Array).map(p => ({ type: 'record', platform: target.platform, data: { bytes: p.data }, mediaOrigin: p.mediaOrigin })),
    mediaOrigin: parts.filter(p => p.mediaOrigin).map(p => ({ ...p.mediaOrigin, ...(p.gap ? { gap: p.gap } : {}) })), forwards: [],
  }
}
export function memoryScopeFor(chat) {
  return chat?.platform ? { kind: 'conversation', ...imTarget(chat) } : undefined
}
export function memoryVisible(item, chat, cfg = {}) {
  const scope = item?.scope
  if (!scope) return !chat?.platform || (chat.platform === 'qq' && Boolean(cfg.botQQ) && chat.accountId === String(cfg.botQQ))
  if (scope.kind === 'legacy-conversation') return !chat?.platform && Boolean(chat?.chatId) && scope.chatId === chat.chatId
  if (scope.kind === 'shared') {
    // Sharing for conversation recall is distinct from publishing to a QQ feed.
    if (!chat) return scope.publishTo === 'qq-public'
    if (scope.audience === 'owner-private') return chat.kind === 'private' && actorIsOwner(cfg, chat)
    if (scope.audience === 'all-conversations') return true
    return Array.isArray(scope.audience) && scope.audience.some(a => {
      if (!a || typeof a !== 'object') return false
      if (a.platform !== chat.platform || a.accountId !== chat.accountId) return false
      if (a.senderId) return chat.kind === 'private' && a.senderId === chat.userId
      try { return conversationKey(a) === conversationKey(chat) } catch { return false }
    })
  }
  if (!chat?.platform) return false
  if (scope.kind === 'conversation') {
    try { return conversationKey(scope) === conversationKey(chat) } catch { return false }
  }
  if (scope.kind === 'person-private') return chat.kind === 'private' && scope.platform === chat.platform && scope.accountId === chat.accountId && scope.senderId === chat.userId
  return false
}
export function chatFromKey(chatId, senderId = '') {
  const target = targetFromChatId(chatId)
  if (target?.platform) return { ...target, chatId, kind: target.conversation.kind === 'direct' ? 'private' : 'group', userId: String(senderId), groupId: target.conversation.kind === 'group' ? chatId : '' }
  return { chatId, kind: target?.kind || 'private', userId: target?.kind === 'private' ? target.id : String(senderId), groupId: target?.kind === 'group' ? target.id : '' }
}
// Preserve legacy QQ results, but never mistake an explicit IM receipt object for truthy success.
export function deliveryConfirmed(value, chat) {
  return value?.status ? value.status === 'confirmed' && Boolean(value.messageId || value.serverMessageId) : !chat?.platform && Boolean(value)
}
// Adapters classify delivery; the hub accepts success only with explicit evidence.
export function normalizeReceipt(value) {
  if (value?.status === 'failed') return { status: 'failed', ...(value.code ? { code: String(value.code) } : {}) }
  if (value?.status === 'confirmed' && (value.messageId || value.serverMessageId)) return { status: 'confirmed', messageId: imId(value.messageId || value.serverMessageId) }
  return { status: 'uncertain' }
}
