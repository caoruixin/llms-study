/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Connect, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { classifyKeyFailure, createKeyRotator, parseKeyList } from './src/lib/keyRotation'

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

// base URL 规范化：去尾斜杠，避免与上游路径拼出 //（jinaFailoverPlugin 用）
const normalizeBase = (u: string) => u.replace(/\/+$/, '')

/**
 * /api/jina 专用代理：支持 JINA_API_KEYS 多 key 按序故障转移。
 * 同一请求内逐 key 尝试——invalid(401/403) 本进程内永久剔除、quota/限流(402/429)
 * 冷却 60s——直到成功或全部不可用(此时透出最后一次上游错误)。
 * Jina 的 embeddings/rerank 均为小 JSON 非流式，可安全缓冲请求体重放；
 * 流式的 LLM chat 路由做不到请求内重试，仍走上面的 http-proxy(后端网关落地后统一收口)。
 * X-User-Key 仍最优先且不参与轮换(保持既有代理语义)。
 */
function jinaFailoverPlugin(env: Record<string, string>): Plugin {
  const target = normalizeBase(env.JINA_BASE_URL || 'https://api.jina.ai')
  const rotator = createKeyRotator(parseKeyList(env.JINA_API_KEYS || env.JINA_API_KEY))

  const handler: Connect.NextHandleFunction = (req, res) => {
    void (async () => {
      // connect 挂载在 /api/jina 下，req.url 已被去掉该前缀
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const method = req.method ?? 'POST'
      const contentType = req.headers['content-type']

      const userKey = req.headers['x-user-key']
      const rotating = !(typeof userKey === 'string' && userKey)
      const attempt = rotating ? rotator.candidates() : [userKey as string]

      if (attempt.length === 0) {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'no-usable-jina-key', detail: 'JINA_API_KEYS 全部 invalid 或冷却中' }))
        return
      }

      let last: { status: number; contentType: string | null; body: Buffer } | null = null
      for (const key of attempt) {
        const upstream = await fetch(target + (req.url ?? ''), {
          method,
          headers: {
            ...(typeof contentType === 'string' ? { 'content-type': contentType } : {}),
            authorization: `Bearer ${key}`,
          },
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
        })
        const buf = Buffer.from(await upstream.arrayBuffer())
        const failure = classifyKeyFailure(upstream.status)
        if (failure && rotating) {
          rotator.reportFailure(key, failure)
          last = { status: upstream.status, contentType: upstream.headers.get('content-type'), body: buf }
          continue
        }
        res.statusCode = upstream.status
        const ct = upstream.headers.get('content-type')
        if (ct) res.setHeader('content-type', ct)
        res.end(buf)
        return
      }
      // 全部 key 均 invalid/quota：透出最后一次上游错误，前端据此报错
      res.statusCode = last!.status
      if (last!.contentType) res.setHeader('content-type', last!.contentType)
      res.end(last!.body)
    })().catch((e: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
      }
      res.end(JSON.stringify({ error: 'jina-proxy-error', detail: String(e) }))
    })
  }

  return {
    name: 'jina-key-failover',
    configureServer(server) {
      server.middlewares.use('/api/jina', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/jina', handler)
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // dev 拓扑 = 生产：/api/app（账号域）与 4 条 LLM 前缀全部原样转发本地后端（nginx 在
  // 生产做同一件事）。原「直连上游 + .env.local key 注入」已删——鉴权与 key 注入统一
  // 收口在后端网关（P2），浏览器侧不再存在任何 key 通路。
  // /api/jina 例外：仍走 jinaFailoverPlugin（rerank 未实弹，dev 先保留本地多 key 轮换）。
  const BACKEND = 'http://localhost:8787'
  const proxy: Record<string, ProxyOptions> = {}
  for (const prefix of ['/api/app', '/api/moonshot', '/api/zhipu', '/api/deepseek', '/api/openai-compat']) {
    // 不 rewrite：后端网关按完整 /api/{provider}/* 路径路由（URL 形状前后端一致）
    proxy[prefix] = { target: BACKEND }
  }

  // 与 src/nav.ts / src/App.tsx 同一个开关：三处一起决定论文陪读是否存在于产物中
  const paperEnabled = env.VITE_ENABLE_PAPER_COPILOT === '1'

  return {
    plugins: [react(), tailwindcss(), jinaFailoverPlugin(env), ...(paperEnabled ? [] : [paperCopilotOffPlugin()])],
    server: { proxy },
    preview: { proxy },
    build: {
      rollupOptions: {
        output: {
          /**
           * 大件 vendor 单独成 chunk，两个目的（站点跨境直连、实测带宽仅 ~17KB/s）：
           * 1. 入口瘦身：recharts 原先被打进入口，论文陪读等不用图表的路由也被迫下载；
           * 2. 缓存稳定：vendor 版本不随业务代码变，hash 跨部署不变——发版后老用户
           *    只需重下业务 chunk，不再全量重拉。
           * 只点名"大且边界清晰"的库；其余交给 Rollup 默认切分（点太细反而碎片化）。
           * 只影响主构建；worker 产物（pdfWorkerEntry）走独立管线不受此配置影响。
           */
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            if (/node_modules\/(recharts|victory-vendor|d3-[a-z-]+)\//.test(id)) return 'vendor-charts'
            if (/node_modules\/katex\//.test(id)) return 'vendor-katex'
            if (/node_modules\/(framer-motion|motion-dom|motion-utils)\//.test(id)) return 'vendor-motion'
            if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|zustand)\//.test(id))
              return 'vendor-react'
            return undefined
          },
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }
})
