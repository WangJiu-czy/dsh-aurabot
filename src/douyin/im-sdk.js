import { isAbsolute, parse, resolve } from 'node:path'
import { lstat, mkdir } from 'node:fs/promises'

const failure = (code, message) => ({ ok: false, code, message })

/** Explicit opt-in only. Never logs in, restores accounts, or registers business handlers. */
export async function createDouyinImClient({
  enabled = false,
  dataDir,
  nodeVersion = process.versions.node,
  loadSqlite = () => import('node:sqlite'),
  loadSdk = () => import('douyin-im'),
} = {}) {
  if (enabled !== true) return failure('DISABLED', '抖音 IM SDK 未启用')
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion)
  if (!version || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 13)) {
    return failure('UNSUPPORTED_RUNTIME', '抖音 IM 要求宿主 Node >=22.13.0；请在实际 DSH 进程核对')
  }
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || resolve(dataDir) === parse(dataDir).root) {
    return failure('INVALID_DATA_DIR', '请提供抖音专用受限数据目录的绝对路径（非根目录）')
  }
  // 1.1.0 imports node:sqlite statically, including when localState is false.
  try {
    const sqlite = await loadSqlite()
    if (typeof sqlite.DatabaseSync !== 'function') throw new Error('missing DatabaseSync')
  } catch {
    return failure('SQLITE_UNAVAILABLE', '实际宿主缺少 node:sqlite DatabaseSync；QQ 可继续独立运行')
  }
  let sdk
  try {
    sdk = await loadSdk()
  } catch (error) {
    return failure(error?.code === 'ERR_MODULE_NOT_FOUND' ? 'SDK_NOT_FOUND' : 'SDK_LOAD_FAILED',
      '抖音 SDK 加载失败；请用 npm ci --ignore-scripts 核对 douyin-im@1.1.0 及锁定依赖')
  }
  if (typeof sdk?.createClient !== 'function') return failure('SDK_EXPORT_MISMATCH', 'douyin-im 根导出缺少 createClient')
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const directory = await lstat(dataDir)
    if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)) {
      return failure('INVALID_DATA_DIR', '抖音专用目录须为真实目录且仅当前用户可访问（0700）；既有权限保持原样')
    }
  } catch {
    return failure('INVALID_DATA_DIR', '抖音专用数据目录创建或权限检查失败')
  }
  try {
    // Disable implicit account discovery and full-message disk cache. T3 owns explicit login/cursors.
    const client = sdk.createClient({ dataDir, autoLoad: false, localState: false })
    return { ok: true, client, runtimeNode: nodeVersion, sqlite: 'available' }
  } catch {
    return failure('SDK_INIT_FAILED', '抖音 SDK 初始化失败；请核对专用数据目录和依赖，QQ 可继续独立运行')
  }
}
