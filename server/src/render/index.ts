/**
 * 渲染服务启动入口(独立进程、独立 systemd unit:deploy/llms-study-render.service)。
 *
 * 与 API 同一份构建产物(dist/server/src/render/index.js),但**刻意不是** API 的子模块:
 * - 独立 cgroup:Chromium 是几百 MB 的内存大户,放在 API 的 cgroup(MemoryMax=512M)里,
 *   一次 OOM 会把登录、同步、LLM 网关一起带走;
 * - 独立用户、独立 env:API 的环境里有 LLM_KEY_MASTER、DB 对 llmapp 可读,而这个进程跑不可信网页。
 *   所以这里不 loadConfig()、不开 DB、**不加载 server/.env**(那是 API 的 env 文件,
 *   读进来机密就会被 Chromium 子进程继承)——本地开发请在命令行上内联传 RENDER_* 变量。
 */
import { accessSync, constants, existsSync, unlinkSync } from 'node:fs'
import { createRenderer } from './browser.js'
import { loadRenderConfig } from './config.js'
import { createRenderServer, listenOnSocket } from './server.js'

const config = loadRenderConfig()

// fail-fast:二进制不在/不可执行,每次渲染都只会得到一个启动失败。现在就退出,
// 让 systemd 的 StartLimitBurst 把 unit 判为 failed——API 侧连不上 socket,如实回 503
try {
  accessSync(config.chromePath, constants.X_OK)
} catch {
  throw new Error(`RENDER_CHROME_PATH 不存在或不可执行:${config.chromePath}`)
}

if (config.allowForbiddenDev) {
  console.warn(
    '[render] !!! RENDER_ALLOW_FORBIDDEN_DEV 已开启:解析到 198.18/15(fake-IP)的域名不再被拒。仅限本机开发,生产严禁 !!!',
  )
}

// 每个在途渲染一个 AbortController:收到停机信号时逐个取消,让渲染器自己把浏览器关干净
const inflight = new Set<AbortController>()
const renderer = createRenderer(config)
const server = createRenderServer({
  renderer: async (url, signal) => {
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', forward, { once: true })
    inflight.add(controller)
    try {
      return await renderer(url, controller.signal)
    } finally {
      inflight.delete(controller)
      signal.removeEventListener('abort', forward)
    }
  },
})

await listenOnSocket(server, config.socketPath)
console.log(`[render] listening on unix:${config.socketPath} (chrome: ${config.chromePath})`)

let stopping = false
function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(`[render] ${signal} received, shutting down`)
  for (const c of inflight) c.abort()
  // 兜底:渲染器关浏览器最多 5s,再不退就硬退(systemd 会按 control-group 收走残留的 Chromium)
  const hard = setTimeout(() => process.exit(1), 8_000)
  hard.unref()
  server.close(() => {
    // node 在正常 close 时会自己 unlink socket 文件;这里只是防御残留
    try {
      if (existsSync(config.socketPath)) unlinkSync(config.socketPath)
    } catch {
      // 留给下次启动时清
    }
    process.exit(0)
  })
  // keep-alive 的空闲连接会让 close 回调永远不来
  server.closeIdleConnections()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
