// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { COL_MAX, COL_MIN, MIN_COL_WIDTH, parseTableHtml, planTableColumns, SMALL_FONT } from './textDocTables'

const measure = (text: string, size: number): number => Array.from(text).length * size * 0.5

describe('parseTableHtml', () => {
  it('thead 行为表头；短行补空串；空白折叠；嵌套表格的行不算', () => {
    const html = `
      <table>
        <thead><tr><th> Name </th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>a\n  b</td><td>1</td><td>extra</td></tr>
          <tr><td>c</td></tr>
          <tr><td><table><tr><td>nested</td></tr></table></td><td>2</td></tr>
        </tbody>
      </table>`
    const t = parseTableHtml(html, document)!
    expect(t.cols).toBe(3)
    expect(t.headerRows).toBe(1)
    expect(t.rows).toEqual([
      ['Name', 'Value', ''],
      ['a b', '1', 'extra'],
      ['c', '', ''],
      ['nested', '2', ''],
    ])
  })

  it('没有 thead 时开头全是 th 的行算表头，中途的 th 行不算', () => {
    const t = parseTableHtml('<table><tr><th>h1</th><th>h2</th></tr><tr><td>x</td><td>y</td></tr><tr><th>z</th><th>w</th></tr></table>', document)!
    expect(t.headerRows).toBe(1)
    expect(t.rows).toHaveLength(3)
  })

  it('colspan 忽略（V1）；没有 table / 没有行 → null', () => {
    const t = parseTableHtml('<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>', document)!
    expect(t.cols).toBe(2)
    expect(t.rows[0]).toEqual(['wide', ''])
    expect(parseTableHtml('<p>no table</p>', document)).toBeNull()
    expect(parseTableHtml('<table></table>', document)).toBeNull()
  })
})

describe('planTableColumns', () => {
  it('列宽 ∝ clamp(平均内容宽, 40, 200) 归一到总宽', () => {
    const rows = [
      ['a', 'x'.repeat(100), 'mid-sized'],
      ['b', 'y'.repeat(100), 'content'],
    ]
    const r = planTableColumns({ rows, cols: 3 }, 487, measure, 8.5)!
    expect(r.fontSize).toBe(8.5)
    expect(r.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(487)
    // 平均内容宽：4.25 → 40；425 → 200；~34 → 40
    const raw = [COL_MIN, COL_MAX, COL_MIN]
    const sum = raw.reduce((a, b) => a + b, 0)
    r.widths.forEach((w, i) => expect(w).toBeCloseTo((raw[i] / sum) * 487))
  })

  it('> 8 列降到 7 pt；列均宽 < 24 → null', () => {
    const many = { rows: [Array.from({ length: 9 }, () => 'c')], cols: 9 }
    expect(planTableColumns(many, 487, measure, 8.5)!.fontSize).toBe(SMALL_FONT)
    const tooMany = { rows: [Array.from({ length: 21 }, () => 'c')], cols: 21 }
    expect(487 / 21).toBeLessThan(MIN_COL_WIDTH)
    expect(planTableColumns(tooMany, 487, measure, 8.5)).toBeNull()
    expect(planTableColumns({ rows: [], cols: 0 }, 487, measure, 8.5)).toBeNull()
  })
})
