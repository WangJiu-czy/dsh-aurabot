import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAngelKnowledgeStore } from '../src/features/angel-knowledge.js'

function fixture(t) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'angel-knowledge-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return createAngelKnowledgeStore({ root: dir })
}

test('知识库检索只返回共享资料和当前聊天范围', (t) => {
  const store = fixture(t)
  const shared = store.add({ title: '原神角色', domain: '游戏', content: '旅行者可以在提瓦特探索七国。', scope: 'shared' })
  const local = store.add({ title: '群内约定', domain: '聊天', content: '777 群约定周五一起打本。', scope: 'group:777' })
  store.add({ title: '其他群资料', domain: '聊天', content: '777 群不应该看到这条。', scope: 'group:888' })
  const hits = store.search('提瓦特 探索', { kind: 'group', chatId: 'group:777' })
  assert.deepEqual(hits.map((x) => x.id), [shared.id])
  assert.equal(store.search('约定 周五', { kind: 'group', chatId: 'group:777' })[0].id, local.id)
  assert.equal(store.search('约定 周五', { kind: 'group', chatId: 'group:888' }).length, 0)
})

test('知识条目限制长度与范围格式', (t) => {
  const store = fixture(t)
  assert.equal(store.add({ title: '路径探测', content: '资料', scope: 'group:../private' }).code, 'INVALID_SCOPE')
  assert.equal(store.add({ title: '太长', content: 'x'.repeat(12001), scope: 'shared' }).code, 'CONTENT_TOO_LARGE')
  assert.equal(store.add({ title: { text: '伪标题' }, content: '正文', scope: 'shared' }).code, 'INVALID_TITLE')
  assert.equal(store.add({ title: '伪正文', content: { text: '对象' }, scope: 'shared' }).code, 'INVALID_CONTENT')
  assert.equal(store.list().length, 0)
})

test('面板搜索会检索预览片段之后的正文', (t) => {
  const store = fixture(t)
  const note = store.add({ title: '长资料', content: 'x'.repeat(400) + '深层关键词', scope: 'shared' })
  assert.equal(store.list('深层关键词')[0].id, note.id)
})

test('范围外的笔记无法通过 ID 读取', (t) => {
  const store = fixture(t)
  const note = store.add({ title: '私人笔记', content: '仅限主人私聊。', scope: 'private:123' })
  assert.equal(store.read(note.id, { kind: 'private', chatId: 'private:456' }), null)
  assert.equal(store.read(note.id, { kind: 'private', chatId: 'private:123' }).content, '仅限主人私聊。')
})
