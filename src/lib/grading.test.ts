import { describe, expect, it } from 'vitest'
import { parseScoreJson, toGrade, weightedScore } from './grading'
import { extractContent } from './llmClient'
import type { ScoreResult } from '../data/types'

const valid: ScoreResult = {
  accuracy: 8,
  structure: 7,
  business: 6,
  depth: 7,
  highlights: ['讲清了机制'],
  comments: ['好'],
  missed: [],
}

describe('parseScoreJson', () => {
  it('解析纯 JSON', () => {
    const r = parseScoreJson(JSON.stringify(valid))
    expect(r.accuracy).toBe(8)
    expect(r.comments).toEqual(['好'])
  })

  it('解析带 markdown 栅栏的 JSON', () => {
    const raw = '```json\n' + JSON.stringify(valid) + '\n```'
    expect(parseScoreJson(raw).structure).toBe(7)
  })

  it('解析前后有解释文字的 JSON', () => {
    const raw = '评分如下：\n' + JSON.stringify(valid) + '\n以上。'
    expect(parseScoreJson(raw).depth).toBe(7)
  })

  it('分数越界钳位到 1-10', () => {
    const r = parseScoreJson(JSON.stringify({ ...valid, accuracy: 15, depth: 0 }))
    expect(r.accuracy).toBe(10)
    expect(r.depth).toBe(1)
  })

  it('缺数值字段时抛错', () => {
    const { accuracy: _drop, ...rest } = valid
    expect(() => parseScoreJson(JSON.stringify(rest))).toThrow('accuracy')
  })

  it('非 JSON 时抛错', () => {
    expect(() => parseScoreJson('抱歉，我无法评分')).toThrow()
  })

  it('comments 非数组时容错为空数组', () => {
    const r = parseScoreJson(JSON.stringify({ ...valid, comments: '不错' }))
    expect(r.comments).toEqual([])
  })
})

describe('weightedScore + toGrade（确定性 A-D 映射）', () => {
  it('权重加权正确', () => {
    // 0.35*8 + 0.25*7 + 0.2*6 + 0.2*7 = 2.8 + 1.75 + 1.2 + 1.4 = 7.15
    expect(weightedScore(valid)).toBeCloseTo(7.15)
  })

  it('等级阈值', () => {
    expect(toGrade(8.0)).toBe('A')
    expect(toGrade(7.99)).toBe('B')
    expect(toGrade(6.5)).toBe('B')
    expect(toGrade(6.49)).toBe('C')
    expect(toGrade(5.0)).toBe('C')
    expect(toGrade(4.99)).toBe('D')
  })

  it('满分与最低分', () => {
    const perfect: ScoreResult = { ...valid, accuracy: 10, structure: 10, business: 10, depth: 10 }
    expect(toGrade(weightedScore(perfect))).toBe('A')
    const worst: ScoreResult = { ...valid, accuracy: 1, structure: 1, business: 1, depth: 1 }
    expect(toGrade(weightedScore(worst))).toBe('D')
  })
})

describe('extractContent（上游返回容错）', () => {
  it('正常 OpenAI 格式', () => {
    expect(extractContent({ choices: [{ message: { content: 'hi' } }] })).toBe('hi')
  })
  it('choices 缺失 / 空 / content 非字符串 → null', () => {
    expect(extractContent({})).toBeNull()
    expect(extractContent({ choices: [] })).toBeNull()
    expect(extractContent({ choices: [{ message: { content: 42 } }] })).toBeNull()
    expect(extractContent(null)).toBeNull()
  })
})
