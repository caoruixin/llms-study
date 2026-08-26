import { describe, expect, it } from 'vitest'
import { mergeRanges, newHighlightId, splitByRanges, validRanges } from './highlightModel'
import type { PaperHighlight } from '../types'

const SOURCE = 'The quick brown fox jumps over the lazy dog'

const row = (id: string, start: number, end: number, overrides: Partial<PaperHighlight> = {}): PaperHighlight => ({
  id,
  paperId: 'p1',
  blockIndex: 0,
  blockId: 'p1:0',
  lang: 'orig',
  start,
  end,
  text: SOURCE.slice(start, end),
  createdAt: 1,
  ...overrides,
})

describe('mergeRanges', () => {
  it('无既有行：原样返回，不删任何行', () => {
    expect(mergeRanges([], 4, 9)).toEqual({ start: 4, end: 9, toDelete: [] })
  })

  it('不相交也不相邻的旧行不被吞并', () => {
    const r = mergeRanges([row('a', 0, 3), row('b', 20, 25)], 4, 9)
    expect(r).toEqual({ start: 4, end: 9, toDelete: [] })
  })

  it('相交旧行被吞并，区间取并集', () => {
    const r = mergeRanges([row('a', 4, 9)], 6, 15)
    expect(r.start).toBe(4)
    expect(r.end).toBe(15)
    expect(r.toDelete).toEqual(['a'])
  })

  it('相邻（端点相接）也吞并：新区间恰好接住左右两条', () => {
    const r = mergeRanges([row('a', 0, 3), row('b', 9, 15)], 3, 9)
    expect(r).toMatchObject({ start: 0, end: 15 })
    expect([...r.toDelete].sort()).toEqual(['a', 'b'])
  })

  it('新区间完全覆盖多条旧行：全部吞并', () => {
    const r = mergeRanges([row('a', 4, 6), row('b', 8, 10), row('c', 12, 14)], 0, 20)
    expect(r).toMatchObject({ start: 0, end: 20 })
    expect(r.toDelete).toHaveLength(3)
  })

  it('历史脏数据的连锁吞并：吞并一条后与更早跳过的一条相接，也要收进来', () => {
    // 不变式下 [0,1] 与 [1,10] 不会共存；防御路径要能收敛到不动点
    const r = mergeRanges([row('x', 0, 1), row('y', 1, 10)], 5, 6)
    expect(r).toMatchObject({ start: 0, end: 10 })
    expect([...r.toDelete].sort()).toEqual(['x', 'y'])
  })
})

describe('validRanges', () => {
  it('快照一致的行保留，失配的行被过滤', () => {
    const good = row('a', 4, 9)
    const stale = row('b', 10, 15, { text: '已经对不上的旧快照' })
    expect(validRanges(SOURCE, [good, stale])).toEqual([good])
  })

  it('区间越界或空区间被过滤', () => {
    const tooFar = row('a', 40, 99, { text: SOURCE.slice(40) })
    const negative = row('b', -1, 3, { text: SOURCE.slice(0, 3) })
    const empty = row('c', 5, 5, { text: '' })
    expect(validRanges(SOURCE, [tooFar, negative, empty])).toEqual([])
  })

  it('恰好到串尾的区间合法', () => {
    const tail = row('a', 35, SOURCE.length)
    expect(validRanges(SOURCE, [tail])).toEqual([tail])
  })
})

describe('splitByRanges', () => {
  it('无区间：整串一段普通文本', () => {
    expect(splitByRanges(SOURCE, [])).toEqual([{ text: SOURCE }])
  })

  it('中段高亮：前后各一段普通文本，高亮段带 id', () => {
    expect(splitByRanges('abcdef', [row('h', 2, 4)])).toEqual([
      { text: 'ab' },
      { text: 'cd', id: 'h' },
      { text: 'ef' },
    ])
  })

  it('区间从 0 开始 / 到串尾结束：不产生空段', () => {
    expect(splitByRanges('abcd', [row('h', 0, 2)])).toEqual([{ text: 'ab', id: 'h' }, { text: 'cd' }])
    expect(splitByRanges('abcd', [row('h', 2, 4)])).toEqual([{ text: 'ab' }, { text: 'cd', id: 'h' }])
    expect(splitByRanges('abcd', [row('h', 0, 4)])).toEqual([{ text: 'abcd', id: 'h' }])
  })

  it('多区间乱序入参：按位置输出，间隙成普通段', () => {
    expect(splitByRanges('abcdefgh', [row('b', 6, 8), row('a', 0, 2)])).toEqual([
      { text: 'ab', id: 'a' },
      { text: 'cdef' },
      { text: 'gh', id: 'b' },
    ])
  })

  it('相邻区间之间没有空普通段', () => {
    expect(splitByRanges('abcd', [row('a', 0, 2), row('b', 2, 4)])).toEqual([
      { text: 'ab', id: 'a' },
      { text: 'cd', id: 'b' },
    ])
  })

  it('越界区间钳位；重叠的后一条防御性跳过', () => {
    expect(splitByRanges('abcd', [row('a', -3, 99)])).toEqual([{ text: 'abcd', id: 'a' }])
    expect(splitByRanges('abcdef', [row('a', 0, 4), row('b', 2, 6)])).toEqual([
      { text: 'abcd', id: 'a' },
      { text: 'ef' },
    ])
  })

  it('空串：无段输出', () => {
    expect(splitByRanges('', [])).toEqual([])
  })
})

describe('newHighlightId', () => {
  it('非空且两次生成不同', () => {
    const a = newHighlightId()
    const b = newHighlightId()
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })
})
