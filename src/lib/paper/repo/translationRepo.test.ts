import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb } from './db'
import { createPaperRepository } from './paperRepo'
import { createTranslationRepository } from './translationRepo'
import type { BlockTranslation } from '../types'

function freshDb(): PaperDb {
  return new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
}

const row = (paperId: string, blockIndex: number, text = `译文 ${blockIndex}`): BlockTranslation => ({
  id: `${paperId}:${blockIndex}:zh`,
  paperId,
  blockIndex,
  blockId: `${paperId}:${blockIndex}`,
  targetLang: 'zh',
  promptVersion: 'tr1',
  model: 'deepseek-v4-pro',
  srcHash: 'deadbeef',
  text,
  createdAt: 1,
  updatedAt: 1,
})

describe('createTranslationRepository', () => {
  it('putTranslations 幂等：同键重放覆盖而不是叠加', async () => {
    const db = freshDb()
    const repo = createTranslationRepository(db)

    await repo.putTranslations([row('p1', 0), row('p1', 1)])
    await repo.putTranslations([row('p1', 0, '重译后的 0'), row('p1', 2)])

    const rows = await repo.getTranslations('p1')
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.blockIndex === 0)?.text).toBe('重译后的 0')
  })

  it('getTranslations 只返回本篇论文的行；空数组入参不报错', async () => {
    const db = freshDb()
    const repo = createTranslationRepository(db)
    await repo.putTranslations([row('p1', 0), row('p2', 0)])
    await repo.putTranslations([])

    expect((await repo.getTranslations('p1')).map((r) => r.paperId)).toEqual(['p1'])
    expect(await repo.getTranslations('p-none')).toEqual([])
  })

  it('deleteByPaper 只清本篇', async () => {
    const db = freshDb()
    const repo = createTranslationRepository(db)
    await repo.putTranslations([row('p1', 0), row('p2', 0)])

    await repo.deleteByPaper('p1')
    expect(await repo.getTranslations('p1')).toEqual([])
    expect(await repo.getTranslations('p2')).toHaveLength(1)
  })

  it('paperRepo.deletePaper 级联删除 translations', async () => {
    const db = freshDb()
    const paperRepo = createPaperRepository(db)
    const repo = createTranslationRepository(db)
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
    await repo.putTranslations([row(paper.id, 0), row(paper.id, 1)])

    await paperRepo.deletePaper(paper.id)
    expect(await repo.getTranslations(paper.id)).toEqual([])
  })
})

describe('db v2 → v3 迁移', () => {
  /** 与升级前发布版完全一致的 v1+v2 schema：模拟老用户的既有库 */
  class LegacyPaperDbV2 extends Dexie {
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
    }
  }

  it('老库打开后 translations 空表可用，既有数据无损', async () => {
    const factory = new IDBFactory()
    const name = `mig-${crypto.randomUUID()}`

    const legacy = new LegacyPaperDbV2(name, { indexedDB: factory, IDBKeyRange })
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
    await legacy.table('blocks').add({
      id: 'p1:0',
      paperId: 'p1',
      index: 0,
      kind: 'paragraph',
      text: 'hello',
      anchor: { kind: 'pdf', blockIndex: 0, page: 1 },
    })
    await legacy.table('outbox').add({ op: 'progress', paperId: 'p1', createdAt: 1 })
    legacy.close()

    const db = new PaperDb(name, { indexedDB: factory, IDBKeyRange })
    await db.open()
    // v4（highlights）加入后，老库一次跳到当前版本
    expect(db.verno).toBe(4)

    // 新表可用（空表 + 读写正常）
    expect(await db.translations.count()).toBe(0)
    const repo = createTranslationRepository(db)
    await repo.putTranslations([row('p1', 0)])
    expect(await repo.getTranslations('p1')).toHaveLength(1)
    // 复合索引 [paperId+blockIndex] 生效
    expect(await db.translations.where('[paperId+blockIndex]').equals(['p1', 0]).count()).toBe(1)

    // 既有各表数据无损
    expect(await db.papers.get('p1')).toMatchObject({ title: '老论文', progress: { blockIndex: 3 } })
    expect(await db.blocks.where('paperId').equals('p1').count()).toBe(1)
    expect(await db.outbox.count()).toBe(1)
    db.close()
  })
})
