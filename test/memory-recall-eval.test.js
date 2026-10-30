import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createMemoryStore } from '../src/features/memory.js'
import { normalizeImMessage } from '../src/chat/im-context.js'

// Synthetic lexical-recall benchmark, not a claim of semantic paraphrase understanding.
const CASES = [
  ['episode', '我们在天文馆看过流星投影，座位K41。', '我们在天文馆看过流星投影', '还记得去天文馆那次吗？', 'K41'],
  ['episode', '我们沿海边骑过自行车，租车编号R82。', '我们沿海边骑过自行车', '海边骑自行车那回你还有印象吗？', 'R82'],
  ['episode', '我们在陶艺工坊做过杯子，釉色编号T63。', '我们在陶艺工坊做过杯子', '上次陶艺做杯子的经历还记得吗？', 'T63'],
  ['episode', '我们在屋顶看过日出，集合时间05:17。', '我们在屋顶看过日出', '说起屋顶日出，你能想起什么？', '05:17'],
  ['episode', '我们一起救助过受伤麻雀，纸箱编号B96。', '我们一起救助过受伤麻雀', '那只受伤麻雀后来让你想到什么？', 'B96'],
  ['episode', '我们在雨夜共撑过一把伞，伞牌编号U28。', '我们在雨夜共撑过一把伞', '雨夜共撑伞的事还记得吗？', 'U28'],
  ['episode', '我们在剧院听过弦乐演出，票号V74。', '我们在剧院听过弦乐演出', '剧院那场弦乐演出还有印象吗？', 'V74'],
  ['episode', '我们在山间露营煮过汤，营位C35。', '我们在山间露营煮过汤', '聊聊山间露营煮汤那次吧。', 'C35'],
  ['episode', '我们一起参加过旧书交换，摊位S19。', '我们一起参加过旧书交换', '还想得起来旧书交换活动吗？', 'S19'],
  ['episode', '我们在灯会猜过字谜，灯笼编号L57。', '我们在灯会猜过字谜', '灯会猜字谜的经历你记得多少？', 'L57'],
  ['fact', '小岚在植物园负责兰花养护。', '', '小岚平时负责兰花的什么工作？'],
  ['fact', '阿澄的宠物是一只叫团子的刺猬。', '', '阿澄养的刺猬叫什么名字？'],
  ['fact', '南枝每周三上夜间法语课。', '', '南枝的法语课安排在哪天？'],
  ['fact', '远舟的生日在十一月。', '', '远舟是几月生日来着？'],
  ['fact', '白榆住在靠近渡口的小镇。', '', '白榆住的小镇靠近哪里？'],
  ['fact', '小禾是医院的康复治疗师。', '', '小禾在医院做什么工作？'],
  ['fact', '阿鹿的自行车停在图书馆北门。', '', '阿鹿把自行车停在哪个门？'],
  ['fact', '竹青正在准备建筑师资格考试。', '', '竹青最近准备参加什么考试？'],
  ['fact', '云栖的姐姐在博物馆修复壁画。', '', '云栖的姐姐做什么修复工作？'],
  ['fact', '星野今年搬去了临海城市。', '', '星野今年搬到什么样的城市？'],
  ['preference', '小眠喜欢无糖乌龙茶。', '', '给小眠点乌龙茶需要加糖吗？'],
  ['preference', '阿棠吃面时偏爱番茄汤底。', '', '阿棠吃面更喜欢什么汤底？'],
  ['preference', '清弦听音乐时最喜欢木吉他。', '', '给清弦推荐木吉他音乐合适吗？'],
  ['preference', '暮雪旅行时习惯选靠窗座位。', '', '暮雪出行选座有什么习惯？'],
  ['preference', '小满讨厌香菜的味道。', '', '给小满做饭要避开香菜吗？'],
  ['preference', '照野比起购物更喜欢逛自然公园。', '', '周末带照野逛自然公园怎么样？'],
  ['preference', '阿梨喜欢雨声胜过白噪音。', '', '阿梨助眠喜欢听雨声还是白噪音？'],
  ['preference', '初晴玩桌游时偏爱合作解谜。', '', '初晴最喜欢哪类桌游？'],
  ['preference', '望舒穿衣时喜欢宽松亚麻。', '', '望舒喜欢什么材质和版型的衣服？'],
  ['preference', '木生周末宁愿烘焙也不想登山。', '', '木生周末想烘焙还是登山？'],
]
const chatFor = (accountId = 'A', kind = 'direct') => normalizeImMessage({ platform: 'douyin', accountId, conversation: { kind, id: 'eval-conversation' }, sender: { id: 'fictional-speaker' }, messageId: 'fixture', parts: [] })

test('synthetic Chinese store recall evaluation reports ranking, latency and zero-leak negatives', async t => {
  const prior = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-recall-eval-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (prior === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prior
    // Only remove the directory created by this fixture.
    rmSync(dir, { recursive: true, force: true })
  })
  const cfg = { memory: { enabled: true, simulation: { enabled: true }, recallCount: 6 } }
  const memory = createMemoryStore({ dsh: { get() { throw new Error('No model/network in recall eval') } }, getConfig: () => cfg, hub: {}, log: { info() {}, warn() {} } })
  const chat = chatFor(), foreign = chatFor('B'), group = chatFor('A', 'group')
  const now = Date.now(), targets = [], visibleIds = new Set(), privateDetails = []
  for (const [kind, text, gist, query, detail] of CASES) {
    const at = kind === 'episode' ? now - 30 * 86_400_000 : now
    const sourceId = `synthetic-${targets.length}`
    const result = memory.add({ text, gist, kind, source: 'auto', importance: 0.5, chat, at, ...(kind === 'episode' ? { occurredAt: at } : {}), evidence: { quote: text }, sourceRefs: [{ id: sourceId, quote: text, senderId: 'fictional-speaker', at }] })
    assert.equal(result.ok, true)
    visibleIds.add(result.id)
    targets.push({ id: result.id, query, kind, gist })
    if (detail) privateDetails.push(detail)
  }
  // Same-account group and same-sender foreign-account records are deliberately strong distractors.
  const foreignId = memory.add({ text: '黑曜石保险柜的密码编号QZX998。', kind: 'fact', chat: foreign, source: 'panel' }).id
  const groupId = memory.add({ text: '珊瑚礁行动的集合编号JGP777。', kind: 'fact', chat: group, source: 'panel' }).id
  let at1 = 0, at3 = 0, reciprocal = 0, leaks = 0, falseDetails = 0
  const times = [], misses = []
  for (const expected of targets) {
    await t.test(`${expected.kind}: ${expected.query}`, () => {
      const start = performance.now()
      const hits = memory.recall(expected.query, { chat, limit: 3 })
      times.push(performance.now() - start)
      const rank = hits.findIndex(h => h.it.id === expected.id)
      if (rank === 0) at1++
      if (rank >= 0 && rank < 3) at3++
      if (rank >= 0) reciprocal += 1 / (rank + 1)
      else misses.push(expected.query)
      leaks += hits.filter(h => !visibleIds.has(h.it.id)).length
      const serialized = JSON.stringify(hits)
      falseDetails += privateDetails.filter(detail => serialized.includes(detail)).length
      assert.equal(hits.some(h => h.it.id === foreignId || h.it.id === groupId), false)
      assert.doesNotMatch(serialized, /sourceRefs|"quote"|evidence/)
      if (expected.kind === 'episode' && rank >= 0) {
        assert.equal(hits[rank].clarity, 'gist')
        assert.equal(hits[rank].it.text, expected.gist)
      }
    })
  }
  const negatives = [
    '量子纠缠的测量原理是什么？',
    '火箭推进器的燃料配比如何？',
    '电子芯片的晶圆良率如何？',
    '南极冰盖的厚度有多少？',
    '保险柜黑曜石密码编号是什么？',
    '珊瑚礁行动集合编号是什么？',
  ]
  let falseRecalls = 0
  for (const query of negatives) {
    await t.test(`unrelated or invisible: ${query}`, () => {
      const hits = memory.recall(query, { chat, limit: 3 })
      falseRecalls += hits.length
      assert.equal(hits.length, 0)
    })
  }
  await t.test('other account and group never read direct-conversation fixture memories', () => {
    for (const context of [foreign, group]) {
      for (const expected of targets) {
        const hits = memory.recall(expected.query, { chat: context, limit: 3 })
        const exposed = hits.filter(h => visibleIds.has(h.it.id)).length
        leaks += exposed
        assert.equal(exposed, 0)
      }
    }
  })
  times.sort((a, b) => a - b)
  const p50 = (times[14] + times[15]) / 2
  const metrics = { scenarios: targets.length, negativeQueries: negatives.length, scopeNegativeQueries: targets.length * 2, recallAt1: at1 / targets.length, recallAt3: at3 / targets.length, MRR: reciprocal / targets.length, p50Ms: Number(p50.toFixed(4)), leaks, falseDetails, falseRecalls, misses }
  console.log('synthetic memory recall metrics:', JSON.stringify(metrics))
  assert.ok(metrics.recallAt3 >= 0.9, `Recall@3 below .9: ${JSON.stringify(metrics)}`)
  assert.equal(leaks, 0)
  assert.equal(falseDetails, 0)
  assert.equal(falseRecalls, 0)
})
