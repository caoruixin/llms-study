import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb } from './db'
import { createPaperRepository, type NewPaperInput } from './paperRepo'
import {
  createSyncedCopilotRepository,
  createSyncedHighlightRepository,
  createSyncedLearnerRepository,
  createSyncedPaperRepository,
  createSyncedTranslationRepository,
} from './syncedRepos'
import { emptyProfile } from '../learnerProfile'
import type { BlockTranslation, NormalizedBlock, PaperHighlight } from '../types'

/** 每个用例一套全新的 IDBFactory + 唯一库名：测例之间零串扰 */
function freshDb(): PaperDb {
  return new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
}

const bytesOf = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

const input = (overrides: Partial<NewPaperInput> = {}): NewPaperInput => ({
  title: '论文标题',
  fileName: 'paper.pdf',
  format: 'pdf',
  mime: 'application/pdf',
  byteSize: 8,
  sha256: 'sha-a',
  bytes: bytesOf('%PDF-1.7'),
  ...overrides,
})

const block = (index: number, text: string): NormalizedBlock => ({
  index,
  kind: 'paragraph',
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})

const always = { shouldQueue: () => true }
const never = { shouldQueue: () => false }

describe('createSyncedPaperRepository', () => {
  it('updateProgress：本地写行为与原仓储一致 + 入队 progress 项（payload 为整行 papers 快照）', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, always)
    const paper = await synced.createPaper(input())
    const progress = { blockIndex: 7, ratio: 0.5, maxBlockIndex: 9, updatedAt: 12345 }
    await synced.updateProgress(paper.id, progress)

    // 本地写与原仓储同语义：progress + lastReadAt 落 papers 行
    const row = await db.papers.get(paper.id)
    expect(row?.progress).toEqual(progress)
    expect(row?.lastReadAt).toBe(12345)

    const queue = await db.outbox.toArray()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ op: 'progress', paperId: paper.id })
    expect(queue[0].payload).toEqual(row) // 快照 = 当前行
  })

  it('markReady 入队 push-artifacts 并落 syncMeta；deletePaper 入队 delete-paper 并清 syncMeta', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, always)
    const paper = await synced.createPaper(input())
    await synced.saveBlocks(paper.id, [block(0, '第一段')])
    await synced.markReady(paper.id, { blockCount: 1, charCount: 3 })

    expect((await db.papers.get(paper.id))?.status).toBe('ready')
    expect(await db.syncMeta.get(paper.id)).toEqual({
      paperId: paper.id,
      artifactsPushed: false,
      blocksPushed: false,
      filePushed: false,
      blocksPulled: true,
    })
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['push-artifacts'])

    await synced.deletePaper(paper.id)
    expect(await db.papers.get(paper.id)).toBeUndefined()
    expect(await db.syncMeta.get(paper.id)).toBeUndefined()
    const ops = (await db.outbox.toArray()).map((i) => i.op)
    expect(ops).toEqual(['push-artifacts', 'delete-paper'])
  })

  it('markReady 整行覆盖既有 meta：上次的 lastError/attempts/已推 flag 全部清掉（重新解析后三步重推）', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, always)
    const paper = await synced.createPaper(input())
    await db.syncMeta.put({
      paperId: paper.id,
      artifactsPushed: true,
      blocksPushed: true,
      filePushed: true,
      blocksPulled: true,
      pulledBlockCount: 3,
      attempts: 4,
      lastError: { step: 'file', code: 'internal', message: 'x', status: 500, at: 1 },
    })
    await synced.markReady(paper.id, { blockCount: 1, charCount: 3 })
    const meta = await db.syncMeta.get(paper.id)
    expect(meta).toEqual({ paperId: paper.id, artifactsPushed: false, blocksPushed: false, filePushed: false, blocksPulled: true })
    expect(meta?.lastError).toBeUndefined()
  })

  it('replaceFile：被清掉的译文/高亮逐行入队墓碑（带 paperId），制品本身留给随后的 markReady', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, always)
    const paper = await synced.createPaper(input())
    await db.translations.bulkAdd([
      { id: 't0', paperId: paper.id, blockIndex: 0, blockId: `${paper.id}:0`, targetLang: 'zh', promptVersion: 'v1', model: 'm', srcHash: 'h', text: '译0', createdAt: 1, updatedAt: 2 },
      { id: 't1', paperId: paper.id, blockIndex: 1, blockId: `${paper.id}:1`, targetLang: 'zh', promptVersion: 'v1', model: 'm', srcHash: 'h', text: '译1', createdAt: 1, updatedAt: 2 },
    ])
    await db.highlights.add({ id: 'h0', paperId: paper.id, blockIndex: 0, blockId: `${paper.id}:0`, lang: 'orig', start: 0, end: 2, text: 'ab', createdAt: 3 })
    // 另一篇的行不受影响
    await db.highlights.add({ id: 'h-other', paperId: 'other', blockIndex: 0, blockId: 'other:0', lang: 'orig', start: 0, end: 2, text: 'ab', createdAt: 3 })
    await db.outbox.clear()

    const bytes = bytesOf('新快照')
    await synced.replaceFile(paper.id, { bytes, mime: 'application/x-paper-web-snapshot', sha256: 'sha-new', byteSize: bytes.byteLength, format: 'html' })

    expect((await db.papers.get(paper.id))?.sha256).toBe('sha-new')
    const queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.op, i.tbl, i.recordId, i.paperId, i.deleted])).toEqual([
      ['record', 'translations', 't0', paper.id, true],
      ['record', 'translations', 't1', paper.id, true],
      ['record', 'highlights', 'h0', paper.id, true],
    ])
    expect(await db.highlights.get('h-other')).toBeDefined()
  })

  it('markReady 块数比上一版少：旧尾块逐行入队 blocks 墓碑（排在 push-artifacts 之前）；首次 ready / 块数不减不出墓碑', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, always)
    const paper = await synced.createPaper(input())
    await synced.saveBlocks(paper.id, [block(0, 'a'), block(1, 'b'), block(2, 'c')])
    await synced.markReady(paper.id, { blockCount: 3, charCount: 3 })
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['push-artifacts']) // 首次：没有上一版
    await db.outbox.clear()

    // 原地重导入 → 新正文只剩 1 块：服务端的 :1 :2 若不推墓碑会永远留着
    const bytes = bytesOf('新快照')
    await synced.replaceFile(paper.id, { bytes, mime: 'application/x-paper-web-snapshot', sha256: 'sha-new', byteSize: bytes.byteLength, format: 'html' })
    await synced.saveBlocks(paper.id, [block(0, 'x')])
    await synced.markReady(paper.id, { blockCount: 1, charCount: 1 })
    expect((await db.outbox.toArray()).map((i) => [i.op, i.tbl, i.recordId, i.paperId, i.deleted])).toEqual([
      ['record', 'blocks', `${paper.id}:1`, paper.id, true],
      ['record', 'blocks', `${paper.id}:2`, paper.id, true],
      ['push-artifacts', undefined, undefined, paper.id, undefined],
    ])
    await db.outbox.clear()

    // 块数不减（1 → 2）：只有制品序列
    await synced.saveBlocks(paper.id, [block(0, 'x'), block(1, 'y')])
    await synced.markReady(paper.id, { blockCount: 2, charCount: 2 })
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['push-artifacts'])
  })

  it('replaceFile 且 shouldQueue=false：本地照常替换，零入队', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, never)
    const paper = await synced.createPaper(input())
    await db.highlights.add({ id: 'h0', paperId: paper.id, blockIndex: 0, blockId: `${paper.id}:0`, lang: 'orig', start: 0, end: 2, text: 'ab', createdAt: 3 })

    const bytes = bytesOf('新快照')
    await synced.replaceFile(paper.id, { bytes, mime: 'text/html', sha256: 'sha-new', byteSize: bytes.byteLength, format: 'html' })

    expect((await db.papers.get(paper.id))?.sha256).toBe('sha-new')
    expect(await db.highlights.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })

  it('读方法与 ingest 中间态（createPaper/setStage/saveBlocks/saveChunks/markFailed/retryPaper）不入队', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, always)
    const paper = await synced.createPaper(input())
    await synced.setStage(paper.id, 'parsing')
    await synced.saveBlocks(paper.id, [block(0, 'x')])
    await synced.saveChunks(paper.id, [])
    await synced.markFailed(paper.id, { kind: 'unknown', message: 'x', at: 1 })
    await synced.retryPaper(paper.id)
    await synced.listPapers()
    await synced.getBlocks(paper.id)
    expect(await db.outbox.count()).toBe(0)
  })

  it('shouldQueue=false（游客库/未登录）：本地写照常，零入队', async () => {
    const db = freshDb()
    const synced = createSyncedPaperRepository(db, never)
    const paper = await synced.createPaper(input())
    await synced.updateProgress(paper.id, { blockIndex: 1, ratio: 0.1, updatedAt: 1 })
    await synced.markReady(paper.id, { blockCount: 0, charCount: 0 })
    await synced.deletePaper(paper.id)
    expect(await db.outbox.count()).toBe(0)
    expect(await db.syncMeta.count()).toBe(0)
  })

  it('本地写行为与原仓储字节级一致：同输入下 papers/blocks 表内容相同（忽略随机 id/时间戳）', async () => {
    const a = freshDb()
    const b = freshDb()
    const raw = createPaperRepository(a)
    const synced = createSyncedPaperRepository(b, always)
    const pa = await raw.createPaper(input())
    const pb = await synced.createPaper(input())
    await raw.saveBlocks(pa.id, [block(0, '同一段')])
    await synced.saveBlocks(pb.id, [block(0, '同一段')])

    const strip = (o: object, paperId: string): unknown => {
      const rec: Record<string, unknown> = { ...(o as Record<string, unknown>) }
      for (const k of ['id', 'createdAt', 'updatedAt', 'progress']) delete rec[k]
      return JSON.parse(JSON.stringify(rec).replaceAll(paperId, 'PID')) as unknown
    }
    expect(strip((await a.papers.get(pa.id))!, pa.id)).toEqual(strip((await b.papers.get(pb.id))!, pb.id))
    const [ba] = await raw.getBlocks(pa.id)
    const [bb] = await synced.getBlocks(pb.id)
    expect(strip(ba, pa.id)).toEqual(strip(bb, pb.id))
  })
})

describe('createSyncedCopilotRepository', () => {
  async function setup() {
    const db = freshDb()
    const paperRepo = createSyncedPaperRepository(db, never) // 造数据，不关心 paper 队列
    const paper = await paperRepo.createPaper(input())
    const copilot = createSyncedCopilotRepository(db, always)
    return { db, paper, copilot }
  }

  it('session 创建/更新与 addMessage 入队 record（messages 经 session 反查 paperId）', async () => {
    const { db, paper, copilot } = await setup()
    const session = await copilot.getOrCreateSession(paper.id, '会话')
    const msg = await copilot.addMessage({ sessionId: session.id, role: 'user', content: '你好', createdAt: 1 })
    await copilot.updateMessage(msg.id, { feedback: 'right' })
    await copilot.updateSession(session.id, { turnsSinceMemo: 3 })

    const queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.op, i.tbl, i.recordId])).toEqual([
      ['record', 'sessions', session.id],
      ['record', 'messages', msg.id],
      ['record', 'messages', msg.id],
      ['record', 'sessions', session.id],
    ])
    expect(queue.every((i) => i.paperId === paper.id)).toBe(true)
    expect((queue[2].payload as { feedback?: string }).feedback).toBe('right')
  })

  it('Track 3：updateSession 写 persona 字段落库并入队 outbox（与其余 patch 字段同一路径，无需专门代码）', async () => {
    const { db, paper, copilot } = await setup()
    const session = await copilot.getOrCreateSession(paper.id, '会话')
    await db.outbox.clear()
    await copilot.updateSession(session.id, { persona: 'presales' })

    const row = await db.sessions.get(session.id)
    expect(row?.persona).toBe('presales')

    const queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.op, i.tbl, i.recordId])).toEqual([['record', 'sessions', session.id]])
    expect((queue[0].payload as { persona?: string }).persona).toBe('presales')
  })

  it('resetSession：删掉的消息逐条入队墓碑 + session 行重推', async () => {
    const { db, paper, copilot } = await setup()
    const session = await copilot.getOrCreateSession(paper.id, '会话')
    const m1 = await copilot.addMessage({ sessionId: session.id, role: 'user', content: 'a', createdAt: 1 })
    await db.outbox.clear()
    await copilot.resetSession(session.id)

    const queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.tbl, i.recordId, i.deleted ?? false])).toEqual([
      ['messages', m1.id, true],
      ['sessions', session.id, false],
    ])
    expect(await db.messages.count()).toBe(0)
  })

  it('addUsage/saveBrief 入队；setConsent 永不入队（consents 留本地）', async () => {
    const { db, paper, copilot } = await setup()
    await copilot.setConsent('deepseek', true)
    expect(await db.outbox.count()).toBe(0)

    await copilot.addUsage({
      paperId: paper.id,
      provider: 'deepseek',
      model: 'm',
      inputTokens: 1,
      outputTokens: 2,
      estimated: false,
      cost: 0.01,
      ts: 5,
      status: 'ok',
      latencyMs: 10,
    })
    await copilot.saveBrief(paper.id, 'cache-key', { hello: 1 })
    const queue = await db.outbox.toArray()
    expect(queue.map((i) => i.tbl)).toEqual(['usage', 'briefs'])
    // 入队的 usage 行与落库行一致（含生成的 id）
    const usageRow = (await db.usage.toArray())[0]
    expect(queue[0].payload).toEqual(usageRow)
  })

  it('setSensitive 以 papers 整行 record 入队（LWW 同步开关状态）', async () => {
    const { db, paper, copilot } = await setup()
    await copilot.setSensitive(paper.id, true)
    const queue = await db.outbox.toArray()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ op: 'record', tbl: 'papers', recordId: paper.id })
    expect((queue[0].payload as { sensitive: boolean }).sensitive).toBe(true)
  })
})

describe('createSyncedLearnerRepository', () => {
  it('save/logEvidence 入队 record；reset 逐行入队墓碑', async () => {
    const db = freshDb()
    const learner = createSyncedLearnerRepository(db, always)
    const paperId = 'p1'
    await learner.save(paperId, [emptyProfile('attention', 100)])
    const ev = await learner.logEvidence(paperId, {
      conceptIds: ['attention'],
      dir: 1,
      weight: 1,
      ts: 200,
      source: 'quiz',
    })
    expect(ev.length).toBeGreaterThan(0)

    const queue1 = await db.outbox.toArray()
    expect(queue1.filter((i) => i.tbl === 'conceptStates')).toHaveLength(1)
    expect(queue1.filter((i) => i.tbl === 'evidence')).toHaveLength(ev.length)
    // conceptStates 的入队行 = 落库行（确定性 id 拼接）
    const stateRow = (await db.conceptStates.toArray())[0]
    expect(queue1.find((i) => i.tbl === 'conceptStates')?.payload).toEqual(stateRow)

    await db.outbox.clear()
    await learner.reset(paperId)
    const queue2 = await db.outbox.toArray()
    expect(queue2.every((i) => i.deleted === true)).toBe(true)
    expect(queue2.filter((i) => i.tbl === 'conceptStates')).toHaveLength(1)
    expect(queue2.filter((i) => i.tbl === 'evidence')).toHaveLength(ev.length)
    expect(await db.conceptStates.count()).toBe(0)
    expect(await db.evidence.count()).toBe(0)
  })
})

describe('createSyncedTranslationRepository（§1.6）', () => {
  const tr = (id: string, blockIndex: number): BlockTranslation => ({
    id,
    paperId: 'p1',
    blockIndex,
    blockId: `p1:${blockIndex}`,
    targetLang: 'zh',
    promptVersion: 'v1',
    model: 'm',
    srcHash: 'h',
    text: `译${blockIndex}`,
    createdAt: 1,
    updatedAt: 2,
  })

  it('putTranslations：本地 bulkPut 照旧 + 每行一条 record（tbl translations、recordId=row.id、带 paperId）', async () => {
    const db = freshDb()
    const repo = createSyncedTranslationRepository(db, always)
    await repo.putTranslations([tr('p1:0:zh', 0), tr('p1:1:zh', 1)])
    expect(await repo.getTranslations('p1')).toHaveLength(2)

    const queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.op, i.tbl, i.recordId, i.paperId, i.deleted ?? false])).toEqual([
      ['record', 'translations', 'p1:0:zh', 'p1', false],
      ['record', 'translations', 'p1:1:zh', 'p1', false],
    ])
    expect(queue[0].payload).toEqual(tr('p1:0:zh', 0))

    // 空数组不入队；deleteByPaper（整篇删除的级联）不入队——服务端按 paper_id 级联
    await repo.putTranslations([])
    await repo.deleteByPaper('p1')
    expect(await db.outbox.count()).toBe(2)
    expect(await db.translations.count()).toBe(0)
  })

  it('shouldQueue=false：本地写照常，零入队', async () => {
    const db = freshDb()
    const repo = createSyncedTranslationRepository(db, never)
    await repo.putTranslations([tr('p1:0:zh', 0)])
    expect(await db.translations.count()).toBe(1)
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('createSyncedHighlightRepository（§1.6）', () => {
  const hl = (id: string, start: number, end: number, paperId = 'p1'): PaperHighlight => ({
    id,
    paperId,
    blockIndex: 0,
    blockId: `${paperId}:0`,
    lang: 'orig',
    start,
    end,
    text: 'x'.repeat(end - start),
    createdAt: 5,
  })

  it('applyMerge：被吞并的旧行入队墓碑（paperId 从旧行反查）+ 合并行入队 record', async () => {
    const db = freshDb()
    const repo = createSyncedHighlightRepository(db, always)
    await repo.applyMerge([], [hl('h1', 0, 3)])
    await db.outbox.clear()

    await repo.applyMerge(['h1'], [hl('h2', 0, 8)])
    expect((await repo.getHighlights('p1')).map((h) => h.id)).toEqual(['h2'])
    const queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.tbl, i.recordId, i.paperId, i.deleted ?? false])).toEqual([
      ['highlights', 'h1', 'p1', true],
      ['highlights', 'h2', 'p1', false],
    ])
    expect(queue[1].payload).toEqual(hl('h2', 0, 8))
  })

  it('applyMerge：本地查不到的 toDelete 退回合并行的论文；无合并行时跳过（没有 paperId 的墓碑推不了）', async () => {
    const db = freshDb()
    const repo = createSyncedHighlightRepository(db, always)
    await repo.applyMerge(['ghost'], [hl('h9', 0, 1, 'p7')])
    let queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.recordId, i.paperId, i.deleted ?? false])).toEqual([
      ['ghost', 'p7', true],
      ['h9', 'p7', false],
    ])

    await db.outbox.clear()
    await repo.applyMerge(['ghost2'], [])
    queue = await db.outbox.toArray()
    expect(queue).toEqual([])
  })

  it('deleteHighlights：每个存在的 id 一条墓碑；不存在的 id 不入队；applyMerge 空参不入队', async () => {
    const db = freshDb()
    const repo = createSyncedHighlightRepository(db, always)
    await repo.applyMerge([], [hl('h1', 0, 3), hl('h2', 4, 6, 'p2')])
    await db.outbox.clear()

    await repo.deleteHighlights(['h1', 'h2', 'nope'])
    expect(await db.highlights.count()).toBe(0)
    const queue = await db.outbox.toArray()
    expect(queue.map((i) => [i.tbl, i.recordId, i.paperId, i.deleted])).toEqual([
      ['highlights', 'h1', 'p1', true],
      ['highlights', 'h2', 'p2', true],
    ])

    await repo.applyMerge([], [])
    await repo.deleteHighlights([])
    expect(await db.outbox.count()).toBe(2)
  })

  it('shouldQueue=false：本地写照常，零入队', async () => {
    const db = freshDb()
    const repo = createSyncedHighlightRepository(db, never)
    await repo.applyMerge([], [hl('h1', 0, 3)])
    await repo.deleteHighlights(['h1'])
    expect(await db.outbox.count()).toBe(0)
  })
})
