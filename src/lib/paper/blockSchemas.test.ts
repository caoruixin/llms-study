import { describe, expect, it } from 'vitest'
import {
  BLOCK_LIMITS,
  CONTROL_ISLAND_TYPES,
  MAX_ISLAND_RAW_BYTES,
  isControlIsland,
  islandRenderMode,
  parseIslandJson,
  repairLatexBackslashes,
  validateIsland,
} from './blockSchemas'

/** 取校验通过的块，失败直接抛（测试里省掉逐处 ok 判断） */
function block(type: string, json: unknown): Record<string, unknown> {
  const r = validateIsland(type, JSON.stringify(json))
  if (!r.ok) throw new Error(`expected ok, got ${r.failure}`)
  return r.block as unknown as Record<string, unknown>
}

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

describe('repairLatexBackslashes（公式密集岛的唯一一种温和修复）', () => {
  it('未转义的 LaTeX 反斜杠补成 \\\\，修复后可解析', () => {
    const broken = String.raw`{"expr":"\alpha + \sigma"}`
    expect(parseIslandJson(broken)).toEqual({ expr: String.raw`\alpha + \sigma` })
    const formula = validateIsland('formula', String.raw`{"expr":"\sqrt{d_k} \cdot \alpha","terms":[],"steps":[]}`)
    expect(formula.ok && (formula.block as { expr: string }).expr).toBe(String.raw`\sqrt{d_k} \cdot \alpha`)
  })

  it('已知边界：\\b / \\f 开头的命令（\\beta、\\frac）本身就是合法 JSON 转义，不在修复范围内', () => {
    // 单独出现时 JSON.parse 直接成功（得到退格/换页控制符），修复路径根本不会被触发——
    // 这一档只能靠 prompt 的「JSON 转义铁律」收敛，此处锁定行为避免误以为已修复
    expect(parseIslandJson(String.raw`{"expr":"\beta"}`)).toEqual({ expr: '\beta' })
  })

  it('合法 JSON 转义不被误改：\\n 仍是换行，已双写的 \\\\ 不再加层', () => {
    // \n 是合法转义（保持换行语义），同段里的 \alpha 才被修复
    expect(parseIslandJson(String.raw`{"a":"x\ny\alpha"}`)).toEqual({ a: 'x\ny\\alpha' })
    // 已正确双写的输入首次 parse 就成功，修复函数不介入；单独调用也保持幂等
    expect(parseIslandJson(String.raw`{"a":"\\alpha"}`)).toEqual({ a: String.raw`\alpha` })
    expect(repairLatexBackslashes(String.raw`{"a":"\\alpha"}`)).toBe(String.raw`{"a":"\\alpha"}`)
    expect(repairLatexBackslashes(String.raw`{"a":"line\nnext\ttabé"}`)).toBe(
      String.raw`{"a":"line\nnext\ttabé"}`,
    )
    expect(repairLatexBackslashes('无反斜杠原样返回')).toBe('无反斜杠原样返回')
  })

  it('彻底坏掉的 JSON 修复后仍失败 → 照旧走 bad-json 降级', () => {
    expect(parseIslandJson(String.raw`{"expr":"\alpha`)).toBeNull()
    expect(validateIsland('formula', String.raw`{"expr":"\alpha", 截断了`)).toEqual({ ok: false, failure: 'bad-json' })
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

describe('validateIsland · stepper', () => {
  it('步骤含标题/说明/伪代码', () => {
    const b = block('stepper', {
      title: 'PagedAttention',
      steps: [{ title: '分页', detail: '按块分配', code: 'for b in blocks:' }],
      cites: ['c1'],
    })
    expect(b).toEqual({
      kind: 'stepper',
      title: 'PagedAttention',
      steps: [{ title: '分页', detail: '按块分配', code: 'for b in blocks:' }],
      cites: ['c1'],
    })
  })
  it('容错：字符串数组步骤；坏项剔除；无有效步骤 → invalid', () => {
    expect(block('stepper', { steps: ['第一步', null, { detail: '缺标题' }] }).steps).toEqual([{ title: '第一步' }])
    expect(validateIsland('stepper', '{"steps":[]}')).toEqual({ ok: false, failure: 'invalid' })
  })
  it('步骤数钳到上限', () => {
    const steps = Array.from({ length: 30 }, (_, i) => `s${i}`)
    expect(block('stepper', { steps }).steps).toHaveLength(BLOCK_LIMITS.stepperSteps)
  })
})

describe('validateIsland · comparison', () => {
  it('行列对齐：缺格补空、多格截断', () => {
    const b = block('comparison', {
      columns: ['A', 'B'],
      rows: [{ label: '延迟', cells: ['1'] }, { label: '成本', cells: ['2', '3', '4'] }],
    })
    expect(b.rows).toEqual([
      { label: '延迟', cells: ['1', ''] },
      { label: '成本', cells: ['2', '3'] },
    ])
  })
  it('列数 <2 或无有效行 → invalid；数字单元格转字符串', () => {
    expect(validateIsland('comparison', '{"columns":["A"],"rows":[{"label":"x","cells":["1"]}]}')).toEqual({
      ok: false,
      failure: 'invalid',
    })
    expect(validateIsland('comparison', '{"columns":["A","B"],"rows":[]}')).toEqual({ ok: false, failure: 'invalid' })
    expect(block('comparison', { columns: ['A', 'B'], rows: [{ label: 'x', cells: [1, true] }] }).rows).toEqual([
      { label: 'x', cells: ['1', ''] },
    ])
  })
  it('行列上限钳位', () => {
    const b = block('comparison', {
      columns: Array.from({ length: 12 }, (_, i) => `c${i}`),
      rows: Array.from({ length: 20 }, (_, i) => ({ label: `r${i}`, cells: [] })),
    })
    expect((b.columns as string[]).length).toBe(BLOCK_LIMITS.comparisonColumns)
    expect((b.rows as unknown[]).length).toBe(BLOCK_LIMITS.comparisonRows)
  })
})

describe('validateIsland · concept-map / flow', () => {
  it('节点去重、悬空边与自环剔除', () => {
    const b = block('concept-map', {
      nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: '重复' }, 'b'],
      edges: [
        { from: 'a', to: 'b', label: '影响' },
        { from: 'a', to: 'zzz' },
        { from: 'a', to: 'a' },
      ],
    })
    expect(b.nodes).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'b' },
    ])
    expect(b.edges).toEqual([{ from: 'a', to: 'b', label: '影响' }])
    expect(b.overflow).toBe(false)
  })
  it('超过 12 节点 / 24 边 → overflow=true（组件降级为列表）', () => {
    const nodes = Array.from({ length: 14 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }))
    expect(block('concept-map', { nodes, edges: [] }).overflow).toBe(true)
    const few = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }))
    const many = Array.from({ length: 26 }, (_, i) => ({ from: `n${i % 6}`, to: `n${(i + 1) % 6}` }))
    expect(block('concept-map', { nodes: few, edges: many }).overflow).toBe(true)
  })
  it('flow 与 concept-map 共用形状但保留各自 kind；source/target 别名可用', () => {
    const b = block('flow', { nodes: ['a', 'b'], edges: [{ source: 'a', target: 'b' }] })
    expect(b.kind).toBe('flow')
    expect(b.edges).toEqual([{ from: 'a', to: 'b' }])
  })
  it('无节点 → invalid', () => {
    expect(validateIsland('flow', '{"nodes":[],"edges":[]}')).toEqual({ ok: false, failure: 'invalid' })
  })
})

describe('validateIsland · timeline', () => {
  it('items/stages 均可，at 数字转字符串', () => {
    expect(block('timeline', { items: [{ at: 2017, title: 'Transformer' }] }).items).toEqual([
      { at: '2017', title: 'Transformer' },
    ])
    expect(block('timeline', { stages: [{ stage: '阶段一', name: '预训练', desc: '大规模语料' }] }).items).toEqual([
      { at: '阶段一', title: '预训练', detail: '大规模语料' },
    ])
  })
  it('缺 title 的项剔除，全空 → invalid；条数钳位', () => {
    expect(validateIsland('timeline', '{"items":[{"at":"x"}]}')).toEqual({ ok: false, failure: 'invalid' })
    const items = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}` }))
    expect((block('timeline', { items }).items as unknown[]).length).toBe(BLOCK_LIMITS.timelineItems)
  })
})

describe('validateIsland · quiz（§7.3 样例 B）', () => {
  it('单选：JSON 的 kind 映射为 variant，answer 为下标', () => {
    const b = block('quiz', {
      kind: 'single',
      stem: 'KV cache 大小与哪个量成正比？',
      options: ['层数的平方', '上下文长度', '词表大小'],
      answer: 1,
      why: '每 token 每层各存一份 K/V',
      cites: ['c4'],
      concept: 'kv-cache',
    })
    expect(b).toMatchObject({ kind: 'quiz', variant: 'single', answer: 1, concept: 'kv-cache' })
  })
  it('多选：下标去重升序；数字字符串可接受', () => {
    const b = block('quiz', { kind: 'multi', stem: 's', options: ['a', 'b', 'c'], answer: [2, '0', 2] })
    expect(b.answer).toEqual([0, 2])
    expect(b.variant).toBe('multi')
  })
  it('answer 是数组时即使 kind 写成 single 也按多选处理', () => {
    expect(block('quiz', { kind: 'single', stem: 's', options: ['a', 'b'], answer: [0, 1] }).variant).toBe('multi')
  })
  it('简答：无 options 自动判定 short，answer 落到 reference', () => {
    const b = block('quiz', { kind: 'short', stem: '请解释 KV cache', answer: '参考答案' })
    expect(b).toMatchObject({ variant: 'short', options: [], answer: null, reference: '参考答案' })
  })
  it('答案越界 / 选项不足 → invalid（无法本地判分的题不渲染）', () => {
    expect(validateIsland('quiz', '{"kind":"single","stem":"s","options":["a","b"],"answer":5}')).toEqual({
      ok: false,
      failure: 'invalid',
    })
    // 只有一个选项的选择题无从判分 → invalid（降级卡）
    expect(validateIsland('quiz', '{"kind":"single","stem":"s","options":["a"],"answer":0}')).toEqual({
      ok: false,
      failure: 'invalid',
    })
    expect(validateIsland('quiz', '{"kind":"single","options":["a","b"],"answer":0}')).toEqual({
      ok: false,
      failure: 'invalid',
    })
  })
  it('选项条数钳位', () => {
    const options = Array.from({ length: 12 }, (_, i) => `o${i}`)
    expect((block('quiz', { kind: 'single', stem: 's', options, answer: 0 }).options as string[]).length).toBe(
      BLOCK_LIMITS.quizOptions,
    )
  })
})

describe('validateIsland · flashcard / teach-back', () => {
  it('flashcard：front/back（term/definition 别名可用）', () => {
    expect(block('flashcard', { term: 'RoPE', definition: '旋转位置编码', concept: 'rope' })).toEqual({
      kind: 'flashcard',
      front: 'RoPE',
      back: '旋转位置编码',
      concept: 'rope',
      cites: [],
    })
    expect(validateIsland('flashcard', '{"front":"只有正面"}')).toEqual({ ok: false, failure: 'invalid' })
  })
  it('teach-back：prompt 必需，hints 上限 5', () => {
    const b = block('teach-back', { prompt: '请用自己的话解释 KV cache', hints: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] })
    expect((b.hints as string[]).length).toBe(5)
    expect(validateIsland('teach-back', '{"hints":["x"]}')).toEqual({ ok: false, failure: 'invalid' })
  })
})

describe('validateIsland · learner / verdict 控制岛', () => {
  it('learner：dir 钳到三值，条数上限，空信号 → invalid', () => {
    const b = block('learner', {
      signals: [
        { concept: 'kv-cache', dir: 5, evidence: '主动追问分页注意力' },
        { concept: 'rope', dir: -3 },
        { concept: 'attn', dir: 'x' },
      ],
    })
    expect(b.signals).toEqual([
      { concept: 'kv-cache', dir: 1, evidence: '主动追问分页注意力' },
      { concept: 'rope', dir: -1 },
      { concept: 'attn', dir: 0 },
    ])
    expect(validateIsland('learner', '{"signals":[]}')).toEqual({ ok: false, failure: 'invalid' })
    const many = Array.from({ length: 10 }, (_, i) => ({ concept: `c${i}`, dir: 1 }))
    expect((block('learner', { signals: many }).signals as unknown[]).length).toBe(BLOCK_LIMITS.learnerSignals)
  })
  it('verdict：枚举归一，missed/evidence 上限，三项全空 → invalid', () => {
    expect(block('verdict', { verdict: 'PASS', missed: ['a'], evidence: ['b'] })).toEqual({
      kind: 'verdict',
      verdict: 'ok',
      missed: ['a'],
      evidence: ['b'],
    })
    expect(block('verdict', { missed: ['只有遗漏点'] })).toMatchObject({ missed: ['只有遗漏点'], evidence: [] })
    expect(validateIsland('verdict', '{"note":"无关字段"}')).toEqual({ ok: false, failure: 'invalid' })
  })
})

describe('validateIsland · 降级矩阵（§7.5）', () => {
  it('表外类型 → unknown-type，不报错', () => {
    expect(validateIsland('hologram', '{}')).toEqual({ ok: false, failure: 'unknown-type', detail: 'hologram' })
    expect(validateIsland('chart', '{}')).toMatchObject({ ok: false, failure: 'unknown-type' })
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

describe('islandRenderMode（§7.5 渲染分发）', () => {
  const DISPLAY = ['explanation', 'formula', 'stepper', 'comparison', 'quiz', 'flashcard', 'teach-back']

  it('流未结束时未闭合岛一律骨架', () => {
    for (const t of [...DISPLAY, ...CONTROL_ISLAND_TYPES]) {
      expect(islandRenderMode({ islandType: t, closed: false, hasBlock: false, done: false })).toBe('skeleton')
    }
  })

  it('finalize 时未闭合：展示块出降级卡，控制岛静默丢弃', () => {
    for (const t of DISPLAY) {
      expect(islandRenderMode({ islandType: t, closed: false, hasBlock: false, done: true })).toBe('fallback')
    }
    for (const t of CONTROL_ISLAND_TYPES) {
      expect(islandRenderMode({ islandType: t, closed: false, hasBlock: false, done: true })).toBe('drop')
    }
  })

  it('闭合但校验失败：展示块出降级卡，控制岛（含 evidence）静默丢弃', () => {
    for (const t of DISPLAY) {
      expect(islandRenderMode({ islandType: t, closed: true, hasBlock: false, done: true })).toBe('fallback')
    }
    for (const t of CONTROL_ISLAND_TYPES) {
      expect(islandRenderMode({ islandType: t, closed: true, hasBlock: false, done: true })).toBe('drop')
    }
  })

  it('未知类型按展示块处理（降级卡 + 计数）', () => {
    expect(islandRenderMode({ islandType: 'hologram', closed: true, hasBlock: false, done: true })).toBe('fallback')
    expect(isControlIsland('hologram')).toBe(false)
    expect(isControlIsland('PLAN')).toBe(true)
  })

  it('校验通过 → 正常渲染', () => {
    expect(islandRenderMode({ islandType: 'quiz', closed: true, hasBlock: true, done: true })).toBe('block')
    expect(islandRenderMode({ islandType: 'plan', closed: true, hasBlock: true, done: false })).toBe('block')
  })
})
