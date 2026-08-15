import Dexie, { type Table } from 'dexie'
import { useAuthStore } from '../../auth/authStore'
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

// ---------------------------------------------------------------------------
// P4 同步域本地表类型（v2 纯加法）
// ---------------------------------------------------------------------------

export type OutboxOp = 'progress' | 'record' | 'push-artifacts' | 'delete-paper'

/**
 * outbox 队列项：本地写入的「待推送镜像」。
 * - progress：payload = 入队时刻的完整 papers 行（含最新 progress）——pagehide 的
 *   keepalive 兜底推送没有机会再读 IndexedDB，payload 必须自带；
 * - record：payload = 完整业务行（tbl+recordId 直传服务端，LWW 语义靠整行覆盖）；
 * - push-artifacts / delete-paper：只带 paperId，推送时刻由引擎读库组装。
 */
export interface OutboxItem {
  /** Dexie 自增主键：兼作 FIFO 顺序与合并时的「谁更新」判据 */
  qid?: number
  op: OutboxOp
  paperId: string
  /** record 项：目标表名（服务端 allowlist 8 张之一） */
  tbl?: string
  /** record 项：目标行 id */
  recordId?: string
  /** record 项：true = 墓碑（删除该行） */
  deleted?: boolean
  payload?: unknown
  createdAt: number
}

/** syncState：KV 杂物间（游标 cursor、lastSyncAt、claimedShas、claimDismissed…） */
export interface SyncStateRow {
  key: string
  value: unknown
}

/** 每论文的同步进展标记：徽标显示与「换设备补拉」判定用 */
export interface SyncMetaRow {
  paperId: string
  ownerId?: number
  /** papers 行 + 原始文件 + blocks 已完整推上服务端 */
  artifactsPushed?: boolean
  /** blocks 已从服务端整拉过一轮（换设备场景；本机解析的论文由引擎在推完制品时置 true） */
  blocksPulled?: boolean
  /** 原始文件字节已 PUT 成功（同 sha 重试时跳过整个上传） */
  filePushed?: boolean
}

/**
 * Paper Copilot 的 IndexedDB schema。
 * v1 一次建齐 §4.2 全部 12 张表（含尚未使用的 Phase 2–4 实体），Phase 2–4 只加字段不加 migration。
 * v2（P4 同步客户端）纯加法：outbox / syncState / syncMeta 三张同步域本地表，
 * 既有 12 张表的索引与数据零变动——老库升级只是建三张空表。
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
  outbox!: Table<OutboxItem, number>
  syncState!: Table<SyncStateRow, string>
  syncMeta!: Table<SyncMetaRow, string>

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
    this.version(2).stores({
      outbox: '++qid, op, paperId',
      syncState: 'key',
      syncMeta: 'paperId',
    })
  }
}

// ---------------------------------------------------------------------------
// 账号感知的 active-db 机制：登录后数据落 paper-copilot-u{userId}，游客沿用 paper-copilot。
// 按账号分库而非行级 ownerId 过滤——同浏览器多账号串门在物理上不可能发生。
// ---------------------------------------------------------------------------

export const dbNameForUser = (userId: number): string => `${PAPER_DB_NAME}-u${userId}`

/**
 * 实例缓存按库名索引：账号库与游客库可同时打开（认领要跨两库读写），
 * 切换账号不关闭旧连接——IndexedDB 连接常驻是浏览器常态，代价可忽略。
 */
const instances = new Map<string, PaperDb>()

function dbByName(name: string): PaperDb {
  let db = instances.get(name)
  if (!db) {
    db = new PaperDb(name)
    instances.set(name, db)
  }
  return db
}

/** 游客库（登录前的历史数据；认领扫描的数据源） */
export function getGuestPaperDb(): PaperDb {
  return dbByName(PAPER_DB_NAME)
}

export function getPaperDbForUser(userId: number): PaperDb {
  return dbByName(dbNameForUser(userId))
}

/**
 * 当前活跃库：**每次调用时**按登录态解析（不靠订阅缓存）——账号切换瞬间的写入
 * 也会路由到正确的库，不存在「订阅回调还没跑、写进了旧库」的窗口。
 * node 测试不走这里——各测例各自 `new PaperDb(唯一库名, { indexedDB, IDBKeyRange })` 以保证互不干扰。
 */
export function getPaperDb(): PaperDb {
  const { status, user } = useAuthStore.getState()
  return status === 'authed' && user ? getPaperDbForUser(user.id) : getGuestPaperDb()
}

/**
 * 删除整个本地库（设置页「清除本地论文缓存」用）：先关缓存里的连接再物理删库，
 * 否则打开中的连接会让 deleteDatabase 一直 blocked。
 */
export async function destroyPaperDb(name: string): Promise<void> {
  const cached = instances.get(name)
  if (cached) {
    cached.close()
    instances.delete(name)
  }
  await Dexie.delete(name)
}
