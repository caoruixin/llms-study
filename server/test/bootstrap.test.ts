/**
 * 启动链路:migrate 幂等(重启不重放)、admin 种子只在空表时生效。
 */
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/db.js'
import { migrate } from '../src/db/migrate.js'
import { seedAdmin } from '../src/db/seed.js'
import { createTestApp, createUser, login, testConfig } from './helpers.js'

describe('migrate', () => {
  it('重复执行不报错、版本不重放', () => {
    const db = openDb(':memory:')
    migrate(db)
    const v1 = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
    migrate(db) // 模拟重启
    const v2 = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
    expect(v2.v).toBe(v1.v)
    expect(v1.v).toBeGreaterThanOrEqual(1)
    // 账号域五张表齐备
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name)
    for (const t of ['users', 'invite_codes', 'sessions', 'user_llm_keys', 'llm_call_log']) {
      expect(tables).toContain(t)
    }
  })
})

describe('seedAdmin', () => {
  it('空表 + env 齐备 → 创建 admin 且可登录', async () => {
    const { app, db } = createTestApp()
    await seedAdmin(
      db,
      testConfig({ adminUsername: 'boss', adminInitialPassword: 'boss-pass-1234' }),
    )
    const row = db.prepare("SELECT role FROM users WHERE username = 'boss'").get() as {
      role: string
    }
    expect(row.role).toBe('admin')
    await login(app, 'boss', 'boss-pass-1234') // 不抛即成功
  })

  it('表非空时跳过(不重置已有账号)', async () => {
    const { db } = createTestApp()
    await createUser(db, 'existing', 'existing-pass-1')
    await seedAdmin(
      db,
      testConfig({ adminUsername: 'boss', adminInitialPassword: 'boss-pass-1234' }),
    )
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    expect(n).toBe(1)
  })

  it('env 缺失时不创建', async () => {
    const { db } = createTestApp()
    await seedAdmin(db, testConfig())
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    expect(n).toBe(0)
  })
})
