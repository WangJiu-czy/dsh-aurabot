# T4 第一阶段：ego transport、同轮事务、双 UID 准备

执行者：后端工程师；attempt `ego-media-2`。**T4 仍 running；本报告是阶段交接，不是总 T4 完成或 live parity 验收。**

## 结算与共享树写冻结

本阶段已落生产接线、fake 测试与四项协调者授权的 T2/T3 返修。最终发现另一会话向同一工作树写入 memory/companion 相关内容，已立即冻结全部源码写入，未恢复、覆盖或自主融合；协调者确认本会话其他代理 inactive、这些内容来自外部并发作者，指示仅落本报告与 progress/bus 后交接。**稳定单写窗口后的集成复核仍待协调者另派。**

- 开工已有 19 个 tracked dirty 文件，`git diff --stat` 合计 415 insertions / 237 deletions，另有 T1–T3 未跟踪工件；全部保留。未重做 T1–T3 整体工作。
- 冻结时发现新增的非本包内容：[companion](../../src/features/companion.js)、[memory-dynamics](../../src/features/memory-dynamics.js)、[memory-pending](../../src/features/memory-pending.js)、[memory module](../../src/modules/memory/index.js)、[mood module](../../src/modules/mood/index.js)、[memory-dynamics tests](../../test/memory-dynamics.test.js)、[memory-pending tests](../../test/memory-pending.test.js)、[memory-simulation tests](../../test/memory-simulation.test.js)。[memory](../../src/features/memory.js)、[hub](../../src/chat/hub.js)、[config](../../src/core/config.js) 也出现额外非本阶段增量。它们不计入本包产出。
- 开工没有保存逐文件 SHA-256，故没有可声称的“并发前精确指纹”；上面的初始 status/stat 与本会话 read 结果是前快照。冻结后指纹见末节；不可把当前混合工作树整体 diff 当成本包 diff。
- 未执行再委派、commit、push、restore、checkout、安装依赖或修改 node_modules。

## 1. 本阶段增量与真实接线

| 文件 | 本阶段自己的增量 |
| --- | --- |
| [ego-browser](../../src/douyin/ego-browser.js) | ego-lite adapter；固定 `spawn('ego-browser',['nodejs'],{shell:false})`，脚本走 stdin；完整新进程 round；TaskSpace ID/p1 复用；同轮 `runAction`；有界 IO/超时/脱敏/截图 dataURI/用户控制。 |
| [browser](../../src/douyin/browser.js) | `createBrowser` 默认 ego-lite；旧实现重命名 `createLegacyBrowser`，仅 `backend:'legacy-cdp'` 显式选择；无 silent fallback；legacy 实现同一 `runAction` seam。原 pickPage/findBrowser/端口等导出保留。 |
| [site](../../src/douyin/site.js) | 追踪全部 browser caller 后，原五处 `waitResponse→操作→await` 全移至 `runAction`；DM 第二次按钮重试删除；self UID string 缓存；DM/share 保守收据核对；新增 wait 注入供 fake。 |
| [duty](../../src/douyin/duty.js) | 默认 factory 接线、browser 注入/懒 dispose、ready/login 网页 uid 缓存、SDK cached accountId 比对与只读 identity 状态；不确定分享不静默 QQ 补发/不重复发送；预选 both 独立保留。原 T3 SDK 停旧 DM consumer guard 保留。 |
| [config](../../src/core/config.js) | 仅新增/归一化 `douyin.browserTransport:'ego-lite'`；明确 legacy-cdp 可选。其他已有及并发配置增量不属本包。 |
| [module](../../src/modules/douyin/index.js) | 加 ego 文件到模块清单；注入 `getImState:()=>im.state()`；dispose 浏览 adapter。SDK 工厂/登录能力没有替换。 |
| [ego tests](../../test/douyin-ego.test.js) | 10 个离线测试，通过新进程作用域 fake runner 执行真实生成脚本，并覆盖 factory、CLI、事务、UID、未知投递。 |

### CLI 与浏览器契约

- 已运行 `ego-browser skill`，保存后用 read 读完 550 行到 `[ego-browser:skill] end of guide v2.1.0`。没有用技能说明代替实现，也没有导入 Playwright 或另开 Chrome。
- 只有 own TaskSpace ID 与 Page 标签持久；不保存 Promise、JS 变量或 targetId；一个目标稳定名称，后续通过 spaceId 回同空间/p1。TaskSpace 用户接管、失活、unassigned/name collision 映射暂停，不创建替代空间、自动 claim/takeOver 或浏览用户空间。
- page.events 是公开 CDP 缓冲数组，不是 EventEmitter。每个 `runAction` 在一个 CLI round 中 Network.enable → drain → dispatch → bounded events polling → getResponseBody；响应体和事件数有上限。普通 evaluate/goto/waitFor/keyboard/press/click/screenshot 均有映射。
- 脚本输入 128 KiB、stdout+stderr 总输出 8 MiB、普通 runner 30s（封顶60s）、响应体1 MiB、PNG4 MiB。生产 runner 分别处理两流 UTF-8 行，仅提取协议前缀 JSON 帧；stderr 非协议诊断丢弃，重复帧、截断帧、非法形状和超限均失败，不泄上游异常正文。
- **协调者实际 CLI 探针证实 marker 在 stderr 而非 stdout**，本阶段据此修复，新增 stderr-only/混合无关日志/双帧/截断/超限 fake 回归。只读普通状态和未 open 的 dispose 均零 runner。
- `page.evaluate` 没有 timeout 参数。外层 timeout/CLI kill **不声称浏览器已中止**，`executionStopped:false`、`mayHaveLateEffects:true`；未知执行后冻结 unsafe 操作，连 goto 也不作为超时重试。已结束的 page 错误允许明确 goto 在同空间恢复；不自动重放原动作。
- show(true) 是 handOff 用户控制，不是挪窗口；show(false) 不自动抢回空间。暂停后需用户/宿主明确协调控制权，本阶段没有新增自动接管入口。cleanup 只 own task/Page，不 kill ego；截图读自己创建的 private tmp leaf，no-follow/有界读/PNG头校验，再转原 dataURI 契约。

### 公共 transport 实证与误 CLI 记录

1. **本执行专家没有执行真实抖音浏览、SDK login、账号读取或平台外发。**浏览器交互功能的验证用注入 fake runner。
2. 但本阶段曾发生一次意外 CLI 尝试：首次接入 module dispose 时，未 open 的 close 仍生成生产 round。`douyin-im` 模块测试因此报 `EGO_PROCESS_ERROR`，当次组合 62 tests / 61 pass / 1 fail。没有成功开页/读取账号/外发；不能把本阶段说成“完全零 CLI 尝试”。已修复 close 在无 spaceId 时直接 resolve，并新增零 runner 回归；重跑通过。
3. 协调者另行执行受限公共 probe（非本专家操作）：`help('page.events')` 明确 read-and-clear buffered CDP events；公共 api.github.com transport 专用空间22返回 `ownership:'agent'`、p1、Array103 events，event keys `method/params/sessionId`，responseReceived/ loadingFinished 含 requestId；最后 await finish keep[] 关闭。这里只采用其公开 transport 形状实证，**不是抖音网页或 IM 实测**。未把整个公共响应/账号内容落盘。

## 2. 同轮业务操作与未知投递

- 点赞/评论由 network response 的明确 `status_code:0` 判定，原验证 header 检查保留。CLI action receipt 本身不是业务成功。
- 网页 DM/share 的 HTTP200、空 body、未解析 binary body 都不是 IM 应用 ACK。本阶段不猜网页二进制协议、不新增媒体解析；只有当前 account UID + 精确 peer conversation + startedAt 之后 + before snapshot 未出现的正数字符串 server message ID + mine/sender/正文或视频ID匹配，才返回已确认。
- 单纯正文回显、输入框清空、页面“捎句话/已分享”标签都不算新 confirmed。无法取得上述证据时 `dm_uncertain`，无第二次 Enter/按钮、不自动重发、不写成功经历。
- duty 的 unknown share 不 fallback QQ；明确预选 both 仍可执行其独立 QQ 分支。未知视频 ID 存 bounded `uncertainDy`（300项），同一已记录未知分享不会在 ownerAsked fallback 或后次调用中自动重复；指定收据核对/清理入口留后续阶段。
- 原 duty/site fake 契约保留，但没有靠 fake 特殊分支虚构生产 ACK。旧 [douyin tests](../../test/douyin.test.js) 没有改断言；新增真实 site seam 负例覆盖无回应/HTTP200-empty/HTTP200-binary 均单次 dispatch，正例依赖匹配服务端消息 ID。
- 网页 share 当前视频页通常没有可核的当前会话消息，因而很可能保守返回 uncertain；这是明确待后续受控证据验证的行为，不宣称网页分享 parity 已完成。

## 3. 双 UID 准备

- ready 和 loginStep 账号缓存新增 `uid`；只接受十进制 string，大 ID 保真；缺失、numeric precision loss、secUid/imUid 都不当作真实网页 UID。
- 读取 T3 adapter 后确认：`state().accountId` 只在 `account.uid` 与 `system.online.platformUid` 双核通过后写入，退出时清空。故本阶段复用这个已验证 accountId 缓存，不擅改 SDK state/能力。
- `identity` 要网页 uid 和 cached SDK accountId 非空且相等，SDK状态属于当前在线/恢复阶段；缺UID或不一致都 false。SDK模式 ready 在操作前挡下未核对状态；`/douyin/state` 与普通 account(false) 仅缓存，零 open。
- 这里只完成双登录准备/门，不是后台 generation、权限、原会话回投完整闭环。账号可能变化时的后续异步业务撤销仍属下一阶段。

## 4. 协调者授权的 T2/T3 返修

四项都是协调者先独立核实并扩 scope，之后由本唯一写型执行专家最小实施；未重新设计既有工作包。

1. **SDK页宽（T3）**：[im-adapter](../../src/douyin/im-adapter.js) baseline/recovery 两处 count100→50；实际 SDK发布物 pageSize 限1..50。测试 fake 拒绝>50，300条分页按 opts.count。红 `recovery-pending != online` → 绿17/17。
2. **撤权游标（T3）**：getHistory 前后、consume 开始/await后及分页提交前重核 allowedContact 当前权限；撤 group allow 时不 receive/不提交 baseline/不推进seq或IDs。挂起baseline/recovery→撤权→恢复后重放负例红→绿，im18/18。
3. **旧sid（T2）**：[hub](../../src/chat/hub.js) 在 sessions map 持久记录已知 IM origin `imSessions`；generation reset/manual reset 后不丢来源，旧sid fail-closed，普通未知本地 DSH 与legacyQQ合同不变。旧social挂起→换代→旧sid bash/probe deny/不回投、hub reload 后仍deny。红 true→false，hub8/8。
4. **派生profile（T2）**：[memory](../../src/features/memory.js) IM profile 存 source IDs+text/about/identity/scope指纹；profileOf/contextFor/buildProfile旧档案入口以及模型await后重核来源可见/有效/当前绑定。源撤owner、解绑、删除、invalid、修改正文都隐藏旧派生资料、不再喂旧敏感profile给模型；没有可核来源的IM旧/手工profile保守隐藏，legacyQQ旧手工兼容。旧测试该处断言明确调整为保守语义；memory与scope20/20。

注意 `imSessions` 来源元数据必须随 session 生命周期保留，不能按活跃 turn 清理；本阶段未实现历史来源压缩。profile来源仅依赖元数据/指纹，不另复制原文；源变化后先隐藏，后续明确build可重建。

## 5. 可复现验证

终端 Node v24.19.0；这不是实际 DSH 宿主 Node/sqlite 证据。

| 验证 | 实际结果与日志 |
| --- | --- |
| transport 最初缺模块红 | [red](</tmp/aurabot-t4-transport-red.log>)；后续factory红与完整fake脚本6/6绿。 |
| site cross-round seam红 | [red](</tmp/aurabot-t4-site-red.log>)，waitResponse fake明确失败；已全部迁移同轮。 |
| SDK页宽/撤权/旧sid/profile红绿 | `/tmp/aurabot-t4-{sdk-page,revoke,origin,profile}-{red,green}.log`，分别有实际红失败与绿结果；不是只写stub。 |
| 用户要求三文件最终 | `node --test test/douyin-ego.test.js test/douyin.test.js test/douyin-im.test.js`：**65/65 pass**，exit0，333.37ms；[日志](</tmp/aurabot-t4-requested-final.log>)。 |
| 五组扩展定向 | 加 im-hub/im-memory-scope：**79/79 pass**，exit0，302.89ms；[日志](</tmp/aurabot-t4-targeted.log>)。该次之后进一步加严了frame schema/超时goto/分享标签/serverId处理，三文件65最终已涵盖；并发写冻结后没有再跑五组稳定集成。 |
| syntax/diff | 本包涉及13个JS `node --check`，以及 `git diff --check`，exit0；冻结后再次diff-check亦0。 |
| npm test 全量（共享树） | **522 tests / 518 pass / 4 fail**，exit1，84.63s；[完整日志](</tmp/aurabot-t4-all-final.log>)。运行期间存在外部并发写，数量包括其新测试，**不得归为本包独立完整验收**。 |

全量四项与已知 T2/T3 基线同名同类型，均未修：
- [e2e](../../test/e2e.test.js#L465)：QQ voice超时；[e2e](../../test/e2e.test.js#L580)：强制语音超时。
- [paintings](../../test/paintings.test.js#L53)：POSIX下Windows绝对路径断言。
- [song](../../test/song.test.js#L142)：POSIX下Windows路径诊断断言。

没有安装/发布，不重做依赖audit；真实私群 `WAITING_TARGETS`，原生语音 `gap` 保留。

## 6. 未完成的原总 T4 项目

- 图片/真@组合/表情/引用组合/分享卡片/视频/文件/收语音与转写，每种独立来源、MIME/大小/目录/账号校验与发送证据；本阶段没有媒体发送接线。
- SDK原生语音发送公开能力缺口；没有把音频附件/文本冒充原生语音。
- 后台浏览、主动触达、jobs/schedule 与账号/conversation/generation 绑定的异步回原正常会话、切号/注销晚结果防外发。
- 全链工具执行期权限、来源、时段、预算和主动搭话的统一闭环；没有因本阶段顺便扩大这些权限。
- 双登录真实 UID、网页事件/DOM版本、DM/share应用回执的指定目标实测；用户接管后的明确恢复入口、未知收据核对入口。
- 冻结共享树后的单写集成复核、独立审查与后续T5/T6。不执行done T4、不提前解锁后续包。

## 7. 冻结后指纹（非归属声明）

以下是最后只读 snapshot 的 SHA-256。重叠文件包含他人并发增量；开工未采集 SHA，不能据此反推出本包独立 diff。

```text
src/douyin/ego-browser.js 84f93186be7cc7e4dd59c44106282b04a5f054e79c60bc52701862e5f271b76b
src/douyin/browser.js f86375e504755cf8ca5ec3600e49aa14508d6f644d15341f38de183410b5ffa5
src/douyin/site.js 739767fba5907c102223d91efff1c4c87791a63585539c4bb2d84ab30520d8f8
src/douyin/duty.js 6ee5a533eae52765a8ce84f8933953079dbe22ccb5c29e3a0f940c936e1a061e
src/douyin/im-adapter.js b499cf904e7476ba82f51a395fbdd793e8679d72ec895532fe4de6ef8af99cdd
src/core/config.js 9dd9667d1c36081b776d26650a50a7c65c4ea2e607ac3336da324e6385bde1a8
src/modules/douyin/index.js 94ad527acad14842376d51edfd0cc0c184dc1618e5ef3dcb280c77c1643797b3
src/chat/hub.js 1bba98b1fe16ed2369dad6cabbbf92e29a60ff251475db0426170bb924d021d4
src/features/memory.js 083eec1f4fd19efec6b0a7809e4739283b6f0d993b24f381cb8d2d4dd21d6f06
test/douyin-ego.test.js 14059f3e22db2c9ae072826ed2a320813f068cc5903fbfcf3a58ffa1a5320c2e
test/douyin-im.test.js b11acfbe43fd6bc5cffbd694bb2bed687eee3031461cc59ca86121b7208dcf54
test/im-hub.test.js 81e02249bb75a4b8ee3a24e7db9d8bac2bea1fb5be7fcc5ff0cb05e2ccfa9e64
test/im-memory-scope.test.js 1c5a70ff588a40fca2afe0bbf25687753c2f0d74dd729a4b377b897e9d8277e5
scoped tracked diff e1101216fffc1c283b92c94ad69aa3dafed8df18a60846333ac84635302c29a7
```
