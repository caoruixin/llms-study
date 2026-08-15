/**
 * 前后端共享的 API DTO 与错误码(账号域)。
 * 约束:本目录零运行时依赖、不 import 任何第三方包——前端(bundler 解析)与
 * server(NodeNext 解析)两套 tsconfig 都要能原样编译。
 * 同步域 DTO 在 P3 落地时再加,避免未实现的接口形状先行漂移。
 */

/**
 * 统一错误码:所有非 2xx 响应都是 `{error, message?}` JSON。
 * 前端只 switch 错误码,message 仅兜底展示——文案权在服务端。
 */
export type ApiErrorCode =
  | 'unauthenticated' // 401:无有效 session
  | 'invalid-credentials' // 401:用户名或密码错误(故意不区分哪个错)
  | 'forbidden' // 403:已登录但无权限(如普通用户访问 admin 路由)
  | 'origin-forbidden' // 403:非 GET 请求携带了不在 allowlist 的 Origin(CSRF 防线)
  | 'account-disabled' // 403:账号被 admin 停用
  | 'no-user-key' // 403:该 provider 未配置用户 key(P2 LLM 网关用)
  | 'invalid-invite' // 400:邀请码不存在/已用/已过期
  | 'username-taken' // 409:用户名已被占用(NOCASE 判重)
  | 'invalid-input' // 400:请求体不合法
  | 'not-found' // 404
  | 'quota-exceeded' // 413:存储配额不足(P3 同步域用)
  | 'rate-limited' // 429:登录爆破限流/LLM 限流,带 Retry-After 头
  | 'internal' // 500

export interface ApiError {
  error: ApiErrorCode
  message?: string
}

/** LLM provider allowlist:与 nginx/vite 代理的 5 条路由一一对应 */
export const LLM_PROVIDERS = ['deepseek', 'moonshot', 'zhipu', 'jina', 'openai-compat'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

export type UserRole = 'admin' | 'user'

// ---- auth ----

export interface RegisterBody {
  username: string
  password: string
  inviteCode: string
}

export interface LoginBody {
  username: string
  password: string
}

export interface ChangePasswordBody {
  oldPassword: string
  newPassword: string
}

/** 用户 key 只回 last4,明文永不出服务端 */
export interface LlmKeyInfo {
  last4: string
}

/** GET /auth/me 与 login/register 成功响应共用 */
export interface MeResponse {
  id: number
  username: string
  role: UserRole
  storageQuotaBytes: number
  storageUsedBytes: number
  llmKeys: Record<LlmProvider, LlmKeyInfo | null>
}

// ---- llm keys ----

export interface PutLlmKeyBody {
  key: string
}

export interface PutLlmKeyResponse {
  provider: LlmProvider
  last4: string
}

// ---- admin ----

export interface CreateInviteBody {
  /** 缺省 = 永不过期 */
  expiresInDays?: number
  note?: string
}

export interface InviteCode {
  code: string
  createdAt: number
  expiresAt: number | null
  note: string | null
  usedBy: number | null
  usedAt: number | null
}

export interface AdminUser {
  id: number
  username: string
  role: UserRole
  disabled: boolean
  storageQuotaBytes: number
  storageUsedBytes: number
  createdAt: number
}

export interface AdminUpdateUserBody {
  disabled?: boolean
  storageQuotaBytes?: number
}

export interface RecountQuotaResponse {
  ok: true
  /** 被重算的用户数 */
  users: number
}

// ---- llm gateway(P2)----

/**
 * 403 无用户 key 时的响应体(伴随响应头 X-LLM-Deny: no-user-key):
 * 比通用 ApiError 多带 provider,前端可直接引导"去设置页给 xx 配 key"。
 */
export interface LlmDenyBody {
  error: 'no-user-key'
  provider: LlmProvider
}

// ---- sync(P3)----

/**
 * 可同步的 8 张业务表。chunks 明确不收:它是 blocks 的确定性派生物,
 * 换设备本地重建(buildPaperIndex)比上传/下载更便宜也永不漂移。
 */
export const SYNC_TABLES = [
  'papers',
  'blocks',
  'briefs',
  'sessions',
  'messages',
  'conceptStates',
  'evidence',
  'usage',
] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

/** push 逐条变更;tbl 故意不收窄成 SyncTable——不合法的表名逐条 rejected 而非整批 400 */
export interface SyncPushChange {
  tbl: string
  id: string
  /** 非 papers 记录所属论文 id(级联删除/paper-deleted 校验用);papers 记录取自身 id,可省略 */
  paperId?: string
  /** true = 墓碑(删除该记录),payload 忽略 */
  deleted?: boolean
  payload?: unknown
}

export interface SyncPushBody {
  changes: SyncPushChange[]
}

export type SyncRejectReason = 'tbl-not-allowed' | 'paper-deleted'

export interface SyncPushResponse {
  applied: { tbl: string; id: string; seq: number }[]
  rejected: { tbl: string; id: string; reason: SyncRejectReason }[]
  /** 应用后的全局 seq 水位:客户端可直接作为下次 changes?since= 的起点 */
  cursor: number
}

export interface SyncChangeRecord {
  tbl: string
  id: string
  paperId: string | null
  deleted: boolean
  /** 墓碑行为 null */
  payload: unknown
  seq: number
  updatedAt: number
}

export interface SyncChangesResponse {
  changes: SyncChangeRecord[]
  nextSince: number
  hasMore: boolean
}

export interface SyncSnapshotResponse {
  /** 存活(非墓碑)记录清单,不含 payload——长期离线设备对账用 */
  records: { tbl: string; id: string; seq: number }[]
  cursor: number
}

export interface DeletePaperResponse {
  ok: true
  cursor: number
}

export interface FilePutResponse {
  ok: true
  sha256: string
  byteSize: number
}

// ---- misc ----

export interface OkResponse {
  ok: true
}

export interface HealthResponse {
  ok: true
  version: string
}
