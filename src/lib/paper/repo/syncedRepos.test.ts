import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb } from './db'
import { createPaperRepository, type NewPaperInput } from './paperRepo'
import {
  createSyncedCopilotRepository,
  createSyncedLearnerRepository,
  createSyncedPaperRepository,
} from './syncedRepos'
import { emptyProfile } from '../learnerProfile'
import type { NormalizedBlock } from '../types'

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
    expect(await db.syncMeta.get(paper.id)).toMatchObject({ artifactsPushed: false, filePushed: false })
    expect((await db.outbox.toArray()).map((i) => i.op)).toEqual(['push-artifacts'])

    await synced.deletePaper(paper.id)
    expect(await db.papers.get(paper.id)).toBeUndefined()
    expect(await db.syncMeta.get(paper.id)).toBeUndefined()
    const ops = (await db.outbox.toArray()).map((i) => i.op)
    expect(ops).toEqual(['push-artifacts', 'delete-paper'])
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
