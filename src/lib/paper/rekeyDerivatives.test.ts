import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { PaperDb } from './repo/db'
import { createHighlightRepository } from './repo/highlightRepo'
import { createTranslationRepository } from './repo/translationRepo'
import { mapBlockIndices, planRekey, rekeyBlockDerivatives } from './rekeyDerivatives'
import type { BlockTranslation, NormalizedBlock, PaperBlock, PaperHighlight } from './types'

const P = 'paper-1'

const blk = (index: number, text: string) => ({ index, text })
const oldBlock = (index: number, text: string): PaperBlock => ({
  id: `${P}:${index}`,
  paperId: P,
  index,
  kind: 'paragraph',
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})
const newBlock = (index: number, text: string): NormalizedBlock => ({
  index,
  kind: 'paragraph',
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})
const tr = (blockIndex: number, text = `译${blockIndex}`): BlockTranslation => ({
  id: `${P}:${blockIndex}:zh`,
  paperId: P,
  blockIndex,
  blockId: `${P}:${blockIndex}`,
  targetLang: 'zh',
  promptVersion: 'tr1',
  model: 'm',
  srcHash: `h${blockIndex}`,
  text,
  createdAt: 1,
  updatedAt: 2,
})
const hl = (id: string, blockIndex: number): PaperHighlight => ({
  id,
  paperId: P,
  blockIndex,
  blockId: `${P}:${blockIndex}`,
  lang: 'orig',
  start: 0,
  end: 3,
  text: 'abc',
  createdAt: 3,
})

describe('mapBlockIndices', () => {
  it('完全相同 → 恒等映射', () => {
    const blocks = [blk(0, 'A'), blk(1, 'B'), blk(2, 'C')]
    expect([...mapBlockIndices(blocks, blocks)]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
  })

  it('新解析多出一块（页眉独立成块 / 脚注拆出）→ 之后的序号整体后移', () => {
    const map = mapBlockIndices([blk(0, 'A'), blk(1, 'B'), blk(2, 'C')], [blk(0, 'A'), blk(1, 'Header'), blk(2, 'B'), blk(3, 'C')])
    expect([...map]).toEqual([
      [0, 0],
      [1, 2],
      [2, 3],
    ])
  })

  it('文本变化的块不映射（吞过页眉的段落），其后的块仍对得上；首尾空白不算差异', () => {
    const map = mapBlockIndices([blk(0, 'A'), blk(1, 'B page 4 of 14'), blk(2, ' C ')], [blk(0, 'A'), blk(1, 'B'), blk(2, 'C')])
    expect([...map]).toEqual([
      [0, 0],
      [2, 2],
    ])
  })

  it('重复文本就近命中且单调：两个「Proof.」各自对应，不会都指向第一个', () => {
    const old = [blk(0, 'Proof.'), blk(1, 'A'), blk(2, 'Proof.'), blk(3, 'B')]
    const next = [blk(0, 'Intro'), blk(1, 'Proof.'), blk(2, 'A'), blk(3, 'Proof.'), blk(4, 'B')]
    expect([...mapBlockIndices(old, next)]).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ])
  })

  it('前瞻窗口：超出 lookahead 的匹配放弃（避免跨越整篇误配同文块）', () => {
    const next = [...Array.from({ length: 70 }, (_, i) => blk(i, `filler ${i}`)), blk(70, 'A')]
    expect(mapBlockIndices([blk(0, 'A')], next).size).toBe(0)
    expect([...mapBlockIndices([blk(0, 'A')], next, 100)]).toEqual([[0, 70]])
  })

  it('空文本块不参与映射', () => {
    expect(mapBlockIndices([blk(0, ''), blk(1, '  ')], [blk(0, ''), blk(1, 'x')]).size).toBe(0)
  })
})

describe('planRekey', () => {
  it('只改写命中且序号变化的译文：新 id / blockIndex / blockId，其余字段原样', () => {
    const map = new Map([
      [0, 0],
      [1, 2],
    ])
    const plan = planRekey(P, map, [tr(0), tr(1)], [])
    expect(plan.translations.put).toEqual([{ ...tr(1), id: `${P}:2:zh`, blockIndex: 2, blockId: `${P}:2` }])
    expect(plan.translations.delete).toEqual([`${P}:1:zh`])
    expect(plan.stats).toEqual({ mapped: 2, movedTranslations: 1, movedHighlights: 0 })
  })

  it('链式搬迁 5→6、6→7：delete 只含不再被写的旧 id，被 put 覆盖的 id 不进 delete（先删后写不会误删新行）', () => {
    const map = new Map([
      [5, 6],
      [6, 7],
    ])
    const plan = planRekey(P, map, [tr(5), tr(6)], [])
    expect(plan.translations.put.map((r) => [r.id, r.blockIndex, r.text])).toEqual([
      [`${P}:6:zh`, 6, '译5'],
      [`${P}:7:zh`, 7, '译6'],
    ])
    expect(plan.translations.delete).toEqual([`${P}:5:zh`])
  })

  it('高亮：id 不变，只改 blockIndex / blockId', () => {
    const plan = planRekey(P, new Map([[3, 4]]), [], [hl('h1', 3), hl('h2', 9)])
    expect(plan.highlights.put).toEqual([{ ...hl('h1', 3), blockIndex: 4, blockId: `${P}:4` }])
    expect(plan.stats.movedHighlights).toBe(1)
  })

  it('未命中的行不动；恒等映射零改写', () => {
    const plan = planRekey(P, new Map([[0, 0]]), [tr(0), tr(1)], [hl('h1', 0), hl('h2', 1)])
    expect(plan.translations).toEqual({ put: [], delete: [] })
    expect(plan.highlights).toEqual({ put: [] })
  })
})

describe('rekeyBlockDerivatives（fake-indexeddb 真实仓储）', () => {
  function setup() {
    const db = new PaperDb(`t-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange })
    const translation = createTranslationRepository(db)
    const highlight = createHighlightRepository(db)
    const calls: string[] = []
    const repos = {
      translation: {
        ...translation,
        deleteTranslations: async (ids: readonly string[]) => {
          calls.push(`delete:${[...ids].join(',')}`)
          await translation.deleteTranslations(ids)
        },
        putTranslations: async (rows: BlockTranslation[]) => {
          calls.push(`put:${rows.map((r) => r.id).join(',')}`)
          await translation.putTranslations(rows)
        },
      },
      highlight: {
        ...highlight,
        applyMerge: async (toDelete: readonly string[], toPut: readonly PaperHighlight[]) => {
          calls.push(`merge:${toDelete.length}/${toPut.map((h) => h.id).join(',')}`)
          await highlight.applyMerge(toDelete, toPut)
        },
      },
    }
    return { db, translation, highlight, repos, calls }
  }

  it('先 deleteTranslations 再 putTranslations，再高亮 applyMerge；落库结果按新序号', async () => {
    const { translation, highlight, repos, calls } = setup()
    await translation.putTranslations([tr(0, 'A译'), tr(1, 'B译'), tr(2, 'C译'), tr(7, '未命中')])
    await highlight.applyMerge([], [hl('h1', 1), hl('h9', 9)])

    const plan = await rekeyBlockDerivatives(
      {
        paperId: P,
        oldBlocks: [oldBlock(0, 'A'), oldBlock(1, 'B'), oldBlock(2, 'C'), oldBlock(7, 'Z')],
        newBlocks: [newBlock(0, 'Header'), newBlock(1, 'A'), newBlock(2, 'B'), newBlock(3, 'C')],
      },
      repos,
    )

    expect(plan.stats).toEqual({ mapped: 3, movedTranslations: 3, movedHighlights: 1 })
    expect(calls).toEqual([`delete:${P}:0:zh`, `put:${P}:1:zh,${P}:2:zh,${P}:3:zh`, 'merge:0/h1'])
    const rows = (await translation.getTranslations(P)).sort((a, b) => a.blockIndex - b.blockIndex)
    expect(rows.map((r) => [r.id, r.blockIndex, r.blockId, r.text])).toEqual([
      [`${P}:1:zh`, 1, `${P}:1`, 'A译'],
      [`${P}:2:zh`, 2, `${P}:2`, 'B译'],
      [`${P}:3:zh`, 3, `${P}:3`, 'C译'],
      [`${P}:7:zh`, 7, `${P}:7`, '未命中'],
    ])
    const hls = (await highlight.getHighlights(P)).sort((a, b) => a.id.localeCompare(b.id))
    expect(hls.map((h) => [h.id, h.blockIndex, h.blockId])).toEqual([
      ['h1', 2, `${P}:2`],
      ['h9', 9, `${P}:9`],
    ])
  })

  it('映射为空（文本全变）→ 不读不写', async () => {
    const { translation, repos, calls } = setup()
    await translation.putTranslations([tr(0)])
    const plan = await rekeyBlockDerivatives(
      { paperId: P, oldBlocks: [oldBlock(0, 'A')], newBlocks: [newBlock(0, 'B')] },
      repos,
    )
    expect(plan.stats).toEqual({ mapped: 0, movedTranslations: 0, movedHighlights: 0 })
    expect(calls).toEqual([])
    expect(await translation.getTranslations(P)).toHaveLength(1)
  })

  it('恒等映射 → 读了但不写', async () => {
    const { translation, repos, calls } = setup()
    await translation.putTranslations([tr(0)])
    await rekeyBlockDerivatives({ paperId: P, oldBlocks: [oldBlock(0, 'A')], newBlocks: [newBlock(0, 'A')] }, repos)
    expect(calls).toEqual([])
  })
})
