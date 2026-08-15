/**
 * 启动时自动迁移:migrations/*.sql 按文件名序号执行,schema_version 记录已应用版本。
 * 每个迁移在事务内执行(SQLite DDL 可回滚),失败即启动失败——不允许半套 schema 服务。
 * 迁移目录相对本模块定位:src 下跑 tsx、dist 下跑 node 都成立(build 会拷贝 .sql 进 dist)。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './db.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))

export function migrate(db: Db, dir: string = MIGRATIONS_DIR): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  )
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  const current = row.v ?? 0

  // '.' 开头的是 OS 垃圾(macOS tar 的 AppleDouble `._*.sql`、.DS_Store 等),跳过而非报错;
  // 其余不合名规的 .sql 仍然 fail-fast——那是真的迁移文件写错了名
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('.'))
    .sort()
  for (const file of files) {
    const version = Number.parseInt(file, 10) // '001_init.sql' → 1
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`迁移文件名必须以序号开头:${file}`)
    }
    if (version <= current) continue
    const sql = readFileSync(path.join(dir, file), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        version,
        Date.now(),
      )
    })()
    console.log(`[migrate] applied ${file}`)
  }
}
