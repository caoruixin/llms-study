/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const PAPER_VIRTUAL_ID = '\0paper-copilot-disabled'

/**
 * flag-off 生产构建时，把 `src/pages/papers/**` 与 `src/lib/paper/**` 解析成空模块，
 * 让整棵论文陪读子树根本不进构建图。
 *
 * 为什么只靠 `PAPER_ENABLED ? lazy(() => import(...)) : null` 不够：Rollup 的 tree-shaking
 * 确实会剪掉死分支（JS chunk 里零 paper 代码），但 Vite 的 `vite:asset-import-meta-url` 是在
 * **transform 阶段** 就为 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`
 * 调用 emitFile 的——那时候还没开始 tree-shaking，于是 1.2MB 的 worker 资产会留在 dist 里，
 * 尽管没有任何代码引用它。只有让这些模块压根不被 load，才能做到 flag-off 产物零 paper 痕迹。
 *
 * `apply: 'build'` 保证它只在 `vite build` 生效：dev server 与 vitest（走 serve 管线）不受影响。
 */
function paperCopilotOffPlugin(): Plugin {
  return {
    name: 'paper-copilot-disabled',
    apply: 'build',
    enforce: 'pre',
    resolveId(source) {
      return source.includes('/pages/papers/') ||
        source.includes('/lib/paper/') ||
        source.includes('/components/papers/')
        ? PAPER_VIRTUAL_ID
        : null
    },
    load(id) {
      return id === PAPER_VIRTUAL_ID ? 'export default {}' : null
    },
  }
}

// 固定 allowlist 代理路由：不允许运行时任意 base URL。
// key 优先级：请求头 X-User-Key（UI 粘贴，代理删除该头并改写为上游鉴权头）> .env.local 环境变量（无 VITE_ 前缀，不进 bundle）。
interface ProviderRoute {
  prefix: string
  target: string
  envKeys: string[] // 取第一个非空值，支持旧名兼容（KIMI → MOONSHOT）
}

// base URL 规范化：去尾斜杠，避免与 chatPath 拼出 //；
// BASE_URL 只写协议+域名（不带 /v1），否则会与 chatPath 拼成 /v1/v1 重复。
const normalizeBase = (u: string) => u.replace(/\/+$/, '')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // 各 *_BASE_URL 在 dev server 启动时固定（沿 OPENAI_COMPAT_BASE_URL 先例），仍非运行时可变；
  // honor 它们是为了避免 .env.local 里已有的变量被静默忽略造成配置漂移。
  const routes: ProviderRoute[] = [
    { prefix: '/api/moonshot', target: normalizeBase(env.KIMI_BASE_URL || 'https://api.moonshot.cn'), envKeys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
    { prefix: '/api/zhipu', target: 'https://open.bigmodel.cn', envKeys: ['ZHIPU_API_KEY'] },
    { prefix: '/api/deepseek', target: normalizeBase(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'), envKeys: ['DEEPSEEK_API_KEY'] },
    // Jina：Paper Copilot 的 embeddings /v1/embeddings 与 rerank /v1/rerank 同源
    { prefix: '/api/jina', target: normalizeBase(env.JINA_BASE_URL || 'https://api.jina.ai'), envKeys: ['JINA_API_KEY'] },
    // 通用 OpenAI 兼容端点：target 在 dev server 启动时由 env 固定，仍非运行时可变
    { prefix: '/api/openai-compat', target: normalizeBase(env.OPENAI_COMPAT_BASE_URL || 'https://api.openai.com'), envKeys: ['OPENAI_COMPAT_API_KEY'] },
  ]

  const proxy: Record<string, ProxyOptions> = {}
  for (const route of routes) {
    proxy[route.prefix] = {
      target: route.target,
      changeOrigin: true,
      rewrite: (path) => path.slice(route.prefix.length),
      configure: (p) => {
        p.on('proxyReq', (proxyReq, req) => {
          const userKey = req.headers['x-user-key']
          const key = (typeof userKey === 'string' && userKey) || route.envKeys.map((k) => env[k]).find((v) => v) || ''
          proxyReq.removeHeader('x-user-key')
          if (key) proxyReq.setHeader('Authorization', `Bearer ${key}`)
        })
      },
    }
  }

  // 与 src/nav.ts / src/App.tsx 同一个开关：三处一起决定论文陪读是否存在于产物中
  const paperEnabled = env.VITE_ENABLE_PAPER_COPILOT === '1'

  return {
    plugins: [react(), tailwindcss(), ...(paperEnabled ? [] : [paperCopilotOffPlugin()])],
    server: { proxy },
    preview: { proxy },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }
})
