/**
 * 同步服务端(P3):push/changes 游标分页、墓碑、paper-deleted 竞态、
 * tbl allowlist、配额 413 与记账、snapshot、论文级联删除。
 * 另含 §1.3 对账端点 /sync/summary 与 §1.6 译文/高亮两张新表。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SyncChangesResponse,
  SyncPushResponse,
  SyncSnapshotResponse,
  SyncSummaryResponse,
} from '../../shared/apiTypes.js'
import { createTestApp, createUser, login, postJson, withSid, type TestCtx } from './helpers.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setupSync(): Promise<{ ctx: TestCtx; sid: string; userId: number }> {
  const filesDir = mkdtempSync(path.join(os.tmpdir(), 'llms-sync-test-'))
  tmpDirs.push(filesDir)
  const ctx = createTestApp({ filesDir })
  const userId = await createUser(ctx.db, 'alice', 'password-1')
  const sid = await login(ctx.app, 'alice', 'password-1')
  return { ctx, sid, userId }
}

async function push(ctx: TestCtx, sid: string, changes: unknown[]): Promise<Response> {
  return ctx.app.request('/api/app/sync/push', postJson({ changes }, withSid(sid)))
}

async function getChanges(
  ctx: TestCtx,
  sid: string,
  since: number,
  limit?: number,
): Promise<SyncChangesResponse> {
  const qs = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`
  const res = await ctx.app.request(`/api/app/sync/changes?${qs}`, { headers: withSid(sid) })
  expect(res.status).toBe(200)
  return (await res.json()) as SyncChangesResponse
}

function usedBytes(ctx: TestCtx, userId: number): number {
  const row = ctx.db.prepare('SELECT storage_used_bytes AS u FROM users WHERE id = ?').get(userId) as {
    u: number
  }
  return row.u
}

/** 与服务端相同的记账口径:payload JSON 串的 utf8 字节数 */
const bytesOf = (payload: unknown): number => Buffer.byteLength(JSON.stringify(payload), 'utf8')

async function getSummary(ctx: TestCtx, sid: string): Promise<SyncSummaryResponse> {
  const res = await ctx.app.request('/api/app/sync/summary', { headers: withSid(sid) })
  expect(res.status).toBe(200)
  return (await res.json()) as SyncSummaryResponse
}

/** summary.papers 的顺序是实现细节,断言一律走 paperId → blocks 的映射 */
const blocksByPaper = (s: SyncSummaryResponse): Record<string, number> =>
  Object.fromEntries(s.papers.map((p) => [p.paperId, p.blocks]))

/** 服务端全局 seq 水位(cursor 的真相来源) */
function globalSeq(ctx: TestCtx): number {
  const row = ctx.db.prepare("SELECT v FROM sync_meta WHERE k = 'global_seq'").get() as { v: number }
  return row.v
}

describe('push / changes', () => {
  it('push 赋 seq 单调递增,changes 拉回 payload 原样', async () => {
    const { ctx, sid } = await setupSync()
    const paper = { title: '论文一', sha256: 'abc' }
    const block = { text: '第一段', idx: 0 }
    const res = await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: paper },
      { tbl: 'blocks', id: 'b1', paperId: 'p1', payload: block },
    ])
    expect(res.status).toBe(200)
    const body = (await res.json()) as SyncPushResponse
    expect(body.rejected).toEqual([])
    expect(body.applied).toHaveLength(2)
    expect(body.applied[1].seq).toBeGreaterThan(body.applied[0].seq)
    expect(body.cursor).toBe(body.applied[1].seq)

    const changes = await getChanges(ctx, sid, 0)
    expect(changes.hasMore).toBe(false)
    expect(changes.nextSince).toBe(body.cursor)
    expect(changes.changes.map((c) => [c.tbl, c.id, c.payload])).toEqual([
      ['papers', 'p1', paper],
      ['blocks', 'b1', block],
    ])
    expect(changes.changes[1].paperId).toBe('p1')
  })

  it('changes 游标分页:limit 生效、hasMore/nextSince 可迭代到底', async () => {
    const { ctx, sid } = await setupSync()
    const items = Array.from({ length: 5 }, (_, i) => ({
      tbl: 'messages',
      id: `m${i}`,
      paperId: 'p1',
      payload: { text: `msg-${i}` },
    }))
    await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload: {} }, ...items])

    const seen: string[] = []
    let since = 0
    for (let guard = 0; guard < 10; guard++) {
      const page = await getChanges(ctx, sid, since, 2)
      seen.push(...page.changes.map((c) => c.id))
      since = page.nextSince
      if (!page.hasMore) break
      expect(page.changes).toHaveLength(2)
    }
    expect(seen).toEqual(['p1', 'm0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('changes?paperId= 只回该论文的记录(含 papers 行自身),分页仍可迭代', async () => {
    const { ctx, sid } = await setupSync()
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: { t: 1 } },
      { tbl: 'blocks', id: 'p1-b0', paperId: 'p1', payload: { i: 0 } },
      { tbl: 'blocks', id: 'p1-b1', paperId: 'p1', payload: { i: 1 } },
      { tbl: 'papers', id: 'p2', payload: { t: 2 } },
      { tbl: 'blocks', id: 'p2-b0', paperId: 'p2', payload: { i: 0 } },
    ])

    const seen: string[] = []
    let since = 0
    for (let guard = 0; guard < 10; guard++) {
      const res = await ctx.app.request(`/api/app/sync/changes?since=${since}&limit=2&paperId=p1`, {
        headers: withSid(sid),
      })
      expect(res.status).toBe(200)
      const page = (await res.json()) as SyncChangesResponse
      seen.push(...page.changes.map((c) => c.id))
      since = page.nextSince
      if (!page.hasMore) break
    }
    expect(seen).toEqual(['p1', 'p1-b0', 'p1-b1'])

    // 过滤参数不合法 → 400(空串/超长)
    const bad = await ctx.app.request('/api/app/sync/changes?since=0&paperId=', { headers: withSid(sid) })
    expect(bad.status).toBe(400)
  })

  it('重复 push 同一条记录 = 覆盖并赋新 seq(增量拉取会再次看到它)', async () => {
    const { ctx, sid } = await setupSync()
    const r1 = (await (await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload: { v: 1 } }])).json()) as SyncPushResponse
    const r2 = (await (await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload: { v: 2 } }])).json()) as SyncPushResponse
    expect(r2.applied[0].seq).toBeGreaterThan(r1.applied[0].seq)

    const changes = await getChanges(ctx, sid, r1.cursor)
    expect(changes.changes).toHaveLength(1)
    expect(changes.changes[0].payload).toEqual({ v: 2 })
  })

  it('tbl allowlist:chunks 被逐条 rejected,同批其它记录照常应用', async () => {
    const { ctx, sid } = await setupSync()
    const res = await push(ctx, sid, [
      { tbl: 'chunks', id: 'c1', paperId: 'p1', payload: { emb: [1, 2] } },
      { tbl: 'papers', id: 'p1', payload: {} },
    ])
    const body = (await res.json()) as SyncPushResponse
    expect(body.rejected).toEqual([{ tbl: 'chunks', id: 'c1', reason: 'tbl-not-allowed' }])
    expect(body.applied.map((a) => a.tbl)).toEqual(['papers'])
  })

  it('记录墓碑:deleted push 置 payload null 并回收字节', async () => {
    const { ctx, sid, userId } = await setupSync()
    const payload = { text: 'x'.repeat(100) }
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: {} },
      { tbl: 'messages', id: 'm1', paperId: 'p1', payload },
    ])
    const before = usedBytes(ctx, userId)
    expect(before).toBe(bytesOf({}) + bytesOf(payload))

    const res = await push(ctx, sid, [{ tbl: 'messages', id: 'm1', paperId: 'p1', deleted: true }])
    expect(res.status).toBe(200)
    expect(usedBytes(ctx, userId)).toBe(bytesOf({}))

    const changes = await getChanges(ctx, sid, 0)
    const m1 = changes.changes.find((c) => c.id === 'm1')!
    expect(m1.deleted).toBe(true)
    expect(m1.payload).toBeNull()
  })

  it('paper-deleted 竞态:论文删除后迟到的子记录 push 被拒', async () => {
    const { ctx, sid } = await setupSync()
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: {} },
      { tbl: 'blocks', id: 'b1', paperId: 'p1', payload: { t: 1 } },
    ])
    const del = await ctx.app.request('/api/app/sync/papers/p1', {
      method: 'DELETE',
      headers: withSid(sid),
    })
    expect(del.status).toBe(200)

    // 另一台慢设备的迟到写入:更新已删论文的进度/新增块,一律 paper-deleted
    const res = await push(ctx, sid, [
      { tbl: 'blocks', id: 'b2', paperId: 'p1', payload: { t: 2 } },
      { tbl: 'papers', id: 'p1', payload: { resurrect: true } },
    ])
    const body = (await res.json()) as SyncPushResponse
    expect(body.applied).toEqual([])
    expect(body.rejected.map((r) => r.reason)).toEqual(['paper-deleted', 'paper-deleted'])
  })

  it('push papers 墓碑 = 完整级联(与 DELETE 端点同语义)', async () => {
    const { ctx, sid, userId } = await setupSync()
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p2', payload: {} },
      { tbl: 'blocks', id: 'b1', paperId: 'p2', payload: { big: 'y'.repeat(200) } },
    ])
    expect(usedBytes(ctx, userId)).toBeGreaterThan(0)

    const res = await push(ctx, sid, [{ tbl: 'papers', id: 'p2', deleted: true }])
    expect(res.status).toBe(200)
    // 子记录物理消失,papers 只剩墓碑,配额全额回收
    const rows = ctx.db
      .prepare('SELECT tbl, id, deleted FROM sync_records WHERE user_id = ?')
      .all(userId) as { tbl: string; id: string; deleted: number }[]
    expect(rows).toEqual([{ tbl: 'papers', id: 'p2', deleted: 1 }])
    expect(usedBytes(ctx, userId)).toBe(0)
  })
})

describe('配额', () => {
  it('超配额 → 413,整批不应用、不记账', async () => {
    const { ctx, sid, userId } = await setupSync()
    ctx.db.prepare('UPDATE users SET storage_quota_bytes = 50 WHERE id = ?').run(userId)
    const res = await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: { pad: 'z'.repeat(100) } },
    ])
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'quota-exceeded' })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM sync_records').get()).toEqual({ n: 0 })
    expect(usedBytes(ctx, userId)).toBe(0)
  })

  it('记账 = 新旧 payload 字节差:覆盖更小的 payload 会降占用', async () => {
    const { ctx, sid, userId } = await setupSync()
    const big = { text: 'a'.repeat(500) }
    const small = { text: 'b' }
    await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload: big }])
    expect(usedBytes(ctx, userId)).toBe(bytesOf(big))
    await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload: small }])
    expect(usedBytes(ctx, userId)).toBe(bytesOf(small))
  })

  it('admin recount-quota 按存活记录 + 文件真实聚合', async () => {
    const { ctx, sid, userId } = await setupSync()
    const payload = { text: 'c'.repeat(64) }
    await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload }])
    const fileBytes = Buffer.from('pdf-bytes-here')
    const sha = createHash('sha256').update(fileBytes).digest('hex')
    const up = await ctx.app.request('/api/app/files/p1', {
      method: 'PUT',
      headers: { ...withSid(sid), 'x-file-sha256': sha, 'content-type': 'application/pdf' },
      body: fileBytes,
    })
    expect(up.status).toBe(200)

    // 人为把记账搞乱,重算应恢复真相
    ctx.db.prepare('UPDATE users SET storage_used_bytes = 12345 WHERE id = ?').run(userId)
    await createUser(ctx.db, 'boss', 'password-1', 'admin')
    const adminSid = await login(ctx.app, 'boss', 'password-1')
    const res = await ctx.app.request('/api/app/admin/recount-quota', {
      method: 'POST',
      headers: withSid(adminSid),
    })
    expect(res.status).toBe(200)
    expect(usedBytes(ctx, userId)).toBe(bytesOf(payload) + fileBytes.length)
  })
})

describe('snapshot 与级联删除', () => {
  it('snapshot 只含存活记录,不含 payload', async () => {
    const { ctx, sid } = await setupSync()
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: {} },
      { tbl: 'messages', id: 'm1', paperId: 'p1', payload: { t: 1 } },
    ])
    await push(ctx, sid, [{ tbl: 'messages', id: 'm1', paperId: 'p1', deleted: true }])

    const res = await ctx.app.request('/api/app/sync/snapshot', { headers: withSid(sid) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SyncSnapshotResponse
    expect(body.records.map((r) => r.id)).toEqual(['p1'])
    expect(body.records[0]).not.toHaveProperty('payload')
  })

  it('DELETE /sync/papers/:id:级联删子记录 + 磁盘文件 + 配额回收,papers 留新 seq 墓碑', async () => {
    const { ctx, sid, userId } = await setupSync()
    const pushRes = (await (
      await push(ctx, sid, [
        { tbl: 'papers', id: 'p1', payload: { title: 't' } },
        { tbl: 'blocks', id: 'b1', paperId: 'p1', payload: { text: 'x'.repeat(300) } },
        { tbl: 'sessions', id: 's1', paperId: 'p1', payload: {} },
      ])
    ).json()) as SyncPushResponse

    const fileBytes = Buffer.from('%PDF-1.7 fake body')
    const sha = createHash('sha256').update(fileBytes).digest('hex')
    await ctx.app.request('/api/app/files/p1', {
      method: 'PUT',
      headers: { ...withSid(sid), 'x-file-sha256': sha },
      body: fileBytes,
    })
    const diskPath = path.join(ctx.config.filesDir, String(userId), 'p1.bin')
    expect(existsSync(diskPath)).toBe(true)
    expect(usedBytes(ctx, userId)).toBeGreaterThan(0)

    const res = await ctx.app.request('/api/app/sync/papers/p1', {
      method: 'DELETE',
      headers: withSid(sid),
    })
    expect(res.status).toBe(200)

    // 墓碑带新 seq:其它设备增量拉取能看到删除
    const changes = await getChanges(ctx, sid, pushRes.cursor)
    expect(changes.changes).toHaveLength(1)
    expect(changes.changes[0]).toMatchObject({ tbl: 'papers', id: 'p1', deleted: true })

    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM sync_records WHERE deleted = 0").get()).toEqual({ n: 0 })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM stored_files').get()).toEqual({ n: 0 })
    expect(existsSync(diskPath)).toBe(false)
    expect(usedBytes(ctx, userId)).toBe(0)
  })

  it('删除从未 push 过的论文也幂等成功(写墓碑)', async () => {
    const { ctx, sid } = await setupSync()
    const res = await ctx.app.request('/api/app/sync/papers/ghost', {
      method: 'DELETE',
      headers: withSid(sid),
    })
    expect(res.status).toBe(200)
    const changes = await getChanges(ctx, sid, 0)
    expect(changes.changes[0]).toMatchObject({ tbl: 'papers', id: 'ghost', deleted: true })
  })

  it('push 超过 500 条 → 400', async () => {
    const { ctx, sid } = await setupSync()
    const changes = Array.from({ length: 501 }, (_, i) => ({
      tbl: 'messages',
      id: `m${i}`,
      payload: {},
    }))
    const res = await push(ctx, sid, changes)
    expect(res.status).toBe(400)
  })
})

describe('summary(客户端对账,§1.3)', () => {
  it('未登录 → 401', async () => {
    const { ctx } = await setupSync()
    const res = await ctx.app.request('/api/app/sync/summary')
    expect(res.status).toBe(401)
  })

  it('逐篇回 blocks 计数:只数 blocks 表,其它子表不掺和', async () => {
    const { ctx, sid } = await setupSync()
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: { title: '一' } },
      { tbl: 'blocks', id: 'p1-b0', paperId: 'p1', payload: { i: 0 } },
      { tbl: 'blocks', id: 'p1-b1', paperId: 'p1', payload: { i: 1 } },
      // 同篇的其它子表不该被算进 blocks(对账只关心正文到齐没有)
      { tbl: 'messages', id: 'p1-m0', paperId: 'p1', payload: { t: 'hi' } },
      { tbl: 'papers', id: 'p2', payload: { title: '二' } },
      { tbl: 'blocks', id: 'p2-b0', paperId: 'p2', payload: { i: 0 } },
      // 空心论文:papers 行在、一块正文都没推上来
      { tbl: 'papers', id: 'p3', payload: { title: '三' } },
    ])

    expect(blocksByPaper(await getSummary(ctx, sid))).toEqual({ p1: 2, p2: 1, p3: 0 })
  })

  it('blocks 墓碑不计入计数', async () => {
    const { ctx, sid } = await setupSync()
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: {} },
      { tbl: 'blocks', id: 'b0', paperId: 'p1', payload: { i: 0 } },
      { tbl: 'blocks', id: 'b1', paperId: 'p1', payload: { i: 1 } },
    ])
    expect(blocksByPaper(await getSummary(ctx, sid))).toEqual({ p1: 2 })

    const res = await push(ctx, sid, [{ tbl: 'blocks', id: 'b1', paperId: 'p1', deleted: true }])
    expect(res.status).toBe(200)
    expect(blocksByPaper(await getSummary(ctx, sid))).toEqual({ p1: 1 })
  })

  it('已删论文(墓碑)整篇不出现', async () => {
    const { ctx, sid } = await setupSync()
    await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: {} },
      { tbl: 'blocks', id: 'b0', paperId: 'p1', payload: {} },
      { tbl: 'papers', id: 'p2', payload: {} },
    ])
    const del = await ctx.app.request('/api/app/sync/papers/p2', {
      method: 'DELETE',
      headers: withSid(sid),
    })
    expect(del.status).toBe(200)
    // push 的 papers 墓碑走同一条级联路径,也必须消失
    await push(ctx, sid, [{ tbl: 'papers', id: 'p1', deleted: true }])

    const summary = await getSummary(ctx, sid)
    expect(summary.papers).toEqual([])
  })

  it('files 段带 sha256/byteSize,文件删除后消失', async () => {
    const { ctx, sid } = await setupSync()
    await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload: {} }])
    expect((await getSummary(ctx, sid)).files).toEqual([])

    const fileBytes = Buffer.from('%PDF-1.7 summary body')
    const sha = createHash('sha256').update(fileBytes).digest('hex')
    const up = await ctx.app.request('/api/app/files/p1', {
      method: 'PUT',
      headers: { ...withSid(sid), 'x-file-sha256': sha, 'content-type': 'application/pdf' },
      body: fileBytes,
    })
    expect(up.status).toBe(200)

    expect((await getSummary(ctx, sid)).files).toEqual([
      { paperId: 'p1', sha256: sha, byteSize: fileBytes.length },
    ])

    await ctx.app.request('/api/app/sync/papers/p1', { method: 'DELETE', headers: withSid(sid) })
    expect((await getSummary(ctx, sid)).files).toEqual([])
  })

  it('cursor = 当前 seq 水位(不分配新 seq),且只含本人数据', async () => {
    const { ctx, sid } = await setupSync()
    const pushed = (await (
      await push(ctx, sid, [{ tbl: 'papers', id: 'p1', payload: {} }])
    ).json()) as SyncPushResponse

    const first = await getSummary(ctx, sid)
    expect(first.cursor).toBe(pushed.cursor)
    expect(first.cursor).toBe(globalSeq(ctx))
    // 读端点不该动 seq:再读一次水位不变
    expect((await getSummary(ctx, sid)).cursor).toBe(pushed.cursor)

    // 另一个账号的论文/文件不出现在本人 summary 里
    await createUser(ctx.db, 'bob', 'password-1')
    const bobSid = await login(ctx.app, 'bob', 'password-1')
    await push(ctx, bobSid, [
      { tbl: 'papers', id: 'bob-p', payload: {} },
      { tbl: 'blocks', id: 'bob-b', paperId: 'bob-p', payload: {} },
    ])
    expect(blocksByPaper(await getSummary(ctx, sid))).toEqual({ p1: 0 })
    expect(blocksByPaper(await getSummary(ctx, bobSid))).toEqual({ 'bob-p': 1 })
    // 但 cursor 是全局水位,会被别人的写入推高
    expect((await getSummary(ctx, sid)).cursor).toBe(globalSeq(ctx))
  })
})

describe('译文与高亮同步(§1.6)', () => {
  it('translations / highlights 在 allowlist 内:push 被应用而非 tbl-not-allowed', async () => {
    const { ctx, sid } = await setupSync()
    const tr = { blockId: 'b0', text: '中文译文', srcHash: 'h1' }
    const hl = { blockId: 'b0', start: 3, end: 9, color: 'yellow' }
    const res = await push(ctx, sid, [
      { tbl: 'papers', id: 'p1', payload: {} },
      { tbl: 'translations', id: 't1', paperId: 'p1', payload: tr },
      { tbl: 'highlights', id: 'h1', paperId: 'p1', payload: hl },
    ])
    expect(res.status).toBe(200)
    const body = (await res.json()) as SyncPushResponse
    expect(body.rejected).toEqual([])
    expect(body.applied.map((a) => a.tbl)).toEqual(['papers', 'translations', 'highlights'])

    // 换设备增量拉取能原样收到
    const changes = await getChanges(ctx, sid, 0)
    expect(changes.changes.map((c) => [c.tbl, c.id, c.payload])).toEqual([
      ['papers', 'p1', {}],
      ['translations', 't1', tr],
      ['highlights', 'h1', hl],
    ])

    // 墓碑同样可推(deleteHighlights 走这条路径)
    const del = await push(ctx, sid, [{ tbl: 'highlights', id: 'h1', paperId: 'p1', deleted: true }])
    expect(((await del.json()) as SyncPushResponse).rejected).toEqual([])
  })

  it('DELETE /sync/papers/:id 级联删掉译文与高亮', async () => {
    const { ctx, sid, userId } = await setupSync()
    const pushRes = (await (
      await push(ctx, sid, [
        { tbl: 'papers', id: 'p1', payload: {} },
        { tbl: 'translations', id: 't1', paperId: 'p1', payload: { text: 'x'.repeat(200) } },
        { tbl: 'highlights', id: 'h1', paperId: 'p1', payload: { start: 0, end: 5 } },
      ])
    ).json()) as SyncPushResponse
    expect(usedBytes(ctx, userId)).toBeGreaterThan(0)

    const res = await ctx.app.request('/api/app/sync/papers/p1', {
      method: 'DELETE',
      headers: withSid(sid),
    })
    expect(res.status).toBe(200)

    const rows = ctx.db
      .prepare('SELECT tbl, id, deleted FROM sync_records WHERE user_id = ?')
      .all(userId) as { tbl: string; id: string; deleted: number }[]
    expect(rows).toEqual([{ tbl: 'papers', id: 'p1', deleted: 1 }])
    expect(usedBytes(ctx, userId)).toBe(0)

    // 其它设备增量拉取只看到 papers 墓碑(子记录不留墓碑,整树按论文丢弃)
    const changes = await getChanges(ctx, sid, pushRes.cursor)
    expect(changes.changes.map((c) => [c.tbl, c.id, c.deleted])).toEqual([['papers', 'p1', true]])
  })
})
