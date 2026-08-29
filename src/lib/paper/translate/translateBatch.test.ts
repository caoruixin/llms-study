import { describe, expect, it } from 'vitest'
import {
  BATCH_MAX_ITEMS,
  TRANSLATE_SYSTEM_PROMPT,
  buildTranslateMessages,
  estimateTranslationCost,
  isTranslatableBlock,
  packBatches,
  planTranslationWindow,
  splitLongBlock,
  srcHash,
  translateItemKey,
  validateTranslationJson,
  type TranslateItem,
} from './translateBatch'
import { DEEPSEEK_V4_PRO } from '../../../data/paperPolicy'
import type { PaperBlock, PaperBlockKind } from '../types'

const blk = (index: number, kind: PaperBlockKind, text: string): PaperBlock => ({
  id: `p:${index}`,
  paperId: 'p',
  index,
  kind,
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})

const item = (blockIndex: number, text: string, piece?: number): TranslateItem => ({
  blockIndex,
  kind: 'paragraph',
  text,
  ...(piece !== undefined ? { piece } : {}),
})

describe('isTranslatableBlock', () => {
  it('白名单只放行 heading/paragraph/list/caption', () => {
    expect(isTranslatableBlock('heading')).toBe(true)
    expect(isTranslatableBlock('paragraph')).toBe(true)
    expect(isTranslatableBlock('list')).toBe(true)
    expect(isTranslatableBlock('caption')).toBe(true)
    expect(isTranslatableBlock('formula')).toBe(false)
    expect(isTranslatableBlock('code')).toBe(false)
    expect(isTranslatableBlock('table')).toBe(false)
    // image 不进 allowlist：图不翻译，三态下都渲染原图（占位 text 也不进翻译包）
    expect(isTranslatableBlock('image')).toBe(false)
  })
})

describe('splitLongBlock', () => {
  it('不超限的文本原样单片返回', () => {
    expect(splitLongBlock('short text', 100)).toEqual(['short text'])
  })

  it('优先在句边界切分，分片 join 恒等复原', () => {
    const text = `${'A'.repeat(80)}. ${'B'.repeat(50)}? ${'C'.repeat(40)}`
    const pieces = splitLongBlock(text, 100)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.join('')).toBe(text)
    // 第一片应终止在句号（含）处而不是硬切 100
    expect(pieces[0].endsWith('.')).toBe(true)
  })

  it('没有句边界时硬切在 maxChars，join 仍恒等', () => {
    const text = 'x'.repeat(250)
    const pieces = splitLongBlock(text, 100)
    expect(pieces.map((p) => p.length)).toEqual([100, 100, 50])
    expect(pieces.join('')).toBe(text)
  })

  it('句边界太靠前（<30% 片长）时放弃边界改硬切，防碎片', () => {
    const text = `A. ${'b'.repeat(300)}`
    const pieces = splitLongBlock(text, 100)
    expect(pieces[0].length).toBe(100)
    expect(pieces.join('')).toBe(text)
  })

  it('中文句号同样是切分边界', () => {
    const text = `${'甲'.repeat(80)}。${'乙'.repeat(60)}`
    const pieces = splitLongBlock(text, 100)
    expect(pieces[0].endsWith('。')).toBe(true)
    expect(pieces.join('')).toBe(text)
  })

  it('默认阈值：4500 字符以内不切', () => {
    expect(splitLongBlock('y'.repeat(4500))).toHaveLength(1)
    expect(splitLongBlock('y'.repeat(4501))).toHaveLength(2)
  })
})

describe('planTranslationWindow', () => {
  const blocks = Array.from({ length: 41 }, (_, i) => blk(i, 'paragraph', `para ${i}`))
  const noCache = { has: () => false }

  it('窗口 = 当前块前 4 后 16', () => {
    const items = planTranslationWindow(blocks, 10, noCache)
    expect(items.map((it) => it.blockIndex)).toEqual(Array.from({ length: 21 }, (_, i) => i + 6))
  })

  it('文档头部：窗口向前钳位到 0', () => {
    const items = planTranslationWindow(blocks, 0, noCache)
    expect(items[0].blockIndex).toBe(0)
    expect(items[items.length - 1].blockIndex).toBe(16)
  })

  it('文档尾部：窗口向后钳位到末块', () => {
    const items = planTranslationWindow(blocks, 40, noCache)
    expect(items[0].blockIndex).toBe(36)
    expect(items[items.length - 1].blockIndex).toBe(40)
  })

  it('已缓存/不可译/空白块都跳过', () => {
    const mixed = [
      blk(0, 'paragraph', 'keep'),
      blk(1, 'code', 'const x = 1'),
      blk(2, 'paragraph', '   '),
      blk(3, 'formula', 'E=mc^2'),
      blk(4, 'heading', 'cached'),
      blk(5, 'caption', 'Figure 1'),
    ]
    const items = planTranslationWindow(mixed, 0, { has: (i) => i === 4 })
    expect(items.map((it) => it.blockIndex)).toEqual([0, 5])
  })

  it('长块展开为带分片号的连续条目，且分片可复原原文', () => {
    const long = 'z'.repeat(9200)
    const items = planTranslationWindow([blk(7, 'paragraph', long)], 7, noCache)
    expect(items.length).toBeGreaterThan(1)
    expect(items.map((it) => it.piece)).toEqual(items.map((_, i) => i))
    expect(items.every((it) => it.blockIndex === 7)).toBe(true)
    expect(items.map((it) => it.text).join('')).toBe(long)
  })
})

describe('packBatches', () => {
  it('按 token 上限分包且保持顺序', () => {
    // 2400 字符 ≈ 800 token：两条 1600 可同包，第三条超 1800 另起
    const items = Array.from({ length: 5 }, (_, i) => item(i, 'w'.repeat(2400)))
    const batches = packBatches(items)
    expect(batches.map((b) => b.map((it) => it.blockIndex))).toEqual([[0, 1], [2, 3], [4]])
  })

  it('按条数上限 24 分包', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(i, 'tiny'))
    const batches = packBatches(items)
    expect(batches.map((b) => b.length)).toEqual([BATCH_MAX_ITEMS, 6])
    expect(batches[1][0].blockIndex).toBe(24)
  })

  it('单条超 token 上限时独立成包（不丢弃）', () => {
    const items = [item(0, 'a'.repeat(9000)), item(1, 'b')]
    const batches = packBatches(items)
    expect(batches.map((b) => b.map((it) => it.blockIndex))).toEqual([[0], [1]])
  })

  it('空输入产出零包', () => {
    expect(packBatches([])).toEqual([])
  })
})

describe('buildTranslateMessages', () => {
  it('system 字节稳定（与包内容无关），user 为 i/p/k/t 的 JSON', () => {
    const m1 = buildTranslateMessages([item(3, 'hello world')])
    const m2 = buildTranslateMessages([item(9, 'other', 1), item(10, 'x')])
    expect(m1[0].role).toBe('system')
    expect(m1[0].content).toBe(TRANSLATE_SYSTEM_PROMPT)
    expect(m2[0].content).toBe(m1[0].content)

    expect(JSON.parse(m1[1].content)).toEqual({ items: [{ i: 3, k: 'paragraph', t: 'hello world' }] })
    expect(JSON.parse(m2[1].content)).toEqual({
      items: [
        { i: 9, p: 1, k: 'paragraph', t: 'other' },
        { i: 10, k: 'paragraph', t: 'x' },
      ],
    })
  })
})

describe('validateTranslationJson', () => {
  const keys = ['1', '2#0', '2#1']
  const good = JSON.stringify({
    items: [
      { i: 1, zh: '一' },
      { i: 2, p: 0, zh: '二上' },
      { i: 2, p: 1, zh: '二下' },
    ],
  })

  it('键集合完全相等且 zh 非空 → 返回 键→译文 Map', () => {
    const map = validateTranslationJson(good, keys)
    expect(map).not.toBeNull()
    expect(map!.get('1')).toBe('一')
    expect(map!.get('2#0')).toBe('二上')
    expect(map!.get('2#1')).toBe('二下')
  })

  it('条目乱序不影响（校验的是集合相等）', () => {
    const shuffled = JSON.stringify({
      items: [
        { i: 2, p: 1, zh: '二下' },
        { i: 1, zh: '一' },
        { i: 2, p: 0, zh: '二上' },
      ],
    })
    expect(validateTranslationJson(shuffled, keys)).not.toBeNull()
  })

  it('markdown 围栏包裹的 JSON 也接受（首尾大括号裁剪）', () => {
    expect(validateTranslationJson('```json\n' + good + '\n```', keys)).not.toBeNull()
  })

  it('缺条 → null', () => {
    const raw = JSON.stringify({ items: [{ i: 1, zh: '一' }, { i: 2, p: 0, zh: '二' }] })
    expect(validateTranslationJson(raw, keys)).toBeNull()
  })

  it('多条 → null', () => {
    const raw = JSON.stringify({
      items: [
        { i: 1, zh: '一' },
        { i: 2, p: 0, zh: '二' },
        { i: 2, p: 1, zh: '三' },
        { i: 99, zh: '多' },
      ],
    })
    expect(validateTranslationJson(raw, keys)).toBeNull()
  })

  it('i 不匹配 → null', () => {
    const raw = JSON.stringify({
      items: [
        { i: 7, zh: '一' },
        { i: 2, p: 0, zh: '二' },
        { i: 2, p: 1, zh: '三' },
      ],
    })
    expect(validateTranslationJson(raw, keys)).toBeNull()
  })

  it('该带 p 的条目丢了 p → null（键集合不等）', () => {
    const raw = JSON.stringify({
      items: [
        { i: 1, zh: '一' },
        { i: 2, zh: '二' },
        { i: 2, p: 1, zh: '三' },
      ],
    })
    expect(validateTranslationJson(raw, keys)).toBeNull()
  })

  it('重复键 → null', () => {
    const raw = JSON.stringify({
      items: [
        { i: 1, zh: '一' },
        { i: 1, zh: '又一' },
        { i: 2, p: 0, zh: '二' },
      ],
    })
    expect(validateTranslationJson(raw, keys)).toBeNull()
  })

  it('空 zh / 纯空白 zh / 非字符串 zh → null', () => {
    for (const zh of ['', '   ', 42]) {
      const raw = JSON.stringify({
        items: [
          { i: 1, zh },
          { i: 2, p: 0, zh: '二' },
          { i: 2, p: 1, zh: '三' },
        ],
      })
      expect(validateTranslationJson(raw, keys)).toBeNull()
    }
  })

  it('非 JSON / 顶层数组 / 缺 items → null', () => {
    expect(validateTranslationJson('对不起，我直接给你翻译……', keys)).toBeNull()
    expect(validateTranslationJson('[1,2,3]', keys)).toBeNull()
    expect(validateTranslationJson('{"foo":1}', keys)).toBeNull()
  })
})

describe('estimateTranslationCost', () => {
  it('只统计可译块，成本 = 输入价 + 输出价（估算为正且量级合理）', () => {
    const blocks = [
      blk(0, 'heading', 'Attention Is All You Need'),
      blk(1, 'paragraph', 'The dominant sequence transduction models are based on complex recurrent networks. '.repeat(20)),
      blk(2, 'code', 'ignored'),
      blk(3, 'paragraph', 'x'.repeat(3000)),
    ]
    const est = estimateTranslationCost(blocks, DEEPSEEK_V4_PRO.pricing)
    expect(est.translatableBlocks).toBe(3)
    expect(est.batches).toBeGreaterThan(0)
    expect(est.inputTokens).toBeGreaterThan(est.outputTokens) // 输入含 system 提示 + JSON 包装
    expect(est.cost).toBeGreaterThan(0)
    expect(est.cost).toBeLessThan(0.05) // 几段文本远小于一篇 30 页白皮书（≈$0.046）
  })

  it('空文档 / 全不可译 → 零成本零包', () => {
    const est = estimateTranslationCost([blk(0, 'code', 'x')], DEEPSEEK_V4_PRO.pricing)
    expect(est).toMatchObject({ translatableBlocks: 0, batches: 0, inputTokens: 0, outputTokens: 0, cost: 0 })
  })
})

describe('srcHash / translateItemKey', () => {
  it('FNV-1a：确定性、8 位十六进制、不同输入不同哈希', () => {
    expect(srcHash('hello')).toBe(srcHash('hello'))
    expect(srcHash('hello')).toMatch(/^[0-9a-f]{8}$/)
    expect(srcHash('hello')).not.toBe(srcHash('hellp'))
    expect(srcHash('')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('条目键编码：整块用 i，分片用 i#p', () => {
    expect(translateItemKey(5)).toBe('5')
    expect(translateItemKey(5, 0)).toBe('5#0')
    expect(translateItemKey(5, 2)).toBe('5#2')
  })
})
