import { describe, expect, it } from 'vitest'
import {
  CHARS_PER_TOKEN,
  DEFAULT_TARGET_TOKENS,
  buildChunkRows,
  chunkBlocks,
  estimateTokens,
  splitLongText,
} from './chunking'
import type { NormalizedBlock } from './types'

const para = (index: number, text: string, section?: string, page = 1): NormalizedBlock => ({
  index,
  kind: 'paragraph',
  text,
  anchor: { kind: 'pdf', blockIndex: index, page, section },
})

const heading = (index: number, text: string, page = 1): NormalizedBlock => ({
  index,
  kind: 'heading',
  level: 1,
  text,
  anchor: { kind: 'pdf', blockIndex: index, page, section: text },
})

/** 生成 n 个 token 左右的英文正文（chars/3 估算） */
const words = (tokens: number): string => 'lorem ipsum '.repeat(Math.ceil((tokens * CHARS_PER_TOKEN) / 12)).trim()

describe('estimateTokens', () => {
  it('按 chars/3 上取整估算（中英一致）', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('注意力机制的计算复杂度')).toBe(4)
  })
})

describe('chunkBlocks', () => {
  it('空输入 → 空数组；空白块被跳过', () => {
    expect(chunkBlocks([])).toEqual([])
    expect(chunkBlocks([para(0, '   ')])).toEqual([])
  })

  it('短文档聚成一块，锚点取首块并保留章节与页码', () => {
    const chunks = chunkBlocks([heading(0, 'Method', 3), para(1, '第一段', 'Method', 3), para(2, '第二段', 'Method', 4)])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      order: 0,
      blockStart: 0,
      blockEnd: 2,
      anchor: { kind: 'pdf', blockIndex: 0, page: 3, section: 'Method' },
    })
    expect(chunks[0].text).toBe('Method\n第一段\n第二段')
  })

  it('超过目标 token 时切块，order 连续、块序号区间递增且完整覆盖原文', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => para(i, words(200)))
    const chunks = chunkBlocks(blocks, { targetTokens: 600 })

    expect(chunks.length).toBeGreaterThan(2)
    chunks.forEach((c, i) => expect(c.order).toBe(i))
    expect(chunks[0].blockStart).toBe(0)
    expect(chunks[chunks.length - 1].blockEnd).toBe(11)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].blockStart).toBeGreaterThan(chunks[i - 1].blockStart)
      expect(chunks[i].blockEnd).toBeGreaterThanOrEqual(chunks[i - 1].blockEnd)
    }
    // 覆盖完整：相邻块之间不能有缺口（下一块起点 ≤ 上一块终点 + 1）
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].blockStart).toBeLessThanOrEqual(chunks[i - 1].blockEnd + 1)
    }
  })

  it('相邻块保持约 15% 重叠（下一块起点落在上一块区间内）', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => para(i, words(100)))
    const chunks = chunkBlocks(blocks, { targetTokens: 600, overlapRatio: 0.15 })
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].blockStart).toBeLessThanOrEqual(chunks[i - 1].blockEnd)
    }
  })

  it('overlapRatio = 0 时不重叠', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => para(i, words(100)))
    const chunks = chunkBlocks(blocks, { targetTokens: 600, overlapRatio: 0 })
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].blockStart).toBe(chunks[i - 1].blockEnd + 1)
    }
  })

  it('章节标题构成语义边界：缓冲够大时另起一块，并且不带上一节的重叠尾巴', () => {
    const blocks = [
      heading(0, '1 Introduction'),
      para(1, words(300), '1 Introduction'),
      heading(2, '2 Method'),
      para(3, words(120), '2 Method'),
    ]
    const chunks = chunkBlocks(blocks, { targetTokens: 600, minSplitRatio: 0.35 })
    expect(chunks).toHaveLength(2)
    expect(chunks[0].blockEnd).toBe(1)
    expect(chunks[1].blockStart).toBe(2)
    expect(chunks[1].anchor.section).toBe('2 Method')
  })

  it('小节太短时标题不断块，避免切出一堆碎块', () => {
    const blocks = [heading(0, 'A'), para(1, '短'), heading(2, 'B'), para(3, '也短')]
    expect(chunkBlocks(blocks, { targetTokens: 600 })).toHaveLength(1)
  })

  it('单块超长 → 按字符切片，切片共用同一块序号与锚点', () => {
    const long = 'x'.repeat(600 * CHARS_PER_TOKEN * 3)
    const chunks = chunkBlocks([para(0, '前情提要'), para(1, long, 'Method', 7)], { targetTokens: 600 })
    const pieces = chunks.filter((c) => c.blockStart === 1)
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces) {
      expect(p.blockEnd).toBe(1)
      expect(p.anchor).toMatchObject({ blockIndex: 1, page: 7, section: 'Method' })
      expect(p.tokenEstimate).toBeLessThanOrEqual(600)
    }
    // 超长块之前的缓冲被单独冲出，不会与切片混在一起
    expect(chunks[0].blockEnd).toBe(0)
  })

  it('中英混排：块大小按估算 token 控制，不会因中文字符少就切得过碎', () => {
    const zh = Array.from({ length: 10 }, (_, i) => para(i, '注意力机制'.repeat(60)))
    const chunks = chunkBlocks(zh, { targetTokens: 600 })
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeGreaterThan(300)
    }
  })

  it('默认目标 1200 token：块不会明显超标', () => {
    const blocks = Array.from({ length: 30 }, (_, i) => para(i, words(150)))
    const chunks = chunkBlocks(blocks)
    for (const c of chunks) {
      expect(c.tokenEstimate!).toBeLessThan(DEFAULT_TARGET_TOKENS * 1.3)
    }
  })
})

describe('splitLongText', () => {
  it('短文本原样返回', () => {
    expect(splitLongText('hello', 100, 10)).toEqual(['hello'])
  })

  it('优先在句末切分', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here.'
    const parts = splitLongText(text, 30, 5)
    expect(parts[0].endsWith('.')).toBe(true)
  })

  it('无空白可切时硬切，且一定推进（不死循环）', () => {
    const parts = splitLongText('あ'.repeat(100), 10, 9)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('').length).toBeGreaterThanOrEqual(100)
  })
})

describe('buildChunkRows', () => {
  it('补齐 id/paperId，并把 BM25 词频表一起算好', () => {
    const drafts = chunkBlocks([para(0, 'attention is all you need')])
    const rows = buildChunkRows('p1', drafts)
    expect(rows[0].id).toBe('p1:c0')
    expect(rows[0].paperId).toBe('p1')
    expect(rows[0].len).toBeGreaterThan(0)
    expect(rows[0].tf?.attention).toBe(1)
  })
})
