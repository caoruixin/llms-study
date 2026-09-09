import type { OutboxItem, PaperDb } from './db'
import { outboxSignal } from '../sync/outbox'
import { createPaperRepository, type PaperRepository } from './paperRepo'
import { createCopilotRepository, type CopilotRepository } from './copilotRepo'
import { createLearnerRepository, profileToRow, type LearnerRepository } from './learnerRepo'
import { createTranslationRepository, type TranslationRepository } from './translationRepo'
import { createHighlightRepository, type HighlightRepository } from './highlightRepo'

/**
 * 同步装饰器（P4）：先写本地（完全委托原仓储，字节级不变），再把「值得同步的写入」
 * 镜像进同库 outbox。读方法与 ingest 中间态（setStage/saveBlocks/saveChunks/jobs/
 * markFailed/retryPaper/createPaper）不入队——制品在 markReady 后由 push-artifacts
 * 一次性整推；chunks/jobs/consents 永不同步（确定性派生物 / 设备瞬态 / 按设备语义）。
 *
 * shouldQueue 每次写入时调用：只有「已登录且写的是账号库」才入队——游客库的写入
 * 没有归属账号，入队只会造成推送 401 死循环。
 */
export interface SyncedDeps {
  shouldQueue: () => boolean
  now?: () => number
}

type NewItem = Omit<OutboxItem, 'qid' | 'createdAt'>

function makeEnqueue(db: PaperDb, deps: SyncedDeps) {
  const now = deps.now ?? Date.now
  return async (item: NewItem): Promise<void> => {
    if (!deps.shouldQueue()) return
    try {
      const full: OutboxItem = { ...item, createdAt: now() }
      await db.outbox.add(full)
      outboxSignal.emit(db.name, full)
    } catch (e) {
      // 入队失败绝不能拖垮用户写入本身：本地已写成功，丢的只是这一次推送机会
      console.warn('[sync] outbox 入队失败', e)
    }
  }
}

// ---------------------------------------------------------------------------
// PaperRepository
// ---------------------------------------------------------------------------

export function createSyncedPaperRepository(db: PaperDb, deps: SyncedDeps): PaperRepository {
  const local = createPaperRepository(db)
  const enqueue = makeEnqueue(db, deps)

  return {
    ...local,

    // 进度：payload 带整行 papers 快照——keepalive 兜底推送没机会再读库
    updateProgress: async (paperId, progress) => {
      await local.updateProgress(paperId, progress)
      const row = await db.papers.get(paperId)
      if (row) await enqueue({ op: 'progress', paperId, payload: row })
    },

    // ready 是制品定稿点：papers 行 + 原始文件 + blocks 由引擎按序列一次性整推
    markReady: async (paperId, stats) => {
      // 上一版的块数：replaceFile/retryPaper 都不动 blockCount，它一直是服务端已有块数的忠实记录
      const prevBlockCount = (await db.papers.get(paperId))?.blockCount ?? 0
      await local.markReady(paperId, stats)
      if (deps.shouldQueue()) {
        // 整行覆盖既有 meta（含 lastError/attempts）：重新解析（retry）后制品变了，三步全部重推
        await db.syncMeta.put({
          paperId,
          artifactsPushed: false,
          blocksPushed: false,
          filePushed: false,
          blocksPulled: true,
        })
      }
      // 重解析/原地重导入后块数变少：blocks 行 id 是 `${paperId}:${index}` 确定性拼接，push-artifacts
      // 只 upsert 现有行，服务端与其它设备会永远留着旧尾块（旧段落接在新正文后面，译文/高亮还锚着旧文）。
      // 尾巴逐行入队墓碑；record 批先于制品序列推送，且索引与新块不重叠，不存在与 upsert 的竞争。
      for (let index = stats.blockCount; index < prevBlockCount; index++) {
        await enqueue({ op: 'record', tbl: 'blocks', recordId: `${paperId}:${index}`, paperId, deleted: true })
      }
      await enqueue({ op: 'push-artifacts', paperId })
    },

    /**
     * 原地重导入：本地换字节 + 清译文/高亮，队列里只补两类**墓碑**——
     * 那两张表的行是逐行同步的（§1.6），删掉后不推墓碑，另一台设备会把陈旧译文/高亮拉回来。
     * 制品本身不在这里入队：随后 reingestPaper 的 markReady 会整行重置 syncMeta 并入队
     * push-artifacts，新 sha 的文件届时自然重传（服务端只在 sha 相同时短路）；
     * 新正文比旧的短时多出来的旧尾块也由 markReady 按旧 blockCount 补墓碑。
     */
    replaceFile: async (paperId, input) => {
      // 先取将被删的行 id：replaceFile 返回时它们已经不在库里了
      const queueing = deps.shouldQueue()
      const translationIds = queueing
        ? (await db.translations.where('paperId').equals(paperId).toArray()).map((r) => r.id)
        : []
      const highlightIds = queueing ? (await db.highlights.where('paperId').equals(paperId).toArray()).map((r) => r.id) : []
      await local.replaceFile(paperId, input)
      for (const id of translationIds) {
        await enqueue({ op: 'record', tbl: 'translations', recordId: id, paperId, deleted: true })
      }
      for (const id of highlightIds) {
        await enqueue({ op: 'record', tbl: 'highlights', recordId: id, paperId, deleted: true })
      }
    },

    deletePaper: async (paperId) => {
      await local.deletePaper(paperId)
      await db.syncMeta.delete(paperId).catch(() => undefined)
      await enqueue({ op: 'delete-paper', paperId })
    },
  }
}

// ---------------------------------------------------------------------------
// CopilotRepository
// ---------------------------------------------------------------------------

export function createSyncedCopilotRepository(db: PaperDb, deps: SyncedDeps): CopilotRepository {
  const local = createCopilotRepository(db)
  const enqueue = makeEnqueue(db, deps)

  /** messages 行只有 sessionId：paperId（服务端级联列）要经 session 反查 */
  const paperIdOfSession = async (sessionId: string): Promise<string | null> =>
    (await db.sessions.get(sessionId))?.paperId ?? null

  const synced: CopilotRepository = {
    ...local,

    getOrCreateSession: async (paperId, title) => {
      const row = await local.getOrCreateSession(paperId, title)
      // 每次打开都会重入队一条 session 行——outbox 按 (tbl,id) 去重，只是幂等覆盖
      await enqueue({ op: 'record', tbl: 'sessions', recordId: row.id, paperId, payload: row })
      return row
    },

    updateSession: async (id, patch) => {
      await local.updateSession(id, patch)
      const row = await db.sessions.get(id)
      if (row) await enqueue({ op: 'record', tbl: 'sessions', recordId: id, paperId: row.paperId, payload: row })
    },

    resetSession: async (sessionId) => {
      // 先取要删的消息 id 与归属论文：删完就查不到了
      const paperId = await paperIdOfSession(sessionId)
      const messageIds = (await db.messages.where('sessionId').equals(sessionId).toArray()).map((m) => m.id)
      await local.resetSession(sessionId)
      if (!paperId) return
      for (const id of messageIds) {
        await enqueue({ op: 'record', tbl: 'messages', recordId: id, paperId, deleted: true })
      }
      const row = await db.sessions.get(sessionId)
      if (row) await enqueue({ op: 'record', tbl: 'sessions', recordId: sessionId, paperId, payload: row })
    },

    addMessage: async (msg) => {
      const row = await local.addMessage(msg)
      const paperId = await paperIdOfSession(row.sessionId)
      if (paperId) await enqueue({ op: 'record', tbl: 'messages', recordId: row.id, paperId, payload: row })
      return row
    },

    updateMessage: async (id, patch) => {
      await local.updateMessage(id, patch)
      const row = await db.messages.get(id)
      if (!row) return
      const paperId = await paperIdOfSession(row.sessionId)
      if (paperId) await enqueue({ op: 'record', tbl: 'messages', recordId: id, paperId, payload: row })
    },

    addUsage: async (draft) => {
      const row = await local.addUsage(draft)
      await enqueue({ op: 'record', tbl: 'usage', recordId: row.id, paperId: row.paperId, payload: row })
      return row
    },

    saveBrief: async (paperId, cacheKey, data) => {
      await local.saveBrief(paperId, cacheKey, data)
      const row = await local.getBrief(paperId, cacheKey)
      if (row) await enqueue({ op: 'record', tbl: 'briefs', recordId: row.id, paperId, payload: row })
    },

    // 必须走装饰后的 saveBrief（local 实现里是 this.saveBrief，直接展开会绕过入队）
    saveUnitDigest: async (paperId, cacheKey, digest) => {
      await synced.saveBrief(paperId, cacheKey, digest)
    },

    // sensitive 是 papers 行字段：以整行覆盖同步（LWW），另一台设备才能看到本地模式开关
    setSensitive: async (paperId, sensitive) => {
      await local.setSensitive(paperId, sensitive)
      const row = await db.papers.get(paperId)
      if (row) await enqueue({ op: 'record', tbl: 'papers', recordId: paperId, paperId, payload: row })
    },
  }
  return synced
}

// ---------------------------------------------------------------------------
// LearnerRepository
// ---------------------------------------------------------------------------

export function createSyncedLearnerRepository(db: PaperDb, deps: SyncedDeps): LearnerRepository {
  const local = createLearnerRepository(db)
  const enqueue = makeEnqueue(db, deps)

  return {
    ...local,

    save: async (paperId, profiles) => {
      await local.save(paperId, profiles)
      // 行 id 是 `${paperId}:${conceptId}` 确定性拼接：与 local.save 写入的行完全一致
      for (const p of profiles) {
        const row = profileToRow(paperId, p)
        await enqueue({ op: 'record', tbl: 'conceptStates', recordId: row.id, paperId, payload: row })
      }
    },

    logEvidence: async (paperId, ev) => {
      const rows = await local.logEvidence(paperId, ev)
      for (const row of rows) {
        await enqueue({ op: 'record', tbl: 'evidence', recordId: row.id, paperId, payload: row })
      }
      return rows
    },

    reset: async (paperId) => {
      // 先取将被删的行 id：墓碑要逐行推送，否则另一台设备的画像不会清空
      const stateIds = (await db.conceptStates.where('paperId').equals(paperId).toArray()).map((r) => r.id)
      const evidenceIds = (await db.evidence.where('paperId').equals(paperId).toArray()).map((r) => r.id)
      await local.reset(paperId)
      for (const id of stateIds) {
        await enqueue({ op: 'record', tbl: 'conceptStates', recordId: id, paperId, deleted: true })
      }
      for (const id of evidenceIds) {
        await enqueue({ op: 'record', tbl: 'evidence', recordId: id, paperId, deleted: true })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// TranslationRepository（§1.6：译文跨设备同步）
// ---------------------------------------------------------------------------

export function createSyncedTranslationRepository(db: PaperDb, deps: SyncedDeps): TranslationRepository {
  const local = createTranslationRepository(db)
  const enqueue = makeEnqueue(db, deps)

  return {
    ...local,

    // 每行一条 record：id 是确定性拼接键，重译是幂等覆盖（LWW 靠 updatedAt）；
    // deleteByPaper 只在整篇删除的级联里调用，服务端按 paper_id 级联，无需逐行墓碑
    putTranslations: async (rows) => {
      await local.putTranslations(rows)
      for (const row of rows) {
        await enqueue({ op: 'record', tbl: 'translations', recordId: row.id, paperId: row.paperId, payload: row })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// HighlightRepository（§1.6：高亮跨设备同步）
// ---------------------------------------------------------------------------

export function createSyncedHighlightRepository(db: PaperDb, deps: SyncedDeps): HighlightRepository {
  const local = createHighlightRepository(db)
  const enqueue = makeEnqueue(db, deps)

  /** 墓碑要带 paperId（服务端级联列）：删之前先把归属论文查出来 */
  const paperIdsOf = async (ids: readonly string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    if (!ids.length) return out
    const rows = await db.highlights.bulkGet([...ids])
    rows.forEach((row, i) => {
      if (row) out.set(ids[i], row.paperId)
    })
    return out
  }

  return {
    ...local,

    applyMerge: async (toDelete, toPut) => {
      const owners = await paperIdsOf(toDelete)
      await local.applyMerge(toDelete, toPut)
      for (const id of toDelete) {
        // 被吞并的旧行若本地查不到（已被别处删过），退回合并行的论文：同一次合并必然同篇
        const paperId = owners.get(id) ?? toPut[0]?.paperId
        if (paperId) await enqueue({ op: 'record', tbl: 'highlights', recordId: id, paperId, deleted: true })
      }
      for (const row of toPut) {
        await enqueue({ op: 'record', tbl: 'highlights', recordId: row.id, paperId: row.paperId, payload: row })
      }
    },

    deleteHighlights: async (ids) => {
      const owners = await paperIdsOf(ids)
      await local.deleteHighlights(ids)
      for (const [id, paperId] of owners) {
        await enqueue({ op: 'record', tbl: 'highlights', recordId: id, paperId, deleted: true })
      }
    },
  }
}
