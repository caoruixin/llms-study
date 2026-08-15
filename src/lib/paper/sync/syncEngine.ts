import type { SyncChangeRecord, SyncPushChange } from '../../../../shared/apiTypes'
import { ApiRequestError } from '../../auth/apiClient'
import { useAuthStore } from '../../auth/authStore'
import {
  PAPER_DB_NAME,
  getGuestPaperDb,
  getPaperDbForUser,
  type OutboxItem,
  type PaperDb,
} from '../repo/db'
import { createPaperRepository } from '../repo/paperRepo'
import type { PaperFileBytes, PaperRecord } from '../types'
import { mergePaperRecord, mergeProgress, rowTimestamp, shouldApplyRemote } from './merge'
import { chunkRows, outboxSignal, planOutbox, recordKey } from './outbox'
import { syncApi } from './serverApi'

/**
 * 同步引擎（P4）：本地优先 + outbox 后台推 + 打开时拉。
 * - 启动条件：authed 且 paper 页面已挂载（bootstrap 由 PapersPage/Workbench 调用，
 *   **绝不能挂在 App.tsx**——flag-off 构建把 lib/paper 虚模块化，App 层引用会破坏 flag-off）；
 * - `navigator.locks('paper-sync')` 领导者选举：多 tab 只有一个推送者，拿不到锁的 tab
 *   排队待命（领导者关页后自动接棒），pull 不受锁限制（读端幂等）；
 * - 失败指数退避 1s→60s；401 → 停机并触发 authStore.refresh() 校准登录态。
 */

/** progress 攒批延迟：阅读位置每 600ms 就写一次库，5s 合并一次推送足够实时又省请求 */
const PROGRESS_FLUSH_DELAY_MS = 5000
/** 非 progress 写入（消息/画像/制品/删除）的推送延迟：几百毫秒攒一小撮即可 */
const URGENT_FLUSH_DELAY_MS = 400
const BACKOFF_MAX_MS = 60_000
/** changes 拉取分页循环的保险丝：1000 页 × 1000 条 = 百万记录，正常绝无可能触顶 */
const PULL_PAGE_GUARD = 1000

/** 指数退避：第 n 次连续失败等 1s·2^(n-1)，封顶 60s */
export const backoffMs = (failures: number): number =>
  Math.min(1000 * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS)

export type FlushResult = 'idle' | 'pushed' | 'error' | 'auth'

export interface SyncEngine {
  readonly db: PaperDb
  start(): void
  stop(): void
  /** outbox 有新项（或想立即冲一轮）：按项类型调度下一次 flush */
  kick(item?: OutboxItem): void
  /** 单轮推送（测试直接调用；运行时由内部 loop 驱动） */
  flushOnce(): Promise<FlushResult>
  /** 全量增量拉取（全局 seq 游标） */
  pullSince(): Promise<void>
  /** 按论文补拉（换设备打开某篇时；不动全局游标，since 恒从 0 起） */
  pullPaper(paperId: string): Promise<void>
  /** pagehide/隐藏兜底：内存里的最新进度用 keepalive 直推 */
  flushProgressKeepalive(): void
}

// ---------------------------------------------------------------------------
// syncState KV 帮手
// ---------------------------------------------------------------------------

const CURSOR_KEY = 'cursor'
const CLAIMED_SHAS_KEY = 'claimedShas'
const CLAIM_DISMISSED_KEY = 'claimDismissed'

async function getState<T>(db: PaperDb, key: string): Promise<T | undefined> {
  return (await db.syncState.get(key))?.value as T | undefined
}

async function putState(db: PaperDb, key: string, value: unknown): Promise<void> {
  await db.syncState.put({ key, value })
}

// ---------------------------------------------------------------------------
// 引擎实现
// ---------------------------------------------------------------------------

export function createSyncEngine(db: PaperDb): SyncEngine {
  /** 原生仓储（不经装饰器）：应用远端墓碑时的级联删除绝不能再入 outbox（回声循环） */
  const rawPaperRepo = createPaperRepository(db)

  let running = false
  let leader = false
  let failures = 0
  /** 下一次 flush 的最早时刻；null = 无排期 */
  let deadline: number | null = null
  let wake: (() => void) | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  /** 最新 progress 快照（paperId → papers 行）：pagehide 时没机会读 IndexedDB，只能靠它 */
  const progressCache = new Map<string, PaperRecord>()

  const subTables = () =>
    ({
      blocks: db.blocks,
      briefs: db.briefs,
      sessions: db.sessions,
      messages: db.messages,
      conceptStates: db.conceptStates,
      evidence: db.evidence,
      usage: db.usage,
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

  /** 远端 papers 墓碑落地：级联删本地 + 清 syncMeta + 作废该论文的全部队列项（删除必须赢） */
  async function applyPaperTombstone(paperId: string): Promise<void> {
    await rawPaperRepo.deletePaper(paperId).catch(() => undefined)
    await db.syncMeta.delete(paperId).catch(() => undefined)
    const doomed = await db.outbox.where('paperId').equals(paperId).toArray()
    const qids = doomed.map((i) => i.qid).filter((q): q is number => q !== undefined)
    if (qids.length) await db.outbox.bulkDelete(qids)
    progressCache.delete(paperId)
  }

  /** paper-deleted 拒绝里子表行只带 (tbl,id)，据 outbox 项反查归属论文再级联 */
  async function paperIdsOfRejected(
    batch: OutboxItem[],
    rejected: { tbl: string; id: string; reason: string }[],
  ): Promise<Set<string>> {
    const ids = new Set<string>()
    for (const r of rejected) {
      if (r.reason !== 'paper-deleted') continue
      if (r.tbl === 'papers') {
        ids.add(r.id)
        continue
      }
      const src = batch.find((i) => (i.tbl ?? 'papers') === r.tbl && (i.recordId ?? i.paperId) === r.id)
      if (src) ids.add(src.paperId)
    }
    return ids
  }

  /** push-artifacts 序列：papers 行 → 原始文件（同 sha 跳过）→ blocks 分批 → 落 meta */
  async function pushArtifacts(paperId: string): Promise<void> {
    const paper = await db.papers.get(paperId)
    // 论文已删或还没 ready（retry 中）：队列项作废即可，markReady 会再入队
    if (!paper || paper.status !== 'ready') return

    const head = await syncApi.push([{ tbl: 'papers', id: paperId, payload: paper }])
    if (head.rejected.some((r) => r.reason === 'paper-deleted')) {
      await applyPaperTombstone(paperId)
      return
    }

    const meta = (await db.syncMeta.get(paperId)) ?? { paperId }
    if (!meta.filePushed) {
      const file = await db.files.get(paperId)
      if (file) {
        // 服务端同 sha 短路 200：换设备重推同一文件不写盘;失败会抛出并整段重试
        await syncApi.putFile(paperId, file.bytes, file.mime, paper.sha256)
      }
      meta.filePushed = true
      await db.syncMeta.put(meta)
    }

    const blocks = await rawPaperRepo.getBlocks(paperId)
    for (const batch of chunkRows(blocks)) {
      await syncApi.push(
        batch.map((b) => ({ tbl: 'blocks', id: b.id, paperId, payload: b })),
      )
    }
    await db.syncMeta.put({ ...meta, paperId, artifactsPushed: true, blocksPulled: true, filePushed: true })
  }

  async function flushOnce(): Promise<FlushResult> {
    const items = await db.outbox.orderBy('qid').toArray()
    if (!items.length) return 'idle'
    const plan = planOutbox(items)
    if (plan.obsoleteQids.length) await db.outbox.bulkDelete(plan.obsoleteQids)

    try {
      for (const del of plan.deletes) {
        await syncApi.deletePaper(del.paperId)
        if (del.qid !== undefined) await db.outbox.delete(del.qid)
        progressCache.delete(del.paperId)
      }

      for (const batch of plan.recordBatches) {
        const resp = await syncApi.push(batch.map(toPushChange))
        // 服务端说目标论文已被删除（另一台设备删的）：本地跟删，别再借尸还魂
        for (const pid of await paperIdsOfRejected(batch, resp.rejected)) {
          await applyPaperTombstone(pid)
        }
        for (const r of resp.rejected) {
          if (r.reason !== 'paper-deleted') console.warn('[sync] push 被拒', r)
        }
        const qids = batch.map((i) => i.qid).filter((q): q is number => q !== undefined)
        if (qids.length) await db.outbox.bulkDelete(qids)
        for (const it of batch) if (it.op === 'progress') progressCache.delete(it.paperId)
      }

      for (const art of plan.artifacts) {
        await pushArtifacts(art.paperId)
        if (art.qid !== undefined) await db.outbox.delete(art.qid)
      }

      return plan.deletes.length + plan.recordBatches.length + plan.artifacts.length > 0 ? 'pushed' : 'idle'
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 401 || e.code === 'unauthenticated')) return 'auth'
      return 'error'
    }
  }

  // -------------------------------------------------------------------------
  // 拉取与合并
  // -------------------------------------------------------------------------

  async function applyRemoteChanges(changes: SyncChangeRecord[]): Promise<void> {
    if (!changes.length) return
    // pending 键快照：本地 outbox 里有同记录待推 → 本地胜（远端这版必然会被我们覆盖）
    const items = await db.outbox.toArray()
    const pendingKeys = new Set(items.filter((i) => i.op === 'record' || i.op === 'progress').map(recordKey))
    const pendingArtifacts = new Set(items.filter((i) => i.op === 'push-artifacts').map((i) => i.paperId))
    const pendingDeletes = new Set(items.filter((i) => i.op === 'delete-paper').map((i) => i.paperId))

    for (const ch of changes) {
      try {
        await applyOne(ch, pendingKeys, pendingArtifacts, pendingDeletes)
      } catch (e) {
        // 单条应用失败不阻断整页：宁可缺一行（下轮全量对账可补），不可卡死游标
        console.warn('[sync] 应用远端变更失败', ch.tbl, ch.id, e)
      }
    }
  }

  async function applyOne(
    ch: SyncChangeRecord,
    pendingKeys: Set<string>,
    pendingArtifacts: Set<string>,
    pendingDeletes: Set<string>,
  ): Promise<void> {
    const paperScope = ch.tbl === 'papers' ? ch.id : ch.paperId
    // 本地已发起删除：远端这篇论文的任何行都不再落地，等我们的 DELETE 推上去
    if (paperScope && pendingDeletes.has(paperScope)) return

    if (ch.tbl === 'papers') {
      if (ch.deleted) {
        // 墓碑无条件赢（含本地有 pending 写入时）：另一台设备删了，这里必须跟删
        await applyPaperTombstone(ch.id)
        return
      }
      if (pendingKeys.has(`papers:${ch.id}`) || pendingArtifacts.has(ch.id)) return
      const remote = ch.payload as PaperRecord | null
      if (!remote || typeof remote !== 'object' || typeof remote.id !== 'string') return
      const local = await db.papers.get(ch.id)
      await db.papers.put(mergePaperRecord(local, remote))
      if (!local) {
        // 首次从远端见到这篇论文：制品在服务端（另一台设备推的），徽标按已同步计
        await db.syncMeta.put({ paperId: ch.id, artifactsPushed: true, filePushed: true, blocksPulled: false })
      }
      return
    }

    const table = subTables()[ch.tbl as keyof ReturnType<typeof subTables>]
    if (!table) return // chunks/jobs/consents 或未知表：永不落地
    if (pendingKeys.has(`${ch.tbl}:${ch.id}`)) return
    if (ch.deleted) {
      await table.delete(ch.id)
      return
    }
    // 本地即将整推这篇的 blocks（重新解析后）：远端旧块不落地，避免新旧混叠
    if (ch.tbl === 'blocks' && paperScope && pendingArtifacts.has(paperScope)) return
    const payload = ch.payload
    if (typeof payload !== 'object' || payload === null) return
    const localRow = await table.get(ch.id)
    if (
      localRow &&
      !shouldApplyRemote({
        hasPendingLocal: false,
        localUpdatedAt: rowTimestamp(localRow),
        remoteUpdatedAt: rowTimestamp(payload),
      })
    ) {
      return
    }
    await table.put(payload as never)
  }

  async function pullSince(): Promise<void> {
    let since = (await getState<number>(db, CURSOR_KEY)) ?? 0
    for (let guard = 0; guard < PULL_PAGE_GUARD; guard++) {
      const page = await syncApi.changes(since, { limit: 1000 })
      await applyRemoteChanges(page.changes)
      since = page.nextSince
      await putState(db, CURSOR_KEY, since)
      if (!page.hasMore) break
    }
    await putState(db, 'lastSyncAt', Date.now())
  }

  async function pullPaper(paperId: string): Promise<void> {
    let since = 0
    for (let guard = 0; guard < PULL_PAGE_GUARD; guard++) {
      const page = await syncApi.changes(since, { limit: 1000, paperId })
      await applyRemoteChanges(page.changes)
      since = page.nextSince
      if (!page.hasMore) break
    }
    const meta = (await db.syncMeta.get(paperId)) ?? { paperId }
    await db.syncMeta.put({ ...meta, blocksPulled: true })
  }

  // -------------------------------------------------------------------------
  // 调度 loop 与领导者选举
  // -------------------------------------------------------------------------

  function schedule(delayMs: number): void {
    const t = Date.now() + delayMs
    if (deadline === null || t < deadline) {
      deadline = t
      wake?.()
    }
  }

  function kick(item?: OutboxItem): void {
    if (item?.op === 'progress') {
      if (item.payload) progressCache.set(item.paperId, item.payload as PaperRecord)
      schedule(PROGRESS_FLUSH_DELAY_MS)
    } else {
      schedule(URGENT_FLUSH_DELAY_MS)
    }
  }

  /** 可被 schedule 提前打断的睡眠 */
  function interruptibleSleep(ms: number | null): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        wake = null
        if (wakeTimer) clearTimeout(wakeTimer)
        wakeTimer = null
        resolve()
      }
      wake = done
      if (ms !== null) wakeTimer = setTimeout(done, ms)
    })
  }

  async function loop(): Promise<void> {
    while (running && leader) {
      if (deadline === null) {
        await interruptibleSleep(null) // 无排期：睡到下一次 kick/stop
        continue
      }
      const waitMs = deadline - Date.now()
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
      if (result === 'error') {
        failures += 1
        deadline = Date.now() + backoffMs(failures)
      } else {
        failures = 0
        if (result === 'pushed' && typeof window !== 'undefined') {
          // 通知展示层(列表页同步徽标等)重读 syncMeta——否则后台推完要等下次 refresh 才变「已同步」
          window.dispatchEvent(new CustomEvent('paper-sync-flushed'))
        }
      }
    }
    leader = false
  }

  function start(): void {
    if (running) return
    running = true
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    if (!locks) {
      // node/旧浏览器：没有 Web Locks 就按单 tab 假设直接当领导者
      leader = true
      void loop()
      return
    }
    // 阻塞式请求（非 ifAvailable）：拿不到锁的 tab 排队待命，领导者关页后自动接棒
    void locks
      .request('paper-sync', async () => {
        if (!running) return
        leader = true
        await loop()
      })
      .catch(() => {
        // 锁 API 异常（隐私模式等）：退化为单 tab 假设，宁可冒双推（服务端覆盖幂等）也不罢工
        if (running && !leader) {
          leader = true
          void loop()
        }
      })
  }

  function stop(): void {
    running = false
    leader = false
    wake?.()
  }

  function flushProgressKeepalive(): void {
    if (!progressCache.size) return
    const changes: SyncPushChange[] = [...progressCache.values()].map((row) => ({
      tbl: 'papers',
      id: row.id,
      payload: row,
    }))
    syncApi.pushKeepalive(changes)
  }

  return { db, start, stop, kick, flushOnce, pullSince, pullPaper, flushProgressKeepalive }
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
    outboxSignal.on((dbName, item) => {
      if (current?.db.name === dbName) current.kick(item)
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
      current.start()
      current.kick() // 启动即冲一轮：上次会话遗留的 outbox 尽快补推
    } else {
      current.start() // 401 停机后 refresh 确认仍在登录态：复活推送 loop
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
    const [file, blocks, chunks, jobs, briefs, messages, conceptStates, evidence, usage] = await Promise.all([
      guestDb.files.get(pid),
      guestDb.blocks.where('paperId').equals(pid).toArray(),
      guestDb.chunks.where('paperId').equals(pid).toArray(),
      guestDb.jobs.where('paperId').equals(pid).toArray(),
      guestDb.briefs.where('paperId').equals(pid).toArray(),
      sessionIds.length ? guestDb.messages.where('sessionId').anyOf(sessionIds).toArray() : Promise.resolve([]),
      guestDb.conceptStates.where('paperId').equals(pid).toArray(),
      guestDb.evidence.where('paperId').equals(pid).toArray(),
      guestDb.usage.where('paperId').equals(pid).toArray(),
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
    await accountDb.syncMeta.put({ paperId: pid, artifactsPushed: false, blocksPulled: true, filePushed: false })

    // 入队：制品序列 + 相关业务行（record 直传）
    const queue: Omit<OutboxItem, 'qid'>[] = [{ op: 'push-artifacts', paperId: pid, createdAt: now }]
    const record = (tbl: string, recordId: string, payload: unknown): void => {
      queue.push({ op: 'record', tbl, recordId, paperId: pid, payload, createdAt: now })
    }
    for (const r of sessions) record('sessions', r.id, r)
    for (const r of messages) record('messages', r.id, r)
    for (const r of briefs) record('briefs', r.id, r)
    for (const r of conceptStates) record('conceptStates', r.id, r)
    for (const r of evidence) record('evidence', r.id, r)
    for (const r of usage) record('usage', r.id, r)
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
