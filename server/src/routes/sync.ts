/**
 * 同步服务端(P3):push / changes / snapshot / 论文级联删除。
 * 一致性模型:客户端本地优先 + LWW 合并,服务端只做"带 seq 的最后写入仓库"——
 * push 无条件覆盖(客户端已做合并),唯一的服务端否决是 paper 墓碑:
 * 删除必须赢,否则慢设备的迟到 push 会让已删论文"借尸还魂"。
 */
import { rm } from 'node:fs/promises'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  FILE_ID_RE,
  SYNC_CHANGES_MAX_LIMIT,
  SYNC_PUSH_MAX_BYTES,
  SYNC_PUSH_MAX_CHANGES,
} from '../../../shared/apiRoutes.js'
import {
  SYNC_TABLES,
  type DeletePaperResponse,
  type SyncChangeRecord,
  type SyncChangesResponse,
  type SyncPushResponse,
  type SyncSnapshotResponse,
} from '../../../shared/apiTypes.js'
import { requireSession } from '../auth/middleware.js'
import type { Db, StoredFileRow, SyncRecordRow } from '../db/db.js'
import { addStorageUsed, currentSeq, nextSeq, readQuota } from '../lib/quota.js'
import { apiError } from '../lib/respond.js'
import type { AppDeps, AppEnv } from '../types.js'
import { storedFilePath } from './files.js'

const changeSchema = z.object({
  tbl: z.string().min(1).max(64),
  id: z.string().min(1).max(200),
  paperId: z.string().min(1).max(200).optional(),
  deleted: z.boolean().optional(),
  payload: z.unknown().optional(),
})

const pushSchema = z.object({
  changes: z.array(changeSchema).max(SYNC_PUSH_MAX_CHANGES),
})

const SYNC_TABLE_SET = new Set<string>(SYNC_TABLES)

function getRecord(db: Db, userId: number, tbl: string, id: string): SyncRecordRow | undefined {
  return db
    .prepare('SELECT * FROM sync_records WHERE user_id = ? AND tbl = ? AND id = ?')
    .get(userId, tbl, id) as SyncRecordRow | undefined
}

const upsertRecordStmt = `
  INSERT INTO sync_records (user_id, tbl, id, paper_id, payload, bytes_size, seq, deleted, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, tbl, id) DO UPDATE SET
    paper_id = excluded.paper_id, payload = excluded.payload, bytes_size = excluded.bytes_size,
    seq = excluded.seq, deleted = excluded.deleted, updated_at = excluded.updated_at`

/**
 * 论文级联删除(必须已在事务内):物理删该论文全部记录 → papers 行写墓碑(新 seq)
 * → 删文件元数据行 → 回收配额。磁盘文件的 unlink 由调用方在事务提交后执行
 * (文件 IO 不进事务:unlink 失败只是漏磁盘垃圾,绝不能让 DB 状态回滚一半)。
 * push 里的 papers 墓碑与 DELETE /sync/papers/:id 共用此函数——两个入口一个语义。
 */
export function deletePaperInTx(
  db: Db,
  filesDir: string,
  userId: number,
  paperId: string,
  now: number,
): { seq: number; fileToDelete: string | null } {
  const { s: freedSync } = db
    .prepare(
      'SELECT COALESCE(SUM(bytes_size), 0) AS s FROM sync_records WHERE user_id = ? AND paper_id = ?',
    )
    .get(userId, paperId) as { s: number }
  // 子记录不留墓碑:papers 一颗墓碑足以让客户端整树丢弃,逐条墓碑白占 seq 与存储
  db.prepare('DELETE FROM sync_records WHERE user_id = ? AND paper_id = ?').run(userId, paperId)

  const seq = nextSeq(db)
  db.prepare(upsertRecordStmt).run(userId, 'papers', paperId, paperId, null, 0, seq, 1, now)

  const file = db
    .prepare('SELECT * FROM stored_files WHERE user_id = ? AND paper_id = ?')
    .get(userId, paperId) as StoredFileRow | undefined
  if (file) {
    db.prepare('DELETE FROM stored_files WHERE user_id = ? AND paper_id = ?').run(userId, paperId)
  }

  const freed = freedSync + (file?.byte_size ?? 0)
  addStorageUsed(db, userId, -freed)

  // 只有通过 files PUT(强校验 FILE_ID_RE)写入过的 paperId 才会有磁盘文件;
  // 这里再校验一次是纵深防御——路径拼接永远不信任外部输入
  const fileToDelete = file && FILE_ID_RE.test(paperId) ? storedFilePath(filesDir, userId, paperId) : null
  return { seq, fileToDelete }
}

export function syncRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db, config } = deps
  const r = new Hono<AppEnv>()
  r.use('*', requireSession(deps))

  r.post('/push', async (c) => {
    // 尺寸上限先看 Content-Length(nginx 已挡 10m,这里是精确闸),再按实读字节兜底
    const declared = Number(c.req.header('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > SYNC_PUSH_MAX_BYTES) {
      return apiError(c, 413, 'invalid-input', 'push 体积超过 8MB')
    }
    const raw = await c.req.text()
    if (Buffer.byteLength(raw, 'utf8') > SYNC_PUSH_MAX_BYTES) {
      return apiError(c, 413, 'invalid-input', 'push 体积超过 8MB')
    }
    let parsedRaw: unknown
    try {
      parsedRaw = JSON.parse(raw)
    } catch {
      return apiError(c, 400, 'invalid-input', 'body 不是合法 JSON')
    }
    const parsed = pushSchema.safeParse(parsedRaw)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return apiError(c, 400, 'invalid-input', first ? `${first.path.join('.')}: ${first.message}` : 'invalid body')
    }

    const user = c.get('user')
    const now = Date.now()
    const applied: SyncPushResponse['applied'] = []
    const rejected: SyncPushResponse['rejected'] = []
    const filesToDelete: string[] = []

    const outcome = db.transaction((): 'ok' | 'quota-exceeded' => {
      // ---- pass 1:逐条分类,先算清总配额增量再动数据(超配额整批拒,不留半批状态) ----
      interface Plan {
        tbl: string
        id: string
        paperId: string | null
        kind: 'upsert' | 'tombstone' | 'paper-cascade'
        payloadText: string | null
        bytes: number
        delta: number
      }
      const plans: Plan[] = []
      let totalDelta = 0

      for (const ch of parsed.data.changes) {
        if (!SYNC_TABLE_SET.has(ch.tbl)) {
          rejected.push({ tbl: ch.tbl, id: ch.id, reason: 'tbl-not-allowed' })
          continue
        }
        const paperId = ch.tbl === 'papers' ? ch.id : (ch.paperId ?? null)
        // 删除必须赢:目标论文已是墓碑 → 迟到的写入一律拒绝(客户端据此丢弃本地残留)
        if (paperId) {
          const paperRow = getRecord(db, user.id, 'papers', paperId)
          if (paperRow && paperRow.deleted) {
            rejected.push({ tbl: ch.tbl, id: ch.id, reason: 'paper-deleted' })
            continue
          }
        }
        if (ch.tbl === 'papers' && ch.deleted) {
          // papers 墓碑走完整级联:与 DELETE /sync/papers/:id 同语义,
          // 否则会留下"论文没了、子记录还在计费"的半删除状态
          plans.push({ tbl: ch.tbl, id: ch.id, paperId, kind: 'paper-cascade', payloadText: null, bytes: 0, delta: 0 })
          continue
        }
        const isTombstone = ch.deleted === true
        const payloadText = isTombstone ? null : JSON.stringify(ch.payload ?? null)
        const bytes = payloadText === null ? 0 : Buffer.byteLength(payloadText, 'utf8')
        const old = getRecord(db, user.id, ch.tbl, ch.id)
        const delta = bytes - (old?.bytes_size ?? 0)
        totalDelta += delta
        plans.push({
          tbl: ch.tbl,
          id: ch.id,
          paperId,
          kind: isTombstone ? 'tombstone' : 'upsert',
          payloadText,
          bytes,
          delta,
        })
      }

      // 配额在事务内实读(requireSession 的快照可能已过期);级联释放不计入预检,偏保守是安全方向
      const { used, quota } = readQuota(db, user.id)
      if (totalDelta > 0 && used + totalDelta > quota) return 'quota-exceeded'

      // ---- pass 2:逐条应用,seq 依分配顺序单调 ----
      for (const p of plans) {
        if (p.kind === 'paper-cascade') {
          const { seq, fileToDelete } = deletePaperInTx(db, config.filesDir, user.id, p.id, now)
          if (fileToDelete) filesToDelete.push(fileToDelete)
          applied.push({ tbl: p.tbl, id: p.id, seq })
          continue
        }
        const seq = nextSeq(db)
        db.prepare(upsertRecordStmt).run(
          user.id,
          p.tbl,
          p.id,
          p.paperId,
          p.payloadText,
          p.bytes,
          seq,
          p.kind === 'tombstone' ? 1 : 0,
          now,
        )
        applied.push({ tbl: p.tbl, id: p.id, seq })
      }
      addStorageUsed(db, user.id, totalDelta)
      return 'ok'
    })()

    if (outcome === 'quota-exceeded') {
      return apiError(c, 413, 'quota-exceeded', '存储配额不足')
    }
    // 磁盘清理在事务提交之后:失败只丢磁盘空间,不丢一致性
    for (const f of filesToDelete) await rm(f, { force: true })

    const body: SyncPushResponse = { applied, rejected, cursor: currentSeq(db) }
    return c.json(body)
  })

  r.get('/changes', (c) => {
    const since = Number(c.req.query('since') ?? 0)
    if (!Number.isInteger(since) || since < 0) return apiError(c, 400, 'invalid-input', 'since 不合法')
    const limitRaw = Number(c.req.query('limit') ?? SYNC_CHANGES_MAX_LIMIT)
    if (!Number.isInteger(limitRaw) || limitRaw < 1) return apiError(c, 400, 'invalid-input', 'limit 不合法')
    const limit = Math.min(limitRaw, SYNC_CHANGES_MAX_LIMIT)
    // 可选按论文过滤(P4 换设备补拉单篇用):语义不变,只是多一个 AND 条件,
    // (user_id,paper_id) 索引已存在;papers 行自身 paper_id = 自己的 id,也会被带出
    const paperId = c.req.query('paperId')
    if (paperId !== undefined && (paperId.length === 0 || paperId.length > 200)) {
      return apiError(c, 400, 'invalid-input', 'paperId 不合法')
    }

    // 多取一行探测 hasMore,免掉一次 COUNT
    const rows = (
      paperId === undefined
        ? db
            .prepare('SELECT * FROM sync_records WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
            .all(c.get('user').id, since, limit + 1)
        : db
            .prepare(
              'SELECT * FROM sync_records WHERE user_id = ? AND paper_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
            )
            .all(c.get('user').id, paperId, since, limit + 1)
    ) as SyncRecordRow[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const changes: SyncChangeRecord[] = page.map((row) => ({
      tbl: row.tbl,
      id: row.id,
      paperId: row.paper_id,
      deleted: row.deleted !== 0,
      payload: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
      seq: row.seq,
      updatedAt: row.updated_at,
    }))
    const body: SyncChangesResponse = {
      changes,
      nextSince: page.length > 0 ? page[page.length - 1].seq : since,
      hasMore,
    }
    return c.json(body)
  })

  r.get('/snapshot', (c) => {
    const rows = db
      .prepare(
        'SELECT tbl, id, seq FROM sync_records WHERE user_id = ? AND deleted = 0 ORDER BY seq ASC',
      )
      .all(c.get('user').id) as { tbl: string; id: string; seq: number }[]
    const body: SyncSnapshotResponse = { records: rows, cursor: currentSeq(db) }
    return c.json(body)
  })

  r.delete('/papers/:paperId', async (c) => {
    const paperId = c.req.param('paperId')
    if (!paperId || paperId.length > 200) return apiError(c, 400, 'invalid-input', 'paperId 不合法')
    const user = c.get('user')
    // 即使 papers 行不存在也写墓碑:客户端可能删除一篇从未 push 成功的论文,幂等吸收
    const { fileToDelete } = db.transaction(() =>
      deletePaperInTx(db, config.filesDir, user.id, paperId, Date.now()),
    )()
    if (fileToDelete) await rm(fileToDelete, { force: true })
    const body: DeletePaperResponse = { ok: true, cursor: currentSeq(db) }
    return c.json(body)
  })

  return r
}
