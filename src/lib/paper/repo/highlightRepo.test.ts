import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb } from './db'
import { createPaperRepository } from './paperRepo'
import { createHighlightRepository } from './highlightRepo'
import type { PaperHighlight } from '../types'

function freshDb(): PaperDb {
  return new PaperDb(`h-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
}

const row = (id: string, paperId: string, blockIndex: number, overrides: Partial<PaperHighlight> = {}): PaperHighlight => ({
  id,
  paperId,
  blockIndex,
  blockId: `${paperId}:${blockIndex}`,
  lang: 'orig',
  start: 0,
  end: 5,
  text: 'hello',
  createdAt: 1,
  ...overrides,
})

describe('createHighlightRepository', () => {
  it('applyMerge 原子性：删被吞并旧行 + 写合并行一步到位', async () => {
    const db = freshDb()
    const repo = createHighlightRepository(db)
    await repo.applyMerge([], [row('a', 'p1', 0, { start: 0, end: 3, text: 'The' }), row('b', 'p1', 0, { start: 5, end: 8 })])

    // 新区间吞并 a、b：一次调用后旧行消失、只剩合并行
    await repo.applyMerge(['a', 'b'], [row('c', 'p1', 0, { start: 0, end: 8, text: 'The quic' })])
    const rows = await repo.getHighlights('p1')
    expect(rows.map((r) => r.id)).toEqual(['c'])
    expect(rows[0]).toMatchObject({ start: 0, end: 8 })
  })

  it('applyMerge 空入参是空操作；同 id 重放幂等覆盖', async () => {
    const db = freshDb()
    const repo = createHighlightRepository(db)
    await repo.applyMerge([], [])
    expect(await repo.getHighlights('p1')).toEqual([])

    await repo.applyMerge([], [row('a', 'p1', 0)])
    await repo.applyMerge([], [row('a', 'p1', 0, { text: '重写后的快照' })])
    const rows = await repo.getHighlights('p1')
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('重写后的快照')
  })

  it('getHighlights 只返回本篇论文的行', async () => {
    const db = freshDb()
    const repo = createHighlightRepository(db)
    await repo.applyMerge([], [row('a', 'p1', 0), row('b', 'p2', 0)])
    expect((await repo.getHighlights('p1')).map((r) => r.paperId)).toEqual(['p1'])
    expect(await repo.getHighlights('p-none')).toEqual([])
  })

  it('deleteHighlights 按 id 删除；空数组不报错', async () => {
    const db = freshDb()
    const repo = createHighlightRepository(db)
    await repo.applyMerge([], [row('a', 'p1', 0), row('b', 'p1', 1)])
    await repo.deleteHighlights([])
    await repo.deleteHighlights(['a'])
    expect((await repo.getHighlights('p1')).map((r) => r.id)).toEqual(['b'])
  })

  it('deleteByPaper 只清本篇', async () => {
    const db = freshDb()
    const repo = createHighlightRepository(db)
    await repo.applyMerge([], [row('a', 'p1', 0), row('b', 'p2', 0)])
    await repo.deleteByPaper('p1')
    expect(await repo.getHighlights('p1')).toEqual([])
    expect(await repo.getHighlights('p2')).toHaveLength(1)
  })

  it('paperRepo.deletePaper 级联删除 highlights', async () => {
    const db = freshDb()
    const paperRepo = createPaperRepository(db)
    const repo = createHighlightRepository(db)
    const bytes = new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer
    const paper = await paperRepo.createPaper({
      title: 't',
      fileName: 'a.pdf',
      format: 'pdf',
      mime: 'application/pdf',
      byteSize: 8,
      sha256: 'sha-a',
      bytes,
    })
    await repo.applyMerge([], [row('a', paper.id, 0), row('b', paper.id, 1)])

    await paperRepo.deletePaper(paper.id)
    expect(await repo.getHighlights(paper.id)).toEqual([])
  })
})

describe('db v3 → v4 迁移', () => {
  /** 与升级前发布版完全一致的 v1+v2+v3 schema：模拟老用户的既有库 */
  class LegacyPaperDbV3 extends Dexie {
    constructor(name: string, options: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }) {
      super(name, options)
      this.version(1).stores({
        papers: 'id, sha256, status, createdAt, lastReadAt, title',
        files: 'paperId',
        blocks: 'id, paperId, [paperId+index]',
        jobs: 'id, paperId, stage',
        chunks: 'id, paperId, [paperId+order]',
        briefs: 'id, paperId, cacheKey',
        sessions: 'id, paperId, updatedAt',
        messages: 'id, sessionId, [sessionId+createdAt]',
        conceptStates: 'id, paperId, [paperId+conceptId]',
        evidence: 'id, paperId, [paperId+conceptId], ts',
        consents: 'provider',
        usage: 'id, paperId, ts',
      })
      this.version(2).stores({
        outbox: '++qid, op, paperId',
        syncState: 'key',
        syncMeta: 'paperId',
      })
      this.version(3).stores({
        translations: 'id, paperId, [paperId+blockIndex]',
      })
    }
  }

  it('老库打开后 highlights 空表可用，既有数据（含 translations）无损', async () => {
    const factory = new IDBFactory()
    const name = `mig-${crypto.randomUUID()}`

    const legacy = new LegacyPaperDbV3(name, { indexedDB: factory, IDBKeyRange })
    await legacy.table('papers').add({
      id: 'p1',
      title: '老论文',
      fileName: 'old.pdf',
      format: 'pdf',
      mime: 'application/pdf',
      byteSize: 8,
      sha256: 'sha-old',
      status: 'ready',
      parserVersion: 1,
      sensitive: false,
      createdAt: 1,
      updatedAt: 1,
      progress: { blockIndex: 3, ratio: 0.2, updatedAt: 1 },
    })
    await legacy.table('translations').add({
      id: 'p1:0:zh',
      paperId: 'p1',
      blockIndex: 0,
      blockId: 'p1:0',
      targetLang: 'zh',
      promptVersion: 'tr1',
      model: 'deepseek-v4-pro',
      srcHash: 'deadbeef',
      text: '译文',
      createdAt: 1,
      updatedAt: 1,
    })
    await legacy.table('outbox').add({ op: 'progress', paperId: 'p1', createdAt: 1 })
    legacy.close()

    const db = new PaperDb(name, { indexedDB: factory, IDBKeyRange })
    await db.open()
    expect(db.verno).toBe(4)

    // 新表可用（空表 + 读写正常）
    expect(await db.highlights.count()).toBe(0)
    const repo = createHighlightRepository(db)
    await repo.applyMerge([], [row('a', 'p1', 0)])
    expect(await repo.getHighlights('p1')).toHaveLength(1)
    // 复合索引 [paperId+blockIndex] 生效
    expect(await db.highlights.where('[paperId+blockIndex]').equals(['p1', 0]).count()).toBe(1)

    // 既有各表数据无损
    expect(await db.papers.get('p1')).toMatchObject({ title: '老论文', progress: { blockIndex: 3 } })
    expect(await db.translations.get('p1:0:zh')).toMatchObject({ text: '译文' })
    expect(await db.outbox.count()).toBe(1)
    db.close()
  })
})
