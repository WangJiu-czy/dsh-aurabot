import { EventEmitter } from 'node:events'

// A deliberately partial 1.1.0 contract. Controls belong to the test, not the SDK.
export function createFakeDouyinIm() {
  const calls = { imports: 0, creates: [], logins: 0, logouts: 0, sends: [] }
  const replies = []
  const accountsById = new Map()
  const client = new EventEmitter()
  client.accounts = []
  client.login = async () => { calls.logins++; throw new Error('login forbidden in offline tests') }
  client.logout = async () => {
    calls.logouts++
    for (const account of client.accounts) await account.logout()
  }
  client.createAccount = ({ accountId } = {}) => {
    if (typeof accountId !== 'string') throw new TypeError('fake requires a string accountId')
    if (accountsById.has(accountId)) return accountsById.get(accountId)
    const account = new EventEmitter()
    // uid is unknown until an explicitly injected online fixture.
    account.uid = undefined
    account.imUid = undefined
    account.login = client.login
    account.logout = async () => {
      account.emit('system.offline')
      client.emit('system.offline', { account })
    }
    const contact = (id) => ({
      id,
      sendMsg: async (message) => {
        calls.sends.push({ accountId, id, message })
        if (!replies.length) throw new Error('missing explicit send response fixture')
        const response = replies.shift()
        if (response instanceof Error) throw response
        return response
      },
    })
    account.pickFriend = contact
    account.pickGroup = contact
    account.pickStranger = contact
    client.accounts.push(account)
    accountsById.set(accountId, account)
    return account
  }
  client.pickAccount = (id) => {
    const account = id ? accountsById.get(id) : client.accounts.length === 1 ? client.accounts[0] : undefined
    if (!account) throw new Error('account missing or ambiguous')
    return account
  }
  const sdk = { createClient: (options) => { calls.creates.push(options); return client } }
  return {
    calls, sdk, client,
    loadSdk: async () => { calls.imports++; return sdk },
    queueSendResponse: (response) => replies.push(response),
    // Payloads use upstream names; client passive messages are not wrapped in {account, data}.
    emitMessage: (account, payload) => {
      const event = { ...payload, account }
      account.emit(payload.type, event)
      account.emit('message', event)
      client.emit(payload.type, event)
      client.emit('message', event)
    },
    emitSystem: (account, name, payload) => {
      account.emit(name, payload)
      client.emit(name, { ...payload, account })
    },
  }
}
