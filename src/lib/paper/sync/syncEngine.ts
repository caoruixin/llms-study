import type { SyncChangeRecord, SyncPushChange, SyncSummaryResponse, SyncTable } from '../../../../shared/apiTypes'
import { ApiRequestError } from '../../auth/apiClient'
import { useAuthStore } from '../../auth/authStore'
import {
  PAPER_DB_NAME,
  getGuestPaperDb,
  getPaperDbForUser,
  type OutboxItem,
  type PaperDb,
  type SyncMetaError,
  type SyncMetaRow,
} from '../repo/db'
import { createPaperRepository } from '../repo/paperRepo'
import type { PaperFileBytes, PaperRecord } from '../types'
import { onSyncMessage, postSyncMessage } from './crossTab'
import { mergePaperRecord, mergeProgress, rowTimestamp, shouldApplyRemote } from './merge'
import { chunkRows, outboxSignal, planOutbox, recordKey } from './outbox'
import { syncApi } from './serverApi'

/**
 * 同步引擎（P4）：本地优先 + outbox 后台推 + 打开时拉。
 * - 启动条件：authed 且 paper 页面已挂载（bootstrap 由 PapersPage/Workbench 调用，
 *   **绝不能挂在 App.tsx**——flag-off 构建把 lib/paper 虚模块化，App 层引用会破坏 flag-off）；
 * - `navigator.locks('paper-sync')` 领导者选举：多 tab 只有一个推送者，拿不到锁的 tab
 *   排队待命（领导者关页后自动接棒），pull 不受锁限制（读端幂等）；
 * - 跨 tab 唤醒（§1.1）：非领导者 tab 的入队经 BroadcastChannel 通知领导者；领导者空闲时
 *   每 idlePollMs 查一次 outbox 兜底（频道缺失/丢消息）；
 * - 制品推送拆步 + 逐篇隔离（§1.2）：papers → blocks → 文件，各步独立记 flag；一篇失败
 *   不阻塞其它论文，永久性文件失败（400/413）落 lastError 后丢弃队列项等手动重试；
 * - 失败指数退避 1s→60s；401 → 停机并触发 authStore.refresh() 校准登录态。
 */

/** progress 攒批延迟：阅读位置每 600ms 就写一次库，5s 合并一次推送足够实时又省请求 */
const PROGRESS_FLUSH_DELAY_MS = 5000
/** 非 progress 写入（消息/画像/制品/删除）的推送延迟：几百毫秒攒一小撮即可 */
const URGENT_FLUSH_DELAY_MS = 400
/** 无排期时的空闲轮询：BroadcastChannel 缺失/丢消息的兜底，醒来 outbox 非空即 flush */
const IDLE_POLL_MS = 30_000
/** 对账节流（§1.3）：键在共享的 syncState 里，多 tab/接棒不会羊群 */
const RECONCILE_INTERVAL_MS = 10 * 60_000
const BACKOFF_MAX_MS = 60_000
/** changes 拉取分页循环的保险丝：1000 页 × 1000 条 = 百万记录，正常绝无可能触顶 */
const PULL_PAGE_GUARD = 1000
/** 老服务端 tbl-not-allowed 拒绝的队列项：连续这么多轮仍被拒就丢弃，避免无限空转 */
const REJECT_DROP_ATTEMPTS = 5

/** 指数退避：第 n 次连续失败等 1s·2^(n-1)，封顶 60s */
export const backoffMs = (failures: number): number =>
  Math.min(1000 * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS)

/** partial：本轮既有推成功也有失败——既派 flushed 事件（徽标刷新）也退避重试 */
export type FlushResult = 'idle' | 'pushed' | 'partial' | 'error' | 'auth'

export interface SyncEngineOptions {
  urgentDelayMs?: number
  progressDelayMs?: number
  idlePollMs?: number
  reconcileIntervalMs?: number
  now?: () => number
}

export interface SyncStatus {
  /** 本 tab 是否持有推送锁 */
  leader: boolean
  running: boolean
  /** outbox 待推送项数 */
  pending: number
  /** 连续失败轮数（退避基数） */
  failures: number
  /** 本引擎最近一次失败（内存；成功轮次即清） */
  lastError: SyncMetaError | null
  /** 最近一次有东西推上去的时刻（pushed/partial） */
  lastFlushAt: number | null
  /** 最近一次 pullSince 完成时刻（syncState.lastSyncAt） */
  lastSyncAt: number | null
  /** 下一次 flush 排期；null = 无排期（空闲轮询中） */
  nextFlushAt: number | null
}

export interface SyncEngine {
  readonly db: PaperDb
  start(): void
  stop(): void
  /** outbox 有新项（或想立即冲一轮）：按项类型调度下一次 flush */
  kick(item?: OutboxItem): void
  /** 单轮推送（测试直接调用；运行时由内部 loop 驱动） */
  flushOnce(): Promise<FlushResult>
  /** 全量增量拉取（全局 seq 游标）；成功后顺带节流对账 */
  pullSince(): Promise<void>
  /** 按论文补拉（换设备打开某篇时；不动全局游标，since 恒从 0 起） */
  pullPaper(paperId: string): Promise<void>
  /** pagehide/隐藏兜底：内存里的最新进度用 keepalive 直推 */
  flushProgressKeepalive(): void
  /** 与服务端对账（§1.3）：本地有而服务端缺的 blocks/文件 → 入队 push-artifacts */
  reconcile(): Promise<{ enqueued: string[] }>
  /** 节流版对账：reconcileIntervalMs 内只跑一次（键在共享 syncState），永不抛错 */
  maybeReconcile(): Promise<void>
  getSyncStatus(): Promise<SyncStatus>
  /** 清 lastError/attempts + 重新入队 push-artifacts（已完成的步骤按 flag 幂等跳过） */
  retryArtifacts(paperId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// syncState KV 帮手
// ---------------------------------------------------------------------------

const CURSOR_KEY = 'cursor'
const LAST_SYNC_KEY = 'lastSyncAt'
const LAST_RECONCILE_KEY = 'lastReconcileAt'
const CLAIMED_SHAS_KEY = 'claimedShas'
const CLAIM_DISMISSED_KEY = 'claimDismissed'

async function getState<T>(db: PaperDb, key: string): Promise<T | undefined> {
  return (await db.syncState.get(key))?.value as T | undefined
}

async function putState(db: PaperDb, key: string, value: unknown): Promise<void> {
  await db.syncState.put({ key, value })
}

const isAuthError = (e: unknown): boolean =>
  e instanceof ApiRequestError && (e.status === 401 || e.code === 'unauthenticated')

/** 文件 PUT 的永久性失败：400（sha 不符/非法）与 413（配额/超限）重试也不会变好 */
const isPermanentFileStatus = (status: number | undefined): boolean => status === 400 || status === 413
const isPermanentFileError = (e: unknown): boolean => e instanceof ApiRequestError && isPermanentFileStatus(e.status)

/**
 * syncMeta 上落着的永久性文件失败：pushArtifacts 丢弃队列项后只有手动 retryArtifacts 才清。
 * 对账必须认这个标记——否则每个周期都把同一个文件重传一遍再吃一次 413，用户刚点过「重试同步」
 * 看着错误清掉，十分钟后它又自己回来。
 */
const hasPermanentFileFailure = (meta: SyncMetaRow | undefined): boolean =>
  meta?.lastError?.step === 'file' && isPermanentFileStatus(meta.lastError.status)

function dispatchWindowEvent(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(detail === undefined ? new CustomEvent(name) : new CustomEvent(name, { detail }))
}

/** 兼容读法（见 SyncMetaRow 注释）：老行没有 blocksPushed，artifactsPushed=true 必然 blocks 已推 */
const blocksDoneOf = (meta: SyncMetaRow | undefined): boolean =>
  meta?.blocksPushed ?? meta?.artifactsPushed ?? false

/** 去掉 lastError、attempts 归零（Dexie put 是整行覆盖，删键即清） */
function clearErrorFields(meta: SyncMetaRow): SyncMetaRow {
  const { lastError: _dropped, ...rest } = meta
  return { ...rest, attempts: 0 }
}

// ---------------------------------------------------------------------------
// 引擎实现
// ---------------------------------------------------------------------------

export function createSyncEngine(db: PaperDb, opts: SyncEngineOptions = {}): SyncEngine {
  const urgentDelayMs = opts.urgentDelayMs ?? URGENT_FLUSH_DELAY_MS
  const progressDelayMs = opts.progressDelayMs ?? PROGRESS_FLUSH_DELAY_MS
  const idlePollMs = opts.idlePollMs ?? IDLE_POLL_MS
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS
  const now = opts.now ?? Date.now

  /** 原生仓储（不经装饰器）：应用远端墓碑时的级联删除绝不能再入 outbox（回声循环） */
  const rawPaperRepo = createPaperRepository(db)

  let running = false
  let leader = false
  let failures = 0
  /** 下一次 flush 的最早时刻；null = 无排期 */
  let deadline: number | null = null
  let wake: (() => void) | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let lastError: SyncMetaError | null = null
  let lastFlushAt: number | null = null
  /** 本轮 flush 里 recordError 涉及的论文：loop 在 error/partial 时派一次 paper-sync-error */
  let flushErrorPaperIds = new Set<string>()
  let summaryUnsupportedLogged = false
  /**
   * 最新 progress 快照（paperId → papers 行 + 缓存时刻）：pagehide 时没机会读 IndexedDB，只能靠它。
   * 只缓存制品已推完的论文（§1.1 keepalive 泄漏闸）——否则会把 status ready 却没 blocks/文件的
   * papers 行提前推上服务端，造成「空心论文」。
   */
  const progressCache = new Map<string, { row: PaperRecord; at: number }>()

  const subTables = () =>
    ({
      blocks: db.blocks,
      briefs: db.briefs,
      sessions: db.sessions,
      messages: db.messages,
      conceptStates: db.conceptStates,
      evidence: db.evidence,
      usage: db.usage,
      translations: db.translations,
      highlights: db.highlights,
    }) as const

  function toPushChange(item: OutboxItem): SyncPushChange {
    if (item.op === 'progress') return { tbl: 'papers', id: item.paperId, payload: item.payload }
    return {
      tbl: item.tbl ?? '?',
      id: item.recordId ?? '?',
      paperId: item.paperId,
      ...(item.deleted ? { deleted: true } : { payload: item.payload ?? null }),
    }
  }

  function toSyncError(step: SyncMetaError['step'], e: unknown): SyncMetaError {
    const api = e instanceof ApiRequestError ? e : null
    return {
      step,
      code: api?.code ?? 'unknown',
      message: e instanceof Error ? e.message : String(e),
      ...(api?.status !== undefined ? { status: api.status } : {}),
      at: now(),
    }
  }

  /** §1.5：console.error + 对仍存在的论文写 lastError/attempts+1；成功路径各自负责清零 */
  async function recordError(paperIds: readonly string[], step: SyncMetaError['step'], e: unknown): Promise<void> {
    const err = toSyncError(step, e)
    lastError = err
    console.error('[sync] flush 失败', step, paperIds, e)
    for (const pid of paperIds) {
      flushErrorPaperIds.add(pid)
      try {
        if (!(await db.papers.get(pid))) continue
        const meta = (await db.syncMeta.get(pid)) ?? { paperId: pid }
        await db.syncMeta.put({ ...meta, lastError: err, attempts: (meta.attempts ?? 0) + 1 })
      } catch {
        /* 记录失败本身不能再抛：日志已打 */
      }
    }
  }

  /** 引擎内部入队（对账/手动重试）：本 tab kick + 广播给可能是领导者的其它 tab */
  async function enqueueLocal(item: OutboxItem): Promise<void> {
    await db.outbox.add(item)
    kick(item)
    postSyncMessage({ kind: 'enqueued', dbName: db.name, op: item.op, paperId: item.paperId })
  }

  /** 远端 papers 墓碑落地：级联删本地 + 清 syncMeta + 作废该论文的全部队列项（删除必须赢） */
  async function applyPaperTombstone(paperId: string): Promise<void> {
    await rawPaperRepo.deletePaper(paperId).catch(() => undefined)
    await db.syncMeta.delete(paperId).catch(() => undefined)
    const doomed = await db.outbox.where('paperId').equals(paperId).toArray()
    const qids = doomed.map((i) => i.qid).filter((q): q is number => q !== undefined)
    if (qids.length) await db.outbox.bulkDelete(qids)
    progressCache.delete(paperId)
  }

  /**
   * 远端换了字节（另一台设备原地重导入 / 换解析器：papers 行的 sha256 或 mime 变了）：本地 files、
   * blocks、chunks 都是旧字节的派生物。留着的后果——工作台本地命中旧文件去解码新 mime 的快照
   * （永久「快照字节损坏」，重试也走同一条本地命中路径）；对账只比块数，会把旧块当权威重推回服务端
   * 覆盖掉新正文。所以整套删掉：文件由工作台按「本地 miss」懒拉，blocks 由随后的远端行落地 /
   * 按 blockCount 补拉，chunks 由工作台缺失补建。syncMeta 按「制品在服务端」重置，
   * pulledBlockCount 删掉等重新计数（旧计数对新正文没有意义）。
   */
  async function invalidateLocalArtifacts(paperId: string): Promise<void> {
    await db.transaction('rw', [db.files, db.blocks, db.chunks, db.syncMeta], async () => {
      await db.files.delete(paperId)
      await db.blocks.where('paperId').equals(paperId).delete()
      await db.chunks.where('paperId').equals(paperId).delete()
      const { pulledBlockCount: _stale, ...meta } = (await db.syncMeta.get(paperId)) ?? { paperId }
      await db.syncMeta.put(
        clearErrorFields({ ...meta, paperId, artifactsPushed: true, blocksPushed: true, filePushed: true, blocksPulled: false }),
      )
    })
    progressCache.delete(paperId)
  }

  const sourceOfRejected = (batch: OutboxItem[], r: { tbl: string; id: string }): OutboxItem | undefined =>
    batch.find((i) => (i.tbl ?? 'papers') === r.tbl && (i.recordId ?? i.paperId) === r.id)

  /** paper-deleted 拒绝里子表行只带 (tbl,id)，据 outbox 项反查归属论文再级联 */
  function paperIdsOfRejected(
    batch: OutboxItem[],
    rejected: { tbl: string; id: string; reason: string }[],
  ): Set<string> {
    const ids = new Set<string>()
    for (const r of rejected) {
      if (r.reason !== 'paper-deleted') continue
      if (r.tbl === 'papers') {
        ids.add(r.id)
        continue
      }
      const src = sourceOfRejected(batch, r)
      if (src) ids.add(src.paperId)
    }
    return ids
  }

  interface ArtifactOutcome {
    /**
     * - done：队列项可删（全部成功 / 论文已删或未 ready）；
     * - retry：瞬时失败，队列项保留下轮再来（已完成的步骤按 flag 跳过）；
     * - failed：文件 400/413 永久失败——队列项丢弃（lastError 已落盘，等手动重试）但本轮计作失败。
     */
    status: 'done' | 'retry' | 'failed'
    /** 本次真正推上去的步数：>0 时哪怕后续步失败，本轮也算 partial（徽标该刷新） */
    pushedSteps: number
  }

  /**
   * push-artifacts 序列（§1.2）：papers 行 → blocks 分批 → 原始文件，各步独立记 flag；
   * 401 直接抛出，flushOnce 据此返回 'auth'；其余 API 失败在这里记 lastError 后按步返回。
   * blocks 先于文件：正文是「另一台设备能打开」的最低保障，50MB 文件配额被拒不该连累正文。
   */
  async function pushArtifacts(paperId: string): Promise<ArtifactOutcome> {
    let pushedSteps = 0
    const paper = await db.papers.get(paperId)
    // 论文已删或还没 ready（retry 中）：队列项作废即可，markReady 会再入队
    if (!paper || paper.status !== 'ready') return { status: 'done', pushedSteps }

    let head
    try {
      head = await syncApi.push([{ tbl: 'papers', id: paperId, payload: paper }])
    } catch (e) {
      if (isAuthError(e)) throw e
      await recordError([paperId], 'papers', e)
      return { status: 'retry', pushedSteps }
    }
    pushedSteps += 1
    if (head.rejected.some((r) => r.reason === 'paper-deleted')) {
      await applyPaperTombstone(paperId)
      return { status: 'done', pushedSteps }
    }

    let meta: SyncMetaRow = (await db.syncMeta.get(paperId)) ?? { paperId }
    if (!blocksDoneOf(meta)) {
      try {
        const blocks = await rawPaperRepo.getBlocks(paperId)
        for (const batch of chunkRows(blocks)) {
          await syncApi.push(batch.map((b) => ({ tbl: 'blocks', id: b.id, paperId, payload: b })))
        }
      } catch (e) {
        if (isAuthError(e)) throw e
        await recordError([paperId], 'blocks', e)
        return { status: 'retry', pushedSteps }
      }
      pushedSteps += 1
      meta = { ...meta, blocksPushed: true, blocksPulled: true }
      await db.syncMeta.put(meta)
    }

    if (!meta.filePushed) {
      const file = await db.files.get(paperId)
      if (file) {
        try {
          // 服务端同 sha 短路 200：换设备重推同一文件不写盘
          await syncApi.putFile(paperId, file.bytes, file.mime, paper.sha256)
        } catch (e) {
          if (isAuthError(e)) throw e
          await recordError([paperId], 'file', e)
          return { status: isPermanentFileError(e) ? 'failed' : 'retry', pushedSteps }
        }
        pushedSteps += 1
      }
      meta = { ...meta, filePushed: true }
      await db.syncMeta.put(meta)
    }

    await db.syncMeta.put(
      clearErrorFields({ ...meta, paperId, blocksPushed: true, filePushed: true, artifactsPushed: true, blocksPulled: true }),
    )
    return { status: 'done', pushedSteps }
  }

  /** record 批推成功：该批涉及论文上次若是 records 步失败，现在已恢复——清掉过期的 lastError */
  async function clearRecordsError(paperIds: Iterable<string>): Promise<void> {
    for (const pid of paperIds) {
      const meta = await db.syncMeta.get(pid)
      if (meta?.lastError?.step === 'records') await db.syncMeta.put(clearErrorFields(meta))
    }
  }

  /** record 批：被拒项（非 paper-deleted）保留待重试并记 lastError；tbl-not-allowed 连续 N 轮后丢弃 */
  async function handleRejected(
    batch: OutboxItem[],
    rejected: { tbl: string; id: string; reason: string }[],
  ): Promise<{ keep: Set<number>; rejectedPaperIds: Set<string> }> {
    const keep = new Set<number>()
    const rejectedPaperIds = new Set<string>()
    const kept = new Map<string, { reason: string; items: OutboxItem[] }>()
    for (const r of rejected) {
      if (r.reason === 'paper-deleted') continue
      const src = sourceOfRejected(batch, r)
      if (!src) continue
      const entry = kept.get(src.paperId) ?? { reason: r.reason, items: [] }
      entry.items.push(src)
      kept.set(src.paperId, entry)
    }
    for (const [pid, { reason, items }] of kept) {
      const meta = await db.syncMeta.get(pid)
      const attempts = (meta?.attempts ?? 0) + 1
      if (reason === 'tbl-not-allowed' && attempts >= REJECT_DROP_ATTEMPTS) {
        console.error('[sync] push 连续被拒（服务端不认该表，可能是旧版本），丢弃队列项', pid, reason, items.map(recordKey))
        continue
      }
      rejectedPaperIds.add(pid)
      for (const it of items) if (it.qid !== undefined) keep.add(it.qid)
      await recordError([pid], 'records', new Error(`push 被拒：${reason}（${items.map(recordKey).join(', ')}）`))
    }
    return { keep, rejectedPaperIds }
  }

  async function flushOnce(): Promise<FlushResult> {
    flushErrorPaperIds = new Set()
    const items = await db.outbox.orderBy('qid').toArray()
    if (!items.length) return 'idle'
    const plan = planOutbox(items)
    if (plan.obsoleteQids.length) await db.outbox.bulkDelete(plan.obsoleteQids)

    let pushed = 0
    let hadError = false

    for (const del of plan.deletes) {
      try {
        await syncApi.deletePaper(del.paperId)
        if (del.qid !== undefined) await db.outbox.delete(del.qid)
        progressCache.delete(del.paperId)
        pushed += 1
      } catch (e) {
        if (isAuthError(e)) return 'auth'
        hadError = true
        await recordError([del.paperId], 'delete', e)
      }
    }

    for (const batch of plan.recordBatches) {
      try {
        const resp = await syncApi.push(batch.map(toPushChange))
        // 服务端说目标论文已被删除（另一台设备删的）：本地跟删，别再借尸还魂
        for (const pid of paperIdsOfRejected(batch, resp.rejected)) {
          await applyPaperTombstone(pid)
        }
        const { keep, rejectedPaperIds } = await handleRejected(batch, resp.rejected)
        if (keep.size) hadError = true
        const applied = batch.filter((i) => i.qid !== undefined && !keep.has(i.qid))
        const qids = applied.map((i) => i.qid).filter((q): q is number => q !== undefined)
        if (qids.length) await db.outbox.bulkDelete(qids)
        for (const it of applied) if (it.op === 'progress') progressCache.delete(it.paperId)
        if (applied.length) {
          pushed += 1
          // 同批里仍有被拒项的论文不清：刚记下的 lastError 就是它现在的状态
          await clearRecordsError(applied.map((i) => i.paperId).filter((pid) => !rejectedPaperIds.has(pid)))
        }
      } catch (e) {
        if (isAuthError(e)) return 'auth'
        hadError = true
        await recordError([...new Set(batch.map((i) => i.paperId))], 'records', e)
      }
    }

    for (const art of plan.artifacts) {
      try {
        const { status, pushedSteps } = await pushArtifacts(art.paperId)
        if (pushedSteps > 0) pushed += 1
        if (status !== 'done') hadError = true
        if (status !== 'retry' && art.qid !== undefined) await db.outbox.delete(art.qid)
      } catch (e) {
        if (isAuthError(e)) return 'auth'
        hadError = true
        // pushArtifacts 只在 401 与非 API 异常（IndexedDB 等）时抛出：API 失败它自己已记过
        if (!(e instanceof ApiRequestError)) await recordError([art.paperId], 'blocks', e)
      }
    }

    if (hadError) return pushed > 0 ? 'partial' : 'error'
    return pushed > 0 ? 'pushed' : 'idle'
  }

  // -------------------------------------------------------------------------
  // 拉取与合并
  // -------------------------------------------------------------------------

  interface Applied {
    paperIds: Set<string>
    tables: Set<string>
    /** 本轮落地过 blocks 行（含墓碑）的论文：拉完按本地实际块数刷新 syncMeta（§1.4 徽标不锁存） */
    blockPaperIds: Set<string>
  }

  async function applyRemoteChanges(changes: SyncChangeRecord[], applied: Applied): Promise<void> {
    if (!changes.length) return
    // pending 键快照：本地 outbox 里有同记录待推 → 本地胜（远端这版必然会被我们覆盖）
    const items = await db.outbox.toArray()
    const pendingKeys = new Set(items.filter((i) => i.op === 'record' || i.op === 'progress').map(recordKey))
    const pendingArtifacts = new Set(items.filter((i) => i.op === 'push-artifacts').map((i) => i.paperId))
    const pendingDeletes = new Set(items.filter((i) => i.op === 'delete-paper').map((i) => i.paperId))

    for (const ch of changes) {
      try {
        if (await applyOne(ch, pendingKeys, pendingArtifacts, pendingDeletes)) {
          const scope = ch.tbl === 'papers' ? ch.id : ch.paperId
          if (scope) applied.paperIds.add(scope)
          if (scope && ch.tbl === 'blocks') applied.blockPaperIds.add(scope)
          applied.tables.add(ch.tbl)
        }
      } catch (e) {
        // 单条应用失败不阻断整页：宁可缺一行（下轮全量对账可补），不可卡死游标
        console.warn('[sync] 应用远端变更失败', ch.tbl, ch.id, e)
      }
    }
  }

  /** 返回是否真的改动了本地库（pulled 事件只在有变更时派发） */
  async function applyOne(
    ch: SyncChangeRecord,
    pendingKeys: Set<string>,
    pendingArtifacts: Set<string>,
    pendingDeletes: Set<string>,
  ): Promise<boolean> {
    const paperScope = ch.tbl === 'papers' ? ch.id : ch.paperId
    // 本地已发起删除：远端这篇论文的任何行都不再落地，等我们的 DELETE 推上去
    if (paperScope && pendingDeletes.has(paperScope)) return false

    if (ch.tbl === 'papers') {
      if (ch.deleted) {
        // 墓碑无条件赢（含本地有 pending 写入时）：另一台设备删了，这里必须跟删
        await applyPaperTombstone(ch.id)
        return true
      }
      if (pendingKeys.has(`papers:${ch.id}`) || pendingArtifacts.has(ch.id)) return false
      const remote = ch.payload as PaperRecord | null
      if (!remote || typeof remote !== 'object' || typeof remote.id !== 'string') return false
      const local = await db.papers.get(ch.id)
      const merged = mergePaperRecord(local, remote)
      await db.papers.put(merged)
      if (!local) {
        // 首次从远端见到这篇论文：制品在服务端（另一台设备推的），推送侧三步齐；
        // 是否空心由 pullPaper 拉完后的 pulledBlockCount 判定，不在这里假定
        await db.syncMeta.put({
          paperId: ch.id,
          artifactsPushed: true,
          filePushed: true,
          blocksPushed: true,
          blocksPulled: false,
        })
      } else if (merged.sha256 !== local.sha256 || merged.mime !== local.mime) {
        // 比的是合并结果而非远端行：本地更新（LWW 本地胜）时 sha 不变，什么都不动
        await invalidateLocalArtifacts(ch.id)
      }
      return true
    }

    const table = subTables()[ch.tbl as keyof ReturnType<typeof subTables>]
    if (!table) return false // chunks/jobs/consents 或未知表：永不落地
    if (pendingKeys.has(`${ch.tbl}:${ch.id}`)) return false
    if (ch.deleted) {
      await table.delete(ch.id)
      return true
    }
    // 本地即将整推这篇的 blocks（重新解析后）：远端旧块不落地，避免新旧混叠
    if (ch.tbl === 'blocks' && paperScope && pendingArtifacts.has(paperScope)) return false
    const payload = ch.payload
    if (typeof payload !== 'object' || payload === null) return false
    const localRow = await table.get(ch.id)
    if (
      localRow &&
      !shouldApplyRemote({
        hasPendingLocal: false,
        localUpdatedAt: rowTimestamp(localRow),
        remoteUpdatedAt: rowTimestamp(payload),
      })
    ) {
      return false
    }
    await table.put(payload as never)
    return true
  }

  function announcePulled(applied: Applied): void {
    if (!applied.paperIds.size && !applied.tables.size) return
    const detail = { paperIds: [...applied.paperIds], tables: [...applied.tables] }
    dispatchWindowEvent('paper-sync-pulled', detail)
    postSyncMessage({ kind: 'pulled', dbName: db.name, ...detail })
  }

  /**
   * 按本地实际块数刷新 syncMeta 的接收侧标记。§1.4：拉到 0 块绝不能置 blocksPulled——否则工作台
   * 永不重试，「空心论文」就永久化了。pullPaper 拉完必刷；pullSince 只刷本轮落地过 blocks 行的论文
   * （`onlyIfKnown`：本地没有 papers 行的不写——那是还没见过的论文，等它的 papers 行到了再说），
   * 否则列表页的「正文未同步」要等用户打开工作台才会消失。
   */
  async function refreshPulledMeta(paperId: string, onlyIfKnown = false): Promise<void> {
    const record = await db.papers.get(paperId)
    if (onlyIfKnown && !record) return
    const n = await db.blocks.where('paperId').equals(paperId).count()
    const meta = (await db.syncMeta.get(paperId)) ?? { paperId }
    await db.syncMeta.put({
      ...meta,
      pulledBlockCount: n,
      blocksPulled: n > 0 && (record?.blockCount === undefined || n >= record.blockCount),
    })
  }

  async function pullSince(): Promise<void> {
    const applied: Applied = { paperIds: new Set(), tables: new Set(), blockPaperIds: new Set() }
    let since = (await getState<number>(db, CURSOR_KEY)) ?? 0
    for (let guard = 0; guard < PULL_PAGE_GUARD; guard++) {
      const page = await syncApi.changes(since, { limit: 1000 })
      await applyRemoteChanges(page.changes, applied)
      since = page.nextSince
      await putState(db, CURSOR_KEY, since)
      if (!page.hasMore) break
    }
    await putState(db, LAST_SYNC_KEY, now())
    // 先刷 syncMeta 再派 pulled 事件：列表页收到事件重读 syncMeta 时看到的已是新计数
    for (const pid of applied.blockPaperIds) await refreshPulledMeta(pid, true)
    announcePulled(applied)
    await maybeReconcile()
  }

  async function pullPaper(paperId: string): Promise<void> {
    const applied: Applied = { paperIds: new Set(), tables: new Set(), blockPaperIds: new Set() }
    let since = 0
    for (let guard = 0; guard < PULL_PAGE_GUARD; guard++) {
      const page = await syncApi.changes(since, { limit: 1000, paperId })
      await applyRemoteChanges(page.changes, applied)
      since = page.nextSince
      if (!page.hasMore) break
    }
    await refreshPulledMeta(paperId)
    announcePulled(applied)
  }

  // -------------------------------------------------------------------------
  // 对账（§1.3）
  // -------------------------------------------------------------------------

  async function reconcile(): Promise<{ enqueued: string[] }> {
    const enqueued: string[] = []
    const ready = (await db.papers.toArray()).filter((p) => p.status === 'ready')
    if (!ready.length) return { enqueued }
    const outbox = await db.outbox.toArray()
    const busy = new Set(
      outbox.filter((i) => i.op === 'push-artifacts' || i.op === 'delete-paper').map((i) => i.paperId),
    )
    const candidates = ready.filter((p) => !busy.has(p.id))
    if (!candidates.length) return { enqueued }

    let summary: SyncSummaryResponse
    try {
      summary = await syncApi.summary()
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 404) {
        if (!summaryUnsupportedLogged) {
          summaryUnsupportedLogged = true
          console.warn('[sync] 服务端不支持 /sync/summary，跳过对账（需先升级服务端）')
        }
        return { enqueued }
      }
      throw e
    }
    const serverBlocks = new Map(summary.papers.map((p) => [p.paperId, p.blocks]))
    const serverFiles = new Map(summary.files.map((f) => [f.paperId, f]))

    for (const paper of candidates) {
      const localBlocks = await db.blocks.where('paperId').equals(paper.id).count()
      // 绝不 .get() 文件行：50MB blob 只为判存在毫无必要
      const hasLocalFile = (await db.files.where(':id').equals(paper.id).count()) > 0
      const needBlocks = localBlocks > 0 && (serverBlocks.get(paper.id) ?? 0) < localBlocks
      const needFile = hasLocalFile && serverFiles.get(paper.id)?.sha256 !== paper.sha256
      if (!needBlocks && !needFile) continue
      const meta = (await db.syncMeta.get(paper.id)) ?? { paperId: paper.id }
      // 永久性文件失败（400/413）：自动重推只会再吃一次同样的拒绝，留给手动「重试同步」
      if (hasPermanentFileFailure(meta)) continue
      // 只把缺的那步 flag 置 false；另一步先物化兼容读法，避免老行被误判成「两步都没推」
      await db.syncMeta.put({
        ...meta,
        artifactsPushed: false,
        blocksPushed: needBlocks ? false : blocksDoneOf(meta),
        filePushed: needFile ? false : (meta.filePushed ?? false),
      })
      await enqueueLocal({ op: 'push-artifacts', paperId: paper.id, createdAt: now() })
      enqueued.push(paper.id)
    }
    return { enqueued }
  }

  async function maybeReconcile(): Promise<void> {
    try {
      const last = (await getState<number>(db, LAST_RECONCILE_KEY)) ?? 0
      if (now() - last < reconcileIntervalMs) return
      // 先占坑再请求：多 tab 同时进来只有一个真正打服务端
      await putState(db, LAST_RECONCILE_KEY, now())
      await reconcile()
    } catch (e) {
      console.warn('[sync] 对账失败（下个周期再试）', e)
    }
  }

  // -------------------------------------------------------------------------
  // 调度 loop 与领导者选举
  // -------------------------------------------------------------------------

  function schedule(delayMs: number): void {
    const t = now() + delayMs
    if (deadline === null || t < deadline) {
      deadline = t
      wake?.()
    }
  }

  function kick(item?: OutboxItem): void {
    if (item?.op === 'progress') {
      if (item.payload) {
        const row = item.payload as PaperRecord
        // keepalive 泄漏闸：制品未推完的论文不进缓存——pushArtifacts 推的 papers 行本就带最新进度
        void db.syncMeta
          .get(item.paperId)
          .then((m) => {
            if (m?.blocksPushed || m?.artifactsPushed) progressCache.set(item.paperId, { row, at: now() })
          })
          .catch(() => undefined)
      }
      schedule(progressDelayMs)
    } else {
      schedule(urgentDelayMs)
    }
  }

  /** 可被 schedule/stop 提前打断的睡眠 */
  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        wake = null
        if (wakeTimer) clearTimeout(wakeTimer)
        wakeTimer = null
        resolve()
      }
      wake = done
      wakeTimer = setTimeout(done, ms)
    })
  }

  async function afterFlush(result: FlushResult): Promise<void> {
    if (result === 'error' || result === 'partial') {
      failures += 1
      deadline = now() + backoffMs(failures)
      dispatchWindowEvent('paper-sync-error', {
        paperIds: [...flushErrorPaperIds],
        step: lastError?.step ?? 'records',
        message: lastError?.message ?? '',
      })
    } else {
      failures = 0
      if (result === 'idle') lastError = null
    }
    if (result === 'pushed' || result === 'partial') {
      lastFlushAt = now()
      if (result === 'pushed') lastError = null
      // 通知展示层(列表页同步徽标等)重读 syncMeta——否则后台推完要等下次 refresh 才变「已同步」；
      // 同时广播给其它 tab（非领导者的列表页也要刷新）
      dispatchWindowEvent('paper-sync-flushed')
      postSyncMessage({ kind: 'flushed', dbName: db.name })
    }
  }

  async function loop(): Promise<void> {
    while (running && leader) {
      if (deadline === null) {
        // 无排期：睡到下一次 kick/stop，或空闲轮询到期——后者查一眼 outbox 兜底（频道缺失/丢消息）
        await interruptibleSleep(idlePollMs)
        if (running && leader && deadline === null && (await db.outbox.count()) > 0) deadline = now()
        continue
      }
      const waitMs = deadline - now()
      if (waitMs > 0) {
        await interruptibleSleep(waitMs)
        continue // 醒来后重新评估 deadline（可能被提前了）
      }
      deadline = null
      const result = await flushOnce()
      if (!running) break
      if (result === 'auth') {
        // 401：cookie 已失效或被服务端吊销。停机 + 校准登录态；
        // refresh 若确认未登录会把 status 置 anon，bootstrap 的订阅随之丢弃本引擎。
        running = false
        void useAuthStore.getState().refresh()
        break
      }
      await afterFlush(result)
    }
    leader = false
  }

  /** 拿到领导权后的固定动作：先冲一轮（遗留 outbox）+ 节流对账，再进 loop */
  function becomeLeader(): Promise<void> {
    leader = true
    kick()
    void maybeReconcile()
    return loop()
  }

  function start(): void {
    if (running) return
    running = true
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    if (!locks) {
      // node/旧浏览器：没有 Web Locks 就按单 tab 假设直接当领导者
      void becomeLeader()
      return
    }
    // 阻塞式请求（非 ifAvailable）：拿不到锁的 tab 排队待命，领导者关页后自动接棒
    void locks
      .request('paper-sync', async () => {
        if (!running) return
        await becomeLeader()
      })
      .catch(() => {
        // 锁 API 异常（隐私模式等）：退化为单 tab 假设，宁可冒双推（服务端覆盖幂等）也不罢工
        if (running && !leader) void becomeLeader()
      })
  }

  function stop(): void {
    running = false
    leader = false
    wake?.()
  }

  function flushProgressKeepalive(): void {
    // 先清陈旧条目：非领导者 tab 永远不 flush，缓存只能靠时间窗收敛
    const cutoff = now() - progressDelayMs * 4
    for (const [pid, entry] of progressCache) if (entry.at < cutoff) progressCache.delete(pid)
    if (!progressCache.size) return
    const changes: SyncPushChange[] = [...progressCache.values()].map(({ row }) => ({
      tbl: 'papers',
      id: row.id,
      payload: row,
    }))
    syncApi.pushKeepalive(changes)
  }

  async function getSyncStatus(): Promise<SyncStatus> {
    return {
      leader,
      running,
      pending: await db.outbox.count(),
      failures,
      lastError,
      lastFlushAt,
      lastSyncAt: (await getState<number>(db, LAST_SYNC_KEY)) ?? null,
      nextFlushAt: deadline,
    }
  }

  async function retryArtifacts(paperId: string): Promise<void> {
    const meta = await db.syncMeta.get(paperId)
    if (meta) await db.syncMeta.put(clearErrorFields(meta))
    await enqueueLocal({ op: 'push-artifacts', paperId, createdAt: now() })
  }

  return {
    db,
    start,
    stop,
    kick,
    flushOnce,
    pullSince,
    pullPaper,
    flushProgressKeepalive,
    reconcile,
    maybeReconcile,
    getSyncStatus,
    retryArtifacts,
  }
}

// ---------------------------------------------------------------------------
// 模块级单例 + bootstrap：只能从 paper 懒加载边界内调用（PapersPage / Workbench）。
// ---------------------------------------------------------------------------

let current: SyncEngine | null = null
let wired = false

export function getSyncEngine(): SyncEngine | null {
  return current
}

export function bootstrapSyncEngine(): void {
  if (typeof window === 'undefined') return
  if (!wired) {
    wired = true
    // 本 tab 与远端 tab 的入队信号都从这里进（outbox.ts 已把跨 tab enqueued 转成合成项）
    outboxSignal.on((dbName, item) => {
      if (current?.db.name === dbName) current.kick(item)
    })
    // 其它 tab 推完/拉完：在本 tab 重派窗口事件，非领导者的列表页/工作台也能刷新
    onSyncMessage((msg) => {
      if (!current || msg.dbName !== current.db.name) return
      if (msg.kind === 'flushed') dispatchWindowEvent('paper-sync-flushed')
      else if (msg.kind === 'pulled') dispatchWindowEvent('paper-sync-pulled', { paperIds: msg.paperIds, tables: msg.tables })
    })
    const flushHidden = () => current?.flushProgressKeepalive()
    window.addEventListener('pagehide', flushHidden)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushHidden()
    })
    useAuthStore.subscribe(() => alignEngineToAuth())
  }
  alignEngineToAuth()
}

/** 登录/登出/换账号 → 切换引擎实例（每引擎绑定一个账号库） */
function alignEngineToAuth(): void {
  const { status, user } = useAuthStore.getState()
  const wantDb = status === 'authed' && user ? getPaperDbForUser(user.id) : null
  if (current && (!wantDb || current.db.name !== wantDb.name)) {
    current.stop()
    current = null
  }
  if (wantDb) {
    if (!current) {
      current = createSyncEngine(wantDb)
      current.start() // start 拿到领导权即 kick：上次会话遗留的 outbox 尽快补推
    } else {
      current.start() // 401 停机后 refresh 确认仍在登录态：复活推送 loop（同样先 kick）
    }
  }
}

// ---------------------------------------------------------------------------
// 换设备拉取帮手（Workbench 用）
// ---------------------------------------------------------------------------

/** 原版 PDF 字节本地 miss：从服务端拉回并写 files 表（下次纯本地） */
export async function fetchRemoteFileToLocal(db: PaperDb, paperId: string): Promise<PaperFileBytes | null> {
  const remote = await syncApi.getFile(paperId)
  if (!remote) return null
  const row: PaperFileBytes = { paperId, bytes: remote.bytes, mime: remote.mime }
  await db.files.put(row)
  return row
}

// ---------------------------------------------------------------------------
// 认领：游客库(paper-copilot)历史论文 → 账号库 + 推送
// ---------------------------------------------------------------------------

/**
 * 认领时逐行直传的子表 = SYNC_TABLES 去掉走 push-artifacts 序列的 papers/blocks。
 * claimGuestPapers 里用它做 Record 的键集：以后再给 SYNC_TABLES 加表，这里漏了就编译不过——
 * 译文/高亮当初就是这样漏掉的（游客高亮认领后消失、翻译重新付费）。
 */
type ClaimRecordTable = Exclude<SyncTable, 'papers' | 'blocks'>

export interface ClaimScanResult {
  /** 账号库没有同 sha：可整篇认领 */
  fresh: PaperRecord[]
  /** 账号库已有同 sha（本机或服务端先到）：仅合并进度，不迁会话（v1 收敛策略） */
  dupes: PaperRecord[]
  dismissed: boolean
}

/** 扫描游客库里可认领的论文；未登录或没有候选返回 null */
export async function scanClaimables(): Promise<ClaimScanResult | null> {
  const { status, user } = useAuthStore.getState()
  if (status !== 'authed' || !user) return null
  const accountDb = getPaperDbForUser(user.id)
  const guestDb = getGuestPaperDb()
  if (accountDb.name === PAPER_DB_NAME) return null // 防御：绝不把游客库当账号库扫自己

  const guestReady = (await guestDb.papers.toArray()).filter((p) => p.status === 'ready')
  if (!guestReady.length) return null
  const claimed = new Set((await getState<string[]>(accountDb, CLAIMED_SHAS_KEY)) ?? [])
  const candidates = guestReady.filter((p) => !claimed.has(p.sha256))
  if (!candidates.length) return null

  const accountShas = new Set((await accountDb.papers.toArray()).map((p) => p.sha256))
  return {
    fresh: candidates.filter((p) => !accountShas.has(p.sha256)),
    dupes: candidates.filter((p) => accountShas.has(p.sha256)),
    dismissed: (await getState<boolean>(accountDb, CLAIM_DISMISSED_KEY)) === true,
  }
}

export async function setClaimDismissed(dismissed: boolean): Promise<void> {
  const { status, user } = useAuthStore.getState()
  if (status !== 'authed' || !user) return
  await putState(getPaperDbForUser(user.id), CLAIM_DISMISSED_KEY, dismissed)
}

/**
 * 认领执行：逐篇把游客库记录复制进账号库（UUID 跨库唯一，原样复制即幂等），
 * 再入 outbox 走正常推送序列；同 sha 论文只做进度 LWW 合并。
 * 游客库数据保留不动（只读旧数据），claimedShas 防重复认领提示。
 */
export async function claimGuestPapers(
  onProgress?: (done: number, total: number) => void,
): Promise<{ claimed: number; merged: number }> {
  const scan = await scanClaimables()
  const { status, user } = useAuthStore.getState()
  if (!scan || status !== 'authed' || !user) return { claimed: 0, merged: 0 }
  const accountDb = getPaperDbForUser(user.id)
  const guestDb = getGuestPaperDb()
  const total = scan.fresh.length + scan.dupes.length
  let done = 0
  const now = Date.now()

  for (const paper of scan.fresh) {
    const pid = paper.id
    const sessions = await guestDb.sessions.where('paperId').equals(pid).toArray()
    const sessionIds = sessions.map((s) => s.id)
    const [file, blocks, chunks, jobs, briefs, messages, conceptStates, evidence, usage, translations, highlights] =
      await Promise.all([
        guestDb.files.get(pid),
        guestDb.blocks.where('paperId').equals(pid).toArray(),
        guestDb.chunks.where('paperId').equals(pid).toArray(),
        guestDb.jobs.where('paperId').equals(pid).toArray(),
        guestDb.briefs.where('paperId').equals(pid).toArray(),
        sessionIds.length ? guestDb.messages.where('sessionId').anyOf(sessionIds).toArray() : Promise.resolve([]),
        guestDb.conceptStates.where('paperId').equals(pid).toArray(),
        guestDb.evidence.where('paperId').equals(pid).toArray(),
        guestDb.usage.where('paperId').equals(pid).toArray(),
        guestDb.translations.where('paperId').equals(pid).toArray(),
        guestDb.highlights.where('paperId').equals(pid).toArray(),
      ])

    // 本地复制（含 chunks/jobs——它们不上服务端，但本地复制省一次索引重建）
    await accountDb.papers.put(paper)
    if (file) await accountDb.files.put(file)
    if (blocks.length) await accountDb.blocks.bulkPut(blocks)
    if (chunks.length) await accountDb.chunks.bulkPut(chunks)
    if (jobs.length) await accountDb.jobs.bulkPut(jobs)
    if (briefs.length) await accountDb.briefs.bulkPut(briefs)
    if (sessions.length) await accountDb.sessions.bulkPut(sessions)
    if (messages.length) await accountDb.messages.bulkPut(messages)
    if (conceptStates.length) await accountDb.conceptStates.bulkPut(conceptStates)
    if (evidence.length) await accountDb.evidence.bulkPut(evidence)
    if (usage.length) await accountDb.usage.bulkPut(usage)
    if (translations.length) await accountDb.translations.bulkPut(translations)
    if (highlights.length) await accountDb.highlights.bulkPut(highlights)
    await accountDb.syncMeta.put({ paperId: pid, artifactsPushed: false, blocksPulled: true, filePushed: false })

    // 入队：制品序列 + 相关业务行（record 直传）；键集由 ClaimRecordTable 约束，与 SYNC_TABLES 同步演进
    const queue: Omit<OutboxItem, 'qid'>[] = [{ op: 'push-artifacts', paperId: pid, createdAt: now }]
    const rowsByTable: Record<ClaimRecordTable, readonly { id: string }[]> = {
      sessions,
      messages,
      briefs,
      conceptStates,
      evidence,
      usage,
      translations,
      highlights,
    }
    for (const tbl of Object.keys(rowsByTable) as ClaimRecordTable[]) {
      for (const r of rowsByTable[tbl]) {
        queue.push({ op: 'record', tbl, recordId: r.id, paperId: pid, payload: r, createdAt: now })
      }
    }
    await accountDb.outbox.bulkAdd(queue as OutboxItem[])

    await addClaimedSha(accountDb, paper.sha256)
    done += 1
    onProgress?.(done, total)
  }

  for (const paper of scan.dupes) {
    // sha256 撞车：账号库已有同篇（可能 id 不同）——只合并进度，账号侧为主
    const target = (await accountDb.papers.toArray()).find((p) => p.sha256 === paper.sha256)
    if (target) {
      const progress = mergeProgress(target.progress, paper.progress)
      const merged: PaperRecord = {
        ...target,
        ...(progress ? { progress } : {}),
        lastReadAt: Math.max(target.lastReadAt ?? 0, paper.lastReadAt ?? 0) || target.lastReadAt,
      }
      await accountDb.papers.put(merged)
      await accountDb.outbox.add({ op: 'progress', paperId: target.id, payload: merged, createdAt: now })
    }
    await addClaimedSha(accountDb, paper.sha256)
    done += 1
    onProgress?.(done, total)
  }

  getSyncEngine()?.kick()
  return { claimed: scan.fresh.length, merged: scan.dupes.length }
}

async function addClaimedSha(db: PaperDb, sha: string): Promise<void> {
  const existing = (await getState<string[]>(db, CLAIMED_SHAS_KEY)) ?? []
  if (!existing.includes(sha)) await putState(db, CLAIMED_SHAS_KEY, [...existing, sha])
}
