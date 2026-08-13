import Dexie, { type Table } from 'dexie'
import type {
  CopilotMessage,
  CopilotSession,
  EvidenceRecord,
  IngestionJob,
  LearnerConceptState,
  ModelUsageRecord,
  PaperBlock,
  PaperBrief,
  PaperChunk,
  PaperFileBytes,
  PaperRecord,
  ProviderConsent,
} from '../types'

export const PAPER_DB_NAME = 'paper-copilot'

/** 解析器版本：升级后写入的 PaperRecord.parserVersion 变化，可据此提示用户重建索引 */
export const PARSER_VERSION = 1

/**
 * Paper Copilot 的 IndexedDB schema。
 * v1 一次建齐 §4.2 全部 12 张表（含尚未使用的 Phase 2–4 实体），Phase 2–4 只加字段不加 migration。
 * sha256 用普通索引而非 &unique：去重由 findBySha256 显式判定后交给用户选择
 * （打开已有 / 替换导入），不依赖 ConstraintError 做控制流。
 */
export class PaperDb extends Dexie {
  papers!: Table<PaperRecord, string>
  files!: Table<PaperFileBytes, string>
  blocks!: Table<PaperBlock, string>
  jobs!: Table<IngestionJob, string>
  chunks!: Table<PaperChunk, string>
  briefs!: Table<PaperBrief, string>
  sessions!: Table<CopilotSession, string>
  messages!: Table<CopilotMessage, string>
  conceptStates!: Table<LearnerConceptState, string>
  evidence!: Table<EvidenceRecord, string>
  consents!: Table<ProviderConsent, string>
  usage!: Table<ModelUsageRecord, string>

  constructor(name = PAPER_DB_NAME, options?: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }) {
    super(name, options)
    this.version(1).stores({
      papers: 'id, sha256, status, createdAt, lastReadAt, title',
      files: 'paperId',
      blocks: 'id, paperId, [paperId+index]',
      jobs: 'id, paperId, stage',
      chunks: 'id, paperId, [paperId+order]',
      briefs: 'id, paperId, cacheKey',
      sessions: 'id, paperId, updatedAt',
      messages: 'id, sessionId, [sessionId+createdAt]',
      conceptStates: 'id, paperId, [paperId+conceptId]',
      evidence: 'id, paperId, [paperId+conceptId], ts',
      consents: 'provider',
      usage: 'id, paperId, ts',
    })
  }
}

let singleton: PaperDb | null = null

/**
 * 浏览器侧懒单例。node 测试不走这里——各测例各自
 * `new PaperDb(唯一库名, { indexedDB, IDBKeyRange })` 以保证互不干扰。
 */
export function getPaperDb(): PaperDb {
  if (!singleton) singleton = new PaperDb()
  return singleton
}
