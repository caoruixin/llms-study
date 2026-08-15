import type { OutboxItem, PaperDb } from './db'
import { outboxSignal } from '../sync/outbox'
import { createPaperRepository, type PaperRepository } from './paperRepo'
import { createCopilotRepository, type CopilotRepository } from './copilotRepo'
import { createLearnerRepository, profileToRow, type LearnerRepository } from './learnerRepo'

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
      await local.markReady(paperId, stats)
      if (deps.shouldQueue()) {
        // 覆盖既有 meta 的 artifactsPushed：重新解析（retry）后制品变了，必须重推
        await db.syncMeta.put({ paperId, artifactsPushed: false, blocksPulled: true, filePushed: false })
      }
      await enqueue({ op: 'push-artifacts', paperId })
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
