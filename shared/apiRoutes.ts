/**
 * 路由前缀与限额常量(前后端共享,零运行时依赖)。
 * 数值改这里,两端同时生效——避免"前端校验放行、服务端 400"的漂移。
 */

/** 新后端业务路由统一前缀;LLM 代理仍走 /api/{provider} 原状(P2 才翻转到后端) */
export const APP_API_PREFIX = '/api/app'

/** session cookie 名:HttpOnly + SameSite=Lax,前端永远读不到,仅作文档 */
export const SESSION_COOKIE = 'sid'

/** session 30 天滑动过期(过半续期) */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const USERNAME_MIN = 3
export const USERNAME_MAX = 32
/** 用户名字符集:URL/日志安全,大小写不敏感判重(NOCASE) */
export const USERNAME_RE = /^[a-zA-Z0-9_-]+$/

export const PASSWORD_MIN = 8
/** 上限防超长密码打满 argon2 计算(DoS) */
export const PASSWORD_MAX = 128

/** LLM key 长度界限:真实 key 均 ≥8;上限防把整段文本当 key 存进来 */
export const LLM_KEY_MIN = 8
export const LLM_KEY_MAX = 512

export const INVITE_CODE_LENGTH = 16

/** 登录爆破限流:IP 与用户名双维度,失败 10 次/15 分钟 → 429 + Retry-After */
export const LOGIN_MAX_FAILURES = 10
export const LOGIN_WINDOW_MS = 15 * 60 * 1000

/** 每账号默认存储配额 2GB(P3 同步域记账用,schema 默认值与此一致) */
export const DEFAULT_STORAGE_QUOTA_BYTES = 2147483648

// ---- 同步域限额(P3)----

/** push 单批上限:批太大单事务持锁过久,阻塞其它用户请求 */
export const SYNC_PUSH_MAX_CHANGES = 500
export const SYNC_PUSH_MAX_BYTES = 8 * 1024 * 1024
/** changes 拉取单页上限 */
export const SYNC_CHANGES_MAX_LIMIT = 1000
/**
 * 论文原始文件单个上限:与 nginx files location 的 client_max_body_size 60m 对齐。
 * 前端导入本就限 50MB,这里留 10MB 余量吸收元数据/边界差异。
 */
export const FILE_MAX_BYTES = 60 * 1024 * 1024
/**
 * paperId 形状(文件名安全):它会拼进磁盘路径 files/{userId}/{paperId}.bin,
 * 白名单字符集从根上排除路径穿越;前端 paper id 是 uuid/hex,天然满足。
 */
export const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

// ---- LLM 网关限额(P2)----

/** LLM 代理请求体上限:多 key 故障转移需要全量缓冲 body 以便换 key 重发 */
export const LLM_PROXY_MAX_BODY_BYTES = 2 * 1024 * 1024
/**
 * 每用户令牌桶,与前端 PAPER_RATE_LIMIT(src/data/paperPolicy.ts)同参:
 * 前端排队等桶、服务端超限 429 + Retry-After,两端参数一致才不会"前端放行、服务端拒绝"。
 * (不直接 import paperPolicy:它引用 llmClient 等前端模块,会把前端依赖树拖进 server 编译)
 */
export const LLM_RATE_CAPACITY = 3
export const LLM_RATE_REFILL_MS = 10_000
/** 每用户并发 SSE 上限:防单用户占满上游连接/后端内存 */
export const LLM_MAX_CONCURRENT_STREAMS = 3
