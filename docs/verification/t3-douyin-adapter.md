# T3：真实 Douyin SDK adapter（离线交付）

## 结论与边界

执行者：后端工程师；T3 / attempt `sdk-adapter-1`。T3 生产接线及离线验收完成，**不是总体 parity、媒体或真实私群验收完成**。

- 直接使用锁定的 `douyin-im@1.1.0`；生产默认调用 T1 懒加载工厂，没有替换 SDK、引入网关或自研协议。
- 全过程没有调用真实 SDK 的 `createAccount/login`，没有打开浏览器、读取真实抖音消息或向任何平台外发。测试复用 [T1 fake](../../test/helpers/fake-douyin-im.js)，仅补测试内、与发布声明一致的账号/联系人/history fixtures；没有编辑该 fake 文件。
- 已加载 persona、expert-orchestration、codebase-design、ponytail、security-and-hardening、tdd；没有联网检索、再委派或执行 commit/push/restore/checkout。
- **实际 DSH 宿主 Node/sqlite：unknown**；模块首次状态仍是 unknown。终端/测试进程的版本不是 DSH 宿主证据。
- **真实私群：WAITING_TARGETS**；**原生语音：gap**。T4 媒体、浏览器 UID 联动、jobs/schedule/后台回投仍由后续包闭环。

## 1. 改动归属与真实接线

| 产物 | T3 增量 |
| --- | --- |
| [生产 adapter](../../src/douyin/im-adapter.js) | 显式登录/退出/缓存状态、self UID 核对、registry 注册、单 message 层级、指定联系人首次基线/恢复、发送与 receipt、持久游标/请求账本、生命周期与 generation。 |
| [SDK 工厂](../../src/douyin/im-sdk.js) | 保留 T1 全部逻辑；成功时额外返回此次调用进程的 runtimeNode 与 sqlite 已检测状态。 |
| [抖音模块](../../src/modules/douyin/index.js) | 实际 setup 创建 adapter；传入同一 core.imAdapters；路由、config/onDispose 清理；SDK 目录路径延迟到显式 login 才求值。 |
| [默认配置](../../src/core/config.js) | 添加并归一化 `douyin.im.enabled:false`；保留 T2 imAccounts/personBindings 及原配置改动。 |
| [既有 duty](../../src/douyin/duty.js) | SDK 选定模式下停止旧 ownerDm 轮询/手动检查和旧 system-turn 回答；在旧异步模型返回/每次发送前再次核对，保留既有浏览/工具入口。 |
| [共享 hub](../../src/chat/hub.js) | 协调者批准的最小范围扩展：DY 自动引用回复不额外附加 auto-mention；DY 群显式数值标签转真 @。未改 QQ 名字解析、OneBot 路径或其他平台策略。 |
| [离线测试](../../test/douyin-im.test.js) | 16 项，包括生产 adapter→registry→真实共享 hub→正常 DSH 私/群会话→SDK sendMsg 的组合验证，不只是孤立 fake 发送器。 |
| [受控 smoke](../../scripts/douyin-im-smoke.mjs) | 无参 WAITING_TARGETS；help/login-only/listen-only/send-test 分离；账号、目标、正文和 SDK 默认同步范围显式门。 |

本包没有重复 `registry.subscribe`：共享 hub 已订阅 host 注入的唯一 registry；adapter 只 register/receive/send。既有 README、client、用户手册、package/lock、权限/记忆/host/registry 等未被本包写入；沿用并保留全部既有未提交内容。没有改四项范围外基线失败。

## 2. SDK 发布物静态证据与同步确认门

延续 [T1 兼容记录](../douyin-sdk-compatibility.md)，本包额外静态阅读以下发布物（不是联网资料或 live 证据）：

- [SDK account.goOnline/loadOnlineContacts](../../node_modules/douyin-im/lib/sdk/account.js#L1118-L1285)：登录建立连接、`onHistoryBatch`、seed 会话，以及自动加载好友、群、陌生人；online 事件早于联系人加载完成。
- [ChatContact 声明](../../node_modules/douyin-im/lib/sdk/contacts/chat-contact.d.ts#L20-L42) 与 [实现](../../node_modules/douyin-im/lib/sdk/contacts/chat-contact.js#L27-L66)：`getHistory({cursor,count,direction,includeCurrent})`，原始 `PrivateMessage` 和 `sendMsg`。
- [消息事件声明](../../node_modules/douyin-im/lib/sdk/events/message.d.ts#L13-L48)：threadId/senderUid/serverMessageId/index 等字段，不能将 threadId 当作用户 UID。
- [原始 history 消息结构](../../node_modules/douyin-im/lib/services/im/types.d.ts#L111-L134)：`msgId/content/msgType/indexInConversation[V2]`；和 MessageEvent 的 `serverMessageId/text/messageType` 分别处理。
- [历史分页实现](../../node_modules/douyin-im/lib/services/im/inbox.js#L95-L146)：newer/older、nextCursor 与 includeCurrent；所有 cursor/平台大 ID 保持 string，排序只用 BigInt 比较。
- [真实 text/at/reply 类型](../../node_modules/douyin-im/lib/sdk/messaging/message.d.ts#L7-L38)、[ReplyMessageOptions](../../node_modules/douyin-im/lib/services/im/content.d.ts#L101-L111)、[quote 实现](../../node_modules/douyin-im/lib/sdk/events/message.js#L121-L131)。
- [SDK receipt 判据及审核码](../../node_modules/douyin-im/lib/services/im/content.js#L273-L335)、[SendMessageError.response](../../node_modules/douyin-im/lib/sdk/errors.js#L1-L13)。
- [QR 实际结构](../../node_modules/douyin-im/lib/desktop/types.d.ts#L63-L68)：只把 qrcodeBase64 暂存到当前登录状态，不暴露 token；退出/上线清除 QR。

高层 login 没有指定好友/群历史同步范围的选项。`autoLoad:false` 只停旧账号发现，`localState:false` 只停 SDK 完整消息磁盘缓存，**都不是关闭历史/好友/群同步**。

因此每次显式 login 必须同时提交 `syncScope:'sdk-default-all'`；缺少该值先返回 `SYNC_SCOPE_CONFIRMATION_REQUIRED`，不 import SDK、不求值目录、不 createAccount/login。scope 确认不写入配置、不在下一次登录沿用。状态明确返回 SDK 内部同步范围与确认要求；脚本也先输出这一范围说明再检查显式确认 flag。当前没有执行过确认后的 live 路径。

## 3. 登录、身份与受信授权

配置示例仅作说明（占位值需用户核对后写入本地受信配置）：

```js
{
  enabled: true,
  douyin: { enabled: true, im: { enabled: true } },
  imAccounts: [{
    platform: 'douyin', accountId: 'VERIFIED_SELF_UID', enabled: true,
    ownerId: 'EXPLICIT_OWNER_UID',
    allow: { private: ['EXPLICIT_PEER_UID'], groups: ['EXPLICIT_GROUP_ID'] }
  }]
}
```

- `douyin.im.enabled` 默认 false；模块 setup、普通启动、缓存状态接口均不初始化 SDK/浏览器。SDK 工厂只在明确 login 且以上开关/受信账号命中/同步门全部满足后调用。
- `accountId` 是期望 self UID，不是可任意注册的身份：`account.uid` 与 `system.online.platformUid` 必须均为相同字符串后才注册；缺失/不一致退出并给 `SELF_UID_MISMATCH`。
- 始终从 imAccounts 读取当前账号 owner/private/group 授权；不默认开放所有会话、不回退 QQ owner。既有 `douyin.owner` 不被自动迁入主人绑定，`secUid` 或改动后未核对的 input/uid 不构成授予权限的证据。后续 UI 若迁入 ownerId，只能使用已核对的 UID。
- 私聊白名单按 peer UID 选 `pickFriend/pickStranger`；发送与 hub conversation 使用这个真实 contact 的 threadId。群使用已授权 group ID 选 `pickGroup`。不枚举未授权联系人、不将 user UID 猜成 threadId、不使用“最近聊天”。
- SDK 内部联系人尚未加载时为 waiting-contacts，随后仅重试本地选择这些明确联系人，并对其做有限 history 恢复。
- 上线注册、重连/离线注销；退出、配置禁用、取消账号授权、模块 dispose 清 listener/timer/目标映射/引用缓存/待发送等待，并调用 SDK 已公开的 client.logout（没有虚构 close）。
- 登录加载、事件队列、history await、发送前后和继续验证都带当前 generation/连接身份检查；旧账号晚到 QR/online/ACK 不覆盖新账号，也不投递新会话。

实际模块路由（沿用既有 AuraBot API 前缀）：

```text
/douyin/im/state     缓存状态，零初始化
/douyin/im/login     {accountId, syncScope:'sdk-default-all'}，QR 登录
/douyin/im/continue  {} / {smsCode} / {secUid}，仅当前显式登录流程继续验证
/douyin/im/logout    退出并清理
/douyin/state        既有浏览状态 + im 缓存，不开 SDK/浏览器
```

原浏览器 `/douyin/login` 等既有入口保持不变；SDK 登录独立于浏览器，T4 核对两侧 UID 前不声称已完成双通道联动。

## 4. 首次水位、恢复、持久去重

SDK 没有公开可靠的“此事件是历史还是实时”来源字段，因此没有发明该字段，也不靠时间窗口猜测历史。

1. 对明确授权且 SDK 已加载的 contact，首次调用 `getHistory({direction:'older',count:100})`，取返回快照中最高 sequence 及 message IDs，**整份基线原子写入，只建游标，不调用共享 hub、不回复该历史快照**。字段/响应异常保持等待，不用部分基线开始回复旧历史。
2. 此后仅对选定 contact 从持久 sequence 用 `direction:'newer', includeCurrent:true` 补收，按 BigInt sequence 排序，用完整 conversation 元组和 messageId 去重；分页保存 scan cursor，不把“第一批已读”当成后续全已读。
3. 每轮最多 100 页、每页 100 条；未恢复完保持 recovery-pending，由后续 poll 继续，不跳到实时事件最高序号从而丢掉恢复区间。
4. 实时消息只订阅账号聚合 `message`，不再同时订阅 private/group 子层级。每个事件核对授权联系人与真实 threadId；自身 platform UID/imUid 回声不进 hub。处理事件前先补该 contact 的 history。
5. 实时事件可能早于 history 可见；已接受事件记 ID，但不提升 history sequence。随后 history 补可见的较早消息，不因实时高序号永久跳过间隙；事件/恢复重复 ID 不再入 hub。恢复批次有序，不声称网络迟到时存在全局实时严格排序。
6. 每账号一个 SHA-256 命名 cursor JSON；key 为 platform/account/kind/threadId 完整元组，每会话最多 256 个 ID；总会话最多 256，达到上限明确 CURSOR_LIMIT/recovery-pending，保留既有证据而不静默重置。另有 256 项 requestId hash/receipt 账本。游标文件 0600、专用 SDK 目录由工厂校验为 0700；原子临时文件 rename。Windows ACL 仍由部署环境设定。
7. 游标只存 sequence/ID/请求 hash/receipt，不存消息正文；当前引用原文只有 256 项内存缓存。正常共享 hub 的按会话日志/记忆仍遵循 T2 既有范围，不是把聊天记录搬到新 cursor 存储。
8. listener/事件触发队列和在途发送有上限；积压触发由持久 sequence 的后续 poll 恢复。损坏/超限/权限异常游标停在错误，不覆盖成空档案。进程崩溃与 hub 接受的提交间隙不是跨进程事务式 exactly-once 承诺；本包验证的是正常重启/断线恢复持久去重和不跳过新消息。

## 5. 确切目标发送与 receipt

生产发送只对当前账号、当前 allow/owner 下的真实 contact/threadId；传入 UID、群 ID、会话/引用/消息 ID 均保留 string。发送前微任务与 await 后再次核对账号 generation/连接与目标授权，名单外目标、错把 peer UID 当 threadId、陈旧身份、dryRun 均不实际发送。

| 情况 | AuraBot receipt |
| --- | --- |
| statusCode=0，正数字符串 serverMessageId，checkCode 缺省/0/8101 | confirmed + messageId；仅服务端接受证据，不是对端读到。 |
| checkCode=8610 | failed：SDK_CONTENT_REJECTED，有发布物明确未投递证据。 |
| 10502 审核中、其他未知 checkCode、缺 ID/0 ID、普通异常、超时、连接中断、注销/切号晚 ACK | uncertain；不从异常推断“未发”，不重试、不换 QQ 补发。 |
| 本地能力/白名单/消息格式在调用 transport 前失败 | 明确 failed/code，零 transport。 |

`SendMessageError` 只读其真实 `.response` 分类，不记录/返回上游敏感异常正文。未有可核对服务端 ID 的 Promise resolve 不是成功。

可选 `message.requestId` 是 AuraBot 层的幂等账本，不假称 SDK 支持传 clientMessageId：发送前持久化 pending=uncertain，同目标/同请求/同 payload hash 重入直接返回已有 receipt（含重启后 uncertain），不同正文复用同 ID 给 REQUEST_ID_CONFLICT。最近 256 项是明确有界窗口，不承诺无限期请求 ID 保留。SDK 自己生成真实 clientMessageId；adapter 不伪造服务端 ID。

超时后 late Promise 完成不把先前 uncertain 改成成功。后续需要指定目标人工/受控收据核对；没有实现自动重发或假 ACK。T2 的拆条/工具 wrapper 继续在首个未确认结果停止，不写成功经历。

## 6. text / @ / quote 与明确差异

- text → SDK `{type:'text',text}`；mention → SDK `{type:'at',uid,name}`；quote → SDK `ReplyMessageOptions` 的 referencedMessageId/type/uid/text，引用必须命中当前账号/会话的已观察缓存，不用 messageId-only 虚构 SDK 参数。
- SDK `buildReplyPayload` 仅把纯 text 交给 buildDesktopTextContent，没有真实 mention 字段。**同条 quote+真@ 为 QUOTE_MENTION_GAP，发送前零 transport**；不先发半条、不静默删用户的显式 @，也不自行拆成两个群气泡。
- 实际组合测试暴露原共享 hub 会对自动群回复同时加 quote+auto@。协调者裁决 A 并授权最小 hub 调整：**仅 DY 已选 quote 的自动回复省略额外 auto@**。这仍是一条真实引用消息；QQ 原自动 quote+@ 保持原样，其他平台不变。
- DY 群显式 `<at:数值UID>`（1–40 位）转换为真 @，超安全整数保真；不查询 OneBot、不使用 QQ 5–12 位解析器、不猜 @昵称。未知/畸形标签保留普通文字，不假称提及成功；DY 私聊不误解析该标签。
- capabilities 明确 text/mention/quote=true，quoteMention/image/file/video/nativeVoice=false。图片、表情、卡片、视频、文件、收语音/转写等留 T4；旧网页浏览/工具保留不等于这些能力已成为 SDK media parity。

## 7. 受控 smoke 与未来实测

本包实际仅运行：

```sh
node scripts/douyin-im-smoke.mjs --help
node scripts/douyin-im-smoke.mjs
```

无参输出 WAITING_TARGETS、runtimeNode/sqlite unknown；测试另外验证有账号/模式/目录但无同步确认门也零连接、零目录写入。未来命令只作使用手册，**当前没有运行**：

```sh
# 登录前须自行理解 SDK 内部全范围同步，并显式提供确认开关。
node scripts/douyin-im-smoke.mjs --login-only \
  --account "$VERIFIED_SELF_UID" --data-dir "$PRIVATE_SDK_DIR" \
  --confirm-sdk-default-sync

node scripts/douyin-im-smoke.mjs --listen-only \
  --account "$VERIFIED_SELF_UID" --data-dir "$PRIVATE_SDK_DIR" \
  --direct "$TEST_PEER_UID" --group "$TEST_GROUP_ID" --seconds 60 \
  --confirm-sdk-default-sync

# 发送和监听分开；发送必须恰好指定一个 direct/group 和明确正文。
node scripts/douyin-im-smoke.mjs --send-test \
  --account "$VERIFIED_SELF_UID" --data-dir "$PRIVATE_SDK_DIR" \
  --direct "$TEST_PEER_UID" --text "$EXPLICIT_TEST_TEXT" \
  --confirm-sdk-default-sync
```

`--direct` 是明确 peer UID，由真实 SDK contact 解析 threadId，不是让操作者猜 threadId。login-only 传给消费表的目标为空，不额外调用联系人 history 或发送；SDK 自带内部同步仍受上文确认门约束。listen-only 不调用共享 hub 生成回答，只输出指定会话事件元数据。send-test 没有默认测试正文、不自动选最近会话，uncertain 不重试。

待指定：机器人 self UID、主人/普通私聊 peer UID、群 ID、测试窗口和约定正文。缺这些保持 WAITING_TARGETS，脚本可执行不等于真实平台通过。

## 8. 红绿、回归与可复现证据

| 阶段 | 实际结果 |
| --- | --- |
| 最初接口红 | 尚无 adapter 时 ERR_MODULE_NOT_FOUND。 |
| 登录/基线红→绿 | 新行为先失败为 DISABLED；接入后首次基线、按序恢复、单 message 层级、回声、注销重启通过。 |
| text/@/quote/receipt 红→绿 | stub 返回 uncertain，断言失败；真实 SDK 类型映射与保守分类后转绿。 |
| 模块真实接线红→绿 | 先缺路由及旧消费者 gate；setup/routes/onDispose/config 与 duty guard 接入后转绿。 |
| 共享 hub 组合红→绿 | 私/群 DSH 都创建，SDK 仅收到私聊发送（原自动 quote+@ 冲突）；经协调者 A 裁决修复，私群组合、显式 @、显式 quote+@ 零发送负例通过。 |
| SDK mention metadata 红→绿 | 按发布物 `parseTextMentions` 补 infoType/location/length 核对；畸形 richTextInfos 的假 @ 负例先红后绿。 |
| 语法与格式 | 本包 8 个 JS/MJS 文件全部 `node --check`，以及 `git diff --check`，退出 0。 |
| T3 最终新增 | 16/16 pass；网络 socket/TLS/HTTP(S)/fetch 在本文件被替换为失败函数；没有加载真实 SDK 或开浏览器。 |
| 最终 SDK+registry+hub+隔离/记忆集 | **39/39 pass**，退出 0，354.25ms；[完整输出](</tmp/aurabot-t3-targeted-final.log>)。 |
| QQ 原 autoquote+@ 定向 | **4/4 pass**，退出 0，约 6.71s；筛选群叫醒/被引用，原 e2e 明确断言 reply 与 at 段。 |
| 首次全量 | 436 tests / 432 pass / 4 fail，退出 1，约 85.50s；[输出](</tmp/aurabot-t3-all.log>)。 |
| 最终全量 | **439 tests / 435 pass / 4 fail / 0 skip**，退出 1，84.93s；较 T2 新增 16 项全部通过；[完整输出](</tmp/aurabot-t3-all-final.log>)。 |

复现命令：

```sh
node --test test/douyin-im.test.js test/douyin-sdk.test.js test/im-adapters.test.js \
  test/im-hub.test.js test/im-isolation.test.js test/im-memory-scope.test.js
node --test --test-name-pattern='群聊：|群聊被引用' test/e2e.test.js
npm test
node --check src/douyin/im-adapter.js
node --check scripts/douyin-im-smoke.mjs
git diff --check
```

最终全量四项失败与用户交接及 [T2 完整基线](t2-shared-hub.md#L100-L107) 同名、同位置、同类型：

1. [QQ 语音标记转换](../../test/e2e.test.js#L465)：约 20s 等待超时。
2. [QQ 强制语音](../../test/e2e.test.js#L580)：约 20s 等待超时。
3. [paintings Windows 绝对路径](../../test/paintings.test.js#L53)：POSIX 下路径期望不符。
4. [song Windows 路径诊断](../../test/song.test.js#L142)：POSIX 下诊断期望不符。

没有修这些范围外问题、改旧断言或声称全套全绿。无新增依赖/lock 变更，未重做网络 audit/安装；T1 已记录原锁的 audit/signatures 证据，本包没有发布操作。

## 9. T4/T5/T6 交接

- T4：双登录 UID 校验、ego-lite、媒体、原生语音 gap、jobs/schedule 与独立后台回原会话，仍为开放工作；本包不替它们签全 parity。
- T4 能力表必须记 `quoteMention:false`：DY 自动引用回复省略额外自动 @；显式两种能力组合目前报 gap，不能标记为与 QQ 完全相同。
- T5：将配置/登录/同步确认门、状态与异常、幂等窗口、目标字段及操作说明纳入用户手册/UI；真实目标未提供继续 WAITING_TARGETS。
- T6：独立核对 SDK 公共类型、首次快照/游标语义、权限撤销、generation 与 uncertain。宿主 runtime unknown、SDK 默认全范围内部同步及真实平台未测应保留为限定条件。

## 后续架构收敛（2026-10-30）

当前实现已将 SDK 消息接入移入 `src/modules/douyin-bridge`；ego-lite 浏览仍由 `src/modules/douyin` 管理。浏览器私信收件轮询和旧 system-turn 回复路径已删除，不再与共享 hub 并行消费；指定对象私信/视频分享仍保留为浏览器发送能力。详见 [ADR-0002](../decisions/0002-douyin-bridge-separation.md)。
