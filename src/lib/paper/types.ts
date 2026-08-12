// Paper Copilot 数据模型（PLAN-paper-copilot.md §4.2）。
// Phase 1 完整实现 papers / files / blocks / jobs 四张表所用类型；其余实体为占位类型，
// schema v1 已一次建齐对应表（见 repo/db.ts），后续 Phase 只加字段、不加 migration。

export type PaperFormat = 'pdf' | 'docx'

/** 导入状态机阶段（§4.4：校验 → 解析 → 规范化 → 索引 → 可阅读） */
export type IngestStage = 'queued' | 'validating' | 'parsing' | 'normalizing' | 'indexing' | 'ready' | 'failed'

/** 失败分类：决定 UI 文案与是否允许重试（见 ingest.ts 的 isRetryable） */
export type IngestFailureKind =
  | 'unsupported-format'
  | 'too-large'
  | 'empty'
  | 'corrupt'
  | 'encrypted'
  | 'no-text-layer'
  | 'too-many-pages'
  | 'too-much-text'
  | 'storage'
  | 'unknown'

export interface ReadingProgress {
  blockIndex: number
  ratio: number
  page?: number
  updatedAt: number
  /** 读到过的最深块序号（只增不减）：目录据此标记「已读章节」，回看旧章节不会把进度打回去 */
  maxBlockIndex?: number
  /** 上次使用的阅读视图，回到这篇论文时恢复 */
  mode?: 'original' | 'text'
}

export interface IngestFailure {
  kind: IngestFailureKind
  message: string
  at: number
}

/**
 * 引用锚点（§4.2）。blockIndex 是稳定定位主键——PDF 页码与字符偏移都可能因解析器升级漂移，
 * 但规范化块序号在同一 parserVersion 内稳定，Phase 2 的引用跳转以它为准。
 */
export interface SourceAnchor {
  kind: PaperFormat
  blockIndex: number
  /** PDF 1-based 页码；DOCX 无页概念 */
  page?: number
  charStart?: number
  charEnd?: number
  /** 最近一级上级标题，用于「§4.2 Method」式引用展示 */
  section?: string
}

export type PaperBlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'formula' | 'caption'

export interface PaperBlock {
  id: string
  paperId: string
  index: number
  kind: PaperBlockKind
  /** heading 的层级 1-6 */
  level?: number
  text: string
  /** 仅 DOCX 表格等需要保留结构时携带（已过 sanitize 白名单） */
  html?: string
  anchor: SourceAnchor
}

/** 解析器产出形：id / paperId 由仓储在写入时补齐 */
export type NormalizedBlock = Omit<PaperBlock, 'id' | 'paperId'>

export interface PaperRecord {
  id: string
  title: string
  fileName: string
  format: PaperFormat
  mime: string
  byteSize: number
  sha256: string
  status: IngestStage
  failure?: IngestFailure
  pageCount?: number
  blockCount?: number
  charCount?: number
  /** 写入时的 PARSER_VERSION；升级解析器后可据此提示重建索引 */
  parserVersion: number
  /** §8 敏感论文本地模式：Phase 1 只存字段，UI 开关归后续 Phase */
  sensitive: boolean
  createdAt: number
  updatedAt: number
  lastReadAt?: number
  progress: ReadingProgress
}

/**
 * 原始文件字节独立一张表（不内嵌进 PaperRecord）：列表查询不会反序列化 50MB 字节。
 * 用 ArrayBuffer + mime 字符串而非 Blob——node 环境可结构化克隆，fake-indexeddb 单测可覆盖。
 */
export interface PaperFileBytes {
  paperId: string
  bytes: ArrayBuffer
  mime: string
}

export interface IngestionJob {
  id: string
  paperId: string
  stage: IngestStage
  attempts: number
  failure?: IngestFailure
  startedAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// 以下为占位类型：schema v1 已建表，Phase 2–4 落地仓储方法时按加法式扩展字段。
// ---------------------------------------------------------------------------

/** Phase 2 落地：检索用语义块（约 1200 token / 15% 重叠） */
export interface PaperChunk {
  id: string
  paperId: string
  order: number
  text: string
  anchor: SourceAnchor
  /** 起止块序号，便于回溯原文 */
  blockStart: number
  blockEnd: number
  /** chars/3 粗估的 token 数（估算值，全链路标注） */
  tokenEstimate?: number
  /**
   * BM25 词频表与词元总数：索引的持久化形态（见 bm25.ts）。
   * 存在 chunk 行里而不是单独建索引表——查询时在内存重建倒排表只要毫秒级，
   * 于是 schema 保持「只加字段、不加 migration」。
   */
  tf?: Record<string, number>
  len?: number
}

/** Phase 3 落地：论文地图与分层摘要 */
export interface PaperBrief {
  id: string
  paperId: string
  /** 缓存键含 fileHash + provider + model + promptVersion */
  cacheKey: string
  createdAt: number
  /** 结构化地图内容，字段随 Phase 3 定稿 */
  data: unknown
}

/** Phase 3 落地：某篇论文的持久化陪读会话（Phase 3 加法字段，schema 不动） */
export interface CopilotSession {
  id: string
  paperId: string
  title: string
  createdAt: number
  updatedAt: number
  /** 滚动摘要（memo 岛折叠产物） */
  rollingSummary?: string
  /** 距上次 memo 折叠的轮数 */
  turnsSinceMemo?: number
  /** 会话累计成本（美元） */
  costTotal?: number
}

/** 与 retrieval.CiteMapEntry 结构一致的可序列化形态（types.ts 不 import retrieval，避免环） */
export interface StoredCiteEntry {
  alias: string
  chunkId: string
  anchor: SourceAnchor
  page?: number
  section?: string
}

/** Phase 3 落地：会话消息。存原始流文本 + finalize 元数据（单一真相），渲染时重跑线协议解析 */
export interface CopilotMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /** assistant：本轮引用白名单（CiteBadge 点击跳转用） */
  citeMap?: StoredCiteEntry[]
  /** assistant：引用体检结果（alias → 徽章档位） */
  auditBadges?: Record<string, 'ok' | 'weak' | 'missing'>
  /** Stop / 断流：半截保留并标记「响应中断」 */
  interrupted?: boolean
  /** 证据不足终态 */
  insufficient?: boolean
  /** 本轮 usage（不含正文） */
  usage?: { provider: string; model: string; inputTokens: number; outputTokens: number; estimated: boolean; cost: number }
  /** user：来自选区快捷操作时的标签（解释这段/更简单/…） */
  actionLabel?: string
}

/** Phase 4 落地：按概念的掌握度画像 */
export interface LearnerConceptState {
  id: string
  paperId: string
  conceptId: string
  mastery: number
  confidence: number
  updatedAt: number
}

/** Phase 4 落地：画像证据日志（不含论文正文与问题原文） */
export interface EvidenceRecord {
  id: string
  paperId: string
  conceptId: string
  dir: 1 | -1
  weight: number
  source: string
  ts: number
}

/** Phase 3 落地：按 provider 独立的文档片段外发授权，不跨 provider 继承 */
export interface ProviderConsent {
  provider: string
  granted: boolean
  grantedAt: number
}

/** Phase 3 落地：token / 时延 / 成本记录，不含问题或论文正文 */
export interface ModelUsageRecord {
  id: string
  paperId: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  estimated: boolean
  cost: number
  ts: number
  /** Phase 3 加法：调用结局 / 时延 / 任务标签（不含内容） */
  status?: 'ok' | 'aborted' | 'error'
  latencyMs?: number
  task?: string
}
