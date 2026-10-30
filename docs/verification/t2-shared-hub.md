# T2：共享 hub、可信身份、权限与记忆范围（离线验证）

## 状态与范围

- 执行者：后端工程师；任务板 T2，attempt `shared-hub-1`。本报告为协调者批准的额外产物。
- **当前：T2 离线实现与逐项验收完成。** 本包不是抖音总体 parity 或真实私群验收；T3/T4/T5 交接项保留在第 7 节。
- 全过程离线 fake/mock：未登录 SDK、未打开浏览器、未读取抖音私信、未向任何平台发送；未执行 commit/push/restore/checkout，也未再委派。
- 已加载 persona 及 expert-orchestration、codebase-design、ponytail、security-and-hardening。persona 所指的 backend 方法文件在给定安装路径不存在；遵循已读取的 persona 正文与批准任务书执行。
- 原 scope 内实现；协调者明确批准扩展 [模块内核](../../src/core/modules.js)、[QQ 资料模块](../../src/modules/profile/index.js)、[危险确认](../../src/security/danger.js) 及其对应测试。本次额外改动对应测试为 [危险确认测试](../../test/danger-guard.test.js)，未改模块/资料既有测试。

## 1. 规范 interface 与真实接线

| 产物 | 实现与兼容性 |
| --- | --- |
| [im-context](../../src/chat/im-context.js) | 集中规范身份、conversation/person/message 元组键、消息、回执、范围判断与执行上下文；ID 保留 string，unsafe number 拒收，含冒号 ID 不 split。 |
| [registry](../../src/core/im-adapters.js) | 复用原 register/onMessage/send/receive interface；增加 subscribe 与单调 generation；receive 覆盖事件自称的 platform/account/generation，只用已注册身份；注销后晚事件失效。 |
| [host](../../src/host.js) | hub 创建前建立唯一 registry，注入 hub/core，并在返回值暴露同一 registry；卸载调用 hub.dispose。没有第二套人格/心情/记忆引擎。 |
| [hub](../../src/chat/hub.js) | 旧 onMessage 仍 parse OneBot；新 onImMessage 规范化后进入同一个 processMessage → group policy → enqueue/flush → agentFor/mount → followup/steer → deliver。 |
| [类型](../../src/modules/aurabot.d.ts) | 追加 IM 消息、actor、回执、范围及 registry 扩展声明，保留原有公开声明。 |

规范输入：`{platform,accountId,conversation:{kind:'direct'|'group',id},sender:{id,name?},messageId,parts,replyTo?,timestamp?,mentioned?}`。

- conversation 保留规范 `direct/group`；只在入口派生 hub 的 `private/group`，sender.id 从不取 threadId。
- 新 chatId 是 `JSON.stringify([platform,accountId,conversation.kind,conversation.id])`。群缓存、cooldown/engagement、引用、pending/running/busy、会话、mutes 输入及显式模型均使用这个新键；sent/received ID 额外纳入会话与消息 ID。
- QQ 旧 `private:<id>` / `group:<id>` 和现有 sessions 映射保留，没有重建、重命名或迁移旧用户文件。
- 显式模型位于 `chatModels.conversations[tupleKey]`；不继承同数字 QQ 私聊/群模型。未配置新表时不增加默认字段，保留旧 QQ 配置的精确 shape；面板整表删除同样生效。
- 新路径不读取 OneBot 群成员、群资料、引用、typing 或 ASR。规范引用/提及交给 adapter 的 `replyTo` / `parts`，不查询 QQ。
- generation 更新时清除同键的旧 pending/运行映射并归档旧规范会话，旧 session 完成事件不转投新注册。收到消息去重为有界内存集合；跨重启游标是 T3，不冒充已持久化。

## 2. actor、权限和执行门

受信本地配置：

```js
imAccounts: [{
  platform: 'douyin', accountId: 'A', enabled: true,
  ownerId: 'OWNER_SENDER_ID',
  allow: { private: ['SENDER_ID'], groups: ['CONVERSATION_ID'] }
}]
```

- `accountId` 必须命中当前注册身份；SDK self UID 的生产核对由 T3 完成，本包不把配置值冒充已登录身份。
- actor 由入口的注册 platform/account 与 sender.id 派生，忽略消息正文或 `event.actor` 自称。旧 `isOwner(cfg,userId)` 仍仅表示 QQ；新 `actorIsOwner` 从不回退 ownerQQ。
- 明确绑定的主人私聊沿既有 ownerLevel 和 longTasks 选择正常 preset；其他账号/同数字陌生人不继承；群始终 social。
- chat/actor 贯穿合并、排队、flush、steer、turn state 与异步投递。flush、push、挂载和执行现场检查 enabled、当前 allow/ownerLevel、registry generation；工具执行还重新生成可见清单并在 await 后再核实。
- host 的 `tools/pre-execute` 复核规范会话权限及工具名，覆盖完整 preset 的宿主工具；social 只准当前可见模块工具，chat 无工具。直接请求宿主终端同样受执行门约束，不仅靠 preset 或提示词控制权限。
- QQ 特定的当前聊天/资料/好友申请/群管/QQ 收藏导入操作按明确工具清单约束，**不是 `qq_` 前缀屏蔽**。平台中立工具（例如旧名 qq_draw_image）保留。明确 QQ 目标的跨渠道操作与当前 DY 会话操作不混为一谈。
- 危险确认保留开关与旧 QQ 行为；新路径绑定原账号/会话/发送者/generation，确认回复先核对受信上下文。关闭、撤权、generation 失效会取消等待（最长约 100ms 检查周期），uncertain 的确认问题不等待假成功。
- T4 的独立 jobs/schedule 子会话及后台回调尚不携带本包 turn state，见下面交接项；本包只验证正常 owner long preset 的选择，不声称后台任务完整闭环。

## 3. 记忆与发布范围

复用 [现有记忆引擎](../../src/features/memory.js) 与 [原模块](../../src/modules/memory/index.js)。

- `memoryVisible` 在索引统计、评分、排序、limit 之前执行；query 回退、context、recall 工具、profile、topic、recentEvents 与自动整理采用同一判定。
- scope 至少支持 conversation、person-private、shared；默认规范聊天写入 conversation。跨 scope 相似文本不合并，自动更新/过时也不修改另一个 scope 或可读但不属于当前会话的 shared 项。
- 旧无 scope 项仅兼容旧 QQ 域；显式 QQ 账号仅在匹配配置的 botQQ 时兼容，其他平台/账号不继承。
- 人物小档案按完整会话及人物键隔离；相处经验/说话方式按平台账号人物或群键隔离。DY 的私密说话方式不灌入 QQ 的全局 self 风格。
- `personBindings:[{personId,identities:[{platform,accountId,senderId}]}]` 只给**已经可见的共享项**关联相关性；解绑实时撤销关联。人物绑定不授 owner，不改变私密可见范围。
- shared 必须声明 audience：`owner-private`、`all-conversations` 或明确身份/会话数组；owner-private 每次现场复核绑定主人。shared 本身不等于能公开发布。
- 无上下文的后台 `memory.list/query`、recentEvents 默认旧 QQ 域；shared 只有显式 `publishTo:'qq-public'` 才可进入无会话的 QQ 发布/偏好读取域。跨平台主人共享召回不自动进入 QQ 空间或 B 站偏好。
- `hub.chatLogOf(day)` 默认旧 QQ 日志；内部逐会话整理使用 `allScopes:true`，先按完整 chatId 分组后逐组交模型，没有全量跨 scope 拼接。
- `allScopes:true` 只用于本地管理列表和内部整理；没有进入模型工具 schema 或由 event.actor 打开。面板记忆列表仍能管理所有 scope，历史内容未被改写为共享。

## 4. 投递与能力边界

- 回执固定为 confirmed / failed / uncertain；confirmed 必须有明确适配器分类及可核对字符串消息 ID。Promise resolve / statusCode=0 / 缺 ID 均不推导成功。
- uncertain 不计 sent、不记录整段 bot 成功流水、不发成功 activity、不自动重发/换渠道；拆条在第一个未确认结果停止。
- 原工具把返回对象当 truthy 成功的路径，通过受信执行上下文收集回执覆盖为 `ok:false,sent:false`；未确认投递不写成功经历。测试实际调用这个 wrapper，而不只测辅助分类函数。
- 已接好规范文字与引用/提及 interface；SDK 的真实发送分类和各媒体映射仍由 T3/T4 接线验证。
- 原生聊天语音明确 `NATIVE_VOICE_GAP`；规范文件/戳一戳等未接通路径明确 CAPABILITY_GAP，不走 QQ、不声称媒体对等。音频附件不等于原生语音。

## 5. 红绿与回归证据

| 阶段 | 命令/结果 |
| --- | --- |
| 身份 interface 红 | 新测试先报 ERR_MODULE_NOT_FOUND（尚无 im-context）。 |
| 身份/共享链绿 | 初次新测试 + pure/chat-model/commands：56/56 pass。 |
| 记忆红 | 新 scope/dedup 测试先 2 fail；实现统一范围及跨 scope 去重后转绿。 |
| 权限/记忆 | 新测试与 memory：24/24 pass；后补原目标危险确认、真实 host、绑定/解绑、逐会话整理、模型表清除和工具 uncertain。 |
| modules/profile/danger 兼容 | 定向 56/56 pass，退出 0。 |
| 收口定向（含 danger/pure/memory/chat-model/commands） | 87/87 pass，退出 0，约 23.13s；此后再增加 1 条工具 uncertain 检查。 |
| 最新 T2 指定新测试 | `node --test test/im-hub.test.js test/im-isolation.test.js test/im-memory-scope.test.js test/im-adapters.test.js`：17/17 pass，退出 0，约 149ms。 |
| 首次全量 | 422 tests / 417 pass / 5 fail；发现新 conversations 默认 shape 回归，已修复，未改旧测试。 |
| 修复后全量 | 422 tests / 418 pass / 4 fail，退出 1，约 84.60s；四项与 T1 已证实基线同名同位置。 |
| 最终工具门验证 | T2 三项 + registry + danger：23/23 pass，退出 0，233.46ms；包括 social/chat 对宿主终端直接调用的执行门。 |
| 最终指定 QQ 集 | `node --test test/e2e.test.js test/pure.test.js test/memory.test.js test/chat-model.test.js test/commands.test.js`：118 tests / 116 pass / 2 fail，退出 1，84.44s；仅两项既有 QQ 语音超时。 |
| 最终完整回归 | `npm test`：**423 tests / 419 pass / 4 fail / 0 skip**，退出 1，85.72s；只剩同四项基线，较 T1 新增 17 项全部通过。 |
| 语法与差异检查 | 所有 12 个改动 JS `node --check` 与 `git diff --check` 均退出 0。 |

完整本机运行输出（临时目录工件，不含平台会话）：[最终新测试](</tmp/aurabot-t2-new-final.log>)、[最终工具门](</tmp/aurabot-t2-gate-final.log>)、[指定 QQ 集](</tmp/aurabot-t2-qq-final.log>)、[完整回归](</tmp/aurabot-t2-all-final.log>)。一次未结算完整回归因补充 aggregate 回执消息 ID 而主动取消，未作为最终通过证据。

新增测试：

- [im-hub](../../test/im-hub.test.js)：真实共享 hub、正常工具/context、long preset、busy steer、执行前撤权、账号 generation 晚结果、uncertain、真实 host 的 memory/mood/persona、QQ 日记/B 站偏好负例、工具未确认不记成功经历。DY OneBot.call 一旦误用即测试失败。
- [im-isolation](../../test/im-isolation.test.js)：QQ/DY、DY A/B、direct/group、含冒号超大 ID、unsafe number、回执、主人/其他账号/群权限、模型隔离与清空。
- [im-memory-scope](../../test/im-memory-scope.test.js)：最相关私密项不占 limit、scope 去重、档案/context/topic、人物绑定/解绑、owner-private 共享不公开、内部逐会话整理。
- [danger-guard](../../test/danger-guard.test.js)：新增原账号/会话/发送者/generation 确认与撤权取消；既有 QQ 测试保留。

已知四项基线，不修范围外问题：

1. [e2e:465](../../test/e2e.test.js#L465)：QQ voice 标记转换等待超时。
2. [e2e:580](../../test/e2e.test.js#L580)：QQ 强制语音等待超时。
3. [paintings:53](../../test/paintings.test.js#L53)：POSIX 下 Windows 绝对路径判定。
4. [song:142](../../test/song.test.js#L142)：POSIX 下 Windows 路径诊断期望。

T1 基线为 406/402 pass、相同 4 fail；其去掉 T1 增量的隔离基线为 400/396 pass、相同 4 fail。当前所有新增失败均已在收口前修复，不用修改旧测试抹平基线。

## 6. 原有工作树保留

开工 tracked diff SHA-256：`543f078c2941f8ee9e7b390477936ec2474b67a8471c59392deb17492b94331d`。

再次逐文件 SHA-256 核对，以下与开工完全相同：README、client/client.js、用户手册、package.json、package-lock.json、模块 API 文档、IM-ADAPTERS 文档、SDK 加载器、SDK 兼容记录、批准计划。原有 SDK/fake/client/registry 测试未编辑。host、类型、registry 在保留既有未提交内容上追加/聚焦修改；没有清理他人改动。

## 7. T3/T4/T5 明确交接与非完成项

1. **T3**：SDK 生产身份 self UID 与注册 accountId 核对、指定会话消费、首次水位、持久有界游标、防历史回放、注销监听和真实状态分类。不要再次把 hub 订阅注册一遍；host 已通过 registry.subscribe 自动消费。
2. **T4**：SDK/ego 媒体、收语音观察与转写、表情/卡片/视频/文件、原生提及和引用能力的实际映射与失败表达。当前 generic parts interface 不是这些能力已实测支持的证明。
3. **T4 长任务**：正常 long preset 已离线验证，但 dsh-tool-jobs / dsh-tool-schedule 创建的独立任务/子会话、后台结果和进度回调尚需携带原 platform/account/conversation/actor/generation，执行时再复核并回原 registry 目标。未知 session 不应被当作已经继承本包权限，T4 必须补独立负例。
4. **T4 既有功能工具**：song/imagegen/stickers/bili 截图等 legacy 工具需要逐媒体验证回执和来源；本包正常工具 wrapper 阻止当前路径假成功，不替代其独立后台任务的完整核对。
5. **T5**：用户界面配置项/能力矩阵/完整文档；没有把本包内部配置数组称作已完成 UI。
6. **实际 DSH 宿主 Node/sqlite：unknown**。终端通过不替代宿主能力证据。
7. **真实私群：WAITING_TARGETS**，仍待用户提供指定测试会话。**原生语音：gap**。两者均保留，不签总体真机 parity 通过。
