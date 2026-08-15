-- 001: 账号域(users/invite_codes/sessions/user_llm_keys/llm_call_log)。
-- 时间戳统一 unix 毫秒 INTEGER。sync 域表在 002(P3)。

-- username UNIQUE NOCASE:Admin 与 admin 是同一个人,注册时判重不区分大小写
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, -- argon2id PHC 字符串
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  storage_quota_bytes INTEGER NOT NULL DEFAULT 2147483648, -- 2GB,admin 可调
  storage_used_bytes INTEGER NOT NULL DEFAULT 0, -- P3 同步域事务内增量维护
  created_at INTEGER NOT NULL
);

-- 一次性邀请码:注册事务内检查未用未过期并写 used_by/used_at
CREATE TABLE invite_codes (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER, -- NULL = 永不过期
  note TEXT,
  used_by INTEGER REFERENCES users(id),
  used_at INTEGER
);

-- id = 256-bit 随机 hex;30 天滑动过期(过半续期),改密吊销其它会话
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ciphertext = iv(12) || tag(16) || ct,AES-256-GCM,AAD='userId:provider' 防密文跨行移植;
-- last4 冗余存明文尾 4 位,/auth/me 展示用(避免每次解密)
CREATE TABLE user_llm_keys (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  last4 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- LLM 调用审计(不含请求/响应内容):P2 网关写入,限流与账单排查用
CREATE TABLE llm_call_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  model TEXT,
  key_source TEXT NOT NULL CHECK (key_source IN ('server', 'user')),
  status INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_llm_call_log_user ON llm_call_log(user_id, created_at);
