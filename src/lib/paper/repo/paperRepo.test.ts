import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PARSER_VERSION, PaperDb } from './db'
import { createPaperRepository, type NewPaperInput, type PaperRepository } from './paperRepo'
import type { NormalizedBlock } from '../types'

/** 每个用例一套全新的 IDBFactory + 唯一库名：测例之间零串扰 */
function freshDb(): PaperDb {
  return new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
}

function freshRepo(): { db: PaperDb; repo: PaperRepository } {
  const db = freshDb()
  return { db, repo: createPaperRepository(db) }
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

describe('createPaperRepository', () => {
  it('createPaper 写入元数据、字节与导入任务，初始状态为 queued', async () => {
    const { db, repo } = freshRepo()
    const paper = await repo.createPaper(input())

    expect(paper).toMatchObject({ status: 'queued', parserVersion: PARSER_VERSION, sensitive: false })
    expect(paper.progress).toMatchObject({ blockIndex: 0, ratio: 0 })
    expect(await repo.getPaper(paper.id)).toMatchObject({ title: '论文标题' })
    expect(await db.jobs.where('paperId').equals(paper.id).count()).toBe(1)
  })

  it('原始字节以 ArrayBuffer 往返，内容逐字节一致', async () => {
    const { repo } = freshRepo()
    const original = bytesOf('%PDF-1.7 hello 论文')
    const paper = await repo.createPaper(input({ bytes: original, byteSize: original.byteLength }))

    const stored = await repo.getFileBytes(paper.id)
    expect(stored?.mime).toBe('application/pdf')
    expect(new Uint8Array(stored!.bytes)).toEqual(new Uint8Array(original))
  })

  it('findBySha256 命中已有论文，未命中返回 undefined', async () => {
    const { repo } = freshRepo()
    await repo.createPaper(input({ sha256: 'sha-a' }))
    expect((await repo.findBySha256('sha-a'))?.sha256).toBe('sha-a')
    expect(await repo.findBySha256('sha-none')).toBeUndefined()
  })

  it('listPapers 返回全部论文', async () => {
    const { repo } = freshRepo()
    await repo.createPaper(input({ sha256: 'a' }))
    await repo.createPaper(input({ sha256: 'b', title: '第二篇' }))
    expect(await repo.listPapers()).toHaveLength(2)
  })

  it('saveBlocks 按 index 有序返回，重复保存覆盖旧块而不是叠加', async () => {
    const { repo } = freshRepo()
    const paper = await repo.createPaper(input())

    await repo.saveBlocks(paper.id, [block(0, 'A'), block(1, 'B'), block(2, 'C')])
    expect((await repo.getBlocks(paper.id)).map((b) => b.text)).toEqual(['A', 'B', 'C'])

    await repo.saveBlocks(paper.id, [block(0, 'X'), block(1, 'Y')])
    const after = await repo.getBlocks(paper.id)
    expect(after.map((b) => b.text)).toEqual(['X', 'Y'])
    expect(after.every((b) => b.paperId === paper.id)).toBe(true)
  })

  it('setStage 同步推进 papers 与 jobs，并可携带补丁字段', async () => {
    const { db, repo } = freshRepo()
    const paper = await repo.createPaper(input())

    await repo.setStage(paper.id, 'parsing', { pageCount: 12 })
    expect(await repo.getPaper(paper.id)).toMatchObject({ status: 'parsing', pageCount: 12 })
    expect((await db.jobs.where('paperId').equals(paper.id).first())?.stage).toBe('parsing')
  })

  it('markFailed 写入失败分类，markReady 清空 failure 并落统计', async () => {
    const { db, repo } = freshRepo()
    const paper = await repo.createPaper(input())

    await repo.markFailed(paper.id, { kind: 'corrupt', message: '文件损坏', at: 1 })
    expect(await repo.getPaper(paper.id)).toMatchObject({ status: 'failed', failure: { kind: 'corrupt' } })
    expect((await db.jobs.where('paperId').equals(paper.id).first())?.stage).toBe('failed')

    await repo.markReady(paper.id, { pageCount: 3, blockCount: 20, charCount: 999, title: '解析后的标题' })
    const ready = await repo.getPaper(paper.id)
    expect(ready).toMatchObject({ status: 'ready', pageCount: 3, blockCount: 20, charCount: 999, title: '解析后的标题' })
    expect(ready?.failure).toBeUndefined()
  })

  it('retryPaper 回到 queued、清 failure 并把 job.attempts 加一', async () => {
    const { db, repo } = freshRepo()
    const paper = await repo.createPaper(input())
    await repo.markFailed(paper.id, { kind: 'storage', message: '空间不足', at: 1 })

    await repo.retryPaper(paper.id)
    const after = await repo.getPaper(paper.id)
    expect(after?.status).toBe('queued')
    expect(after?.failure).toBeUndefined()
    expect((await db.jobs.where('paperId').equals(paper.id).first())?.attempts).toBe(1)

    await repo.retryPaper(paper.id)
    expect((await db.jobs.where('paperId').equals(paper.id).first())?.attempts).toBe(2)
  })

  it('updateProgress 同时写 lastReadAt（列表「最近阅读」排序直接用它）', async () => {
    const { repo } = freshRepo()
    const paper = await repo.createPaper(input())

    await repo.updateProgress(paper.id, { blockIndex: 40, ratio: 0.5, page: 7, updatedAt: 1_700_000_000 })
    const after = await repo.getPaper(paper.id)
    expect(after?.progress).toEqual({ blockIndex: 40, ratio: 0.5, page: 7, updatedAt: 1_700_000_000 })
    expect(after?.lastReadAt).toBe(1_700_000_000)
  })

  it('deletePaper 事务性级联清空全部关联表', async () => {
    const { db, repo } = freshRepo()
    const paper = await repo.createPaper(input())
    await repo.saveBlocks(paper.id, [block(0, 'A'), block(1, 'B')])

    const now = Date.now()
    await db.chunks.add({ id: 'c1', paperId: paper.id, order: 0, text: 'x', anchor: { kind: 'pdf', blockIndex: 0 }, blockStart: 0, blockEnd: 1 })
    await db.briefs.add({ id: 'br1', paperId: paper.id, cacheKey: 'k', createdAt: now, data: {} })
    await db.sessions.add({ id: 's1', paperId: paper.id, title: '会话', createdAt: now, updatedAt: now })
    await db.messages.add({ id: 'm1', sessionId: 's1', role: 'user', content: 'hi', createdAt: now })
    await db.conceptStates.add({ id: 'cs1', paperId: paper.id, conceptId: 'kv-cache', mastery: 0.5, confidence: 0.3, updatedAt: now })
    await db.evidence.add({ id: 'e1', paperId: paper.id, conceptId: 'kv-cache', dir: 1, weight: 0.1, source: 'quiz', ts: now })
    await db.usage.add({ id: 'u1', paperId: paper.id, provider: 'deepseek', model: 'x', inputTokens: 1, outputTokens: 1, estimated: true, cost: 0, ts: now })
    await db.consents.add({ provider: 'deepseek', granted: true, grantedAt: now })

    await repo.deletePaper(paper.id)

    expect(await repo.getPaper(paper.id)).toBeUndefined()
    expect(await repo.getFileBytes(paper.id)).toBeUndefined()
    expect(await db.blocks.where('paperId').equals(paper.id).count()).toBe(0)
    expect(await db.jobs.where('paperId').equals(paper.id).count()).toBe(0)
    expect(await db.chunks.where('paperId').equals(paper.id).count()).toBe(0)
    expect(await db.briefs.where('paperId').equals(paper.id).count()).toBe(0)
    expect(await db.sessions.where('paperId').equals(paper.id).count()).toBe(0)
    expect(await db.messages.where('sessionId').equals('s1').count()).toBe(0)
    expect(await db.conceptStates.where('paperId').equals(paper.id).count()).toBe(0)
    expect(await db.evidence.where('paperId').equals(paper.id).count()).toBe(0)
    expect(await db.usage.where('paperId').equals(paper.id).count()).toBe(0)
    // consents 是全局 provider 授权，与单篇论文无关，不该被级联删除
    expect(await db.consents.count()).toBe(1)
  })

  it('删除一篇论文不会波及另一篇论文的数据', async () => {
    const { db, repo } = freshRepo()
    const keep = await repo.createPaper(input({ sha256: 'keep', fileName: 'keep.pdf' }))
    const drop = await repo.createPaper(input({ sha256: 'drop', fileName: 'drop.pdf' }))
    await repo.saveBlocks(keep.id, [block(0, '保留')])
    await repo.saveBlocks(drop.id, [block(0, '删除')])
    const now = Date.now()
    await db.sessions.add({ id: 's-keep', paperId: keep.id, title: 'k', createdAt: now, updatedAt: now })
    await db.messages.add({ id: 'm-keep', sessionId: 's-keep', role: 'user', content: 'hi', createdAt: now })

    await repo.deletePaper(drop.id)

    expect(await repo.getPaper(keep.id)).toBeDefined()
    expect(await repo.getFileBytes(keep.id)).toBeDefined()
    expect((await repo.getBlocks(keep.id)).map((b) => b.text)).toEqual(['保留'])
    expect(await db.messages.where('sessionId').equals('s-keep').count()).toBe(1)
    expect(await repo.listPapers()).toHaveLength(1)
  })
})
