import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb, type OutboxItem } from '../repo/db'
import { createPaperRepository } from '../repo/paperRepo'
import type { PaperRecord } from '../types'
import { backoffMs, createSyncEngine } from './syncEngine'

/**
 * 引擎单测：stub fetch（循 modelGateway.test.ts 惯例）+ fake-indexeddb。
 * 覆盖：push 批量/失败退避语义/401 停机/制品序列/删除/paper-deleted 级联/拉取合并。
 */

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function freshDb(): PaperDb {
  return new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
}

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

type Responder = (call: Call, index: number) => Response

function stubFetch(responder: Responder): { calls: Call[] } {
  const calls: Call[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    } else if (init?.body) {
      body = init.body
    }
    const call: Call = { method: init?.method ?? 'GET', url: String(input), headers, body }
    calls.push(call)
    return responder(call, calls.length - 1)
  }
  return { calls }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

const okPush = (n: number): Response =>
  json({ applied: Array.from({ length: n }, (_, i) => ({ tbl: 'x', id: String(i), seq: i + 1 })), rejected: [], cursor: n })

let qseq = 0
const qItem = (overrides: Partial<OutboxItem>): OutboxItem => ({
  op: 'record',
  paperId: 'p1',
  createdAt: 1000 + ++qseq,
  ...overrides,
})

async function seedPaper(db: PaperDb, overrides: Partial<PaperRecord> = {}): Promise<PaperRecord> {
  const paper: PaperRecord = {
    id: 'p1',
    title: '论文',
    fileName: 'a.pdf',
    format: 'pdf',
    mime: 'application/pdf',
    byteSize: 8,
    sha256: 'a'.repeat(64),
    status: 'ready',
    parserVersion: 1,
    sensitive: false,
    createdAt: 100,
    updatedAt: 1000,
    progress: { blockIndex: 0, ratio: 0, updatedAt: 1000 },
    ...overrides,
  }
  await db.papers.put(paper)
  return paper
}

describe('flushOnce push 批量', () => {
  it('60 条 record → 两次 push（50+10），成功后队列清空', async () => {
    const db = freshDb()
    await db.outbox.bulkAdd(
      Array.from({ length: 60 }, (_, i) =>
        qItem({ tbl: 'messages', recordId: `m${i}`, payload: { i } }),
      ),
    )
    const { calls } = stubFetch((call) => okPush((call.body as { changes: unknown[] }).changes.length))
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('pushed')
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.url === '/api/app/sync/push' && c.method === 'POST')).toBe(true)
    expect((calls[0].body as { changes: unknown[] }).changes).toHaveLength(50)
    expect((calls[1].body as { changes: unknown[] }).changes).toHaveLength(10)
    expect(await db.outbox.count()).toBe(0)
  })

  it('progress 项以 papers 整行为 payload 推送；同论文多条 progress 只推最新', async () => {
    const db = freshDb()
    const paper = await seedPaper(db)
    await db.outbox.bulkAdd([
      qItem({ op: 'progress', payload: { ...paper, progress: { blockIndex: 1, ratio: 0.1, updatedAt: 1 } } }),
      qItem({ op: 'progress', payload: { ...paper, progress: { blockIndex: 9, ratio: 0.9, updatedAt: 9 } } }),
    ])
    const { calls } = stubFetch(() => okPush(1))
    const engine = createSyncEngine(db)
    await engine.flushOnce()

    expect(calls).toHaveLength(1)
    const changes = (calls[0].body as { changes: { tbl: string; id: string; payload: PaperRecord }[] }).changes
    expect(changes).toHaveLength(1)
    expect(changes[0].tbl).toBe('papers')
    expect(changes[0].id).toBe('p1')
    expect(changes[0].payload.progress.blockIndex).toBe(9)
  })

  it('服务端 5xx → error（队列保留，等退避重试）；401 → auth（停机信号）', async () => {
    const db = freshDb()
    await db.outbox.add(qItem({ tbl: 'messages', recordId: 'm1', payload: {} }))
    const engine = createSyncEngine(db)

    stubFetch(() => json({ error: 'internal' }, 500))
    expect(await engine.flushOnce()).toBe('error')
    expect(await db.outbox.count()).toBe(1)

    stubFetch(() => json({ error: 'unauthenticated' }, 401))
    expect(await engine.flushOnce()).toBe('auth')
    expect(await db.outbox.count()).toBe(1)
  })

  it('paper-deleted 拒绝：本地级联删除该论文并作废其队列项（删除必须赢）', async () => {
    const db = freshDb()
    const paper = await seedPaper(db)
    await db.blocks.put({ id: 'p1:0', paperId: 'p1', index: 0, kind: 'paragraph', text: 'x', anchor: { kind: 'pdf', blockIndex: 0 } })
    await db.outbox.add(qItem({ op: 'progress', payload: paper }))
    stubFetch(() => json({ applied: [], rejected: [{ tbl: 'papers', id: 'p1', reason: 'paper-deleted' }], cursor: 1 }))
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('pushed')
    expect(await db.papers.get('p1')).toBeUndefined()
    expect(await db.blocks.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('flushOnce 制品序列与删除', () => {
  it('push-artifacts：papers 行 → PUT 文件（带 X-File-Sha256）→ blocks 分批 → syncMeta 落定', async () => {
    const db = freshDb()
    const paper = await seedPaper(db)
    await db.files.put({ paperId: 'p1', bytes: new TextEncoder().encode('%PDF').buffer as ArrayBuffer, mime: 'application/pdf' })
    await db.blocks.bulkPut([
      { id: 'p1:0', paperId: 'p1', index: 0, kind: 'paragraph', text: 'a', anchor: { kind: 'pdf', blockIndex: 0 } },
      { id: 'p1:1', paperId: 'p1', index: 1, kind: 'paragraph', text: 'b', anchor: { kind: 'pdf', blockIndex: 1 } },
    ])
    await db.outbox.add(qItem({ op: 'push-artifacts' }))
    const { calls } = stubFetch((call) =>
      call.method === 'PUT' ? json({ ok: true, sha256: paper.sha256, byteSize: 4 }) : okPush(1),
    )
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('pushed')
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/app/sync/push'], // papers 行
      ['PUT', '/api/app/files/p1'], // 原始文件
      ['POST', '/api/app/sync/push'], // blocks 批
    ])
    expect(calls[1].headers['x-file-sha256']).toBe(paper.sha256)
    const blockChanges = (calls[2].body as { changes: { tbl: string; id: string }[] }).changes
    expect(blockChanges.map((c) => c.id)).toEqual(['p1:0', 'p1:1'])
    expect(await db.syncMeta.get('p1')).toMatchObject({ artifactsPushed: true, filePushed: true, blocksPulled: true })
    expect(await db.outbox.count()).toBe(0)
  })

  it('filePushed 已置位时跳过 PUT（重试不再重传 50MB）', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.files.put({ paperId: 'p1', bytes: new ArrayBuffer(4), mime: 'application/pdf' })
    await db.syncMeta.put({ paperId: 'p1', filePushed: true })
    await db.outbox.add(qItem({ op: 'push-artifacts' }))
    const { calls } = stubFetch(() => okPush(1))
    await createSyncEngine(db).flushOnce()
    expect(calls.every((c) => c.method === 'POST')).toBe(true)
  })

  it('delete-paper：调 DELETE 接口并清队列', async () => {
    const db = freshDb()
    await db.outbox.add(qItem({ op: 'delete-paper', paperId: 'p9' }))
    const { calls } = stubFetch(() => json({ ok: true, cursor: 5 }))
    expect(await createSyncEngine(db).flushOnce()).toBe('pushed')
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', '/api/app/sync/papers/p9']])
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('pullSince 拉取合并', () => {
  it('分页循环到 hasMore=false，应用远端行并推进游标；papers 特例 maxBlockIndex 不回退', async () => {
    const db = freshDb()
    await seedPaper(db, {
      updatedAt: 1000,
      progress: { blockIndex: 80, maxBlockIndex: 90, ratio: 0.9, updatedAt: 1000 },
    })
    const remotePaper = {
      ...(await db.papers.get('p1'))!,
      updatedAt: 2000,
      progress: { blockIndex: 10, maxBlockIndex: 15, ratio: 0.15, updatedAt: 2000 },
    }
    const pages = [
      {
        changes: [{ tbl: 'papers', id: 'p1', paperId: 'p1', deleted: false, payload: remotePaper, seq: 1, updatedAt: 2000 }],
        nextSince: 1,
        hasMore: true,
      },
      {
        changes: [
          {
            tbl: 'messages',
            id: 'm1',
            paperId: 'p1',
            deleted: false,
            payload: { id: 'm1', sessionId: 's1', role: 'user', content: 'hi', createdAt: 7 },
            seq: 2,
            updatedAt: 2000,
          },
        ],
        nextSince: 2,
        hasMore: false,
      },
    ]
    stubFetch((_call, i) => json(pages[i]))
    await createSyncEngine(db).pullSince()

    const merged = (await db.papers.get('p1'))!
    expect(merged.updatedAt).toBe(2000)
    expect(merged.progress.maxBlockIndex).toBe(90) // 本地读得更深，不回退
    expect(merged.progress.blockIndex).toBe(10) // 当前位置跟 LWW 胜者（远端）
    expect(await db.messages.get('m1')).toMatchObject({ content: 'hi' })
    expect((await db.syncState.get('cursor'))?.value).toBe(2)
  })

  it('本地 outbox 有同记录 pending → 本地胜；papers 墓碑 → 本地级联删除', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.sessions.put({ id: 's1', paperId: 'p1', title: '本地新', createdAt: 1, updatedAt: 9000 })
    await db.outbox.add(qItem({ tbl: 'sessions', recordId: 's1', payload: { title: '本地新' } }))
    await seedPaper(db, { id: 'p2', sha256: 'b'.repeat(64) })

    stubFetch(() =>
      json({
        changes: [
          // pending 本地胜：远端 session 更“新”也不落地
          {
            tbl: 'sessions',
            id: 's1',
            paperId: 'p1',
            deleted: false,
            payload: { id: 's1', paperId: 'p1', title: '远端', createdAt: 1, updatedAt: 99999 },
            seq: 3,
            updatedAt: 99999,
          },
          // 另一篇论文的墓碑 → 本地级联消失
          { tbl: 'papers', id: 'p2', paperId: 'p2', deleted: true, payload: null, seq: 4, updatedAt: 99999 },
        ],
        nextSince: 4,
        hasMore: false,
      }),
    )
    await createSyncEngine(db).pullSince()

    expect((await db.sessions.get('s1'))?.title).toBe('本地新')
    expect(await db.papers.get('p2')).toBeUndefined()
    expect(await db.papers.get('p1')).toBeDefined()
  })

  it('pullPaper 用 paperId 过滤参数、不动全局游标，完成后置 blocksPulled', async () => {
    const db = freshDb()
    await db.syncState.put({ key: 'cursor', value: 42 })
    const { calls } = stubFetch(() => json({ changes: [], nextSince: 0, hasMore: false }))
    const engine = createSyncEngine(db)
    // 先建本地 papers 行，避免「远端新论文」分支干扰断言焦点
    const raw = createPaperRepository(db)
    void raw
    await engine.pullPaper('p1')

    expect(calls[0].url).toContain('paperId=p1')
    expect((await db.syncState.get('cursor'))?.value).toBe(42) // 全局游标不动
    expect(await db.syncMeta.get('p1')).toMatchObject({ blocksPulled: true })
  })
})

describe('backoffMs', () => {
  it('指数退避 1s→60s 封顶', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ])
  })
})
