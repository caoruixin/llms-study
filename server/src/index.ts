/**
 * 启动入口:.env 加载 → config fail-fast → 目录/DB 就绪 → migrate → admin 种子 → serve。
 * 生产由 systemd 提供 EnvironmentFile,server/.env 仅本地开发用;
 * loadEnvFile 不覆盖已有环境变量,systemd 注入的值始终优先。
 */
import { existsSync, mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { openDb } from './db/db.js'
import { migrate } from './db/migrate.js'
import { seedAdmin } from './db/seed.js'
import { startGc } from './lib/gc.js'

// dev 从 server/ 目录起服(npm run dev),cwd/.env 即 server/.env
const envPath = path.resolve(process.cwd(), '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const config = loadConfig()
mkdirSync(config.dataDir, { recursive: true })
mkdirSync(config.filesDir, { recursive: true })

const db = openDb(config.dbPath)
migrate(db)
await seedAdmin(db, config)

// 同步域墓碑 GC 与行数裁剪:启动即跑 + 每 24h 一次
const gcTimer = startGc(db)

const app = createApp({ db, config })
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[server] listening on http://${config.host}:${info.port} (db: ${config.dbPath})`)
})
// SSE 长流:Node 默认 requestTimeout 5 分钟会掐断进行中的请求,LLM 网关的长回答会被腰斩;
// 置 0 禁用(慢速头攻击仍有 headersTimeout 60s 兜底,且公网入口是 nginx)
;(server as Server).requestTimeout = 0

// systemd stop/restart 走 SIGTERM:先停监听再关 DB,让 WAL checkpoint 干净落盘
function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`)
  clearInterval(gcTimer)
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
