/**
 * 无鉴权健康检查:部署脚本与 systemd 自检用。
 * version 从最近的 package.json 读:src 下跑(tsx)命中 server/package.json,
 * dist 下跑(node)向上走同样命中——两种布局都不用硬编码版本号。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { HealthResponse } from '../../../shared/apiTypes.js'

function findVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'package.json')
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string }
      return pkg.version ?? '0.0.0'
    }
    dir = path.dirname(dir)
  }
  return '0.0.0'
}

const VERSION = findVersion()

export function healthRoutes(): Hono {
  const r = new Hono()
  r.get('/health', (c) => {
    const body: HealthResponse = { ok: true, version: VERSION }
    return c.json(body)
  })
  return r
}
