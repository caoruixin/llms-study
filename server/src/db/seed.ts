/**
 * admin 种子:仅 users 表为空且 env 齐备时创建——已有任何用户就绝不再动,
 * 防止改 env 重启意外重置/复活 admin。
 */
import { hashPassword } from '../auth/password.js'
import type { Config } from '../config.js'
import type { Db } from './db.js'

export async function seedAdmin(db: Db, config: Config): Promise<void> {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  if (n > 0) return
  if (!config.adminUsername || !config.adminInitialPassword) {
    console.warn('[seed] users 表为空且未配置 ADMIN_USERNAME/ADMIN_INITIAL_PASSWORD,跳过 admin 种子')
    return
  }
  const passwordHash = await hashPassword(config.adminInitialPassword)
  db.prepare(
    'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
  ).run(config.adminUsername, passwordHash, 'admin', Date.now())
  console.log(
    `[seed] 已创建 admin 用户「${config.adminUsername}」,初始密码来自 env——请尽快登录修改密码`,
  )
}
