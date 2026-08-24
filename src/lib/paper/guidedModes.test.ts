import { describe, expect, it } from 'vitest'
import {
  GUIDED_MODE_DEFS,
  GUIDED_MODE_IDS,
  LEARNER_DIRECTIVE,
  MAX_SECTION_STEPS,
  advanceGuided,
  findGuidedMode,
  guidedStepAt,
  startGuided,
  type GuidedContext,
} from './guidedModes'

const ctx = (over: Partial<GuidedContext> = {}): GuidedContext => ({
  paperTitle: 'Attention Is All You Need',
  sectionTitles: [],
  ...over,
})

describe('七入口定义（§3.4，Track 3 加售前导读）', () => {
  it('恰好七个模式且 id 唯一', () => {
    expect(GUIDED_MODE_IDS).toEqual(['overview', 'section', 'method', 'derive', 'experiment', 'review', 'presales'])
    expect(new Set(GUIDED_MODE_IDS).size).toBe(7)
  })
  it('每个模式都能生成非空步骤，且步骤字段完整', () => {
    for (const mode of GUIDED_MODE_DEFS) {
      const steps = mode.buildSteps(ctx({ sectionTitles: ['1 引言', '2 方法'] }))
      expect(steps.length).toBeGreaterThan(0)
      for (const s of steps) {
        expect(s.question.length).toBeGreaterThan(4)
        expect(s.retrievalQuery.trim()).not.toBe('')
        expect(['chat', 'deep']).toContain(s.task)
        expect(s.extraDirectives).toContain(LEARNER_DIRECTIVE)
      }
    }
  })
  it('公式推导与批判性审阅全部走深度档（§6.1c）', () => {
    for (const id of ['derive', 'review'] as const) {
      const steps = findGuidedMode(id)!.buildSteps(ctx())
      expect(steps.every((s) => s.task === 'deep')).toBe(true)
    }
  })
  it('速览与 Phase 3 行为一致：单步、chat 档、带 plan 岛', () => {
    const steps = findGuidedMode('overview')!.buildSteps(ctx())
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ task: 'chat', planIsland: true, label: '论文速览' })
    expect(steps[0].question).toContain('速览')
    expect(steps[0].retrievalQuery).toContain('Attention Is All You Need')
  })
  it('实验复盘最后一步（结论有效性）升级为深度档', () => {
    const steps = findGuidedMode('experiment')!.buildSteps(ctx())
    expect(steps.map((s) => s.task)).toEqual(['chat', 'chat', 'chat', 'deep'])
  })
  it('未知模式 → null', () => {
    expect(findGuidedMode('nope')).toBeNull()
    expect(startGuided('nope', ctx())).toBeNull()
  })
})

describe('逐节精读的动态步骤', () => {
  it('按目录展开，每节一步', () => {
    const steps = findGuidedMode('section')!.buildSteps(ctx({ sectionTitles: ['1 引言', '2 方法', '3 实验'] }))
    expect(steps).toHaveLength(3)
    expect(steps[1].label).toBe('精读 2 方法')
    expect(steps[1].retrievalQuery).toContain('2 方法')
  })
  it('目录为空时退回单步全文精读', () => {
    const steps = findGuidedMode('section')!.buildSteps(ctx({ sectionTitles: [] }))
    expect(steps).toHaveLength(1)
    expect(steps[0].label).toBe('精读全文')
  })
  it('空白标题被过滤，步数封顶', () => {
    const titles = ['  ', ...Array.from({ length: 20 }, (_, i) => `§${i}`)]
    expect(findGuidedMode('section')!.buildSteps(ctx({ sectionTitles: titles }))).toHaveLength(MAX_SECTION_STEPS)
  })
})

describe('presales：售前导读五步（Track 3 第 7 入口）', () => {
  it('恰好 5 步，label 依次为定位/术语/卖点/话术/追问，全部 task:chat', () => {
    const steps = findGuidedMode('presales')!.buildSteps(ctx())
    expect(steps.map((s) => s.label)).toEqual([
      '文档定位',
      '关键概念与术语表',
      '方案架构与卖点拆解',
      '怎么讲给客户听',
      '客户追问与应对',
    ])
    expect(steps.every((s) => s.task === 'chat')).toBe(true)
    expect(steps.every((s) => s.planIsland)).toBe(true)
  })
  it('每步的展示块提示与 PLAN 草稿一致', () => {
    const steps = findGuidedMode('presales')!.buildSteps(ctx())
    const blockHintOf = (i: number) => steps[i].extraDirectives.find((d) => d.includes('本步优先用这些展示块'))
    expect(blockHintOf(0)).toContain('copilot:explanation')
    expect(blockHintOf(0)).toContain('copilot:timeline')
    expect(blockHintOf(1)).toContain('copilot:flashcard')
    expect(blockHintOf(1)).toContain('copilot:explanation')
    expect(blockHintOf(2)).toContain('copilot:flow')
    expect(blockHintOf(2)).toContain('copilot:comparison')
    expect(blockHintOf(3)).toContain('copilot:stepper')
    expect(blockHintOf(3)).toContain('copilot:explanation')
    expect(blockHintOf(4)).toContain('copilot:comparison')
    expect(blockHintOf(4)).toContain('copilot:quiz')
  })
  it('末步（客户追问与应对）问题里要求文档答不了的直说、并留一道演练题', () => {
    const steps = findGuidedMode('presales')!.buildSteps(ctx())
    const last = steps[steps.length - 1]
    expect(last.question).toContain('直说')
    expect(last.question).toContain('模拟')
  })
})

describe('步序状态机（每步 1 次调用）', () => {
  it('start 从第 0 步开始并带总步数', () => {
    expect(startGuided('method', ctx())).toEqual({ modeId: 'method', stepIndex: 0, total: 4 })
  })
  it('advance 逐步推进，最后一步之后返回 null（引导结束）', () => {
    let run = startGuided('derive', ctx())!
    const seen = [run.stepIndex]
    for (;;) {
      const next = advanceGuided(run, ctx())
      if (!next) break
      run = next
      seen.push(run.stepIndex)
    }
    expect(seen).toEqual([0, 1, 2])
  })
  it('guidedStepAt 返回当前步；越界 → null', () => {
    const run = startGuided('method', ctx())!
    expect(guidedStepAt(run, ctx())?.label).toBe('方法总览')
    expect(guidedStepAt({ ...run, stepIndex: 99 }, ctx())).toBeNull()
  })
  it('多步模式的展示文案带进度，单步模式不带', () => {
    const method = guidedStepAt(startGuided('method', ctx())!, ctx())!
    expect(method.displayText).toBe('【方法拆解 1/4】方法总览')
    const overview = guidedStepAt(startGuided('overview', ctx())!, ctx())!
    expect(overview.displayText).toBe('【论文速览】')
  })
  it('目录变化后 advance 用最新步数判定结束', () => {
    const run = startGuided('section', ctx({ sectionTitles: ['a', 'b', 'c'] }))!
    expect(advanceGuided(run, ctx({ sectionTitles: ['a'] }))).toBeNull()
    expect(advanceGuided(run, ctx({ sectionTitles: ['a', 'b'] }))).toMatchObject({ stepIndex: 1 })
  })
  it('presales 走完 5 步：start 带 total=5，advance 依次推进到底后返回 null', () => {
    let run = startGuided('presales', ctx())!
    expect(run).toEqual({ modeId: 'presales', stepIndex: 0, total: 5 })
    const labels = [guidedStepAt(run, ctx())!.label]
    for (;;) {
      const next = advanceGuided(run, ctx())
      if (!next) break
      run = next
      labels.push(guidedStepAt(run, ctx())!.label)
    }
    expect(labels).toEqual(['文档定位', '关键概念与术语表', '方案架构与卖点拆解', '怎么讲给客户听', '客户追问与应对'])
  })
})
