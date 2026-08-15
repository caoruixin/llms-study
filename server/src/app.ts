/**
 * 根 Hono 组装:两棵子树 —— /api/app 业务 API + /api/{provider} LLM 网关。
 * P2 起网关路由在 /api/app basePath 之外,故根 app 不再整体 basePath,
 * 改为显式挂载;Origin 校验升到根级——网关同样是 cookie 鉴权的写路由,
 * 必须同受 CSRF 防线保护。
 * deps 注入而非模块级单例——测试里每个用例一套独立 app+内存 DB,互不串味。
 */
import { Hono } from 'hono'
import { APP_API_PREFIX } from '../../shared/apiRoutes.js'
import { originCheck } from './auth/middleware.js'
import { apiError } from './lib/respond.js'
import { llmGatewayRoutes } from './llm/gateway.js'
import { adminRoutes } from './routes/admin.js'
import { authRoutes } from './routes/auth.js'
import { filesRoutes } from './routes/files.js'
import { healthRoutes } from './routes/health.js'
import { llmKeysRoutes } from './routes/llmKeys.js'
import { syncRoutes } from './routes/sync.js'
import type { AppDeps, AppEnv } from './types.js'

export function createApp(deps: AppDeps) {
  const root = new Hono<AppEnv>()
  root.use('*', originCheck(deps.config))

  // ---- /api/app/*:账号/同步/文件 ----
  const api = new Hono<AppEnv>()
  api.route('/', healthRoutes())
  api.route('/auth', authRoutes(deps))
  api.route('/me/llm-keys', llmKeysRoutes(deps))
  api.route('/admin', adminRoutes(deps))
  api.route('/sync', syncRoutes(deps))
  api.route('/files', filesRoutes(deps))
  root.route(APP_API_PREFIX, api)

  // ---- /api/{deepseek,moonshot,zhipu,jina,openai-compat}/*:LLM 网关 ----
  // 只注册 allowlist 内的 POST 路由,其余 path/method 落到下面的 notFound → 404
  root.route('/api', llmGatewayRoutes(deps))

  root.notFound((c) => apiError(c, 404, 'not-found'))
  root.onError((err, c) => {
    // 5xx 只回统一错误码,细节进日志——不把内部栈暴露给客户端
    console.error('[app] unhandled error:', err)
    return apiError(c, 500, 'internal')
  })
  return root
}
