// 抖音消息桥：账号登录、消息恢复与收发只经过通用 IM registry；浏览器行为由 douyin 模块负责。

import { createDouyinImAdapter } from '../../douyin/im-adapter.js'
import { dataDir } from '../../core/store.js'
import { workspaceDirOf } from '../../chat/hub.js'

export default {
  id: 'douyin-bridge',
  name: '抖音消息桥',
  version: '1.0.0',
  description: '通过共享 IM 会话接入抖音私信和群聊；不负责刷视频或浏览器操作。',
  files: ['douyin/im-sdk.js', 'douyin/im-adapter.js', 'douyin/im-media.js'],
  setup(api) {
    const { http } = api.core
    const im = createDouyinImAdapter({
      getConfig: api.config,
      registry: api.core.imAdapters,
      dataDir: () => api.dataDir('im-sdk'),
      media: {
        roots: () => ['imagegen', 'stickers', 'songs'].map(d => dataDir(d)).concat(workspaceDirOf(api.config()), api.config().files?.dirs || []),
      },
    })
    api.onDispose(() => im.dispose())
    api.on('config', () => im.reconcile())
    api.route('/douyin/im/state', async () => im.state())
    api.route('/douyin/im/login', async req => im.login(await http.body(req).catch(() => ({}))))
    api.route('/douyin/im/logout', async () => im.logout())
    api.route('/douyin/im/continue', async req => im.continueLogin(await http.body(req).catch(() => ({}))))
    return im
  },
}
