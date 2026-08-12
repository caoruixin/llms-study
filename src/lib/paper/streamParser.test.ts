import { describe, expect, it } from 'vitest'
import { createStreamParserMemo, splitCopilotStream, splitProseRuns } from './streamParser'

const FORMULA_ISLAND = '```copilot:formula\n{"expr":"2nL","terms":[{"sym":"L","mean":"长度"}],"cites":["c2"]}\n```'

describe('splitCopilotStream · 岛识别', () => {
  it('样例 A（§7.3）：prose + formula 岛 + prose，citeToken 拆出', () => {
    const src = `这段在讲 KV cache [[cite:c2]]。\n\n${FORMULA_ISLAND}\n\n其中系数 2 来自 K 与 V 各存一份 [[cite:c2]]。`
    const segs = splitCopilotStream(src)
    expect(segs.map((s) => s.type)).toEqual(['prose', 'island', 'prose'])
    const island = segs[1]
    expect(island.type === 'island' && island.closed && island.block?.kind).toBe('formula')
    const prose = segs[0]
    // 围栏前的空行保留在 text 内（splitFences 按行拼接语义）
    expect(prose.type === 'prose' && prose.runs).toEqual([
      { kind: 'text', text: '这段在讲 KV cache ' },
      { kind: 'cite', alias: 'c2' },
      { kind: 'text', text: '。\n' },
    ])
  })

  it('info-string 变体：copilot-formula / COPILOT: formula / copilot formula 均识别', () => {
    for (const lang of ['copilot-formula', 'COPILOT:FORMULA', 'copilot formula']) {
      const segs = splitCopilotStream(`\`\`\`${lang}\n{"expr":"x"}\n\`\`\``)
      expect(segs[0]).toMatchObject({ type: 'island', islandType: 'formula' })
    }
  })

  it('普通代码块直通，不当岛处理', () => {
    const segs = splitCopilotStream('```python\nprint(1)\n```')
    expect(segs[0]).toEqual({ type: 'code', lang: 'python', text: 'print(1)', closed: true })
  })

  it('半截岛（未闭合）→ closed:false 无 block（渲染层出 Skeleton/Fallback）', () => {
    const segs = splitCopilotStream('开头\n```copilot:formula\n{"expr":"2nL"')
    expect(segs[1]).toEqual({ type: 'island', islandType: 'formula', raw: '{"expr":"2nL"', closed: false })
  })

  it('闭合岛坏 JSON → failure 标记（§7.5 降级卡）', () => {
    const segs = splitCopilotStream('```copilot:formula\n{"expr":\n```')
    expect(segs[0]).toMatchObject({ type: 'island', closed: true, failure: 'bad-json' })
  })

  it('未知类型闭合岛 → unknown-type', () => {
    const segs = splitCopilotStream('```copilot:learner\n{"signals":[]}\n```')
    expect(segs[0]).toMatchObject({ type: 'island', islandType: 'learner', failure: 'unknown-type' })
  })

  it('JSON 内出现行首 ``` 导致围栏早闭：岛坏 + 泄漏尾按 prose 渲染（§7.5）', () => {
    const src = '```copilot:explanation\n{"text":"看\n```\n代码泄漏"}\n```'
    const segs = splitCopilotStream(src)
    expect(segs[0]).toMatchObject({ type: 'island', failure: 'bad-json' })
    expect(segs.some((s) => s.type === 'prose' && s.text.includes('代码泄漏'))).toBe(true)
  })
})

describe('splitProseRuns · citeToken', () => {
  it('多个 cite 交替', () => {
    expect(splitProseRuns('A [[cite:c1]] B [[cite:c12]] C', false)).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'cite', alias: 'c1' },
      { kind: 'text', text: ' B ' },
      { kind: 'cite', alias: 'c12' },
      { kind: 'text', text: ' C' },
    ])
  })

  it('非法 ID 形态不当 token（保留原文）', () => {
    expect(splitProseRuns('[[cite:x1]] [[cite:c1234]]', false)).toEqual([
      { kind: 'text', text: '[[cite:x1]] [[cite:c1234]]' },
    ])
  })

  it('行尾残缺抑制（open）：各级前缀都剥掉', () => {
    for (const partial of ['[', '[[', '[[c', '[[ci', '[[cit', '[[cite', '[[cite:', '[[cite:c', '[[cite:c1', '[[cite:c12', '[[cite:c123', '[[cite:c1]']) {
      expect(splitProseRuns(`正文 ${partial}`, true)).toEqual([{ kind: 'text', text: '正文 ' }])
    }
  })

  it('finalize（open=false）：残缺 token 原样保留', () => {
    expect(splitProseRuns('正文 [[cite:c1', false)).toEqual([{ kind: 'text', text: '正文 [[cite:c1' }])
  })

  it('无法补全的尾巴不抑制', () => {
    expect(splitProseRuns('数组下标 a[i', true)).toEqual([{ kind: 'text', text: '数组下标 a[i' }])
    expect(splitProseRuns('完整 [[cite:c1]]', true)).toEqual([{ kind: 'text', text: '完整 ' }, { kind: 'cite', alias: 'c1' }])
  })
})

describe('splitCopilotStream · 流式增量与 finalize', () => {
  it('抑制只作用于最末 prose 段', () => {
    const src = '第一段 [[cite:c1\n\n```python\ncode\n```\n\n尾段 [[cite:c2'
    const segs = splitCopilotStream(src, { open: true })
    // 第一段的残缺 token 已成历史（中间隔了代码块），原样保留；只有尾段被抑制
    expect(segs[0].type === 'prose' && segs[0].runs[0].kind === 'text' && segs[0].runs[0].text).toContain('[[cite:c1')
    const tail = segs[2]
    expect(tail.type === 'prose' && tail.runs).toEqual([{ kind: 'text', text: '\n尾段 ' }])
  })

  it('同一累计文本从半截到闭合的推进（append-only）', () => {
    const open1 = splitCopilotStream('讲解 [[cite:c1]]\n```copilot:formula\n{"expr":"x"', { open: true })
    expect(open1[1]).toMatchObject({ type: 'island', closed: false })
    const done = splitCopilotStream('讲解 [[cite:c1]]\n```copilot:formula\n{"expr":"x"}\n```', { open: true })
    expect(done[1]).toMatchObject({ type: 'island', closed: true, block: { kind: 'formula', expr: 'x' } })
  })
})

describe('createStreamParserMemo', () => {
  it('同输入返回同引用；追加后已闭合岛校验结果复用（引用相等）', () => {
    const parse = createStreamParserMemo()
    const src1 = `${FORMULA_ISLAND}\n后续`
    const a = parse(src1, { open: true })
    const b = parse(src1, { open: true })
    expect(b).toBe(a) // 全文未变 → 直接同引用
    const c = parse(`${src1}继续写`, { open: true })
    expect(c).not.toBe(a)
    expect(c[0]).toBe(a[0]) // 已闭合岛 seg 从缓存取，引用相等 → React.memo 直接跳过
  })
})
