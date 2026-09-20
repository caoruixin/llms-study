/**
 * 应用级共享类型:依赖注入(db+config 由 index.ts 组装、测试里可换成内存实例)
 * 与 Hono 环境(requireSession 注入的请求级变量)。
 */
import type { Config } from './config.js'
import type { Db, UserRow } from './db/db.js'
import type { FetchLookup, FetchTransport } from './lib/fetchRaw.js'
import type { VoiceAdapter } from './voice/adapter.js'

export interface AppDeps {
  db: Db
  config: Config
  /**
   * LLM 网关限流参数覆盖(测试专用):生产不传,恒用 shared/apiRoutes 常量。
   * 之所以走 deps 而非 config:这不是运维会调的配置,不该出现在 env 面里。
   */
  llmTuning?: {
    rateCapacity?: number
    rateRefillMs?: number
    maxStreams?: number
  }
  /**
   * URL 抓取参数覆盖(测试专用),同 llmTuning 的理由不进 config。
   * transport/lookup 是注入口:transport 让测试把请求打到本机 stub 而不必放宽禁区校验,
   * lookup 让测试构造"域名解析到内网"这一必须走真实校验路径的场景。
   */
  fetchTuning?: {
    maxBytes?: number
    timeoutMs?: number
    transport?: FetchTransport
    lookup?: FetchLookup
  }
  /**
   * 语音路由参数覆盖(测试专用),同 llmTuning 的理由不进 config。
   * adapter 是注入口:测试用纯内存适配器把转写/合成的全部分支(轮换/超时/上游 4xx)
   * 跑成零网络——语音上游没有可本地复现的 stub 协议,起 http stub 只会测到 multipart 拼装。
   */
  voiceTuning?: {
    adapter?: VoiceAdapter
    rateCapacity?: number
    rateRefillMs?: number
    ttsRateCapacity?: number
    ttsRateRefillMs?: number
    maxBytes?: number
    timeoutMs?: number
  }
  /**
   * 服务端渲染路由参数覆盖(测试专用),同 llmTuning 的理由不进 config。
   * 渲染服务的地址本身走 config.renderServiceSocket(它是运维开关);这里只放测试要压短/压小的量:
   * 超时压到几百毫秒才能测"渲染服务不回话",响应上限压到几 KB 才能测 413 而不必真造 12MB。
   */
  renderTuning?: {
    timeoutMs?: number
    maxResponseBytes?: number
    rateCapacity?: number
    rateRefillMs?: number
  }
}

export type AppEnv = {
  Variables: {
    /** requireSession 通过后必存在;未过中间件的路由禁止 c.get('user') */
    user: UserRow
    sessionId: string
  }
}
