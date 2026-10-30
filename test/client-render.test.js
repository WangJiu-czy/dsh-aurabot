import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

function loadPage(storage) {
  let loaded
  const React = {
    Component: class {},
    createElement(type, props, ...children) {
      const allChildren = children.flat().filter((child) => child !== undefined && child !== null && child !== false)
      return { type, props: { ...(props || {}), ...(allChildren.length ? { children: allChildren.length === 1 ? allChildren[0] : allChildren } : {}) } }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
  }
  const modules = {
    load(definition) { loaded = definition },
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: modules }, localStorage: storage }, { filename: 'client.js' })
  const exports = loaded.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  let cursor = 0
  let state = []
  const config = {
    setupDone: false, enabled: false, dryRun: true, botQQ: '12345678', ownerQQ: '87654321', ownerName: '主人',
    persona: { current: 'default' }, allow: { groups: [] }, group: {}, merge: {}, model: {}, chatModels: {}, snowluma: {},
    voice: { enabled: true }, stickers: { enabled: true }, imageGen: { enabled: true }, diary: { enabled: true },
    speakUp: { enabled: true }, mood: { enabled: true }, memory: {}, song: { enabled: true }, bili: { enabled: true },
    douyin: { enabled: true }, local: {}, ext: {},
  }
  const st = {
    config, version: 'test', personas: [{ id: 'default', name: '默认人格' }], modules: [
      'voice', 'stickers', 'imagegen', 'diary', 'qzone-social', 'speakup', 'mood', 'memory', 'self-evolution', 'angel-memory', 'song', 'bili', 'douyin',
    ].map((id) => ({ id, running: true })),
    mood: { label: '平静' }, selfEvolution: { state: { energy: 72, mood: 66, socialNeed: 42, satiety: 81 }, effects: [{ name: '精神不错' }], todos: [{ title: '找主人聊聊' }] },
    onebot: { state: 'unconfigured', login: null, endpoint: {} },
    snowluma: { installed: false, running: false }, stats: {},

  }
  const draft = { ...config, ownerName: '尚未保存' }
  state = [st, '', draft]
  const render = () => {
    cursor = 0
    return exports.AurabotPage()
  }
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    return textOf(node.props?.children)
  }
  const walk = (node, fn) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach((child) => walk(child, fn))
    fn(node)
    if (node.type?.name === 'Connect' || node.type?.name === 'Access') return walk(node.type(node.props), fn)
    if (node.type?.name === 'Mood') {
      const previous = { state, cursor }
      state = []
      cursor = 0
      try { return walk(node.type(node.props), fn) } finally { state = previous.state; cursor = previous.cursor }
    }
    walk(node.props?.children, fn)
  }
  return { render, walk, textOf, state, storage }
}

for (const setupDone of [false, true]) {
  test(`client renders settings without a wizard when setupDone=${setupDone}`, () => {
    const saved = {}
    const storage = {
      getItem: (key) => saved[key] ?? null,
      setItem: (key, value) => { saved[key] = value },
    }
    const app = loadPage(storage)
    app.state[0].config.setupDone = setupDone
    let tree = app.render()
    const tabs = []
    app.walk(tree, (node) => { if (node.props?.role === 'tab') tabs.push(node) })
    assert.ok(tabs.some((node) => app.textOf(node).includes('人格')))
    assert.ok(tabs.some((node) => app.textOf(node).includes('连接')))
    assert.ok(tabs.some((node) => app.textOf(node).includes('权限')))
    assert.equal(app.textOf(tree).includes('设置向导'), false)
    assert.ok(saved['aurabot.tab'] === undefined)
    assert.ok(tabs.find((node) => node.props['aria-selected']) && app.textOf(tabs.find((node) => node.props['aria-selected'])).includes('人格'))

    const savebar = []
    app.walk(tree, (node) => { if (node.props?.className === 'ab-savebar') savebar.push(node) })
    assert.equal(savebar.length, 1)
    assert.ok(app.textOf(savebar[0]).includes('保存设置'))

    tabs.find((node) => app.textOf(node).includes('连接')).props.onClick()
    tree = app.render()
    assert.equal(saved['aurabot.tab'], 'connect')
    const connectionLabels = []
    app.walk(tree, (node) => { if (node.props?.label) connectionLabels.push(node.props.label) })
    assert.ok(connectionLabels.includes('机器人 QQ 号'))
    tabs.find((node) => app.textOf(node).includes('权限')).props.onClick()
    tree = app.render()
    assert.equal(saved['aurabot.tab'], 'access')
    const labels = []
    app.walk(tree, (node) => { if (node.props?.label) labels.push(node.props.label) })
    assert.ok(labels.includes('主人 QQ 号'))
    assert.ok(labels.includes('她怎么称呼你'))
  })
}

test('client restores a previously selected valid tab', () => {
  const app = loadPage({ getItem: (key) => key === 'aurabot.tab' ? 'connect' : null, setItem() {} })
  const tree = app.render()
  const tabs = []
  app.walk(tree, (node) => { if (node.props?.role === 'tab') tabs.push(node) })
  assert.ok(app.textOf(tabs.find((node) => node.props['aria-selected'])).includes('连接'))
})

test('心情与记忆页显示 Persona Sim 状态卡', () => {
  const app = loadPage({ getItem: (key) => key === 'aurabot.tab' ? 'mood' : null, setItem() {} })
  const tree = app.render()
  const cards = []
  app.walk(tree, (node) => { if (node.props?.title === 'Persona Sim 近况') cards.push(node) })
  assert.equal(cards.length, 1)
  assert.match(app.textOf(cards[0]), /活力.*72/)
  assert.match(app.textOf(cards[0]), /找主人聊聊/)
})

test('心情与记忆页提供天使之魂知识库卡片', () => {
  const app = loadPage({ getItem: (key) => key === 'aurabot.tab' ? 'mood' : null, setItem() {} })
  const tree = app.render()
  const cards = []
  app.walk(tree, (node) => { if (node.type?.name === 'AngelKnowledgeCard') cards.push(node) })
  assert.equal(cards.length, 1)
})
