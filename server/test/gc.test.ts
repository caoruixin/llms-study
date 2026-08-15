/**
 * 同步域 GC(P3):90 天墓碑物理清除 + usage/evidence 行数上限"走墓碑"裁剪。
 */
import { describe, expect, it } from 'vitest'
import { runGc, TOMBSTONE_TTL_MS } from '../src/lib/gc.js'
import { nextSeq } from '../src/lib/quota.js'
import { createTestApp, createUser } from './helpers.js'

function insertRecord(
  db: ReturnType<typeof createTestApp>['db'],
  userId: number,
  tbl: string,
  id: string,
  opts: { deleted?: boolean; updatedAt?: number; bytes?: number } = {},
): void {
  const seq = db.transaction(() => nextSeq(db))()
  db.prepare(
    `INSERT INTO sync_records (user_id, tbl, id, paper_id, payload, bytes_size, seq, deleted, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    tbl,
    id,
    opts.deleted ? null : '{}',
    opts.bytes ?? 2,
    seq,
    opts.deleted ? 1 : 0,
    opts.updatedAt ?? Date.now(),
  )
}

describe('gc', () => {
  it('超过 90 天的墓碑被物理清除,窗口内的保留', async () => {
    const ctx = createTestApp()
    const userId = await createUser(ctx.db, 'alice', 'password-1')
    const now = Date.now()
    insertRecord(ctx.db, userId, 'papers', 'old-tomb', {
      deleted: true,
      updatedAt: now - TOMBSTONE_TTL_MS - 1000,
    })
    insertRecord(ctx.db, userId, 'papers', 'fresh-tomb', { deleted: true, updatedAt: now - 1000 })
    insertRecord(ctx.db, userId, 'papers', 'alive', { updatedAt: now })

    const r = runGc(ctx.db, now)
    expect(r.tombstonesPurged).toBe(1)
    const ids = (
      ctx.db.prepare('SELECT id FROM sync_records ORDER BY id').all() as { id: string }[]
    ).map((x) => x.id)
    expect(ids).toEqual(['alive', 'fresh-tomb'])
  })

  it('usage 超行数上限:最老的行转墓碑(新 seq),配额同步回收', async () => {
    const ctx = createTestApp()
    const userId = await createUser(ctx.db, 'alice', 'password-1')
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      insertRecord(ctx.db, userId, 'usage', `u${i}`, { updatedAt: now, bytes: 10 })
    }
    ctx.db.prepare('UPDATE users SET storage_used_bytes = 50 WHERE id = ?').run(userId)

    const r = runGc(ctx.db, now, { usage: 3 })
    expect(r.rowsTrimmed).toBe(2)
    // 最老(seq 最小)的 u0/u1 变墓碑且 seq 被刷新到最新——其它设备增量拉取会同步删除
    const rows = ctx.db
      .prepare('SELECT id, deleted, seq FROM sync_records WHERE tbl = ? ORDER BY id')
      .all('usage') as { id: string; deleted: number; seq: number }[]
    expect(rows.map((x) => [x.id, x.deleted])).toEqual([
      ['u0', 1],
      ['u1', 1],
      ['u2', 0],
      ['u3', 0],
      ['u4', 0],
    ])
    const maxAliveSeq = Math.max(...rows.filter((x) => !x.deleted).map((x) => x.seq))
    expect(rows[0].seq).toBeGreaterThan(maxAliveSeq)

    const { u } = ctx.db
      .prepare('SELECT storage_used_bytes AS u FROM users WHERE id = ?')
      .get(userId) as { u: number }
    expect(u).toBe(30)
  })
})
