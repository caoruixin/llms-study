import { IngestError } from '../ingest'
import type {
  IngestFailure,
  IngestStage,
  IngestionJob,
  NormalizedBlock,
  PaperBlock,
  PaperChunk,
  PaperFileBytes,
  PaperFormat,
  PaperRecord,
  PaperSource,
} from '../types'
import { PARSER_VERSION, type PaperDb } from './db'

export interface NewPaperInput {
  title: string
  fileName: string
  format: PaperFormat
  mime: string
  byteSize: number
  sha256: string
  bytes: ArrayBuffer
  sensitive?: boolean
  /** Track 1：URL 导入透传抓取来源清单；本地文件上传不传 */
  source?: PaperSource
}

export interface ReadyStats {
  pageCount?: number
  blockCount: number
  charCount: number
  title?: string
}

/**
 * §4.3 可替换服务边界：论文、正文块、导入任务与阅读进度的持久化。
 * v1 是 Dexie/IndexedDB 实现；接口本身不含任何 Dexie 类型，未来可整体换成服务端实现。
 */
export interface PaperRepository {
  listPapers(): Promise<PaperRecord[]>
  getPaper(id: string): Promise<PaperRecord | undefined>
  findBySha256(sha: string): Promise<PaperRecord | undefined>
  createPaper(input: NewPaperInput): Promise<PaperRecord>
  getFileBytes(paperId: string): Promise<PaperFileBytes | undefined>
  saveBlocks(paperId: string, blocks: NormalizedBlock[]): Promise<void>
  getBlocks(paperId: string): Promise<PaperBlock[]>
  saveChunks(paperId: string, chunks: PaperChunk[]): Promise<void>
  getChunks(paperId: string): Promise<PaperChunk[]>
  setStage(paperId: string, stage: IngestStage, patch?: Partial<PaperRecord>): Promise<void>
  markFailed(paperId: string, failure: IngestFailure): Promise<void>
  markReady(paperId: string, stats: ReadyStats): Promise<void>
  retryPaper(paperId: string): Promise<void>
  updateProgress(paperId: string, progress: import('../types').ReadingProgress): Promise<void>
  deletePaper(paperId: string): Promise<void>
}

/**
 * 配额/存储异常统一包装为 IngestError{kind:'storage'} 上抛——不吞掉，
 * 让状态机把这条论文标成可重试的 failed，而不是留下一条卡在 parsing 的僵尸记录。
 */
function isStorageError(e: unknown): boolean {
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) return true
  const name = (e as { name?: unknown } | null)?.name
  return name === 'QuotaExceededError' || name === 'AbortError' || name === 'DataCloneError'
}

async function guard<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (e) {
    if (e instanceof IngestError) throw e
    if (isStorageError(e)) {
      throw new IngestError('storage', '本地存储写入失败，可能是浏览器存储空间不足，请清理后重试')
    }
    throw e
  }
}

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export function createPaperRepository(db: PaperDb): PaperRepository {
  // 级联删除覆盖的全部表（consents 是全局 provider 授权，与单篇论文无关，不删）
  const allTables = [
    db.papers,
    db.files,
    db.blocks,
    db.jobs,
    db.chunks,
    db.briefs,
    db.sessions,
    db.messages,
    db.conceptStates,
    db.evidence,
    db.consents,
    db.usage,
    db.translations,
  ]

  /** 同步更新 jobs 表的当前阶段（jobs 是导入过程的可观测镜像，papers 才是权威状态） */
  async function patchJob(paperId: string, patch: Partial<IngestionJob>): Promise<void> {
    const job = await db.jobs.where('paperId').equals(paperId).first()
    if (job) await db.jobs.update(job.id, { ...patch, updatedAt: Date.now() })
  }

  return {
    listPapers: () => guard(() => db.papers.toArray()),

    getPaper: (id) => guard(() => db.papers.get(id)),

    findBySha256: (sha) => guard(() => db.papers.where('sha256').equals(sha).first()),

    createPaper: (input) =>
      guard(async () => {
        const now = Date.now()
        const paper: PaperRecord = {
          id: newId(),
          title: input.title,
          fileName: input.fileName,
          format: input.format,
          mime: input.mime,
          byteSize: input.byteSize,
          sha256: input.sha256,
          status: 'queued',
          parserVersion: PARSER_VERSION,
          sensitive: input.sensitive ?? false,
          createdAt: now,
          updatedAt: now,
          progress: { blockIndex: 0, ratio: 0, updatedAt: now },
          ...(input.source ? { source: input.source } : {}),
        }
        // papers + files + jobs 同事务：任一步失败都不会留下「有元数据无字节」的半截论文
        await db.transaction('rw', [db.papers, db.files, db.jobs], async () => {
          await db.papers.add(paper)
          await db.files.add({ paperId: paper.id, bytes: input.bytes, mime: input.mime })
          await db.jobs.add({
            id: newId(),
            paperId: paper.id,
            stage: 'queued',
            attempts: 0,
            startedAt: now,
            updatedAt: now,
          })
        })
        return paper
      }),

    getFileBytes: (paperId) => guard(() => db.files.get(paperId)),

    saveBlocks: (paperId, blocks) =>
      guard(async () => {
        const rows: PaperBlock[] = blocks.map((b) => ({ ...b, id: `${paperId}:${b.index}`, paperId }))
        // 先清旧块再整批写入，同事务——重新解析（retry / parserVersion 升级）不会与旧块混叠
        await db.transaction('rw', [db.blocks], async () => {
          await db.blocks.where('paperId').equals(paperId).delete()
          if (rows.length) await db.blocks.bulkAdd(rows)
        })
      }),

    // 与 saveBlocks 同样的「先清后写」语义：重建索引不会与上一版 chunk 混叠
    saveChunks: (paperId, chunks) =>
      guard(async () => {
        await db.transaction('rw', [db.chunks], async () => {
          await db.chunks.where('paperId').equals(paperId).delete()
          if (chunks.length) await db.chunks.bulkAdd(chunks)
        })
      }),

    getChunks: (paperId) =>
      guard(() =>
        db.chunks
          .where('[paperId+order]')
          .between([paperId, -Infinity], [paperId, Infinity])
          .toArray(),
      ),

    // [paperId+index] 复合索引天然有序，无需在内存里再 sort
    getBlocks: (paperId) =>
      guard(() =>
        db.blocks
          .where('[paperId+index]')
          .between([paperId, -Infinity], [paperId, Infinity])
          .toArray(),
      ),

    setStage: (paperId, stage, patch) =>
      guard(async () => {
        await db.transaction('rw', [db.papers, db.jobs], async () => {
          await db.papers.update(paperId, { ...patch, status: stage, updatedAt: Date.now() })
          await patchJob(paperId, { stage })
        })
      }),

    markFailed: (paperId, failure) =>
      guard(async () => {
        await db.transaction('rw', [db.papers, db.jobs], async () => {
          await db.papers.update(paperId, { status: 'failed', failure, updatedAt: Date.now() })
          await patchJob(paperId, { stage: 'failed', failure })
        })
      }),

    markReady: (paperId, stats) =>
      guard(async () => {
        const patch: Partial<PaperRecord> = {
          status: 'ready',
          blockCount: stats.blockCount,
          charCount: stats.charCount,
          failure: undefined,
          updatedAt: Date.now(),
        }
        if (stats.pageCount !== undefined) patch.pageCount = stats.pageCount
        if (stats.title) patch.title = stats.title
        await db.transaction('rw', [db.papers, db.jobs], async () => {
          await db.papers.update(paperId, patch)
          await patchJob(paperId, { stage: 'ready', failure: undefined })
        })
      }),

    retryPaper: (paperId) =>
      guard(async () => {
        await db.transaction('rw', [db.papers, db.jobs], async () => {
          await db.papers.update(paperId, { status: 'queued', failure: undefined, updatedAt: Date.now() })
          const job = await db.jobs.where('paperId').equals(paperId).first()
          if (job) {
            await db.jobs.update(job.id, {
              stage: 'queued',
              attempts: job.attempts + 1,
              failure: undefined,
              updatedAt: Date.now(),
            })
          }
        })
      }),

    // 阅读进度与 lastReadAt 一起写：列表的「最近阅读」排序直接读 lastReadAt
    updateProgress: (paperId, progress) =>
      guard(() => db.papers.update(paperId, { progress, lastReadAt: progress.updatedAt }).then(() => undefined)),

    deletePaper: (paperId) =>
      guard(async () => {
        await db.transaction('rw', allTables, async () => {
          // messages 只有 sessionId 索引，必须先取出该论文的 session id 集合
          const sessionIds = (await db.sessions.where('paperId').equals(paperId).toArray()).map((s) => s.id)
          if (sessionIds.length) await db.messages.where('sessionId').anyOf(sessionIds).delete()
          await Promise.all([
            db.files.where('paperId').equals(paperId).delete(),
            db.blocks.where('paperId').equals(paperId).delete(),
            db.jobs.where('paperId').equals(paperId).delete(),
            db.chunks.where('paperId').equals(paperId).delete(),
            db.briefs.where('paperId').equals(paperId).delete(),
            db.sessions.where('paperId').equals(paperId).delete(),
            db.conceptStates.where('paperId').equals(paperId).delete(),
            db.evidence.where('paperId').equals(paperId).delete(),
            db.usage.where('paperId').equals(paperId).delete(),
            db.translations.where('paperId').equals(paperId).delete(),
          ])
          await db.papers.delete(paperId)
        })
      }),
  }
}
