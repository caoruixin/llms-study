/**
 * 各 provider 允许透传的上游 path allowlist:与前端实际调用一一对应,
 * 其余 path 一律 404——网关只是"前端已知调用形状"的鉴权代理,不是通用转发器,
 * 否则登录用户可以拿服务端 key 打上游任意端点(文件上传、余额查询等)。
 *
 * 来源(改前端调用路径时必须同步这里):
 * - src/store.ts PROVIDERS[].chatPath(deepseek /chat/completions、moonshot 与
 *   openai-compat /v1/chat/completions、zhipu /api/paas/v4/chat/completions)
 * - src/data/paperPolicy.ts cap.chatPath(deepseek/kimi,与上面一致)
 * - jina:embeddings 与 rerank 两个端点(vite.config.ts /api/jina 中间件语义)
 */
import type { LlmProvider } from '../../../shared/apiTypes.js'

export const PROVIDER_ALLOWED_PATHS: Record<LlmProvider, readonly string[]> = {
  deepseek: ['/chat/completions'],
  moonshot: ['/v1/chat/completions'],
  zhipu: ['/api/paas/v4/chat/completions'],
  jina: ['/v1/embeddings', '/v1/rerank'],
  'openai-compat': ['/v1/chat/completions'],
}
