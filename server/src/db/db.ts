/**
 * SQLite 连接工厂 + 行类型。
 * WAL:读写并发互不阻塞(单进程多请求);busy_timeout:偶发写锁竞争时等待而非立即 SQLITE_BUSY;
 * foreign_keys:SQLite 默认关闭,必须每连接显式打开,否则外键形同虚设。
 */
import Database from 'better-sqlite3'

export type Db = Database.Database

export function openDb(dbPath: string): Db {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  return db
}

// ---- 行类型(列名与 schema 一致,snake_case;DTO 转换在路由层做) ----

export interface UserRow {
  id: number
  username: string
  password_hash: string
  role: 'admin' | 'user'
  disabled: number
  storage_quota_bytes: number
  storage_used_bytes: number
  created_at: number
}

export interface InviteCodeRow {
  code: string
  created_by: number
  created_at: number
  expires_at: number | null
  note: string | null
  used_by: number | null
  used_at: number | null
}

export interface SessionRow {
  id: string
  user_id: number
  created_at: number
  expires_at: number
}

export interface UserLlmKeyRow {
  user_id: number
  provider: string
  ciphertext: Buffer
  last4: string
  created_at: number
  updated_at: number
}

export interface SyncRecordRow {
  user_id: number
  tbl: string
  id: string
  paper_id: string | null
  payload: string | null
  bytes_size: number
  seq: number
  deleted: number
  updated_at: number
}

export interface StoredFileRow {
  user_id: number
  paper_id: string
  mime: string
  sha256: string
  byte_size: number
  created_at: number
  updated_at: number
}
