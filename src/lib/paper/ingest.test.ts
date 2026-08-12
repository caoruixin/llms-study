import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import {
  INITIAL_INGEST_STATE,
  IngestError,
  createSerialQueue,
  importPaper,
  ingestReducer,
  isRetryable,
  reingestPaper,
  type IngestDeps,
  type IngestState,
  type ParseResult,
} from './ingest'
import { sha256Hex } from './validate'
import { PaperDb } from './repo/db'
import { createPaperRepository } from './repo/paperRepo'
import type { IngestFailureKind, NormalizedBlock } from './types'

// --------------------------------------------------------------------------
// 状态机
// --------------------------------------------------------------------------

const S = (stage: IngestState['stage'], attempts = 0): IngestState => ({ stage, attempts })

describe('ingestReducer', () => {
  it('走完一条完整的成功链路 queued → ready', () => {
    let s = INITIAL_INGEST_STATE
    s = ingestReducer(s, { type: 'validate:start' })
    expect(s.stage).toBe('validating')
    s = ingestReducer(s, { type: 'validate:ok' })
    expect(s.stage).toBe('parsing')
    s = ingestReducer(s, { type: 'parse:ok' })
    expect(s.stage).toBe('normalizing')
    s = ingestReducer(s, { type: 'normalize:ok' })
    expect(s.stage).toBe('indexing')
    s = ingestReducer(s, { type: 'index:ok' })
    expect(s.stage).toBe('ready')
  })

  it('parse:start 是重试路径的入口：queued 可直接进 parsing（跳过重复校验）', () => {
    expect(ingestReducer(S('queued'), { type: 'parse:start' }).stage).toBe('parsing')
    expect(ingestReducer(S('validating'), { type: 'parse:start' }).stage).toBe('parsing')
  })

  it('非法迁移原样返回，不抛错', () => {
    expect(ingestReducer(S('queued'), { type: 'parse:ok' })).toEqual(S('queued'))
    expect(ingestReducer(S('ready'), { type: 'validate:start' })).toEqual(S('ready'))
    expect(ingestReducer(S('indexing'), { type: 'validate:ok' })).toEqual(S('indexing'))
  })

  it('fail 事件把任意中间态推到 failed 并记录分类', () => {
    const s = ingestReducer(S('parsing'), { type: 'fail', kind: 'corrupt', message: '坏了', at: 42 })
    expect(s.stage).toBe('failed')
    expect(s.failure).toEqual({ kind: 'corrupt', message: '坏了', at: 42 })
  })

  it('已 ready 的论文不会被迟到的 fail 事件推翻', () => {
    expect(ingestReducer(S('ready'), { type: 'fail', kind: 'unknown', message: 'x', at: 1 })).toEqual(S('ready'))
  })

  it('retry 只在 failed 生效，且累加 attempts、清空 failure', () => {
    const failed = ingestReducer(S('parsing', 1), { type: 'fail', kind: 'storage', message: 'x', at: 1 })
    const retried = ingestReducer(failed, { type: 'retry', at: 2 })
    expect(retried).toEqual({ stage: 'queued', attempts: 2 })
    expect(ingestReducer(S('parsing'), { type: 'retry', at: 2 })).toEqual(S('parsing'))
  })

  it('enqueue 把失败态重新放回队列并清掉旧失败信息', () => {
    const failed = ingestReducer(S('parsing', 3), { type: 'fail', kind: 'storage', message: 'x', at: 1 })
    expect(ingestReducer(failed, { type: 'enqueue' })).toEqual({ stage: 'queued', attempts: 3 })
  })
})

describe('isRetryable', () => {
  it('外因失败（storage / unknown）可重试', () => {
    expect(isRetryable('storage')).toBe(true)
    expect(isRetryable('unknown')).toBe(true)
  })

  it('确定性拒绝一律不可重试', () => {
    const deterministic: IngestFailureKind[] = [
      'unsupported-format', 'too-large', 'empty', 'corrupt',
      'encrypted', 'no-text-layer', 'too-many-pages', 'too-much-text',
    ]
    for (const k of deterministic) expect(isRetryable(k)).toBe(false)
  })
})

// --------------------------------------------------------------------------
// 串行队列
// --------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('createSerialQueue', () => {
  it('FIFO 顺序执行', async () => {
    const q = createSerialQueue()
    const order: string[] = []
    const all = ['a', 'b', 'c'].map((id) =>
      q.enqueue(id, async () => {
        await delay(1)
        order.push(id)
      }),
    )
    await Promise.all(all)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('并发恒为 1（峰值计数器断言）', async () => {
    const q = createSerialQueue()
    let active = 0
    let peak = 0
    const all = Array.from({ length: 5 }, (_, i) =>
      q.enqueue(`t${i}`, async () => {
        active++
        peak = Math.max(peak, active)
        await delay(2)
        active--
      }),
    )
    await Promise.all(all)
    expect(peak).toBe(1)
  })

  it('单个任务失败不阻塞后续任务', async () => {
    const q = createSerialQueue()
    const done: string[] = []
    const bad = q.enqueue('bad', async () => {
      throw new Error('boom')
    })
    const good = q.enqueue('good', async () => {
      done.push('good')
    })
    await expect(bad).rejects.toThrow('boom')
    await good
    expect(done).toEqual(['good'])
  })

  it('size 统计未完成任务、activeId 报告正在执行的任务', async () => {
    const q = createSerialQueue()
    expect(q.size()).toBe(0)
    expect(q.activeId()).toBeNull()
    const a = q.enqueue('a', async () => {
      await delay(3)
    })
    const b = q.enqueue('b', async () => {})
    // a 在 enqueue 时同步启动并停在 await 上，b 仍在排队 → size = 运行中 1 + 排队 1
    expect(q.activeId()).toBe('a')
    expect(q.size()).toBe(2)
    await Promise.all([a, b])
    expect(q.size()).toBe(0)
    expect(q.activeId()).toBeNull()
  })

  it('cancel 排队中的任务：直接出队，run 从不执行', async () => {
    const q = createSerialQueue()
    let ranB = false
    const a = q.enqueue('a', async () => {
      await delay(5)
    })
    const b = q.enqueue('b', async () => {
      ranB = true
    })
    q.cancel('b')
    await Promise.all([a, b])
    expect(ranB).toBe(false)
  })

  it('cancel 运行中的任务：abort 其 signal', async () => {
    const q = createSerialQueue()
    let aborted = false
    const a = q.enqueue('a', async (signal) => {
      await delay(5)
      aborted = signal.aborted
    })
    await delay(1)
    q.cancel('a')
    await a
    expect(aborted).toBe(true)
  })

  it('cancelAll 清空队列并 abort 运行中任务', async () => {
    const q = createSerialQueue()
    const ran: string[] = []
    const a = q.enqueue('a', async () => {
      await delay(3)
      ran.push('a')
    })
    const b = q.enqueue('b', async () => {
      ran.push('b')
    })
    await delay(1)
    q.cancelAll()
    await Promise.all([a, b])
    expect(ran).toEqual(['a'])
    expect(q.size()).toBe(0)
  })
})

// --------------------------------------------------------------------------
// 全链路编排（假 parse + fake-indexeddb 仓储）
// --------------------------------------------------------------------------

function freshRepo() {
  const db = new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
  return createPaperRepository(db)
}

const pdfBytes = (payload = 'hello'): ArrayBuffer =>
  new TextEncoder().encode(`%PDF-1.7\n${payload}`).buffer as ArrayBuffer

const block = (index: number, text: string): NormalizedBlock => ({
  index,
  kind: 'paragraph',
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})

const fakeParse = async (): Promise<ParseResult> => ({
  blocks: [block(0, '第一段'), block(1, '第二段')],
  pageCount: 2,
  title: '解析出的标题',
})

function depsWith(repo: ReturnType<typeof freshRepo>, parse: IngestDeps['parse'] = fakeParse): IngestDeps {
  return { repo, hash: sha256Hex, parse }
}

describe('importPaper', () => {
  it('成功路径：落库 + 落块 + status ready + 采用解析出的标题与页数', async () => {
    const repo = freshRepo()
    const out = await importPaper({ name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() }, depsWith(repo))

    expect(out.kind).toBe('ready')
    const list = await repo.listPapers()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ status: 'ready', title: '解析出的标题', pageCount: 2, blockCount: 2, charCount: 6 })

    const blocks = await repo.getBlocks(list[0].id)
    expect(blocks.map((b) => b.text)).toEqual(['第一段', '第二段'])
  })

  it('索引阶段落地：ready 后 chunks 表有内容且带 BM25 词频表', async () => {
    const repo = freshRepo()
    const out = await importPaper({ name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() }, depsWith(repo))
    const paperId = out.kind === 'ready' ? out.paper.id : ''

    const chunks = await repo.getChunks(paperId)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ paperId, order: 0, blockStart: 0, blockEnd: 1 })
    expect(chunks[0].text).toContain('第一段')
    expect(chunks[0].len).toBeGreaterThan(0)
    expect(Object.keys(chunks[0].tf ?? {}).length).toBeGreaterThan(0)
  })

  it('校验不通过的文件根本不写库（不留下永远打不开的记录）', async () => {
    const repo = freshRepo()
    const out = await importPaper(
      { name: 'old.doc', size: 20, type: 'application/msword', bytes: pdfBytes() },
      depsWith(repo),
    )
    expect(out).toMatchObject({ kind: 'failed', failure: { kind: 'unsupported-format' } })
    expect(await repo.listPapers()).toHaveLength(0)
  })

  it('SHA-256 命中已有论文 → duplicate 早退，不产生第二条记录', async () => {
    const repo = freshRepo()
    const file = { name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() }
    await importPaper(file, depsWith(repo))
    const again = await importPaper({ ...file, name: 'copy.pdf', bytes: pdfBytes() }, depsWith(repo))

    expect(again.kind).toBe('duplicate')
    expect(await repo.listPapers()).toHaveLength(1)
  })

  it('解析抛 IngestError：论文落 failed 并带分类，不留可读的空论文', async () => {
    const repo = freshRepo()
    const out = await importPaper(
      { name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() },
      depsWith(repo, async () => {
        throw new IngestError('encrypted', 'PDF 已加密')
      }),
    )

    expect(out).toMatchObject({ kind: 'failed', failure: { kind: 'encrypted' } })
    const list = await repo.listPapers()
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('failed')
    expect(list[0].failure?.message).toBe('PDF 已加密')
    expect(await repo.getBlocks(list[0].id)).toHaveLength(0)
  })

  it('解析抛普通 Error → 归类为可重试的 unknown', async () => {
    const repo = freshRepo()
    const out = await importPaper(
      { name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() },
      depsWith(repo, async () => {
        throw new Error('网络抖了一下')
      }),
    )
    expect(out).toMatchObject({ kind: 'failed', failure: { kind: 'unknown', message: '网络抖了一下' } })
    expect(isRetryable('unknown')).toBe(true)
  })

  it('解析结果为空 → no-text-layer（扫描件），不产生可读空论文', async () => {
    const repo = freshRepo()
    const out = await importPaper(
      { name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() },
      depsWith(repo, async () => ({ blocks: [] })),
    )
    expect(out).toMatchObject({ kind: 'failed', failure: { kind: 'no-text-layer' } })
    expect((await repo.listPapers())[0].status).toBe('failed')
  })

  it('onState 回调按顺序汇报阶段迁移', async () => {
    const repo = freshRepo()
    const stages: string[] = []
    await importPaper(
      { name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() },
      { ...depsWith(repo), onState: (s) => stages.push(s.stage) },
    )
    expect(stages).toEqual(['validating', 'parsing', 'normalizing', 'indexing', 'ready'])
  })
})

describe('reingestPaper', () => {
  it('从 files 表取回字节重跑解析，成功后回到 ready 且 attempts 累加', async () => {
    const repo = freshRepo()
    const failing = await importPaper(
      { name: 'a.pdf', size: 20, type: 'application/pdf', bytes: pdfBytes() },
      depsWith(repo, async () => {
        throw new IngestError('storage', '磁盘满了')
      }),
    )
    const paperId = failing.kind === 'failed' ? failing.paper!.id : ''
    expect((await repo.getPaper(paperId))?.status).toBe('failed')

    const retried = await reingestPaper(paperId, depsWith(repo))
    expect(retried.kind).toBe('ready')
    const after = await repo.getPaper(paperId)
    expect(after?.status).toBe('ready')
    expect(after?.failure).toBeUndefined()
    expect(await repo.getBlocks(paperId)).toHaveLength(2)
    // 重试同样重建索引：不会留下与新正文对不上的旧 chunk
    expect(await repo.getChunks(paperId)).toHaveLength(1)
  })

  it('论文已被删除 → 返回 failed 而不是抛错', async () => {
    const repo = freshRepo()
    const out = await reingestPaper('not-exist', depsWith(repo))
    expect(out).toMatchObject({ kind: 'failed', failure: { kind: 'unknown' } })
  })
})
