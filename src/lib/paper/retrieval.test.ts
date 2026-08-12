import { describe, expect, it, vi } from 'vitest'
import { chunkPaper } from './chunking'
import type { RerankFn } from './hybrid'
import {
  buildCiteMap,
  createRetrievalService,
  expandQuery,
  makeSnippet,
  retrieveFromChunks,
  searchChunks,
  splitHighlight,
} from './retrieval'
import type { NormalizedBlock, PaperChunk } from './types'

const blocks: NormalizedBlock[] = [
  { index: 0, kind: 'heading', level: 1, text: '2 Method', anchor: { kind: 'pdf', blockIndex: 0, page: 3, section: '2 Method' } },
  {
    index: 1,
    kind: 'paragraph',
    text: 'We compute attention with a paged KV cache so that memory grows linearly with context length.',
    anchor: { kind: 'pdf', blockIndex: 1, page: 3, section: '2 Method' },
  },
  { index: 2, kind: 'heading', level: 1, text: '3 Experiments', anchor: { kind: 'pdf', blockIndex: 2, page: 6, section: '3 Experiments' } },
  {
    index: 3,
    kind: 'paragraph',
    text: 'The dataset contains one million documents and we report throughput on eight GPUs.',
    anchor: { kind: 'pdf', blockIndex: 3, page: 6, section: '3 Experiments' },
  },
]

const chunks: PaperChunk[] = chunkPaper('p1', blocks, { targetTokens: 20, overlapRatio: 0, minSplitRatio: 0.1 })

describe('expandQuery', () => {
  it('并入选区、当前阅读章节与词面相关的章节标题', () => {
    const q = expandQuery('throughput 怎么测的', {
      selection: 'we report throughput on eight GPUs',
      currentSection: '3 Experiments',
      sectionTitles: ['2 Method', '3 Experiments', 'throughput analysis'],
    })
    expect(q).toContain('throughput 怎么测的')
    expect(q).toContain('eight GPUs')
    expect(q).toContain('3 Experiments')
    // 与问题有词面交集的标题才并入，无关标题不进
    expect(q).toContain('throughput analysis')
    expect(q).not.toContain('2 Method')
  })

  it('选区超长时截断，避免稀释问题本身的关键词', () => {
    const q = expandQuery('问题', { selection: 'x'.repeat(1000) })
    expect(q.length).toBeLessThan(400)
  })

  it('没有上下文时就是原查询', () => {
    expect(expandQuery('  hello  ')).toBe('hello')
  })
})

describe('retrieveFromChunks', () => {
  it('返回命中片段与 c1..cN 引用白名单（别名与顺序一致）', async () => {
    const out = await retrieveFromChunks(chunks, 'paged KV cache memory', { topK: 2 })
    expect(out.chunks.length).toBeGreaterThan(0)
    expect(out.chunks[0].alias).toBe('c1')
    expect(out.chunks[0].chunk.text).toContain('paged KV cache')
    expect(out.citeMapEntries[0]).toMatchObject({
      alias: 'c1',
      chunkId: out.chunks[0].chunk.id,
      page: 3,
      section: '2 Method',
    })
    expect(out.citeMapEntries.map((e) => e.alias)).toEqual(out.chunks.map((c) => c.alias))
  })

  it('CiteMap 带回锚点，供引用跳转解析', async () => {
    const out = await retrieveFromChunks(chunks, 'throughput GPUs')
    expect(out.citeMapEntries[0].anchor).toMatchObject({ kind: 'pdf', blockIndex: expect.any(Number) })
  })

  it('当前阅读章节获得轻微加权：同分时倾向读者正在看的章节', async () => {
    // 两块文本完全相同，只有章节不同 → 排序差异只可能来自 boost
    const twin: PaperChunk[] = [
      { id: 't:c0', paperId: 't', order: 0, text: 'shared sentence about scaling laws', anchor: { kind: 'pdf', blockIndex: 0, page: 1, section: 'A' }, blockStart: 0, blockEnd: 0 },
      { id: 't:c1', paperId: 't', order: 1, text: 'shared sentence about scaling laws', anchor: { kind: 'pdf', blockIndex: 1, page: 2, section: 'B' }, blockStart: 1, blockEnd: 1 },
    ]
    expect((await retrieveFromChunks(twin, 'scaling laws')).chunks[0].chunk.id).toBe('t:c0')
    expect((await retrieveFromChunks(twin, 'scaling laws', { currentSection: 'B' })).chunks[0].chunk.id).toBe('t:c1')
  })

  it('无命中 / 空库 / 空查询 → 空结果且不抛错', async () => {
    expect((await retrieveFromChunks(chunks, 'quantum entanglement')).chunks).toEqual([])
    expect((await retrieveFromChunks([], 'anything')).chunks).toEqual([])
    expect((await retrieveFromChunks(chunks, '   ')).citeMapEntries).toEqual([])
  })

  it('Phase 2 默认不做 rerank：注入的实现不会被调用', async () => {
    const rerankFn = vi.fn<RerankFn>()
    const out = await retrieveFromChunks(chunks, 'attention', { hybrid: { rerankFn } })
    expect(rerankFn).not.toHaveBeenCalled()
    expect(out.usedRerank).toBe(false)
  })
})

describe('searchChunks', () => {
  it('返回带片段与锚点的搜索结果', () => {
    const hits = searchChunks(chunks, 'paged KV cache')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].snippet).toContain('paged')
    expect(hits[0].page).toBe(3)
    expect(hits[0].anchor.blockIndex).toBe(0)
  })

  it('空查询 → 空结果', () => {
    expect(searchChunks(chunks, '')).toEqual([])
  })
})

describe('makeSnippet / splitHighlight', () => {
  it('片段围绕首个命中词展开并加省略号', () => {
    const text = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`
    const s = makeSnippet(text, ['needle'], 20)
    expect(s.startsWith('…')).toBe(true)
    expect(s).toContain('needle')
    expect(s.endsWith('…')).toBe(true)
  })

  it('没有命中词时退回开头片段', () => {
    expect(makeSnippet('short text', [])).toBe('short text')
  })

  it('高亮切分不丢字符，且命中段被标记', () => {
    const parts = splitHighlight('KV cache 与 kv cache', ['kv'])
    expect(parts.map((p) => p.text).join('')).toBe('KV cache 与 kv cache')
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['KV', 'kv'])
  })

  it('无命中词 → 单段原文', () => {
    expect(splitHighlight('abc', [])).toEqual([{ text: 'abc', hit: false }])
  })
})

describe('buildCiteMap', () => {
  it('别名从 c1 递增；缺页码/章节的锚点不写空字段', () => {
    const entries = buildCiteMap([
      { chunk: { ...chunks[0], anchor: { kind: 'docx', blockIndex: 0 } } },
      { chunk: chunks[chunks.length - 1] },
    ])
    expect(entries.map((e) => e.alias)).toEqual(['c1', 'c2'])
    expect(entries[0].page).toBeUndefined()
    expect(entries[0].section).toBeUndefined()
  })
})

describe('createRetrievalService', () => {
  it('同一篇论文只加载一次 chunk（索引缓存），invalidate 后重新加载', async () => {
    const loadChunks = vi.fn(async () => chunks)
    const svc = createRetrievalService({ loadChunks })
    await svc.retrieve('p1', 'attention')
    await svc.search('p1', 'attention')
    expect(loadChunks).toHaveBeenCalledTimes(1)
    svc.invalidate('p1')
    await svc.search('p1', 'attention')
    expect(loadChunks).toHaveBeenCalledTimes(2)
  })
})
