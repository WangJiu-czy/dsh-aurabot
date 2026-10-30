# Aurabot · 大肥鱼

Aurabot 是一个 DeepSeek Harness（DSH）插件：让 DSH 中的 AI 通过 QQ 网关与 QQ 用户聊天，并提供人格、记忆、心情、媒体和可扩展模块。

本仓库是基于 [上游 Aurabot 项目](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq) 持续二次开发的独立维护版本。当前代码、版本发布、安装和后续更新均以本仓库为准；面板不会再轮询上游版本。

```text
QQ ⇄ SnowLuma / OneBot v11 ⇄ Aurabot ⇄ DeepSeek Harness
```

## 功能一览

- **QQ 对话**：支持 QQ 私聊和群聊；群消息合并、引用回复、合并转发、拍一拍和群聊插话策略。
- **多个消息平台**：通过适配器把已配置平台接入共享聊天中枢；平台、账号及会话范围相互隔离。
- **人格与心情**：内置大肥鱼人格，也可编辑、切换或添加人格；心情会随互动变化。
- **长期记忆**：聊天记忆提炼、相关性检索、人物档案、相处经验和遗忘曲线。仿真记忆提供细节淡化、核心保留和有限强化；开关与参数在面板「心情与记忆」页。
- **本地知识库**：Angel Memory 支持 Markdown / TXT 资料，按共享、群或私聊范围管理；AI 可按请求检索。
- **媒体和日常功能**：收发语音与表情、图片理解和生图、QQ 空间日记及互动、B 站浏览，以及可选的抖音浏览和消息接入。
- **翻唱与本地服务**：支持 RVC 翻唱；语音合成、识别、生图等能力可接本地服务。
- **模块扩展**：面板可启停内置模块；用户模块和本地接口脚本存放在数据目录，升级插件时保留。

不同能力受模块开关、账号配置、权限、模型能力和平台环境影响；安装后可在面板查看各项状态。

## 环境要求

- DeepSeek Harness（DSH）及其支持的插件运行环境。
- Node.js `>=22.13.0`（由 DSH 管理运行时的桌面版通常无需单独安装）。
- 一个用于机器人登录的 QQ 账号，以及以下任一种 QQ 网关：
  - **SnowLuma**：自行安装并登录机器人账号；
  - **OneBot v11**：例如已有的 NapCat、LLOneBot、Lagrange 或 SnowLuma 服务。
- 部分可选功能需要额外组件：翻唱需要 Windows 和模型文件；抖音浏览需要可用的 Chromium 系浏览器；本地 TTS / ASR / 生图服务按需配置。

## 安装

### Windows 桌面版

在 PowerShell 中执行：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:WangJiu-czy/dsh-aurabot
```

### Linux / Docker 或其他 profile

使用 DSH 自带的命令行，并将 `<profile>` 替换为实际 profile 名称：

```bash
dsh plugin --profile <profile> add github:WangJiu-czy/dsh-aurabot
```

安装后重启 DSH，在侧栏「自动化任务」下打开 **Aurabot** 面板。设置分布在「连接」「权限」「人格」「心情与记忆」等标签页。

## 首次配置

1. 在「连接」页设置机器人 QQ 账号，并选择 SnowLuma 或 OneBot v11。
2. 在「权限」页设置主人账号及允许使用的会话。建议机器人账号与主人账号分开。
3. 确认网关连接状态和登录账号正确；先开启试运行观察日志，再决定是否正式发送消息。
4. 按需启用记忆、模块、平台接入和媒体能力。

使用 SnowLuma 时，请自行安装 SnowLuma、阅读并确认其协议。Aurabot 连接或管理你配置的网关，不会替你登录其他 QQ 账号。

## 更新

Aurabot 不再自动检查 GitHub 版本。维护者发布新版本后，重新运行对应系统的安装命令，再重启 DSH；持久数据保存在插件数据目录，不随插件代码更新而覆盖。

安装源和后续版本以本仓库为准：<https://github.com/WangJiu-czy/dsh-aurabot>。

## 数据与隐私

默认数据目录：

```text
Windows: %USERPROFILE%\.dsh\plugins-data\aurabot\
macOS / Linux: ~/.dsh/plugins-data/aurabot/
```

设置 `AURABOT_DATA_DIR` 可指定其他数据目录。目录内可能包含配置、人格、记忆、日志、知识库、用户模块和本地接口脚本；请按个人数据对待，不要公开提交真实配置、令牌或聊天记录。

QQ 会话工作区由 DSH 管理，位置可在 Aurabot 配置中指定。抖音等平台的登录资料和能力也应按各自模块配置与数据位置管理。

## 开发与测试

```bash
npm ci
npm test
```

核心目录：

```text
src/host.js            DSH 插件入口与面板 API
src/core/              配置、模块内核、模型和数据存储
src/chat/              消息中枢、权限、平台会话与回复处理
src/modules/           内置功能模块及模块开发接口
src/features/          记忆、知识库、心情等功能实现
src/douyin/            抖音浏览与消息接入
src/persona/           人格卡与人格管理
client/client.js       DSH Web 面板
cordis.patch.yml       插件与 preset 挂载声明
test/                  单元与集成测试
```

模块接口说明见 [`src/modules/API.md`](src/modules/API.md)，用户使用说明见 [`docs/USER-MANUAL.md`](docs/USER-MANUAL.md)。

## 许可证与致谢

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。本项目从 [accomplish07zrh-eng/dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq) 发展而来，并在其基础上持续进行独立开发；上游版权和许可声明按原文件保留。

问题反馈与功能建议：<https://github.com/WangJiu-czy/dsh-aurabot/issues>。