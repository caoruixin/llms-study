import { describe, expect, it } from 'vitest'
import { MAX_ISLAND_RAW_BYTES, parseIslandJson, validateIsland } from './blockSchemas'

describe('parseIslandJson（首{末}切片）', () => {
  it('剥掉围栏外杂讯', () => {
    expect(parseIslandJson('前缀 {"a":1} 后缀')).toEqual({ a: 1 })
  })
  it('无对象 / 坏 JSON / 数组 → null', () => {
    expect(parseIslandJson('没有对象')).toBeNull()
    expect(parseIslandJson('{"a":')).toBeNull()
    expect(parseIslandJson('[1,2]')).toBeNull()
  })
})

describe('validateIsland · explanation', () => {
  it('完整块通过，字段钳位', () => {
    const r = validateIsland('explanation', JSON.stringify({ text: '讲解', level: '进阶', points: ['p1'], cites: ['c1'] }))
    expect(r).toEqual({
      ok: true,
      block: { kind: 'explanation', text: '讲解', level: '进阶', points: ['p1'], cites: ['c1'] },
    })
  })
  it('缺 text → invalid；非法 level 剔除；坏 cite 别名剔除', () => {
    expect(validateIsland('explanation', '{"points":["x"]}')).toEqual({ ok: false, failure: 'invalid' })
    const r = validateIsland('explanation', JSON.stringify({ text: 't', level: '大师', cites: ['c1', 'x9', 'c1234'] }))
    expect(r.ok && !('level' in r.block)).toBe(true)
    expect(r.ok && (r.block as { cites: string[] }).cites).toEqual(['c1'])
  })
  it('points 超 12 条截断', () => {
    const r = validateIsland('explanation', JSON.stringify({ text: 't', points: Array.from({ length: 20 }, (_, i) => `p${i}`) }))
    expect(r.ok && (r.block as { points: string[] }).points).toHaveLength(12)
  })
})

describe('validateIsland · formula', () => {
  it('expr + terms + steps + cites 全通过', () => {
    const r = validateIsland(
      'formula',
      JSON.stringify({ expr: '2 n L', terms: [{ sym: 'L', mean: '上下文长度' }], steps: ['s1'], cites: ['c2'] }),
    )
    expect(r).toEqual({
      ok: true,
      block: { kind: 'formula', expr: '2 n L', terms: [{ sym: 'L', mean: '上下文长度' }], steps: ['s1'], cites: ['c2'] },
    })
  })
  it('缺 expr → invalid；坏 term 项剔除（宽松修复）', () => {
    expect(validateIsland('formula', '{"terms":[]}')).toEqual({ ok: false, failure: 'invalid' })
    const r = validateIsland('formula', JSON.stringify({ expr: 'x', terms: [{ sym: 'a' }, null, { sym: 'b', mean: 'B' }] }))
    expect(r.ok && (r.block as { terms: unknown[] }).terms).toEqual([{ sym: 'b', mean: 'B' }])
  })
  it('terms 超 24 条截断', () => {
    const terms = Array.from({ length: 30 }, (_, i) => ({ sym: `s${i}`, mean: `m${i}` }))
    const r = validateIsland('formula', JSON.stringify({ expr: 'x', terms }))
    expect(r.ok && (r.block as { terms: unknown[] }).terms).toHaveLength(24)
  })
})

describe('validateIsland · 控制岛', () => {
  it('plan：任一有效信息即接受', () => {
    const r = validateIsland('plan', JSON.stringify({ concepts: ['kv-cache'], level: '进阶', strategy: '先直觉', blocks: ['quiz'] }))
    expect(r.ok && r.block).toEqual({ kind: 'plan', concepts: ['kv-cache'], blocks: ['quiz'], level: '进阶', strategy: '先直觉' })
    expect(validateIsland('plan', '{}')).toEqual({ ok: false, failure: 'invalid' })
  })
  it('memo：summary 或 text 字段均可', () => {
    expect(validateIsland('memo', '{"summary":"摘要"}')).toEqual({ ok: true, block: { kind: 'memo', summary: '摘要' } })
    expect(validateIsland('memo', '{"text":"备用字段"}')).toEqual({ ok: true, block: { kind: 'memo', summary: '备用字段' } })
    expect(validateIsland('memo', '{"other":1}')).toEqual({ ok: false, failure: 'invalid' })
  })
  it('evidence：status 枚举', () => {
    expect(validateIsland('evidence', '{"status":"insufficient","note":"缺 §5 数据"}')).toEqual({
      ok: true,
      block: { kind: 'evidence', status: 'insufficient', note: '缺 §5 数据' },
    })
    expect(validateIsland('evidence', '{"status":"maybe"}')).toEqual({ ok: false, failure: 'invalid' })
  })
})

describe('validateIsland · 降级矩阵（§7.5）', () => {
  it('未知 TYPE（learner/verdict 属 Phase 4）→ unknown-type，不报错', () => {
    expect(validateIsland('learner', '{"signals":[]}')).toEqual({ ok: false, failure: 'unknown-type', detail: 'learner' })
    expect(validateIsland('quiz', '{}')).toMatchObject({ ok: false, failure: 'unknown-type' })
  })
  it('闭合岛 JSON 解析失败 → bad-json', () => {
    expect(validateIsland('explanation', '{"text": 截断了')).toEqual({ ok: false, failure: 'bad-json' })
  })
  it('原文 >8KB → too-large（在 JSON 解析之前判定）', () => {
    const huge = `{"text":"${'x'.repeat(MAX_ISLAND_RAW_BYTES)}"}`
    expect(validateIsland('explanation', huge)).toEqual({ ok: false, failure: 'too-large' })
  })
  it('类型大小写不敏感', () => {
    expect(validateIsland('MEMO', '{"summary":"s"}')).toEqual({ ok: true, block: { kind: 'memo', summary: 's' } })
  })
})
