import { describe, expect, it } from 'vitest'
import type { PaperBlock } from '../types'
import {
  buildViewportContext,
  pageBlockRange,
  SELECTION_DEDUPE_PLACEHOLDER,
  VIEWPORT_MAX_CHARS,
  windowAroundBlock,
} from './viewportContext'

const blk = (index: number, over: Partial<PaperBlock> = {}): PaperBlock => ({
  id: `b${index}`,
  paperId: 'p1',
  index,
  kind: 'paragraph',
  text: `段落${index}`,
  anchor: { kind: 'pdf', blockIndex: index },
  ...over,
})

/** 每块 10 字、互不相同：便于精确算预算与断言扩张顺序 */
const filler = (index: number) => blk(index, { text: String(index % 10).repeat(10) })

describe('buildViewportContext · 块渲染', () => {
  it('位置头取锚点块的章节与页码（沿 renderChunkHeader 格式）', () => {
    const blocks = [blk(3, { anchor: { kind: 'pdf', blockIndex: 3, page: 7, section: '4.2 Method' } })]
    const { text } = buildViewportContext(blocks, { min: 3, max: 3 })
    expect(text.split('\n')[0]).toBe('§4.2 Method · p.7')
  })

  it('无章节无页码（DOCX/URL 导入）时不出位置头', () => {
    const { text } = buildViewportContext([blk(0, { text: '正文一段' })], { min: 0, max: 0 })
    expect(text).toBe('正文一段')
  })

  it('只有章节或只有页码时也能出半行位置头', () => {
    const onlySection = buildViewportContext([blk(0, { anchor: { kind: 'html', blockIndex: 0, section: '3 结果' } })], {
      min: 0,
      max: 0,
    })
    expect(onlySection.text.split('\n')[0]).toBe('§3 结果')
    const onlyPage = buildViewportContext([blk(0, { anchor: { kind: 'pdf', blockIndex: 0, page: 2 } })], {
      min: 0,
      max: 0,
    })
    expect(onlyPage.text.split('\n')[0]).toBe('p.2')
  })

  it('标题渲染成 ##，图注照常收进来', () => {
    const blocks = [
      blk(0, { kind: 'heading', level: 2, text: '4.2 Method' }),
      blk(1, { text: '方法段落。' }),
      blk(2, { kind: 'caption', text: '图 3：整体架构' }),
    ]
    const { text } = buildViewportContext(blocks, { min: 0, max: 2 })
    expect(text).toContain('## 4.2 Method')
    expect(text).toContain('图 3：整体架构')
  })

  it('图片只留 [图: alt] 占位，不带 URL', () => {
    const blocks = [blk(0, { kind: 'image', text: '[图: 模型总览]', src: 'https://cdn.example.com/f1.png' })]
    const { text } = buildViewportContext(blocks, { min: 0, max: 0 })
    expect(text).toBe('[图: 模型总览]')
    expect(text).not.toContain('http')
  })

  it('没有 alt 的图片至少留一个占位', () => {
    const blocks = [blk(0, { kind: 'image', text: '', src: 'https://x/y.png' })]
    expect(buildViewportContext(blocks, { min: 0, max: 0 }).text).toBe('[图]')
  })

  it('表格用 text 不用 html', () => {
    const blocks = [
      blk(0, { kind: 'table', text: '方法 准确率\nBERT 88.1', html: '<table><tr><td>BERT</td></tr></table>' }),
    ]
    const { text } = buildViewportContext(blocks, { min: 0, max: 0 })
    expect(text).toContain('BERT 88.1')
    expect(text).not.toContain('<table')
  })

  it('代码块收进来但去掉首尾空白；空白块整块跳过', () => {
    const blocks = [blk(0, { kind: 'code', text: '  \nfor x in xs:\n  pass\n  ' }), blk(1, { text: '   ' })]
    const { text } = buildViewportContext(blocks, { min: 0, max: 1 })
    expect(text).toBe('for x in xs:\n  pass')
  })

  it('按 index 字段取区间，区间外的块不进上下文', () => {
    const blocks = [blk(0), blk(1), blk(2), blk(3)]
    const { text } = buildViewportContext(blocks, { min: 1, max: 2 })
    expect(text).toBe('段落1\n段落2')
  })

  it('块数组顺序错乱时按 index 排序输出', () => {
    const { text } = buildViewportContext([blk(2), blk(0), blk(1)], { min: 0, max: 2 })
    expect(text).toBe('段落0\n段落1\n段落2')
  })
})

describe('buildViewportContext · 空与边界', () => {
  it('空区间（max < min）→ 空文本且不算截断', () => {
    expect(buildViewportContext([blk(0)], { min: 0, max: -1 })).toEqual({ text: '', truncated: false })
  })

  it('区间内没有任何块 → 空文本', () => {
    expect(buildViewportContext([blk(0)], { min: 5, max: 9 })).toEqual({ text: '', truncated: false })
  })

  it('空块数组 → 空文本', () => {
    expect(buildViewportContext([], { min: 0, max: 10 })).toEqual({ text: '', truncated: false })
  })

  it('maxChars ≤ 0 → 空文本', () => {
    expect(buildViewportContext([blk(0)], { min: 0, max: 0 }, { maxChars: 0 })).toEqual({ text: '', truncated: false })
  })

  it('默认预算是 VIEWPORT_MAX_CHARS，够装下正常一屏', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => filler(i))
    const { text, truncated } = buildViewportContext(blocks, { min: 0, max: 11 })
    expect(truncated).toBe(false)
    expect(text.length).toBeLessThan(VIEWPORT_MAX_CHARS)
  })
})

describe('buildViewportContext · 超帽从锚点向外扩', () => {
  const blocks = Array.from({ length: 7 }, (_, i) => filler(i))

  it('先向下扩（用户正在读的方向）', () => {
    const { text, truncated } = buildViewportContext(blocks, { min: 0, max: 6 }, { centerIndex: 3, maxChars: 21 })
    expect(text).toBe(`${'3'.repeat(10)}\n${'4'.repeat(10)}`)
    expect(truncated).toBe(true)
  })

  it('向下装满后再向上补', () => {
    const { text } = buildViewportContext(blocks, { min: 0, max: 6 }, { centerIndex: 3, maxChars: 32 })
    expect(text).toBe([2, 3, 4].map((i) => String(i).repeat(10)).join('\n'))
  })

  it('预算够就全收，truncated=false', () => {
    const { text, truncated } = buildViewportContext(blocks, { min: 0, max: 6 }, { centerIndex: 3, maxChars: 2000 })
    expect(text.split('\n')).toHaveLength(7)
    expect(truncated).toBe(false)
  })

  it('centerIndex 缺省时锚在区间顶块（视口顶部）', () => {
    const { text } = buildViewportContext(blocks, { min: 2, max: 6 }, { maxChars: 21 })
    expect(text).toBe(`${'2'.repeat(10)}\n${'3'.repeat(10)}`)
  })

  it('centerIndex 落在两块之间时锚到上面那块', () => {
    const sparse = [filler(0), filler(4), filler(8)]
    const { text } = buildViewportContext(sparse, { min: 0, max: 8 }, { centerIndex: 6, maxChars: 10 })
    expect(text).toBe('4'.repeat(10))
  })

  it('锚点块自己就超预算 → 硬切一刀并标记截断（宁可给半段也不给空）', () => {
    const long = blk(0, { text: '论'.repeat(100) })
    const { text, truncated } = buildViewportContext([long], { min: 0, max: 0 }, { maxChars: 20 })
    expect(text).toBe('论'.repeat(20))
    expect(truncated).toBe(true)
  })

  it('位置头也计入预算', () => {
    const head = blk(0, { text: '论'.repeat(100), anchor: { kind: 'pdf', blockIndex: 0, page: 7 } })
    const { text } = buildViewportContext([head], { min: 0, max: 0 }, { maxChars: 20 })
    expect(text.startsWith('p.7\n')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(20)
  })
})

describe('buildViewportContext · 选区去重', () => {
  const selection =
    '注意力机制的计算复杂度随序列长度的平方增长，这是长上下文推理的主要瓶颈所在，也是本文要解决的核心问题。'
  const blocks = [blk(0, { text: `前置说明。${selection}后续说明。` })]

  it('≥40 字且正文包含 → 替换为指代说明', () => {
    expect(selection.length).toBeGreaterThanOrEqual(40)
    const { text } = buildViewportContext(blocks, { min: 0, max: 0 }, { selection })
    expect(text).toBe(`前置说明。${SELECTION_DEDUPE_PLACEHOLDER}后续说明。`)
    expect(text).not.toContain(selection)
  })

  it('选区两侧的空白不影响匹配', () => {
    const { text } = buildViewportContext(blocks, { min: 0, max: 0 }, { selection: `\n  ${selection}  \n` })
    expect(text).toContain(SELECTION_DEDUPE_PLACEHOLDER)
  })

  it('短选区（<40 字）不替换：可能只是巧合重合', () => {
    const short = '注意力机制'
    const { text } = buildViewportContext([blk(0, { text: `讲的是${short}。` })], { min: 0, max: 0 }, { selection: short })
    expect(text).toContain(short)
    expect(text).not.toContain(SELECTION_DEDUPE_PLACEHOLDER)
  })

  it('正文里没出现的选区不动正文', () => {
    const elsewhere = '另一段完全不同的选中内容，长度同样超过四十个字符，用来确认去重只在真的重合时才生效，其余情况正文一字不改。'
    expect(elsewhere.length).toBeGreaterThanOrEqual(40)
    const { text } = buildViewportContext(blocks, { min: 0, max: 0 }, { selection: elsewhere })
    expect(text).toContain(selection)
  })

  it('只替换第一处出现', () => {
    const twice = [blk(0, { text: `${selection}|${selection}` })]
    const { text } = buildViewportContext(twice, { min: 0, max: 0 }, { selection })
    expect(text).toBe(`${SELECTION_DEDUPE_PLACEHOLDER}|${selection}`)
  })
})

describe('pageBlockRange · PDF 原版模式退化', () => {
  const map = { 1: 0, 2: 5, 3: 12 }

  it('普通页：本页首块 → 下一页首块前一块', () => {
    expect(pageBlockRange(map, 2, 20)).toEqual({ min: 5, max: 11 })
  })

  it('最后一页吃到末块', () => {
    expect(pageBlockRange(map, 3, 20)).toEqual({ min: 12, max: 19 })
  })

  it('该页没有文本块（整页大图）→ 退到最近的有块页，区间成为超集', () => {
    expect(pageBlockRange({ 1: 0, 3: 12 }, 2, 20)).toEqual({ min: 0, max: 11 })
  })

  it('页码早于第一个有块页 / 映射为空 / 没有块 → 空区间', () => {
    expect(pageBlockRange({ 2: 5 }, 1, 20)).toEqual({ min: 0, max: -1 })
    expect(pageBlockRange({}, 1, 20)).toEqual({ min: 0, max: -1 })
    expect(pageBlockRange(map, 1, 0)).toEqual({ min: 0, max: -1 })
  })

  it('越界的映射值被钳进 [0, blockCount-1]', () => {
    expect(pageBlockRange({ 1: 0, 2: 100 }, 1, 20)).toEqual({ min: 0, max: 19 })
    expect(pageBlockRange({ 1: 999 }, 1, 20)).toEqual({ min: 19, max: 19 })
  })

  it('空区间喂给 buildViewportContext 得到空上下文（整段省略）', () => {
    const range = pageBlockRange({}, 3, 20)
    expect(buildViewportContext([blk(0)], range)).toEqual({ text: '', truncated: false })
  })
})

describe('windowAroundBlock · 无页码格式兜底', () => {
  it('以当前块为中心上下各 span 块', () => {
    expect(windowAroundBlock(10, 100, 3)).toEqual({ min: 7, max: 13 })
  })

  it('两端钳边', () => {
    expect(windowAroundBlock(0, 100, 3)).toEqual({ min: 0, max: 3 })
    expect(windowAroundBlock(99, 100, 3)).toEqual({ min: 96, max: 99 })
  })

  it('默认半径 8', () => {
    expect(windowAroundBlock(10, 100)).toEqual({ min: 2, max: 18 })
  })

  it('没有块 → 空区间；越界的块序号被钳住', () => {
    expect(windowAroundBlock(5, 0)).toEqual({ min: 0, max: -1 })
    expect(windowAroundBlock(999, 10, 2)).toEqual({ min: 7, max: 9 })
  })
})
