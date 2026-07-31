/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 固定 allowlist 代理路由：不允许运行时任意 base URL。
// key 优先级：请求头 X-User-Key（UI 粘贴，代理删除该头并改写为上游鉴权头）> .env.local 环境变量（无 VITE_ 前缀，不进 bundle）。
interface ProviderRoute {
  prefix: string
  target: string
  envKey: string
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const routes: ProviderRoute[] = [
    { prefix: '/api/moonshot', target: 'https://api.moonshot.cn', envKey: 'MOONSHOT_API_KEY' },
    { prefix: '/api/zhipu', target: 'https://open.bigmodel.cn', envKey: 'ZHIPU_API_KEY' },
    { prefix: '/api/deepseek', target: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
    // 通用 OpenAI 兼容端点：target 在 dev server 启动时由 env 固定，仍非运行时可变
    { prefix: '/api/openai-compat', target: env.OPENAI_COMPAT_BASE_URL || 'https://api.openai.com', envKey: 'OPENAI_COMPAT_API_KEY' },
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
          const key = (typeof userKey === 'string' && userKey) || env[route.envKey]
          proxyReq.removeHeader('x-user-key')
          if (key) proxyReq.setHeader('Authorization', `Bearer ${key}`)
        })
      },
    }
  }

  return {
    plugins: [react(), tailwindcss()],
    server: { proxy },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }
})
