# AuraBot Douyin Parity Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
> 上行是 writing-plans 的交接标识，不是本轮派工指令；实际执行以 expert-orchestration 协议、协调者逐项批准和独立审查为准。本轮只规划、建 draft 板，零 approve、零 spawn、零业务源码改动、零依赖安装、零抖音会话读取与外发。所有路径相对工作区根 `/opt/module/project/dsh-bot-v2/dsh-aurabot`。

**Goal:** 直接复用抖音 IM SDK 与 ego-lite 浏览器能力，使抖音私聊/群聊进入 AuraBot 现有人格、心情、记忆、权限、正常 DSH 会话与长任务链，同时保持 QQ 行为和跨平台边界。

**Architecture:** 复用现有 IM 注册表，将平台事件先规范化再送入共享 hub；保留 QQ OneBot 入口兼容层，不将抖音伪装成 QQ ID。IM SDK 管实时消息、会话及其已证实的发送能力；ego-lite 管网页浏览/互动/分享等 SDK 缺项，两者独立登录并读回 UID 校验，统一投递回执与生命周期。

**Tech Stack:** 现有 Node ESM、node:test、DSH sessionController、AuraBot 模块；已批准选型 `zhinjs/douyin-im` MIT TypeScript SDK，npm 发布版本 1.1.0（精确包名、发布入口、Node >=22.5 和 API 在 T1 验证）；参考 `lc-cn/onebots` 的 `adapters/adapter-douyin`，其网关发送仅文字/@/图片，故不引入整个网关；ego-browser/ego-lite 本地 v2.1.0 为已批准环境事实，T4 再做只读能力探测。

---

## 0. 状态、约束与证据分层

- 本计划与任务板为草案交付，板路径 `.expert-taskboards/aurabot-douyin-parity.json`；T1–T5 执行、T6 独立 review，全部保留 draft。
- 开始时运行 `pwd; git status --short`，工作区正确；`taskboard.py boards` 返回当前目录没有任务板；`docs/plans/*` 无现有文件，因此未重复建对应活跃板。
- 已有他人修改：`README.md`、`client/client.js`、`docs/USER-MANUAL.md`、`package.json`、`src/host.js`、`src/modules/API.md`、`src/modules/aurabot.d.ts`；未跟踪 `docs/IM-ADAPTERS.md`、`src/core/im-adapters.js`、`test/client-render.test.js`、`test/im-adapters.test.js`。这些是基线，不是本计划实施结果；保留全部内容，每包开工前重新核实，不覆盖、不清理。
- 禁止 `git restore`、`git checkout`、`git commit`、`git push`；本计划无提交步骤。writing-plans 的 frequent commits 与本任务明确禁令相冲突，已上报交接，提交步骤不进入执行包。PM persona 要求无实现代码，因此本文件给接口契约、测试向量和步骤，而非未核实的 SDK 实现代码。
- 已加载 graphify，检查本地无 `graphify-out/graph.json`；本轮仅允许计划/板落盘，未安装或生成图谱，直接读取指定源码作事实依据。经验池项目内无匹配文件；全局 `lessons.md` 按抖音/身份/记忆/IM/任务板关键词检索，仅命中“验收必须对照实际布局”的教训，已逐个核实路径。
- 本轮未运行业务测试：以下命令均为未来执行包的验收命令，新增测试/脚本路径均标记为拟建。未联网重做上游研究，SDK/onebots/ego 结论是用户批准输入，不冒充本轮实测。
- 当前终端 Node `v24.19.0`、Python `3.9.6`；`package.json:55–57` engines 已是 `>=22.13.0`，高于选型给定 SDK 最低值；DSH 实际宿主 Node 与 SDK 转译入口仍待 T1 核实，终端版本不替代宿主证据。

### 只读观察到的关键接缝

| 位置 | 当前事实 | 计划处理 |
| --- | --- | --- |
| `docs/IM-ADAPTERS.md:3–22`、`src/core/im-adapters.js:4–44` | registry 以 platform/accountId 隔离，conversation.kind/id 透传；只有 send/onMessage/receive，无 hub、权限或登录接线 | 扩展消费边界，不重造注册表；保留现有模块 API |
| `src/host.js:235–269,321–335` | hub 先创建，registry 之后才在 core 对象创建 | T2 先创建单一 registry 并注入 hub/core，保留未提交注册表接线，避免两份 registry |
| `src/chat/hub.js:157–229,281–323` | QQ 标题、session 映射、preset、工具和 contextProviders 已集中 | 复用正常 agentFor/mount/followup/steer，不使用 system-turn 代替聊天 |
| `src/chat/hub.js:325–387,784–934,1167–1208` | targetOf 按冒号拆 QQ ID、发送强转 Number；onMessage 强耦合 OneBot；群缓冲按裸 groupId | 在边界拆 QQ 解析和规范化消息；全量审计 map/cache/pending/turn/sentIds/mutes/群策略的键；抖音长 ID 始终 string |
| `src/chat/access.js:11–43,58–71` | ownerQQ、白名单和主人判断是 QQ 特定；主人私聊沿 ownerLevel，群 social | 添加 platform/account-aware 身份判断，旧调用维持 QQ 语义；抖音显式主人绑定沿用 ownerLevel，不自动降级 |
| `src/modules/memory/index.js:19–44`、`src/features/memory.js:58–94` | 工具/上下文共用记忆；about 为裸 ID，检索只按相关性/人物加分，无可见范围过滤 | 在索引打分/limit 前做可见性过滤；绑定人物不等于公开私密记忆 |
| `src/douyin/browser.js:123–219`、`src/douyin/site.js:116–155` | 自建 CDP 浏览器可注入 site，self() 回 uid/secUid | 复用注入缝替换 ego-lite，不重建浏览器栈；保留接口能力回归 |
| `src/douyin/duty.js:537–646` | ownerDm 轮询走 noTools system turn、独立去重并发送；与正常 hub 脱节 | T3 单一接收/发送所有权，关闭旧重复轮询路径；T4 异步通知回同一正常会话 |
| `src/modules/douyin/index.js:15–20,22–85,89–104` | 注入 hub/memory、定时 tick、工具可见性/执行权限、登录与状态路由集中 | 沿模块接缝注册 adapter/注销清理；状态只读不打开浏览器 |
| `test/e2e.test.js`、`test/helpers/{fake-dsh,mock-onebot}.js` | 现有 fake DSH/OneBot 覆盖 QQ owner、群、steer、媒体、工具和文件 | 复用测试宿主，加 fake IM SDK，不另搭网关/测试框架 |

## 1. 不可裁剪的完成定义

1. 抖音主人私聊是正常 DSH 会话，按显式绑定后的 `ownerLevel` 使用既有 full/social/chat 和长任务 preset；陌生人、其他账号、同数字 QQ 不继承主人；群始终 social。所有执行工具现场再校验权限。
2. 正常私聊/群聊支持人格、心情、相关记忆、群策略/合并、私聊 steer、DSH 手动插话与长任务；后台浏览仍可用 system turn，但其结果投递必须回原平台/账号/会话。
3. 身份键包含 platform、已登录 accountId、conversation kind/id；人物键额外包含 senderId；SDK conversationId 不等于 userId，账号 UID、secUid、conversationId 分字段。消息/引用 ID 作为 string，不做 Number 截断。
4. QQ 原 `private:<id>`/`group:<id>` 调用和既有会话映射继续有效；新跨平台内部键建议稳定元组 JSON 编码而非随意 split(':')。旧记录仅归属既有 QQ，不盲目重命名/合并；会话迁移可重入且保留旧文件/字段。
5. 人物跨平台只经显式绑定建立 canonical person；昵称/同数字不是绑定证据。解绑撤销之后的召回关联；不因绑定自动授予 owner 或共享私聊记忆。记忆范围至少 conversation、person-private、显式 shared；旧无范围记录按 QQ 兼容域处理，默认不流入抖音/群。filter 在排序/截断前，context、recall 工具、人物档案、自动整理、话题分值、日记/主动触达均使用同一范围判断。
6. 发送回执区分 confirmed/failed/uncertain（字段命名在 T1/T2 固定），confirmed 有平台消息 ID 或可核对的服务端证据。未知结果不记已送达、不写成功记忆、不跨渠道重发、不自动重复；恢复通过指定目标的收据核对。拆条仅重试明确失败且未发送部分。
7. 收消息按 platform/account/conversation/messageId 去重，过滤自身回声；SDK 断线重连不回放旧历史回复。首次开启只建立水位；有界持久游标防重启重复，不存全量历史。账号切换、注销、模块禁用取消监听/定时器/在途投递，generation token 拦晚到事件和异步结果。
8. SDK 登录不支持导入浏览器 cookie，使用其支持的登录入口独立完成；ego-lite 另登录。两侧读回 UID 相等才开启跨通道动作；缺 UID/不一致显示等待核对。凭据只存本地受限数据目录，日志/计划/回执不含 cookie/token。
9. SDK 未公开原生语音发送，能力表明确 gap，禁止把文字/音频附件称原生语音。图片/@/引用、表情、分享卡片、视频、文件、收语音分别验证；不支持项返回能力缺口或明确标注的文件/链接投递，不假成功。
10. 全量 QQ 回归 + 跨平台隔离/去重/注销/切号/不确定发送验证通过；文字 MVP 只是 T3 里程碑，不是最终交付。真实私聊与群聊验收依赖用户指定测试会话，目前缺 ID，状态为 WAITING_TARGETS。

## 2. 工作包与依赖

所有写型包顺序执行，同一共享工作树仅一名写型专家；只读 review 在所有写包后进行。每包开始 `git status --short`，读取当前 diff 和涉及函数所有调用者，复用当前未提交内容；阶段结束 progress 检查点 + bus 发 coordinator，最终正文 <=10 行。范围扩展先报协调者重排，不碰无关文件。

| ID | 工作包 / 建议领域 | 依赖 | 主要产物 | 粗估 |
| --- | --- | --- | --- | --- |
| T1 | 运行时/SDK 兼容，DevOps 自动化 + Node 集成领域 | 无 | 锁定依赖和可离线运行的 fake SDK 契约 | 0.5–1天 |
| T2 | 共享 hub/身份/权限/记忆，后端架构领域 | T1 | 规范化收发与完整隔离测试 | 2–3天 |
| T3 | 真实 IM adapter/登录/回执，后端平台集成领域 | T2 | 私群正常会话、生命周期、指定目标实测入口 | 1–2天 |
| T4 | ego-lite/媒体/主动与异步，浏览器集成领域 | T3 | 浏览器接缝、工具/媒体能力路由与异步回投 | 1–2天 |
| T5 | 集成回归/能力矩阵/文档，测试质量领域 | T4 | 全套证据、用户文档、实测等待记录 | 1–2天 |
| T6 | 独立审查，代码审查/安全审计领域（不同于实现者） | T1,T2,T3,T4,T5 | pass 或 findings + 修复要求 | 0.5–1天 |

无写包并行。T1 通过 SDK 契约检查为 M1；T2 为 M2 共享链路与隔离；T3 为 M3 私群文字闭环；T4/T5 为 M4 完整能力边界及 QQ 回归；T6 为 M5 门禁。每个里程碑协调者执行 PM 检查点，不提前宣称总体完成。

### T1：依赖、运行时、离线契约（draft）

**目标：** 验证并锁定直连 SDK，形成与上游实际发布物一致的最小边界，不引 onebots 网关。
**路径范围：** 读 `package.json`、`src/core/im-adapters.js`、`test/helpers/fake-dsh.js`；未来按需要修改 `package.json`、新增现有包管理器对应锁文件（开工先查现存锁，选一种，不混用）；拟建 `src/douyin/im-sdk.js`、`test/helpers/fake-douyin-im.js`、`test/douyin-sdk.test.js`、`docs/douyin-sdk-compatibility.md`。

按 2–5 分钟动作拆分：
1. 记录终端与实际 DSH 宿主运行时、package engines、可选 native 模块加载条件；查明 npm 精确包名、MIT LICENSE、1.1.0 export/ESM/CJS、Node 要求与发布物是否包含可执行 JS。先看离线缓存/已获批准研究材料，必要网络核实在执行期独立记录来源，不把 Git 源 TS 当 npm 导出。
2. 列出实际登录、self UID、私/群事件、发送文字/@/图片、引用、关闭/重连、回执等 API 签名及其证据；明确 SDK 无浏览器 cookie 导入、原生语音发送缺口。onebots 仅作映射参考，遵守 MIT 署名要求。
3. 先建 fake SDK 和失败测试：懒加载不开网络；缺依赖/不支持运行时给明确诊断；大整数 ID 不丢精度；事件/错误/close 可控。运行红测，不因测试模拟而访问真实抖音。
4. 加最薄 SDK 加载/工厂边界，业务权限仍留 hub；选型依赖精确锁 1.1.0，核对 lock integrity。依赖安装属于批准后的 T1，不在本规划期执行。
5. 运行绿测并落离线兼容记录，运行时/API 有不符就停在 M1 报协调者，不擅自换 SDK、自研协议或引网关。

**命令（拟建测试后）：** `node --test test/douyin-sdk.test.js test/im-adapters.test.js`；`node --check src/douyin/im-sdk.js`；`node -p "process.version"`。
**验收：** 测试全过程零联网/零登录/零外发；记录真实 npm 名/导出/Node 条件/版本/许可证；fake 不凭空扩充上游能力，模块禁用时 SDK 不初始化；依赖问题有诊断，不影响 QQ 启动。

### T2：统一收发、权限、记忆与正常会话（draft）

**目标：** 把平台差异放边界，正常会话复用既有 hub，不复制一套人格/记忆/权限实现。
**路径范围：** 修改 `src/chat/{hub,inbound,access,group-policy,chat-model}.js`（后两者仅需 platform-aware 时）、`src/core/im-adapters.js`、`src/core/config.js`、`src/host.js`、`src/features/memory.js`、`src/modules/memory/index.js`、`src/modules/aurabot.d.ts`；拟建 `src/chat/im-context.js`、`test/im-hub.test.js`、`test/im-isolation.test.js`、`test/im-memory-scope.test.js`。先读全部调用者，若模块/工具调用面超范围则报协调者列增量清单。

2–5 分钟动作清单（每个测试向量单独红→最小实现→绿）：
1. 固定规范化契约：`platform/accountId/conversation:{kind,id}/sender:{id}/messageId/parts/replyTo/timestamp`；注册表 direct 映射 hub private 仅一次；旧 QQ onMessage 仍用 parseMessageEvent，新增规范化入口汇入相同策略/合并/入 agent 流程。
2. host 提前创建一份 registry 并注入 hub/core；保留现有公开 registry 签名，只在必要处补校验。先验证 QQ 身份缺省兼容、新显式身份送到对应 adapter。
3. 新测试用同 account/conversation/sender/message 数字构造 QQ、抖音 A、抖音 B；各自 session/groupBuf/pending/running/sentIds/mutes/引用/模型设置无碰撞；SDK IDs 字符串保真。新键转换集中 im-context，不逐处复制 split/concat。
4. 权限测试覆盖主人绑定 full/social/chat 与 longTasks 组合、陌生人同 ID、群里的主人、同平台另账号；规范化身份作为可信边界字段，不接受消息正文自称 owner。旧 isOwner(cfg,userId) 仅代表 QQ，新增平台上下文路径不回退 ownerQQ。
5. 收发复用 deliver/enqueue/flush/agentFor；抖音不调用 OneBot members/typing/ASR/引用查询，平台能力缺口分支明确。群策略参数和缓存均带命名空间；保留 QQ 旧 chatId 路径和 sessions.json，不破坏现存会话。
6. 记忆先加 scope/人物显式绑定测试，再在 recall/context/profile/topic/consolidate 和工具边界统一过滤；构造“QQ 私密记忆非常相关但抖音不可见”负例，绑定后仍不可见，只有显式共享范围允许。历史无范围记录保持 QQ 兼容，迁移可重复，不修改用户原数据来满足测试。
7. 用 fake DSH 验证同一正常会话 followup、忙时 steer、工具挂载/心情/人格 context、owner 长任务 preset、DSH 手工插话；scope 与 actor 元数据必须沿整条合并/异步链保留。

**命令：** `node --test test/im-hub.test.js test/im-isolation.test.js test/im-memory-scope.test.js test/im-adapters.test.js`；`node --test test/e2e.test.js test/pure.test.js test/memory.test.js test/chat-model.test.js test/commands.test.js`。
**验收：** 同数字跨平台/账号的完整负例通过；私密记忆在打分与工具层都隔离；ownerLevel/群 social 与旧 QQ 会话不变；抖音消息经过正常 hub 而非 noTools system-turn；无重复人格/记忆引擎。

### T3：SDK adapter、正常私群与确定投递（draft）

**目标：** 注册真实抖音账号 adapter，接入正常会话并提供受控登录/指定目标实测入口。
**路径范围：** 修改 `src/douyin/im-sdk.js`、`src/modules/douyin/index.js`、`src/douyin/duty.js`、`src/core/config.js`；拟建 `src/douyin/im-adapter.js`、`test/douyin-im.test.js`、`scripts/douyin-im-smoke.mjs`。沿用数据目录与配置机制，不提交凭据。

2–5 分钟动作清单：
1. 从 T1 实际 API 创建 SDK 登录/会话加载/self UID 读回；登录身份由 self 产生，不相信面板自由填 accountId。状态接口只读缓存，显式 login 操作才建连接。
2. 先写 fake 私聊/群聊/@/reply/自回声/重连测试，再连接 registry.receive；只接已配置会话白名单的新事件。首次启动水位和重连补偿只限指定会话，不遍历所有历史；SDK 自带全局事件若存在，在入口过滤且不记录名单外正文。
3. SDK 发送统一结果 confirmed/failed/uncertain；超时、断线、已传输无 ack、部分拆条、相同 client request ID 重入分别测试。没有上游证据就不把 ID 或 ack 伪造成 confirmed；未知状态待指定收据核对，不盲重试/换 QQ 发送。
4. 在 SDK 正常消息路径启用时停用旧 duty ownerDm noTools 轮询和发送路径，防双回复；保留浏览任务但不再把正常私聊降成 system turn。
5. 显式 onDispose 关闭 SDK、移除 listener、注销 registry、取消 timers/pending；换号更新 generation，晚到旧消息/异步发送不落新账号。再次注册、注销后重注册均测试。
6. 实测脚本先实现 `--help`、默认零副作用、`--login-only`、`--account`、`--direct`、`--group`、`--listen-only`、`--send-test` 入口；账号及测试目标未显式给出返回 WAITING_TARGETS，外发需显式 send-test，不自动选择最近聊天。登录流程不顺带读历史或发测试消息。

**命令：** `node --test test/douyin-im.test.js test/douyin-sdk.test.js test/im-hub.test.js`；`node scripts/douyin-im-smoke.mjs --help`；`node scripts/douyin-im-smoke.mjs`（预期 WAITING_TARGETS、零连接/零外发）。
**未来受控实测示例，当前不运行：** `node scripts/douyin-im-smoke.mjs --login-only`；用户指定目标之后 `node scripts/douyin-im-smoke.mjs --account "$TEST_ACCOUNT_UID" --direct "$TEST_DIRECT_ID" --group "$TEST_GROUP_ID" --listen-only`；独立显式选择 `--send-test` 才做约定文本投递。所有变量必校验非空，允许清单精确匹配。
**验收：** fake 私群闭环与生命周期故障注入通过；真实实测记录服务端 self UID、指定目标、消息 ID/时间、预期/实际（脱敏）；目前未给测试 UID/私群 ID，所以真实核心私群测试标记 WAITING_TARGETS，脚本存在不等于实测通过。

### T4：ego-lite 浏览器、媒体、工具、主动与异步（draft）

**目标：** 复用 ego-lite 接缝补齐浏览/互动和可验证媒体能力，所有结果回到原正常会话。
**路径范围：** 修改 `src/douyin/{browser,site,duty,im-adapter}.js`、`src/modules/douyin/index.js`、必要的 `src/chat/hub.js` 能力分派、`src/core/config.js`；拟建 `src/douyin/ego-browser.js`、`test/douyin-ego.test.js`、`test/douyin-media.test.js`、`test/douyin-async.test.js`；`client/client.js` 仅必要状态/登录/缺口入口，不恢复被简化 UI、不覆盖已有删改，若 UI 超此范围另报协调者。

2–5 分钟动作清单：
1. 只读探测本机 ego-lite v2.1.0 实际命令/API；需要浏览器操作时加载 ego-browser 技能。本包执行期再探测，不在规划阶段启动浏览器。复用 site 注入接口，让 browser.js 封装代理到 ego-lite；按实际能力适配 evaluate/goto/screenshot/response 等，缺项写证据，不再造 CDP 或强行模拟不存在接口。
2. fake ego transport 覆盖不开浏览器读状态、已登录接回、登录等待、异常、关闭；site.self 与 SDK self UID 比较（均为 string），secUid 只辅助定位，缺 UID/不等阻止跨通道动作；切号清缓存且需重新匹配。
3. 媒体每种独立红绿：文字、真 @、图片/表情、引用、分享卡片、视频、文件、收语音/转写、发语音；以 T1 实际支持项决定 SDK 或浏览器。发送前校验 URL/文件来源、大小/MIME/可访问范围，复用既有 net/媒体边界，不让平台媒体请求读本机任意路径。
4. 原生语音发送固定 unsupported/gap；可选音频文件/链接要明确类型并测试，无声称“语音条”的 fallback。QQ 语音/表情/文件继续走原平台，不向抖音调用 QQ API。
5. 主动触达沿现有开关/时段/预算/权限，目标须完整身份；回忆/日记/分享不跨私密范围。浏览/分享工具挂载与执行时双重验证，主人 full 工具仍由正常 DSH 管理，不因接入抖音静默降级。
6. browse 完成/失败/超时/取消回调持有原 account/conversation/generation，回同一正常会话，成功通知只来自 confirmed；注销/切号后结果可本地留档但不发新号/QQ。发送不确定状态沿 T3 统一回执，不记成功事件或无提示补发。

**命令：** `node --test test/douyin-ego.test.js test/douyin-media.test.js test/douyin-async.test.js test/douyin.test.js test/vision-capability.test.js`；`node --test test/speakup.test.js test/features.test.js test/client-render.test.js`。
**验收：** fake 浏览器不开真实页面即可覆盖所有流程；原网页浏览能力回归；两登录 UID 校验通过才联动；工具/主动/异步不串账号会话；各媒体项分别有 supported/gap/待实测状态，不用文字测试覆盖冒称媒体对等。

### T5：完整集成、QQ 回归与能力文档（draft）

**目标：** 用完整证据矩阵收口，而非停在文字 MVP。
**路径范围：** 修改现有/新增 `test/{im-*,douyin-*,e2e,client-render}.test.js`、`test/helpers/{fake-dsh,fake-douyin-im}.js`；更新 `docs/IM-ADAPTERS.md`、`docs/USER-MANUAL.md`、`src/modules/API.md`、`src/modules/aurabot.d.ts`、`README.md`；拟建 `docs/douyin-capabilities.md`、`docs/verification/aurabot-douyin-parity.md`。产品版本/发布元数据不在本包自动调整。

2–5 分钟动作清单：
1. 对照第 1 节每条建立断言索引；每个缺陷补最小失败测试再修正或交相应包修复，不靠手工“看起来正常”。
2. 运行新增跨平台集成，模拟 SDK+ego+DSH+OneBot 同进程并存；验证开关/注册注销、账号切换、重启去重、异步结果/引用隔离、内存/监听器清理、凭据脱敏。
3. 运行 `npm test` 全套 QQ 回归（现 package 脚本为 `node --test "test/**/*.test.js"`），记录命令/环境/退出码/数量/耗时；失败必须分类基线/新增并有证据，不擅自改掉他人测试来变绿。重点核对 owner/full、群 social、合并/steer、语音/图片/文件、网关重连、modules 热重载与 client 简化回归。
4. 发布能力表：每行 QQ 既有 / 抖音 SDK / ego 补充 / 自动测试证据 / 指定目标实测 / 缺口。原生语音发送恒列未公开支持；其他媒体缺口不藏在“等同 QQ”标题里。
5. 文档交代双登录、UID 核对、显式主人/人物绑定、白名单/权限/记忆范围、send uncertain 核对、切号/注销、回滚为禁用新模块（保留旧数据），不写自动迁移跨平台隐私的说明。
6. 记录 live 测试 WAITING_TARGETS 和所需测试会话字段；指定目标提供后再按用户约定逐条验证主人/普通私聊/群 @、正常会话工具/长任务与投递，不扫描其他会话。不删除等待项来宣称全验收。

**命令：** `node --test test/im-*.test.js test/douyin-*.test.js`；`npm test`；`git diff --check`；`git status --short`。
**验收：** 新旧全部自动测试有结果；QQ 无新增回归；文档与代码契约一致；实测未完成就明确“离线验证完成，真实私群待指定目标”，不得宣称最终 parity 全通过。

### T6：独立 review（draft, kind=review）

**领域：** 未参与 T1–T5 写入的代码审查/安全审计专家，只读。
**范围：** 第 1 节 DoD、T1–T5 实际 diff、上游兼容记录、测试命令结果、能力表及 live 等待项。比较本轮实施增量而非把他人既有改动算作本任务；重点审 ownerLevel、群 social、记忆共享、ID 精度、注销切号、uncertain、旧双消费者和模块生命周期。
**步骤：** 读取基线与计划→独立跑 `npm test` / 新测试 / `git diff --check`→逐项核对支持项证据和 gap→输出同意/部分同意/反对、必改项和路径→由协调者安排修复与复审，不自行派工。
**门禁：** 只有明确 `done --verdict pass` 才算评审通过；needs_revision 必附 findings，遵守协议最多两轮人工回炉。可对“离线实现及受控实测入口”给限定范围结论，但核心真实私群 WAITING_TARGETS 存在时不签“总体实测通过”。本轮不执行 verdict 或 approve。

## 3. 验收矩阵与阻塞条件

| 类别 | 必测样例 | 证据 / 完成门 |
| --- | --- | --- |
| 身份隔离 | QQ 与 DY 同 ID、DY A/B 同会话/用户、group/direct 同 ID、超 JS 安全整数 ID | T2/T3 自动测试，零错投与会话串用 |
| 权限 | 主人私聊 ownerLevel 三档+longTasks、群中主人仍 social、伪主人/未绑定/解绑 | 正常 DSH preset、工具清单与执行期权限断言 |
| 人格/心情/记忆 | 共用人格/心情、私密记忆负例、人物显式绑定不扩可见范围、旧 QQ 记录 | context/recall/profile/topic/consolidate 同范围规则 |
| 正常交互 | 私聊连发/steer、群静默/@/引用/合并、DSH 插话、长任务/后台进度 | T2 fake DSH + T3 指定私群实测 |
| 投递 | confirmed/failed/uncertain、拆条部分失败、晚 ack、重连/重启重复、自身回声 | message ID / receipt / 去重断言，不以 Promise resolve 充成功 |
| 生命周期 | 禁用/热重载/注销/切号、旧 generation 晚事件与异步完成 | 无残留 listener/timer/跨号发言；旧 QQ 正常 |
| 浏览/媒体 | 双登录 UID、图/表情/@/引用/分享卡/视频/文件/收语音；发原生语音 gap | 每能力独立证据，无文本 MVP 偷换 |
| QQ 回归 | 原全部测试含 mock OneBot、媒体/文件/权限/模块/client 简化 | npm test 完整结果，不覆盖他人基线 |
| 真机范围 | SDK self、浏览器 self、指定测试私聊+群 | 当前 WAITING_TARGETS；未给定测试账号/私群目标，不执行核心实测 |

## 4. 风险、范围外与协调者决策

- SDK 发布导出/运行时/实际 API 与用户给定信息可能不符：T1 验证为前置门，失败上报，不扩大依赖或自研协议。终端 Node 满足不代表 DSH 进程满足。
- SDK 全局事件/历史同步的默认行为必须核实；只允许指定会话消费与有限游标，不将初始化同步当新消息。SDK 内部行为若超范围，应记录并暂停真实接入验证。
- ego-lite 未证实具备所有旧 CDP 能力，T4 以真实能力探测为准；页面结构变化、验证/账号状态均明确等待处理，不做重复自动点击发送。
- 原生语音发送为明确开放缺口；不承诺所有 QQ 专属群管/戳一戳/QQ 空间在抖音存在。能力协商表达差异，不把整个系统压缩成只会文字。
- 大 hub 修改影响权限、媒体、命令、记忆多个调用者；禁止只修主路径遗漏 tools/后台/日记/主动触达，T2 先查所有 caller，T5 全量回归。
- 他人未提交 IM 注册表和 client 简化与实施范围重叠：协调者按串行写锁、任务 own 工件与每包前后 diff 指纹管理；发现并发修改立即报告，不恢复/覆盖。
- 本轮不含：安装依赖、业务代码实现、凭据操作、启动真实浏览器/IM、私信/群历史浏览、点赞评论转发或任何平台外发、提交/推送、批准/派工。
- 协调者需核对并逐项 approve 草案后再派工；用户已批准技术方向不等于 PM 本轮有权批准具体任务。真实核心实测前补测试机器人 UID、主人/普通私聊会话与群会话 ID、测试窗口及约定投递内容；缺目标不阻塞离线包，但阻塞完整真机验收。SDK 精确 npm 名与导出由 T1 查证，避免猜测安装。

## 5. 本轮规划产物自检与交接

- 产出物完整：一个完整计划、五个执行草案、一个独立 review 草案；无业务代码。
- 依赖无环：T1→T2→T3→T4→T5→T6，review 同时显式依赖 T1–T5；无并行写冲突。
- 每包给出精确路径范围、可执行测试命令、预期与完成标准；新增路径为设计而非已存在断言。
- 原有 tracked diff SHA-256 基线：`99efc639769df3729b42d6d0f028f080d0bf3fc69e3633bfe680347c1358b783`；交付前复算并比对四个原未跟踪文件指纹。
- 任务板只由 taskboard.py create --draft 写入；事件流为权威，不直接编辑 JSON，不 approve/claim/spawn。bus 报告仅规划交付摘要，发往同工作区 coordinator；非平台外发。
