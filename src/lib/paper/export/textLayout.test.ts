import { describe, expect, it } from 'vitest'
import { baselineOffset, fitTextInBox, isCjkCodePoint, justifySpacing, tokenize, wrapText, type WrappedLine } from './textLayout'

/** 假测量：CJK 一个字 = size，其余字符 = 0.5 × size（空格也算 0.5） */
const measureAt = (text: string, size: number): number => {
  let w = 0
  for (const ch of text) w += isCjkCodePoint(ch.codePointAt(0) ?? 0) ? size : size / 2
  return w
}
const SIZE = 10
const measure = (t: string) => measureAt(t, SIZE)
const texts = (lines: readonly WrappedLine[]) => lines.map((l) => l.text)

describe('tokenize', () => {
  it('CJK 逐字、拉丁串连同紧邻 ASCII 标点一个 word、空白 space、换行 break', () => {
    expect(tokenize('中文 hello, world (x)\n下')).toEqual([
      { kind: 'cjk', text: '中' },
      { kind: 'cjk', text: '文' },
      { kind: 'space', text: ' ' },
      { kind: 'word', text: 'hello,' },
      { kind: 'space', text: ' ' },
      { kind: 'word', text: 'world' },
      { kind: 'space', text: ' ' },
      { kind: 'word', text: '(x)' },
      { kind: 'break' },
      { kind: 'cjk', text: '下' },
    ])
  })

  it('全角标点逐字；\\r 丢弃；连续空白合成一个 space', () => {
    expect(tokenize('一，二\r\n  三')).toEqual([
      { kind: 'cjk', text: '一' },
      { kind: 'cjk', text: '，' },
      { kind: 'cjk', text: '二' },
      { kind: 'break' },
      { kind: 'space', text: '  ' },
      { kind: 'cjk', text: '三' },
    ])
  })
})

describe('wrapText', () => {
  it('贪心填充：3 字一行；末行 last；空文本 → []', () => {
    const lines = wrapText('一二三四五六七', 30, measure)
    expect(texts(lines)).toEqual(['一二三', '四五六', '七'])
    expect(lines.map((l) => l.last)).toEqual([false, false, true])
    expect(lines[0].width).toBe(30)
    expect(wrapText('', 30, measure)).toEqual([])
  })

  it('拉丁按词断行：行尾空白不计宽、行首空白丢弃', () => {
    const lines = wrapText('hello world foo', 60, measure)
    expect(texts(lines)).toEqual(['hello world', 'foo'])
    expect(lines[0].width).toBe(55)
  })

  it('避头尾：行首禁标点 → 上一个字一起带下去；行尾禁开标点 → 带到下一行', () => {
    expect(texts(wrapText('一二三，四', 30, measure))).toEqual(['一二', '三，四'])
    expect(texts(wrapText('一二（三四', 30, measure))).toEqual(['一二', '（三四'])
    // ASCII 逗号单独成 word（前面是 CJK）：同样禁行首
    expect(texts(wrapText('一二三,四', 30, measure))).toEqual(['一二', '三,四'])
    // 粘在拉丁词尾的标点本就在词里，不会独占行首
    expect(texts(wrapText('ab cd, ef', 30, measure))).toEqual(['ab cd,', 'ef'])
  })

  it('整行只剩一个 atom 时允许标点悬挂，不独占行首也不死循环', () => {
    const lines = wrapText('一，', 10, measure)
    expect(texts(lines)).toEqual(['一，'])
    expect(lines[0].width).toBe(20)
  })

  it('超宽 atom（URL）按码点硬切；后续文字接在切剩的尾巴后', () => {
    const lines = wrapText('https://example.com/abc 下', 50, measure)
    // 每行 10 个半宽字符；最后一截 "abc" 之后接空格与 "下"
    expect(texts(lines)).toEqual(['https://ex', 'ample.com/', 'abc 下'])
  })

  it('首行缩进 / 悬挂缩进只减可用宽度，indent 记在行上', () => {
    const lines = wrapText('一二三四五', 30, measure, { firstLineIndent: 10 })
    expect(texts(lines)).toEqual(['一二', '三四五'])
    expect(lines[0].indent).toBe(10)
    expect(lines[1].indent).toBe(0)
    const hang = wrapText('一二三四五六', 30, measure, { hangingIndent: 10 })
    expect(texts(hang)).toEqual(['一二三', '四五', '六'])
    expect(hang.map((l) => l.indent)).toEqual([0, 10, 10])
  })

  it('硬换行：hard 标记；连续换行出空行', () => {
    const lines = wrapText('a\n\nb', 100, measure)
    expect(texts(lines)).toEqual(['a', '', 'b'])
    expect(lines.map((l) => l.hard)).toEqual([true, true, false])
  })

  it('breakAll：逐字换行、无避头尾（代码块）', () => {
    expect(texts(wrapText('abcdef,gh', 20, measure, { breakAll: true }))).toEqual(['abcd', 'ef,g', 'h'])
  })

  it('breakAll：硬行行首缩进保留（代码），正文仍丢行首空白', () => {
    const code = 'def f(x):\n    return x\n\tpass'
    expect(texts(wrapText(code, 1000, measure, { breakAll: true }))).toEqual(['def f(x):', '    return x', '\tpass'])
    expect(texts(wrapText('a\n    b', 1000, measure))).toEqual(['a', 'b'])
  })
})

describe('justifySpacing', () => {
  const line = (over: Partial<WrappedLine> = {}): WrappedLine => ({ text: '一二三', width: 30, indent: 0, hard: false, last: false, ...over })

  it('Tc = 余量 / (字数 − 1)；末行 / 硬换行 / 单字 / 没有余量 → 0', () => {
    expect(justifySpacing(line(), 31, SIZE)).toBeCloseTo(0.5)
    expect(justifySpacing(line({ last: true }), 31, SIZE)).toBe(0)
    expect(justifySpacing(line({ hard: true }), 31, SIZE)).toBe(0)
    expect(justifySpacing(line({ text: '一', width: 10 }), 31, SIZE)).toBe(0)
    // 缩进算进可用宽：30 + 1 = 31 → 没有余量
    expect(justifySpacing(line({ indent: 1 }), 31, SIZE)).toBe(0)
  })

  it('间距 > 0.08 × size（= 0.8）放弃对齐（拉丁短行）', () => {
    expect(justifySpacing(line(), 40, SIZE)).toBe(0)
    expect(justifySpacing(line(), 32, SIZE)).toBe(0)
    expect(justifySpacing(line(), 31.4, SIZE)).toBeCloseTo(0.7)
  })
})

describe('fitTextInBox', () => {
  it('溢出按 planFontFit 缩字号（行距等比），到位即停', () => {
    const r = fitTextInBox('一二三四五六七八九十一二', { w: 30, h: 24 }, { f0: 10, pitch0: 12, fMin: 6, measureAt })
    expect(r.overflow).toBe(false)
    expect(r.size).toBeLessThan(10)
    expect(r.size).toBeGreaterThanOrEqual(6)
    expect(r.pitch).toBeCloseTo((12 * r.size) / 10)
    expect(r.lines.length * r.pitch).toBeLessThanOrEqual(24 + 1e-6)
  })

  it('放得下就不动字号', () => {
    const r = fitTextInBox('一二', { w: 30, h: 24 }, { f0: 10, pitch0: 12, fMin: 6, measureAt })
    expect(r.size).toBe(10)
    expect(r.pitch).toBe(12)
    expect(r.lines).toHaveLength(1)
  })

  it('到下限仍溢出 → overflow，保留能放下的行并把末行尾部换 …', () => {
    const r = fitTextInBox('一二三四五六七八九十'.repeat(10), { w: 30, h: 12 }, { f0: 10, pitch0: 12, fMin: 6, measureAt })
    expect(r.overflow).toBe(true)
    expect(r.size).toBe(6)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].text.endsWith('…')).toBe(true)
    expect(r.lines[0].width).toBeLessThanOrEqual(30 + 1e-6)
    expect(r.lines[0].last).toBe(true)
  })

  it('首行缩进固定不随字号缩', () => {
    const r = fitTextInBox('一二三四五六七八', { w: 30, h: 100 }, { f0: 10, pitch0: 12, fMin: 6, indent: 10, measureAt })
    expect(r.lines[0].indent).toBe(10)
    expect(r.lines[0].text).toBe('一二')
  })
})

describe('baselineOffset', () => {
  it('CSS 行盒：(pitch − contentH) / 2 + ascent × size / upm', () => {
    expect(baselineOffset(10, 12, { unitsPerEm: 1000, ascent: 800, descent: -200 })).toBeCloseTo(9)
    expect(baselineOffset(10, 10, { unitsPerEm: 1000, ascent: 800, descent: -200 })).toBeCloseTo(8)
  })
})
