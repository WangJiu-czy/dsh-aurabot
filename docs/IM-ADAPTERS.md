# IM adapter 接缝

`api.core.imAdapters` 是平台消息适配器到共享聊天 hub 的进程内接缝。QQ 的 OneBot 路径保持原样；抖音消息由独立内置模块 `douyin-bridge` 接入，浏览器观看、点赞和评论仍由 `douyin` 模块负责。

注册身份由 `platform` 和已登录账号的 `accountId` 组成。同一平台的不同账号，以及不同平台上相同的账号/会话 ID，都会落到不同 adapter。会话 ID 必须作为 `conversation: { kind, id }` 传递；发来的事件也会附带平台和账号身份。

```js
const identity = { platform: 'example-im', accountId: 'bot-1' }
const unregister = api.core.imAdapters.register(identity, {
  send: (target, message) => client.send(target.conversation, message),
})
const off = api.core.imAdapters.onMessage(identity, (event) => {
  // event 含 platform、accountId、conversation、sender、message 等适配器提供的字段
})

await api.core.imAdapters.send({ ...identity, conversation: { kind: 'direct', id: 'user-7' } }, { text: '你好' })
await api.core.imAdapters.receive({ ...identity, conversation: { kind: 'direct', id: 'user-7' }, sender: { id: 'user-7' }, message: { text: '在吗' } })
// modules 热重载或关闭模块时，内核会调用 onDispose 注册的清理函数。
api.onDispose(() => { off(); unregister() })
```

重复注册相同平台和账号、给未注册身份收发消息、无效身份或没有 `send()` 的 adapter 都会报错。registry 只把事件交给同身份的监听器；它不会调用 QQ hub、OneBot 或 `isOwner`，也不提供 QQ 主人权限判断。平台模块负责登录、事件解析、发送回执和生命周期；共享 hub 负责统一对话。`douyin-bridge` 通过本注册表送入抖音私信/群聊，AI 回复走 hub 的常规权限、工具、记忆和发送链路；ego-lite 浏览器能力与消息 SDK 分开启停、分开验证。
