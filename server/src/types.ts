/**
 * 应用级共享类型:依赖注入(db+config 由 index.ts 组装、测试里可换成内存实例)
 * 与 Hono 环境(requireSession 注入的请求级变量)。
 */
import type { Config } from './config.js'
import type { Db, UserRow } from './db/db.js'

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
}

export type AppEnv = {
  Variables: {
    /** requireSession 通过后必存在;未过中间件的路由禁止 c.get('user') */
    user: UserRow
    sessionId: string
  }
}
