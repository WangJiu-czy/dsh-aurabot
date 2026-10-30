# Douyin IM SDK 1.1.0：T1 离线兼容记录

## 范围与证据

本工作包仅建立加载边界、精确依赖锁与离线 fake，不接 hub，不读抖音会话，不登录、不向平台发送。真实 SDK 只验证根导出，未调用 `createClient`、`createAccount` 或 `login`。下面的 API 能力依据 **npm 1.1.0 发布的 JS 与声明文件静态核对**，不是平台实测通过。

- [npm 精确版本元数据](https://registry.npmjs.org/douyin-im/1.1.0)、[发布 tarball](https://registry.npmjs.org/douyin-im/-/douyin-im-1.1.0.tgz)、[上游仓库](https://github.com/zhinjs/douyin-im)。核对日期：2026-10-29。
- 包名 `douyin-im`，版本 `1.1.0`，作者 Zhin.js，维护者 `lc_cn`，npm 发布者 GitHub Actions OIDC。元数据版本发布时间 2026-10-09。
- 发布包含可执行 `lib/index.js`、声明和 sourcemap，不依赖现场 TypeScript 编译。
- `type: module`；根条件导出为 `import: ./lib/index.js`、`types: ./lib/index.d.ts`；子路径 `/base`、`/protocol`。无 `require` 条件，不承诺 CJS 加载。
- 根 `createClient(options?)` 与 `Client`、`Account`、`segment` 等已在终端通过真实 import 核验。
- 许可证 MIT，`Copyright (c) 2025-2026 Zhin.js contributors`。原包 LICENSE 与 THIRD_PARTY_NOTICES 保留在依赖中；未复制上游实现、未引入 onebots 网关或代码。[第三方参考声明](https://github.com/zhinjs/douyin-im/blob/main/THIRD_PARTY_NOTICES.md)仅作上游说明，核对依据是发布物内相同文件。

## 运行时证据与加载条件

| 层级 | 已核实结果 |
| --- | --- |
| 终端 | Node `v24.19.0`，`process.execPath=/usr/local/bin/node`；npm `11.17.0`；真实根导出与 `node:sqlite.DatabaseSync` 可导入 |
| 仓库 | [package.json](../package.json) engines 既有 `>=22.13.0`，保持原值 |
| SDK | 发布包 engines `>=22.5.0` |
| 实际 DSH 宿主 | **unknown**：本次没有实际宿主进程内的 Node 版本/内建模块证据；终端不替代 Electron/DSH 宿主证据 |

SDK 的 `lib/services/im/state-store.js:1` **静态导入 `node:sqlite` 的 `DatabaseSync`**，即使 `localState:false` 或选择 JSON 后端也要能导入。不是需运行安装脚本编译的第三方 native 模块。`ws` 的可选 native 加速 peer 未安装；不要求它们。SDK 没有未启用时的全局静态导入，因而旧 Node/缺依赖不会仅因加载 AuraBot 就触发 SDK 错误。

[src/douyin/im-sdk.js](../src/douyin/im-sdk.js) 导出 `createDouyinImClient()`：

- 默认 `enabled:false`；只有布尔 `true` 才检测运行时/加载 SDK，禁用时不 import、不建目录、不创建 client。
- 启用时在**调用所在进程**检测 Node `>=22.13.0`（稳定版本），实际动态导入 sqlite；只满足版本号不等于 sqlite 可用。
- 需要专用数据目录绝对路径，禁止根目录；创建时 mode `0700`，POSIX 已存在目录须无 group/other 权限，最终路径若为 symlink 则失败；不替他人目录改权限。Windows 需由部署侧另设用户专有 ACL。
- 强制 `autoLoad:false`，防止上游默认 `true` 扫描旧账号；强制 `localState:false`，避免默认完整消息缓存。SDK client 构造仍会建立 `accounts/_pending` 目录，但不会由这个边界登录。只允许后续 T3 显式创建账号和登录。
- 返回 `{ok:true, client}` 或 `{ok:false, code, message}`，不会输出上游异常正文/凭据；诊断码 `DISABLED`、`UNSUPPORTED_RUNTIME`、`SQLITE_UNAVAILABLE`、`INVALID_DATA_DIR`、`SDK_NOT_FOUND`、`SDK_LOAD_FAILED`、`SDK_EXPORT_MISMATCH`、`SDK_INIT_FAILED`。
- 不自动重试、换 SDK、回退 QQ 或注册业务监听。调用者须检查 `ok`，保留 QQ 独立启动；本次没有改动 QQ/hub 接线。测试注入仅用于 fake，生产应使用默认 loader/version。

## 发布物 API 契约（不是 live 能力承诺）

下列路径均位于安装后的 `node_modules/douyin-im/`。

| 项目 | 实际签名/字段 | 发布物依据 |
| --- | --- | --- |
| 工厂 | `createClient({dataDir?,autoLoad?,skipVerify?,localState?})` | `lib/sdk/client.d.ts:6-11,49`；`client.js:103-112` 默认 autoLoad=true |
| 账号 | `client.createAccount({accountId?,login?,skipVerify?,localState?})`、`pickAccount(accountId?)`、`accounts` | `lib/sdk/account.d.ts:18-33`；`lib/base/client.d.ts:19-25` |
| 登录 | `login:{method:'qr'}` / `{method:'sms',mobile}` / `{method:'password',mobile,password}`；`account.login():Promise<void>` | `lib/sdk/account.d.ts:18-27`；`lib/base/account.d.ts:32-33` |
| 继续验证 | `continueLogin()`、`continueLoginWithSms(code)`、`requestLoginSmsCode()`、`requestLoginVoiceCode()`、`continueLoginWithSubAccount({secUid?,registerNewUser?})` | `lib/sdk/account.d.ts:91-98`；短信/语音是**登录验证码**而非聊天语音 |
| 登录事件 | `system.login.qrcode` / `.qrcode.status` / `.verification` / `.error`；`system.online:{platformUid,screenName?}` | `lib/sdk/account-events.d.ts:49-73` |
| self | `account.uid`、`imUid`、`identity:{platformUid?,imUid?}`、`profile`、`getProfile()` | `lib/sdk/account.d.ts:74-78`；`lib/base/account.d.ts:9-12,27`；UID 未登录时可为空，不能把 accountId 配置当作已验证 UID |
| 私/群/陌生人 | `message.private`、`message.group`、`message.stranger`、聚合 `message` | `lib/sdk/account-events.d.ts:74-77`；同条消息有层级路由，T3 选一条消费路径 |
| 消息形状 | `threadId`、`conversationShortId`、`senderUid`、`senderSecUid?`、`serverMessageId?`、`clientMessageId?`、index/time 等均为字符串；`conversationType:1|2` | `lib/sdk/events/message.d.ts:13-39`；不把 threadId 当 userId，不做 Number 转换 |
| client 事件封装 | 被动消息直接转发 MessageEvent（含 account）；系统事件大多 `{...payload,account}`，login.error 用 `{account,error}`，offline 用 `{account}` | `lib/sdk/client.js:163-212` |
| 选择联系人 | `account.pickFriend(uid)` / `pickGroup(groupId)` / `pickStranger(uid)` 可返回 undefined | `lib/sdk/account.d.ts:104-106`；先核对已存在联系人，不猜会话映射 |
| 文本/@/图片 | `contact.sendMsg(SendableMessage)`；`segment.text(text)`、`segment.at(uid,name?)`、`segment.image(ImageInput)` | `lib/sdk/contacts/chat-contact.d.ts:37`；`lib/sdk/messaging/message.d.ts:46-65` |
| 引用 | `event.quote(text)`、`event.reply(message)`、`segment.reply(ReplyMessageOptions)` | `lib/sdk/events/message.d.ts:45-48`；引用结构按发布类型，不编造 messageId 参数 |
| 回执 | `Promise<{statusCode,statusMsg,serverMessageId?,clientMessageId?,checkCode?}>` | `lib/services/im/types.d.ts:294-300`；Promise resolve 或 statusCode=0 本身不足以证明送达 |
| 生命周期 | `client.logout()`、`account.logout()`、`client.removeAccount(accountId)`；EventEmitter `off/removeAllListeners`；没有公开 client.close() | `lib/base/client.d.ts:23-25`；`lib/base/account.d.ts:32-33` |
| 重连/异常 | `system.reconnecting:{attempt,delayMs,code?,reason?}`、`system.offline`、`system.handler.error:{event,error}` | `lib/sdk/account-events.d.ts:35-43,66-73` |

### 回执供 T2/T3 使用的约定

平台原始响应保留以上形状，fake 不新增 `confirmed` 等虚构 SDK 字段。AuraBot 适配层应单独产出 `status:'confirmed'|'failed'|'uncertain'`：只有可核对的服务端成功证据（含字符串 serverMessageId 并结合状态/checkCode 判定）才 confirmed；明确未投递失败才 failed；超时、连接丢失、缺服务端证据等为 uncertain。具体服务器判定由 T3 实证；不得仅凭异常/Promise resolve 推导“未发/已发”，不得自动重发 uncertain。T1 不实现业务发送分类器。

### 历史同步与隐私边界

`lib/sdk/account.js:1118-1267` 显示登录 goOnline 会加载应用配置、建立连接、`onHistoryBatch` 消费消息，并自动加载好友、群与陌生人会话。SDK 会过滤部分自身回声及缓存重复，但**这不是 AuraBot 首次水位/重启去重的替代品**；localState:false 时尤其不能依赖持久全量缓存。T3 必须在任何真实 login 前评估该默认同步范围、只消费指定测试会话、首次只建水位、持久化有界 cursor/generation；如默认同步超出允许范围，先报告协调者，不扩大读取范围。本次没有运行这些路径。

高层 `ClientOptions/AccountOptions/LoginOptions` 没有浏览器 cookie 导入字段；`/protocol` 存在底层 CookieJar 并不构成高层支持的导入登录入口。SDK 与 ego-lite 独立登录，各自读回 UID 并比对；缺失或不一致时不执行跨通道动作。

## 媒体能力边界

| 类型 | 1.1.0 静态公开 API | 本次验证 |
| --- | --- | --- |
| 文字/@/图片/引用 | `sendMsg`、text/at/image/reply、event.quote | 类型与实现入口核对，fake 仅模拟响应；无 live |
| 表情/贴纸 | `segment.emoji(options)`、`segment.sticker(record)` | 静态核对；无 live |
| 分享卡/链接/用户卡 | `segment.share(work)`、`link(link)`、`user(user)`、`photos(work)` | 静态核对；无 live |
| 视频 | `segment.video(Uint8Array,cover,{width?,height?}?)` | 静态核对；无 live |
| 文件 | `segment.file(FileAsset|Uint8Array,name?)` | 静态核对；无 live |
| 接收语音 | 发布解析器含 voice 内容/资源 URL 类型，需 T4 验证观察/转写及权限 | 无 live，不等于已接通 |
| **发送原生语音** | **公开 SendableMessage/segment 无 audio/voice 分支** | **明确 gap**；文件附件、链接、登录 voice code 均不等于原生聊天语音 |

## 安装边界与供应链

本目录是独立 Git 项目，无祖先 package manifest/workspace、无既有 lock/CI 配置；现有脚本使用 npm，无竞争 lock。新增唯一 [package-lock.json](../package-lock.json)（lockfile v3）并在 [package.json](../package.json) 固定 `packageManager:npm@11.17.0`、`douyin-im:1.1.0`。保留他人的 files 列表修改，不修改全局 npm 设置。

执行顺序：先 `npm view` 与 `npm pack --ignore-scripts` 静态核对；`npm install douyin-im@1.1.0 --save-exact --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org` 生成待审锁；检查所有 resolved/integrity/hasInstallScript 后，才 `npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org`。今后也必须显式 `--ignore-scripts`，本范围未新增全局/仓库 npmrc，也未批准任何生命周期脚本。

锁定完整图（15 外部包，16 lock 条目包含根）：

```text
douyin-im 1.1.0
@zhin.js/logger 1.1.2 -> chalk 5.6.2, string-width 8.3.0
string-width -> get-east-asian-width 1.7.0, strip-ansi 7.2.0 -> ansi-regex 6.5.0
protobufjs 8.8.1 -> long 5.3.2
react 18.2.0, react-dom 18.2.0 -> scheduler 0.23.2
react/scheduler -> loose-envify 1.4.0 -> js-tokens 4.0.0
ws 8.22.0
```

全部来源 `https://registry.npmjs.org/`；已检查安装后的全部 manifest，无 preinstall/install/postinstall/prepare。SDK prebuild/build 等开发命令不是 install lifecycle，未执行。无脚本批准需求。额外 React 18 是上游显式 runtime 依赖，不改 AuraBot client 外置 React 的既有配置。

SDK integrity：

```text
sha512-OMd5nk9h58dRiaDotogcQXjKX/oVPnaW9isVr79ajtepItzh0NuXWxyo6fOLZHdw4xatKsyY8yCeTCzI87kifQ==
```

`npm audit --ignore-scripts --json --registry=https://registry.npmjs.org`：退出 0，已知漏洞 0（含 high/critical 0）。`npm audit signatures --ignore-scripts --registry=https://registry.npmjs.org`：退出 0，15 registry signatures、3 attestations 已验证。这仅说明本次已知公告/签名检查结果，不保证未来版本或代码无缺陷；没有 audit fix/强制升级。

## 离线验证与复现

- [fake SDK](../test/helpers/fake-douyin-im.js) 是已核实 API 的**部分**测试替身，不模拟整个协议；测试控制器的 emit/queue 不属于 SDK API。账号 UID 默认 unknown，fake login 一旦被误用会抛错；sendMsg 只消耗显式 fixture，没有默认成功。
- [测试](../test/douyin-sdk.test.js) 覆盖禁用零导入、运行时/sqlite/缺包/导出/构造诊断、异常脱敏、数据目录、私/群/陌生人事件、超安全整数 ID、错误、logout/清监听。网络 socket/TLS/HTTP(S)/fetch 均被阻断，不加载真实 SDK、不调用 login、不触达平台。
- 先红：未创建 im-sdk 时测试失败（ERR_MODULE_NOT_FOUND），原有 registry 测试通过。后绿：`node --test test/douyin-sdk.test.js test/im-adapters.test.js` 共 7/7 通过，0 fail，0 skip（约 78ms）。
- `node --check src/douyin/im-sdk.js`、`git diff --check`：退出 0。
- 真实根导出检查仅 `await import('douyin-im')` 后断言 `typeof sdk.createClient/Client/segment.image`，网络连接/fetch 被替换为抛错函数；未构造 client，也未建立数据目录或读取凭据。

```sh
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
node --test test/douyin-sdk.test.js test/im-adapters.test.js
node --check src/douyin/im-sdk.js
npm audit --ignore-scripts --registry=https://registry.npmjs.org
npm audit signatures --ignore-scripts --registry=https://registry.npmjs.org
```

## QQ 全量回归与基线归因

额外执行 `npm test`：退出 1，406 tests / 402 pass / 4 fail / 0 skip，约 85.17s。四项失败：

| 位置 | 结果 |
| --- | --- |
| `test/e2e.test.js:465` | voice 标记转 QQ 语音，等待条件超时约 20s |
| `test/e2e.test.js:580` | 明确要语音时强制转语音，等待条件超时约 20s |
| `test/paintings.test.js:53` | POSIX 下 Windows 绝对路径 `C:\\Windows\\x.png` 未归空，期望空字符串 |
| `test/song.test.js:142` | POSIX 下 Windows 路径安装诊断返回空字符串，期望匹配“中文或空格” |

归因复核：在 `/tmp/aurabot-sdk-t1/aurabot-baseline-h2gy5gmu` 创建隔离副本，保留原有 src/test/assets/client/personas 与全部他人修改，仅排除 T1 新建加载器/fake/测试，并移除 T1 新增 manifest 两字段。恢复出的 manifest SHA-256 与开工原件完全相同；不复制 lock/node_modules。执行副本 `npm test`：退出 1，400 tests / 396 pass / **同名同位置 4 fail** / 0 skip，约 84.59s。未修范围外旧失败，T1 新增 6 测试全部通过；QQ 全套不是全绿，但未观察到新增失败。最终定向复核仍为 7/7 pass（约 64ms）。

原有 README、client、用户手册、host、模块 API/类型、IM registry/测试等十个已有文件开工与收尾 SHA-256 相同；package.json 仅添加 T1 manager/dependency 字段，保留他人 `docs/IM-ADAPTERS.md` files 条目。未修改任何 hub/业务聊天代码。

## 交接缺口

T1 只完成离线兼容边界；DSH 实际宿主运行时仍 unknown。T2/T3 负责正常 hub、身份权限记忆、生命周期与回执，T4 验证媒体/ego 补充。真实私群为 **WAITING_TARGETS**，本次未启动浏览器/IM、未读取抖音消息、未登录或外发；原生语音发送仍 gap。没有 commit/push/restore/checkout。
