import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb, type OutboxItem } from '../repo/db'
import { createPaperRepository } from '../repo/paperRepo'
import type { PaperBlock, PaperRecord } from '../types'
import { SYNC_CHANNEL_NAME } from './crossTab'
import { outboxSignal } from './outbox'
import { backoffMs, claimGuestPapers, createSyncEngine, type SyncEngine } from './syncEngine'

/**
 * claimGuestPapers 走模块级单例（getGuestPaperDb / getPaperDbForUser / useAuthStore）：
 * 这里把三者做成可替换的——不设时原样透传给真实现，其余测例零感知。
 */
const claimMocks = vi.hoisted(() => ({ guest: null as unknown, account: null as unknown, authed: false }))
vi.mock('../repo/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repo/db')>()
  return {
    ...actual,
    getGuestPaperDb: () => (claimMocks.guest as PaperDb | null) ?? actual.getGuestPaperDb(),
    getPaperDbForUser: (id: number) => (claimMocks.account as PaperDb | null) ?? actual.getPaperDbForUser(id),
  }
})
vi.mock('../../auth/authStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/authStore')>()
  const store = actual.useAuthStore
  const getState = () =>
    claimMocks.authed ? { ...store.getState(), status: 'authed', user: { id: 7, username: 'u' } } : store.getState()
  return { ...actual, useAuthStore: { ...store, getState } }
})

/**
 * 引擎单测：stub fetch（循 modelGateway.test.ts 惯例）+ fake-indexeddb。
 * 覆盖：push 批量/失败退避语义/401 停机/制品序列（papers→blocks→文件）/逐篇隔离/
 * 删除/paper-deleted 级联/拉取合并/空心论文判定/跨 tab 唤醒/空闲轮询/keepalive 闸/对账。
 */

const realFetch = globalThis.fetch
const engines: SyncEngine[] = []
const channels: BroadcastChannel[] = []

afterEach(() => {
  globalThis.fetch = realFetch
  for (const e of engines.splice(0)) e.stop()
  for (const c of channels.splice(0)) c.close()
  vi.restoreAllMocks()
})

function freshDb(): PaperDb {
  return new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
}

/** 测试用引擎：短延迟，且登记到 afterEach 统一 stop（loop 不会挂住进程） */
function testEngine(db: PaperDb, opts: Parameters<typeof createSyncEngine>[1] = {}): SyncEngine {
  const engine = createSyncEngine(db, { urgentDelayMs: 10, idlePollMs: 30, ...opts })
  engines.push(engine)
  return engine
}

/** 模拟另一个 tab：node 的 BroadcastChannel 同线程可达，不回环给发送方 */
function otherTab(): BroadcastChannel {
  const ch = new BroadcastChannel(SYNC_CHANNEL_NAME)
  ;(ch as { unref?: () => void }).unref?.()
  channels.push(ch)
  return ch
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await sleep(5)
  }
}

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
  keepalive: boolean
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
    const call: Call = { method: init?.method ?? 'GET', url: String(input), headers, body, keepalive: init?.keepalive === true }
    calls.push(call)
    return responder(call, calls.length - 1)
  }
  return { calls }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

const okPush = (n: number): Response =>
  json({ applied: Array.from({ length: n }, (_, i) => ({ tbl: 'x', id: String(i), seq: i + 1 })), rejected: [], cursor: n })

const changesOf = (call: Call) => (call.body as { changes: { tbl: string; id: string; payload?: unknown }[] }).changes
const isSummary = (call: Call) => call.url.endsWith('/sync/summary')
const isPapersRowPush = (call: Call, paperId: string) =>
  call.url.endsWith('/sync/push') && changesOf(call).some((c) => c.tbl === 'papers' && c.id === paperId)

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

const blockRow = (paperId: string, index: number): PaperBlock => ({
  id: `${paperId}:${index}`,
  paperId,
  index,
  kind: 'paragraph',
  text: `b${index}`,
  anchor: { kind: 'pdf', blockIndex: index },
})

/** 一篇带文件 + 两块的 ready 论文 + push-artifacts 队列项 + markReady 同款 syncMeta */
async function seedArtifactPaper(db: PaperDb, paperId = 'p1', overrides: Partial<PaperRecord> = {}): Promise<PaperRecord> {
  const paper = await seedPaper(db, { id: paperId, sha256: paperId.padEnd(64, 'a'), blockCount: 2, ...overrides })
  await db.files.put({ paperId, bytes: new TextEncoder().encode('%PDF').buffer as ArrayBuffer, mime: 'application/pdf' })
  await db.blocks.bulkPut([blockRow(paperId, 0), blockRow(paperId, 1)])
  await db.syncMeta.put({ paperId, artifactsPushed: false, blocksPushed: false, filePushed: false, blocksPulled: true })
  await db.outbox.add(qItem({ op: 'push-artifacts', paperId }))
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
    const { calls } = stubFetch((call) => okPush(changesOf(call).length))
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('pushed')
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.url === '/api/app/sync/push' && c.method === 'POST')).toBe(true)
    expect(changesOf(calls[0])).toHaveLength(50)
    expect(changesOf(calls[1])).toHaveLength(10)
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
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
    await db.blocks.put(blockRow('p1', 0))
    await db.outbox.add(qItem({ op: 'progress', payload: paper }))
    stubFetch(() => json({ applied: [], rejected: [{ tbl: 'papers', id: 'p1', reason: 'paper-deleted' }], cursor: 1 }))
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('pushed')
    expect(await db.papers.get('p1')).toBeUndefined()
    expect(await db.blocks.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })

  it('其它原因的拒绝（tbl-not-allowed）：队列项保留 + lastError；连续 5 轮仍被拒才丢弃', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = freshDb()
    await seedPaper(db)
    const row = { id: 't1', paperId: 'p1', blockIndex: 0, updatedAt: 1 }
    await db.outbox.add(qItem({ tbl: 'translations', recordId: 't1', payload: row }))
    await db.outbox.add(qItem({ tbl: 'messages', recordId: 'm1', payload: { id: 'm1' } }))
    stubFetch((call) =>
      json({
        applied: changesOf(call).filter((c) => c.tbl === 'messages').map((c, i) => ({ ...c, seq: i + 1 })),
        rejected: changesOf(call).filter((c) => c.tbl === 'translations').map((c) => ({ tbl: c.tbl, id: c.id, reason: 'tbl-not-allowed' })),
        cursor: 1,
      }),
    )
    const engine = createSyncEngine(db)

    // 同批既有成功也有被拒：partial；被拒项留队列，成功项删掉
    expect(await engine.flushOnce()).toBe('partial')
    expect((await db.outbox.toArray()).map((i) => i.tbl)).toEqual(['translations'])
    expect((await db.syncMeta.get('p1'))?.lastError).toMatchObject({ step: 'records', code: 'unknown' })
    expect((await db.syncMeta.get('p1'))?.attempts).toBe(1)

    for (let i = 0; i < 3; i++) expect(await engine.flushOnce()).toBe('error')
    expect(await db.outbox.count()).toBe(1)
    // 第 5 次：attempts 到顶，丢弃 + console.error（队列项被消费掉 → 算 pushed，徽标顺带刷新）
    errorSpy.mockClear()
    expect(await engine.flushOnce()).toBe('pushed')
    expect(await db.outbox.count()).toBe(0)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(await engine.flushOnce()).toBe('idle')
  })
})

describe('flushOnce 制品序列与删除', () => {
  it('push-artifacts：papers 行 → blocks 分批 → PUT 文件（带 X-File-Sha256）→ syncMeta 落定', async () => {
    const db = freshDb()
    const paper = await seedArtifactPaper(db)
    const { calls } = stubFetch((call) =>
      call.method === 'PUT' ? json({ ok: true, sha256: paper.sha256, byteSize: 4 }) : okPush(1),
    )
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('pushed')
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/app/sync/push'], // papers 行
      ['POST', '/api/app/sync/push'], // blocks 批（先于文件：正文是最低保障）
      ['PUT', '/api/app/files/p1'], // 原始文件
    ])
    expect(calls[2].headers['x-file-sha256']).toBe(paper.sha256)
    expect(changesOf(calls[1]).map((c) => c.id)).toEqual(['p1:0', 'p1:1'])
    const meta = await db.syncMeta.get('p1')
    expect(meta).toMatchObject({ artifactsPushed: true, blocksPushed: true, filePushed: true, blocksPulled: true, attempts: 0 })
    expect(meta?.lastError).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('filePushed 已置位时跳过 PUT（重试不再重传 50MB）；老行 artifactsPushed=true 兼容为 blocks 已推', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.files.put({ paperId: 'p1', bytes: new ArrayBuffer(4), mime: 'application/pdf' })
    await db.syncMeta.put({ paperId: 'p1', filePushed: true })
    await db.outbox.add(qItem({ op: 'push-artifacts' }))
    const { calls } = stubFetch(() => okPush(1))
    await createSyncEngine(db).flushOnce()
    expect(calls.every((c) => c.method === 'POST')).toBe(true)

    // 老行：只有 artifactsPushed/filePushed，无 blocksPushed → 不重推 blocks
    await db.blocks.put(blockRow('p1', 0))
    await db.syncMeta.put({ paperId: 'p1', artifactsPushed: true, filePushed: true })
    await db.outbox.add(qItem({ op: 'push-artifacts' }))
    calls.length = 0
    await createSyncEngine(db).flushOnce()
    expect(calls).toHaveLength(1) // 只有 papers 行
    expect(changesOf(calls[0]).map((c) => c.tbl)).toEqual(['papers'])
  })

  it('文件 PUT 500：blocks 仍推、blocksPushed=true、filePushed=false、lastError.step=file、队列项保留、结果 partial', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = freshDb()
    await seedArtifactPaper(db)
    const { calls } = stubFetch((call) => (call.method === 'PUT' ? json({ error: 'internal' }, 500) : okPush(1)))
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('partial')
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'PUT'])
    const meta = await db.syncMeta.get('p1')
    expect(meta).toMatchObject({ blocksPushed: true, filePushed: false, blocksPulled: true, attempts: 1 })
    expect(meta?.artifactsPushed).toBeFalsy()
    expect(meta?.lastError).toMatchObject({ step: 'file', status: 500, code: 'internal' })
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['push-artifacts'])
    expect(errorSpy).toHaveBeenCalledTimes(1)

    // 下一轮：blocks 不再重推，只补 papers 行 + 文件；成功后 lastError 清空
    const { calls: calls2 } = stubFetch((call) => (call.method === 'PUT' ? json({ ok: true, sha256: 'x', byteSize: 4 }) : okPush(1)))
    expect(await engine.flushOnce()).toBe('pushed')
    expect(calls2.map((c) => c.method)).toEqual(['POST', 'PUT'])
    const after = await db.syncMeta.get('p1')
    expect(after).toMatchObject({ artifactsPushed: true, filePushed: true, blocksPushed: true, attempts: 0 })
    expect(after?.lastError).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('文件 PUT 413（配额）= 永久失败：队列项删除、lastError 落盘、filePushed 仍 false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = freshDb()
    await seedArtifactPaper(db)
    stubFetch((call) => (call.method === 'PUT' ? json({ error: 'payload-too-large', message: '超配额' }, 413) : okPush(1)))
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('partial')
    expect(await db.outbox.count()).toBe(0)
    const meta = await db.syncMeta.get('p1')
    expect(meta).toMatchObject({ blocksPushed: true, filePushed: false })
    expect(meta?.artifactsPushed).toBeFalsy()
    expect(meta?.lastError).toMatchObject({ step: 'file', status: 413, message: '超配额' })

    // 手动重试：清 lastError + 重新入队；已推的 blocks 按 flag 跳过
    await engine.retryArtifacts('p1')
    expect((await db.syncMeta.get('p1'))?.lastError).toBeUndefined()
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['push-artifacts'])
    const { calls } = stubFetch((call) => (call.method === 'PUT' ? json({ ok: true, sha256: 'x', byteSize: 4 }) : okPush(1)))
    expect(await engine.flushOnce()).toBe('pushed')
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT'])
    expect(await db.syncMeta.get('p1')).toMatchObject({ artifactsPushed: true, filePushed: true })
  })

  it('两篇制品：前一篇 papers 行瞬时失败不影响后一篇推完（逐篇隔离）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = freshDb()
    await seedArtifactPaper(db, 'p1')
    await seedArtifactPaper(db, 'p2')
    stubFetch((call) => {
      if (call.method === 'PUT') return json({ ok: true, sha256: 'x', byteSize: 4 })
      if (isPapersRowPush(call, 'p1')) return json({ error: 'internal' }, 500)
      return okPush(1)
    })
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('partial')
    expect((await db.outbox.toArray()).map((i) => i.paperId)).toEqual(['p1'])
    expect(await db.syncMeta.get('p2')).toMatchObject({ artifactsPushed: true, blocksPushed: true, filePushed: true })
    expect((await db.syncMeta.get('p1'))?.lastError).toMatchObject({ step: 'papers', status: 500 })
    expect(await db.syncMeta.get('p1')).toMatchObject({ attempts: 1 })
    expect((await db.syncMeta.get('p1'))?.blocksPushed).toBeFalsy()
  })

  it('制品序列里任一处 401 → auth，不吞成 retry', async () => {
    const db = freshDb()
    await seedArtifactPaper(db)
    stubFetch((call) => (call.method === 'PUT' ? json({ error: 'unauthenticated' }, 401) : okPush(1)))
    expect(await createSyncEngine(db).flushOnce()).toBe('auth')
    expect(await db.outbox.count()).toBe(1)
  })

  it('delete-paper：调 DELETE 接口并清队列；DELETE 失败不阻塞其它项', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = freshDb()
    await db.outbox.add(qItem({ op: 'delete-paper', paperId: 'p9' }))
    const { calls } = stubFetch(() => json({ ok: true, cursor: 5 }))
    expect(await createSyncEngine(db).flushOnce()).toBe('pushed')
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', '/api/app/sync/papers/p9']])
    expect(await db.outbox.count()).toBe(0)

    await db.outbox.add(qItem({ op: 'delete-paper', paperId: 'p8' }))
    await db.outbox.add(qItem({ tbl: 'messages', recordId: 'm1', paperId: 'p1', payload: {} }))
    stubFetch((call) => (call.method === 'DELETE' ? json({ error: 'internal' }, 500) : okPush(1)))
    expect(await createSyncEngine(db).flushOnce()).toBe('partial')
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['delete-paper'])
  })
})

describe('可观测性（§1.5）', () => {
  it('5xx → console.error 恰好一次 + lastError/attempts 落到仍存在的论文；getSyncStatus 反映现状', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = freshDb()
    await seedPaper(db)
    await db.outbox.add(qItem({ tbl: 'messages', recordId: 'm1', payload: {} }))
    await db.outbox.add(qItem({ tbl: 'messages', recordId: 'm2', paperId: 'ghost', payload: {} }))
    stubFetch(() => json({ error: 'internal', message: '炸了' }, 500))
    const engine = createSyncEngine(db)

    expect(await engine.flushOnce()).toBe('error')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(await db.syncMeta.get('p1')).toMatchObject({
      attempts: 1,
      lastError: { step: 'records', status: 500, code: 'internal', message: '炸了' },
    })
    expect(await db.syncMeta.get('ghost')).toBeUndefined() // 不存在的论文不写 meta

    const status = await engine.getSyncStatus()
    expect(status).toMatchObject({ leader: false, running: false, pending: 2, failures: 0, lastFlushAt: null, lastSyncAt: null, nextFlushAt: null })
    expect(status.lastError).toMatchObject({ step: 'records', status: 500 })

    // 成功后：records 步的 lastError 清掉、attempts 归零
    stubFetch(() => okPush(2))
    expect(await engine.flushOnce()).toBe('pushed')
    const meta = await db.syncMeta.get('p1')
    expect(meta?.lastError).toBeUndefined()
    expect(meta?.attempts).toBe(0)
  })
})

describe('调度：启动即冲、空闲轮询、跨 tab 唤醒（§1.1）', () => {
  it('预置 outbox 不 kick 直接 start() → urgentDelayMs 内推送', async () => {
    const db = freshDb()
    await db.outbox.add(qItem({ tbl: 'messages', recordId: 'm1', payload: {} }))
    const { calls } = stubFetch(() => okPush(1))
    const engine = testEngine(db)

    engine.start()
    await waitFor(() => calls.length >= 1, 500)
    await waitFor(async () => (await db.outbox.count()) === 0)
    expect(calls[0].url).toBe('/api/app/sync/push')
    const status = await engine.getSyncStatus()
    expect(status).toMatchObject({ leader: true, running: true, pending: 0 })
    expect(status.lastFlushAt).not.toBeNull()
  })

  it('空闲轮询：start() 后直接 outbox.add 不发任何信号 → idlePollMs 后推送', async () => {
    const db = freshDb()
    const { calls } = stubFetch(() => okPush(1))
    const engine = testEngine(db, { idlePollMs: 30 })
    engine.start()
    await sleep(40) // 首轮 idle 已过，引擎已进入空闲睡眠
    expect(calls).toHaveLength(0)

    await db.outbox.add(qItem({ tbl: 'messages', recordId: 'm1', payload: {} }))
    await waitFor(() => calls.length >= 1, 500)
    await waitFor(async () => (await db.outbox.count()) === 0)
  })

  it('跨 tab：另一 tab 的 enqueued 广播 → 本 tab 引擎 flush；无 payload 的合成项不进 keepalive 缓存', async () => {
    const db = freshDb()
    const paper = await seedPaper(db)
    await db.syncMeta.put({ paperId: 'p1', artifactsPushed: true, blocksPushed: true, filePushed: true })
    await db.syncState.put({ key: 'lastReconcileAt', value: Date.now() }) // 压住领导权对账，聚焦唤醒本身
    const { calls } = stubFetch(() => okPush(1))
    const engine = testEngine(db, { idlePollMs: 10_000 }) // 轮询远大于断言窗口：推送只能来自跨 tab 唤醒
    // bootstrap 在 node 下不跑：手工接上「入队信号 → kick」这根线（bootstrapSyncEngine 里同一句）
    const off = outboxSignal.on((dbName, item) => {
      if (dbName === db.name) engine.kick(item)
    })
    try {
      engine.start()
      await sleep(30)
      expect(calls).toHaveLength(0)

      // 另一 tab 写了 progress 并广播（消息不带 payload）
      await db.outbox.add(qItem({ op: 'progress', payload: { ...paper, progress: { blockIndex: 3, ratio: 0.3, updatedAt: 3 } } }))
      otherTab().postMessage({ kind: 'enqueued', dbName: db.name, op: 'record', paperId: 'p1' })
      await waitFor(() => calls.length >= 1, 500)
      expect(changesOf(calls[0])[0]).toMatchObject({ tbl: 'papers', id: 'p1' })
      await waitFor(async () => (await db.outbox.count()) === 0)

      // 合成项无 payload → progressCache 空 → keepalive 什么都不发
      calls.length = 0
      engine.flushProgressKeepalive()
      await sleep(10)
      expect(calls).toHaveLength(0)

      // 别的库名的消息不触发
      otherTab().postMessage({ kind: 'enqueued', dbName: 'someone-else', op: 'record', paperId: 'p1' })
      await sleep(40)
      expect(calls).toHaveLength(0)
    } finally {
      off()
    }
  })

  it('keepalive 闸：制品未推完的 progress 不进缓存；推完的才进；超过 progressDelayMs*4 的旧条目清掉', async () => {
    const db = freshDb()
    const paper = await seedPaper(db)
    let clock = 100_000
    const { calls } = stubFetch(() => okPush(1))
    const engine = testEngine(db, { progressDelayMs: 100, now: () => clock })
    const progressItem = (): OutboxItem => qItem({ op: 'progress', payload: paper })

    await db.syncMeta.put({ paperId: 'p1', artifactsPushed: false, blocksPushed: false, filePushed: false })
    engine.kick(progressItem())
    await sleep(10)
    engine.flushProgressKeepalive()
    expect(calls).toHaveLength(0)

    await db.syncMeta.put({ paperId: 'p1', artifactsPushed: false, blocksPushed: true, filePushed: false })
    engine.kick(progressItem())
    await sleep(10)
    engine.flushProgressKeepalive()
    await sleep(5)
    expect(calls).toHaveLength(1)
    expect(calls[0].keepalive).toBe(true)
    expect(changesOf(calls[0])[0]).toMatchObject({ tbl: 'papers', id: 'p1' })

    // 时间推过 4×progressDelayMs：条目过期，不再重推
    clock += 401
    engine.flushProgressKeepalive()
    await sleep(5)
    expect(calls).toHaveLength(1)
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
    stubFetch((call, i) => (isSummary(call) ? json({ error: 'not-found' }, 404) : json(pages[i])))
    await createSyncEngine(db).pullSince()

    const merged = (await db.papers.get('p1'))!
    expect(merged.updatedAt).toBe(2000)
    expect(merged.progress.maxBlockIndex).toBe(90) // 本地读得更深，不回退
    expect(merged.progress.blockIndex).toBe(10) // 当前位置跟 LWW 胜者（远端）
    expect(await db.messages.get('m1')).toMatchObject({ content: 'hi' })
    expect((await db.syncState.get('cursor'))?.value).toBe(2)
    expect((await db.syncState.get('lastSyncAt'))?.value).toBeTypeOf('number')
  })

  it('本地 outbox 有同记录 pending → 本地胜；papers 墓碑 → 本地级联删除', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.sessions.put({ id: 's1', paperId: 'p1', title: '本地新', createdAt: 1, updatedAt: 9000 })
    await db.outbox.add(qItem({ tbl: 'sessions', recordId: 's1', payload: { title: '本地新' } }))
    await seedPaper(db, { id: 'p2', sha256: 'b'.repeat(64) })

    stubFetch((call) =>
      isSummary(call)
        ? json({ papers: [], files: [], cursor: 0 })
        : json({
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

  it('首次从远端见到论文：推送侧三步齐（制品在服务端），blocksPulled=false 等补拉', async () => {
    const db = freshDb()
    const remote = { ...(await seedPaper(freshDb())), id: 'pr', blockCount: 3 }
    stubFetch(() =>
      json({
        changes: [{ tbl: 'papers', id: 'pr', paperId: 'pr', deleted: false, payload: remote, seq: 1, updatedAt: 1 }],
        nextSince: 1,
        hasMore: false,
      }),
    )
    await createSyncEngine(db).pullPaper('pr')
    expect(await db.syncMeta.get('pr')).toMatchObject({
      artifactsPushed: true,
      filePushed: true,
      blocksPushed: true,
      blocksPulled: false,
      pulledBlockCount: 0,
    })
  })

  it('translations / highlights 远端行落地（LWW：translations 按 updatedAt，highlights 按 createdAt）', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.translations.put({ id: 't1', paperId: 'p1', blockIndex: 0, blockId: 'p1:0', targetLang: 'zh', promptVersion: 'v1', model: 'm', srcHash: 'h', text: '本地新', createdAt: 1, updatedAt: 500 })
    stubFetch((call) =>
      isSummary(call)
        ? json({ error: 'not-found' }, 404)
        : json({
            changes: [
              { tbl: 'translations', id: 't1', paperId: 'p1', deleted: false, payload: { id: 't1', paperId: 'p1', blockIndex: 0, text: '远端旧', updatedAt: 100 }, seq: 1, updatedAt: 100 },
              { tbl: 'translations', id: 't2', paperId: 'p1', deleted: false, payload: { id: 't2', paperId: 'p1', blockIndex: 1, text: '远端', updatedAt: 100 }, seq: 2, updatedAt: 100 },
              { tbl: 'highlights', id: 'h1', paperId: 'p1', deleted: false, payload: { id: 'h1', paperId: 'p1', blockIndex: 0, blockId: 'p1:0', lang: 'orig', start: 0, end: 2, text: 'ab', createdAt: 5 }, seq: 3, updatedAt: 5 },
              { tbl: 'highlights', id: 'h1', paperId: 'p1', deleted: true, payload: null, seq: 4, updatedAt: 6 },
            ],
            nextSince: 4,
            hasMore: false,
          }),
    )
    await createSyncEngine(db).pullSince()
    expect((await db.translations.get('t1'))?.text).toBe('本地新') // 本地 updatedAt 更新 → 远端不覆盖
    expect((await db.translations.get('t2'))?.text).toBe('远端')
    expect(await db.highlights.get('h1')).toBeUndefined() // 墓碑落地
  })

  it('远端 papers 行换了 sha/mime（另一台设备原地重导入）：本地旧文件/块/chunks 作废、syncMeta 重置；同 sha 行不动', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = freshDb()
    const local = await seedPaper(db, { blockCount: 2, updatedAt: 1000 })
    await db.files.put({ paperId: 'p1', bytes: new ArrayBuffer(4), mime: 'application/pdf' })
    await db.blocks.bulkPut([blockRow('p1', 0), blockRow('p1', 1)])
    await db.chunks.put({ id: 'c0', paperId: 'p1', order: 0, text: 'b0 b1', anchor: { kind: 'pdf', blockIndex: 0 }, blockStart: 0, blockEnd: 1 })
    await db.syncMeta.put({
      paperId: 'p1',
      artifactsPushed: true,
      blocksPushed: true,
      filePushed: true,
      blocksPulled: true,
      pulledBlockCount: 2,
      attempts: 2,
      lastError: { step: 'file', code: 'payload-too-large', message: '旧字节超配额', status: 413, at: 1 },
    })
    const remote = { ...local, sha256: 'n'.repeat(64), mime: 'application/x-paper-web-snapshot', format: 'html' as const, blockCount: 1, updatedAt: 2000 }
    const newBlock = { ...blockRow('p1', 0), text: '新正文' }
    stubFetch((call) =>
      isSummary(call)
        ? json({ error: 'not-found' }, 404)
        : json({
            changes: [
              { tbl: 'papers', id: 'p1', paperId: 'p1', deleted: false, payload: remote, seq: 1, updatedAt: 2000 },
              { tbl: 'blocks', id: 'p1:0', paperId: 'p1', deleted: false, payload: newBlock, seq: 2, updatedAt: 2000 },
            ],
            nextSince: 2,
            hasMore: false,
          }),
    )
    const engine = createSyncEngine(db)
    await engine.pullSince()

    expect((await db.papers.get('p1'))?.sha256).toBe('n'.repeat(64))
    expect(await db.files.get('p1')).toBeUndefined() // 工作台按本地 miss 懒拉新文件
    expect((await db.blocks.where('paperId').equals('p1').toArray()).map((b) => b.text)).toEqual(['新正文'])
    expect(await db.chunks.where('paperId').equals('p1').count()).toBe(0)
    // 制品在服务端；lastError（旧字节的 413）清掉；pulledBlockCount 由落地的新块重新计数
    expect(await db.syncMeta.get('p1')).toEqual({
      paperId: 'p1',
      artifactsPushed: true,
      blocksPushed: true,
      filePushed: true,
      blocksPulled: true,
      pulledBlockCount: 1,
      attempts: 0,
    })
    // 对账不会把（已删的）旧块当权威重推回服务端
    stubFetch(() => json({ papers: [{ paperId: 'p1', blocks: 1 }], files: [{ paperId: 'p1', sha256: 'n'.repeat(64), byteSize: 4 }], cursor: 2 }))
    expect(await engine.reconcile()).toEqual({ enqueued: [] })

    // 同 sha 的 progress 更新：文件/块原地不动
    await db.files.put({ paperId: 'p1', bytes: new ArrayBuffer(9), mime: 'application/x-paper-web-snapshot' })
    const remote2 = { ...remote, updatedAt: 3000, progress: { blockIndex: 0, ratio: 0.5, updatedAt: 3000 } }
    stubFetch((call) =>
      isSummary(call)
        ? json({ error: 'not-found' }, 404)
        : json({ changes: [{ tbl: 'papers', id: 'p1', paperId: 'p1', deleted: false, payload: remote2, seq: 3, updatedAt: 3000 }], nextSince: 3, hasMore: false }),
    )
    await engine.pullSince()
    expect((await db.files.get('p1'))?.bytes.byteLength).toBe(9)
    expect(await db.blocks.where('paperId').equals('p1').count()).toBe(1)
    expect((await db.syncMeta.get('p1'))?.blocksPulled).toBe(true)
  })

  it('pullSince 落地 blocks 行后按本地块数刷新 syncMeta（列表徽标不用等打开工作台）；本地没有 papers 行的论文不写 syncMeta', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = freshDb()
    await seedPaper(db, { blockCount: 2 })
    // 之前 pullPaper 拉到 0 块：列表页据此显示「正文未同步」
    await db.syncMeta.put({ paperId: 'p1', artifactsPushed: true, blocksPushed: true, filePushed: true, blocksPulled: false, pulledBlockCount: 0 })
    const row = (paperId: string, index: number, seq: number) => ({
      tbl: 'blocks',
      id: `${paperId}:${index}`,
      paperId,
      deleted: false,
      payload: blockRow(paperId, index),
      seq,
      updatedAt: 1,
    })
    stubFetch((call) =>
      isSummary(call)
        ? json({ error: 'not-found' }, 404)
        : json({ changes: [row('p1', 0, 1), row('p1', 1, 2), row('px', 0, 3)], nextSince: 3, hasMore: false }),
    )
    await createSyncEngine(db).pullSince()

    expect(await db.syncMeta.get('p1')).toMatchObject({ pulledBlockCount: 2, blocksPulled: true, artifactsPushed: true })
    expect(await db.blocks.get('px:0')).toBeDefined() // 行照常落地……
    expect(await db.syncMeta.get('px')).toBeUndefined() // ……但没见过 papers 行的论文不凭空造 syncMeta
  })

  it('pullPaper 用 paperId 过滤参数、不动全局游标；拉到 0 块不置 blocksPulled（空心不锁死）', async () => {
    const db = freshDb()
    await seedPaper(db, { blockCount: 2 })
    await db.syncState.put({ key: 'cursor', value: 42 })
    const { calls } = stubFetch(() => json({ changes: [], nextSince: 0, hasMore: false }))
    const engine = createSyncEngine(db)
    const raw = createPaperRepository(db)
    void raw
    await engine.pullPaper('p1')

    expect(calls[0].url).toContain('paperId=p1')
    expect((await db.syncState.get('cursor'))?.value).toBe(42) // 全局游标不动
    expect(await db.syncMeta.get('p1')).toMatchObject({ blocksPulled: false, pulledBlockCount: 0 })

    // 块到齐（≥ blockCount）才置 blocksPulled
    stubFetch(() =>
      json({
        changes: [0, 1].map((i) => ({ tbl: 'blocks', id: `p1:${i}`, paperId: 'p1', deleted: false, payload: blockRow('p1', i), seq: i + 1, updatedAt: 1 })),
        nextSince: 2,
        hasMore: false,
      }),
    )
    await engine.pullPaper('p1')
    expect(await db.syncMeta.get('p1')).toMatchObject({ blocksPulled: true, pulledBlockCount: 2 })
  })

  it('pullPaper：只到一半的 blocks（< blockCount）不置 blocksPulled；papers 行无 blockCount 时有块即算齐', async () => {
    const db = freshDb()
    await seedPaper(db, { blockCount: 5 })
    await seedPaper(db, { id: 'p2', sha256: 'b'.repeat(64), blockCount: undefined })
    stubFetch((call) => {
      const pid = call.url.includes('paperId=p2') ? 'p2' : 'p1'
      return json({
        changes: [{ tbl: 'blocks', id: `${pid}:0`, paperId: pid, deleted: false, payload: blockRow(pid, 0), seq: 1, updatedAt: 1 }],
        nextSince: 1,
        hasMore: false,
      })
    })
    const engine = createSyncEngine(db)
    await engine.pullPaper('p1')
    await engine.pullPaper('p2')
    expect(await db.syncMeta.get('p1')).toMatchObject({ blocksPulled: false, pulledBlockCount: 1 })
    expect(await db.syncMeta.get('p2')).toMatchObject({ blocksPulled: true, pulledBlockCount: 1 })
  })
})

describe('reconcile 对账（§1.3）', () => {
  const summary = (papers: { paperId: string; blocks: number }[], files: { paperId: string; sha256: string; byteSize: number }[]) =>
    json({ papers, files, cursor: 9 })

  it('服务端缺 blocks → 只把 blocksPushed 置 false + 入队 push-artifacts；文件 sha 齐则 filePushed 不动', async () => {
    const db = freshDb()
    const paper = await seedPaper(db)
    await db.blocks.bulkPut([blockRow('p1', 0), blockRow('p1', 1)])
    await db.files.put({ paperId: 'p1', bytes: new ArrayBuffer(4), mime: 'application/pdf' })
    await db.syncMeta.put({ paperId: 'p1', artifactsPushed: true, filePushed: true }) // 老行：无 blocksPushed
    const { calls } = stubFetch(() => summary([{ paperId: 'p1', blocks: 0 }], [{ paperId: 'p1', sha256: paper.sha256, byteSize: 4 }]))
    const engine = createSyncEngine(db)

    expect(await engine.reconcile()).toEqual({ enqueued: ['p1'] })
    expect(calls.map((c) => c.url)).toEqual(['/api/app/sync/summary'])
    expect(await db.syncMeta.get('p1')).toMatchObject({ artifactsPushed: false, blocksPushed: false, filePushed: true })
    expect((await db.outbox.toArray()).map((i) => [i.op, i.paperId])).toEqual([['push-artifacts', 'p1']])
    expect((await engine.getSyncStatus()).nextFlushAt).not.toBeNull() // 已 kick
  })

  it('服务端文件 sha 不符/缺失 → 只把 filePushed 置 false；老行的 blocksPushed 物化为 true 不重推 blocks', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.blocks.bulkPut([blockRow('p1', 0)])
    await db.files.put({ paperId: 'p1', bytes: new ArrayBuffer(4), mime: 'application/pdf' })
    await db.syncMeta.put({ paperId: 'p1', artifactsPushed: true, filePushed: true })
    stubFetch(() => summary([{ paperId: 'p1', blocks: 1 }], []))
    expect(await createSyncEngine(db).reconcile()).toEqual({ enqueued: ['p1'] })
    expect(await db.syncMeta.get('p1')).toMatchObject({ artifactsPushed: false, blocksPushed: true, filePushed: false })
  })

  it('齐全不入队；无本地文件且 blocks 数相等也不入队；非 ready 论文不参与', async () => {
    const db = freshDb()
    const paper = await seedPaper(db)
    await db.blocks.bulkPut([blockRow('p1', 0), blockRow('p1', 1)])
    await db.files.put({ paperId: 'p1', bytes: new ArrayBuffer(4), mime: 'application/pdf' })
    await seedPaper(db, { id: 'p2', sha256: 'b'.repeat(64) }) // 无文件、无块
    await seedPaper(db, { id: 'p3', sha256: 'c'.repeat(64), status: 'parsing' })
    await db.blocks.put(blockRow('p3', 0))
    stubFetch(() => summary([{ paperId: 'p1', blocks: 3 }], [{ paperId: 'p1', sha256: paper.sha256, byteSize: 4 }]))
    expect(await createSyncEngine(db).reconcile()).toEqual({ enqueued: [] })
    expect(await db.outbox.count()).toBe(0)
  })

  it('已有待决 push-artifacts / delete-paper 的论文不参与；全都待决时连 summary 都不请求', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.blocks.put(blockRow('p1', 0))
    await db.outbox.add(qItem({ op: 'push-artifacts' }))
    const { calls } = stubFetch(() => summary([], []))
    expect(await createSyncEngine(db).reconcile()).toEqual({ enqueued: [] })
    expect(calls).toHaveLength(0)
    expect(await db.outbox.count()).toBe(1)
  })

  it('永久性文件失败（lastError.step=file，413）的论文不参与对账重推——只有手动 retryArtifacts 才清；瞬时失败（500）照常重推', async () => {
    const db = freshDb()
    const fileErr = (status: number) => ({ step: 'file' as const, code: 'x', message: 'x', status, at: 1 })
    for (const [id, status] of [['p1', 413], ['p2', 500]] as const) {
      await seedPaper(db, { id, sha256: id.padEnd(64, 'a') })
      await db.blocks.put(blockRow(id, 0))
      await db.files.put({ paperId: id, bytes: new ArrayBuffer(4), mime: 'application/pdf' })
      await db.syncMeta.put({ paperId: id, blocksPushed: true, filePushed: false, artifactsPushed: false, blocksPulled: true, attempts: 1, lastError: fileErr(status) })
    }
    stubFetch(() => summary([{ paperId: 'p1', blocks: 1 }, { paperId: 'p2', blocks: 1 }], []))
    const engine = createSyncEngine(db)

    expect(await engine.reconcile()).toEqual({ enqueued: ['p2'] })
    expect((await db.syncMeta.get('p1'))?.lastError).toMatchObject({ step: 'file', status: 413 }) // 对账没动它

    // 手动重试清掉 lastError 后，下一轮对账才重新把它当候选
    await engine.retryArtifacts('p1')
    await db.outbox.clear()
    expect(await engine.reconcile()).toEqual({ enqueued: ['p1', 'p2'] })
  })

  it('maybeReconcile 节流：reconcileIntervalMs 内不请求；过期后请求并刷新 lastReconcileAt', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.blocks.put(blockRow('p1', 0))
    let clock = 1_000_000
    const { calls } = stubFetch(() => summary([{ paperId: 'p1', blocks: 1 }], []))
    const engine = createSyncEngine(db, { reconcileIntervalMs: 1000, now: () => clock })

    await db.syncState.put({ key: 'lastReconcileAt', value: clock - 500 })
    await engine.maybeReconcile()
    expect(calls).toHaveLength(0)

    clock += 600
    await engine.maybeReconcile()
    expect(calls).toHaveLength(1)
    expect((await db.syncState.get('lastReconcileAt'))?.value).toBe(clock)
    await engine.maybeReconcile()
    expect(calls).toHaveLength(1)
  })

  it('旧服务端 404 → console.warn 一次、跳过；非 404 错误由 maybeReconcile 吞掉、reconcile 抛出', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = freshDb()
    await seedPaper(db)
    await db.blocks.put(blockRow('p1', 0))
    stubFetch(() => json({ error: 'not-found' }, 404))
    const engine = createSyncEngine(db, { reconcileIntervalMs: 0 })
    expect(await engine.reconcile()).toEqual({ enqueued: [] })
    expect(await engine.reconcile()).toEqual({ enqueued: [] })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(await db.outbox.count()).toBe(0)

    stubFetch(() => json({ error: 'internal' }, 500))
    await expect(engine.reconcile()).rejects.toThrow()
    await expect(engine.maybeReconcile()).resolves.toBeUndefined()
  })

  it('pullSince 成功后顺带节流对账；start() 拿到领导权后也对账一次', async () => {
    const db = freshDb()
    await seedPaper(db)
    await db.blocks.put(blockRow('p1', 0))
    const { calls } = stubFetch((call) =>
      isSummary(call) ? summary([{ paperId: 'p1', blocks: 0 }], []) : call.method === 'POST' ? okPush(1) : json({ changes: [], nextSince: 0, hasMore: false }),
    )
    const engine = testEngine(db, { reconcileIntervalMs: 60_000 })
    await engine.pullSince()
    expect(calls.map((c) => c.url)).toEqual(['/api/app/sync/changes?since=0&limit=1000', '/api/app/sync/summary'])
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['push-artifacts'])

    // 节流内：start() 的对账不再请求；但 kick 会把刚入队的 push-artifacts 推掉
    calls.length = 0
    engine.start()
    await waitFor(async () => (await db.outbox.count()) === 0)
    expect(calls.some(isSummary)).toBe(false)

    // 节流过期后重新 start()：领导权对账触发
    engine.stop()
    await db.syncState.put({ key: 'lastReconcileAt', value: 0 })
    calls.length = 0
    const engine2 = testEngine(db, { reconcileIntervalMs: 60_000 })
    engine2.start()
    await waitFor(() => calls.some(isSummary), 500)
  })
})

describe('claimGuestPapers 认领', () => {
  afterEach(() => {
    claimMocks.guest = null
    claimMocks.account = null
    claimMocks.authed = false
  })

  it('游客库的译文/高亮随论文复制进账号库并逐行入队（SYNC_TABLES 里的直传表一个不落）', async () => {
    const guest = freshDb()
    const account = freshDb()
    claimMocks.guest = guest
    claimMocks.account = account
    claimMocks.authed = true
    await seedPaper(guest)
    await guest.blocks.put(blockRow('p1', 0))
    await guest.translations.put({ id: 't0', paperId: 'p1', blockIndex: 0, blockId: 'p1:0', targetLang: 'zh', promptVersion: 'v1', model: 'm', srcHash: 'h', text: '译0', createdAt: 1, updatedAt: 2 })
    await guest.highlights.put({ id: 'h0', paperId: 'p1', blockIndex: 0, blockId: 'p1:0', lang: 'orig', start: 0, end: 2, text: 'b0', createdAt: 3 })

    expect(await claimGuestPapers()).toEqual({ claimed: 1, merged: 0 })

    expect(await account.papers.get('p1')).toBeDefined()
    expect(await account.translations.get('t0')).toMatchObject({ text: '译0' })
    expect(await account.highlights.get('h0')).toMatchObject({ text: 'b0' })
    expect((await account.outbox.toArray()).map((i) => [i.op, i.tbl, i.recordId])).toEqual([
      ['push-artifacts', undefined, undefined],
      ['record', 'translations', 't0'],
      ['record', 'highlights', 'h0'],
    ])
    // 游客库只读不动
    expect(await guest.translations.count()).toBe(1)
    expect(await guest.highlights.count()).toBe(1)
  })
})

describe('backoffMs', () => {
  it('指数退避 1s→60s 封顶', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ])
  })
})
