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

/** Phase 3 落地：某篇论文的持久化陪读会话 */
export interface CopilotSession {
  id: string
  paperId: string
  title: string
  createdAt: number
  updatedAt: number
}

/** Phase 3 落地：会话消息（含结构化交互块） */
export interface CopilotMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
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
}
