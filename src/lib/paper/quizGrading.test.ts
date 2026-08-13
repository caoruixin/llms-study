import { describe, expect, it } from 'vitest'
import { gradeChoice, optionOrder } from './quizGrading'
import type { QuizBlockData } from './blockSchemas'

const single = (answer: number): QuizBlockData => ({
  kind: 'quiz',
  variant: 'single',
  stem: 's',
  options: ['a', 'b', 'c'],
  answer,
  cites: [],
})

const multi = (answer: number[]): QuizBlockData => ({
  kind: 'quiz',
  variant: 'multi',
  stem: 's',
  options: ['a', 'b', 'c', 'd'],
  answer,
  cites: [],
})

describe('gradeChoice · 单选（本地 0 调用判分）', () => {
  it('命中 → correct，未命中 → wrong', () => {
    expect(gradeChoice(single(1), [1]).outcome).toBe('correct')
    expect(gradeChoice(single(1), [0]).outcome).toBe('wrong')
  })
  it('报告应选未选与错选', () => {
    const g = gradeChoice(single(2), [0])
    expect(g.correct).toEqual([2])
    expect(g.missed).toEqual([2])
    expect(g.extra).toEqual([0])
  })
  it('空选 → wrong', () => {
    expect(gradeChoice(single(0), []).outcome).toBe('wrong')
  })
})

describe('gradeChoice · 多选', () => {
  it('完全一致 → correct', () => {
    expect(gradeChoice(multi([0, 2]), [2, 0]).outcome).toBe('correct')
  })
  it('漏选 / 多选 → partial', () => {
    expect(gradeChoice(multi([0, 2]), [0]).outcome).toBe('partial')
    expect(gradeChoice(multi([0, 2]), [0, 2, 3]).outcome).toBe('partial')
  })
  it('零交集 → wrong', () => {
    expect(gradeChoice(multi([0, 2]), [1, 3]).outcome).toBe('wrong')
  })
  it('重复与越界选项被忽略', () => {
    const g = gradeChoice(multi([0, 2]), [0, 0, 2, 99, -1])
    expect(g.outcome).toBe('correct')
    expect(g.extra).toEqual([])
  })
})

describe('optionOrder', () => {
  it('shuffle=false → 自然顺序', () => {
    expect(optionOrder(4, 7, false)).toEqual([0, 1, 2, 3])
  })
  it('同一 seed 结果稳定，且是原下标的一个排列', () => {
    const a = optionOrder(5, 3, true)
    const b = optionOrder(5, 3, true)
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4])
  })
  it('不同 seed 通常给出不同顺序；1 个及以下选项原样返回', () => {
    expect(optionOrder(6, 1, true)).not.toEqual(optionOrder(6, 12345, true))
    expect(optionOrder(1, 9, true)).toEqual([0])
    expect(optionOrder(0, 9, true)).toEqual([])
  })
})
