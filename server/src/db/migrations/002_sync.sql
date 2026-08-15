-- 002: 同步域(sync_records/sync_meta/stored_files)。P3。
-- 设计:服务端不理解论文业务——payload 是前端 JSON 原文,单张文档表吸收前端
-- "只加字段"的演进,零 schema 联动。seq 由服务端全局单调分配作增量拉取游标
-- (否决 updatedAt 游标:客户端时钟不可信,seq 严格可比且无并发歧义)。

CREATE TABLE sync_records (
  user_id INTEGER NOT NULL REFERENCES users(id),
  tbl TEXT NOT NULL,                      -- 8 张业务表之一(路由层 allowlist 校验,DB 不重复约束)
  id TEXT NOT NULL,                       -- 前端记录 id(uuid 等),服务端不解释
  paper_id TEXT,                          -- 冗余列:按论文级联删除/统计;papers 行 = 自身 id
  payload TEXT,                           -- JSON 原文;墓碑行为 NULL
  bytes_size INTEGER NOT NULL DEFAULT 0,  -- payload 字节数(配额记账);墓碑 = 0
  seq INTEGER NOT NULL,                   -- 全局单调递增,增量拉取游标
  deleted INTEGER NOT NULL DEFAULT 0,     -- 墓碑:同步"删除"语义,90 天后 GC 物理清除
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tbl, id)
);
-- changes?since= 按 (user_id, seq) 扫;级联删除/对账按 (user_id, paper_id) 扫
CREATE INDEX idx_sync_records_user_seq ON sync_records(user_id, seq);
CREATE INDEX idx_sync_records_user_paper ON sync_records(user_id, paper_id);

-- 全局 seq 计数器:单行表,写事务内 UPDATE ... RETURNING 自增,
-- SQLite 单写者模型保证分配无竞态、无空洞回退
CREATE TABLE sync_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT INTO sync_meta (k, v) VALUES ('global_seq', 0);

-- 文件元数据;字节本体在磁盘 files/{userId}/{paperId}.bin(tmp+fsync+rename 原子写),
-- 不进 SQLite blob——50MB 级 blob 会把 WAL 与备份都拖垮
CREATE TABLE stored_files (
  user_id INTEGER NOT NULL REFERENCES users(id),
  paper_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,                   -- 内容指纹:ETag / 重复上传短路
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, paper_id)
);
