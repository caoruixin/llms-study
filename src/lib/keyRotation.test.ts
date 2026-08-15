import { describe, expect, it } from 'vitest'
import { classifyKeyFailure, createKeyRotator, parseKeyList } from './keyRotation'

describe('parseKeyList', () => {
  it('拆分逗号列表并剔除空段与空白', () => {
    expect(parseKeyList(' k1 , k2,,k3 ')).toEqual(['k1', 'k2', 'k3'])
    expect(parseKeyList('')).toEqual([])
    expect(parseKeyList(undefined)).toEqual([])
    expect(parseKeyList(null)).toEqual([])
  })
})

describe('classifyKeyFailure', () => {
  it('401/403 → invalid;402/429 → quota;其余与 key 无关', () => {
    expect(classifyKeyFailure(401)).toBe('invalid')
    expect(classifyKeyFailure(403)).toBe('invalid')
    expect(classifyKeyFailure(402)).toBe('quota')
    expect(classifyKeyFailure(429)).toBe('quota')
    expect(classifyKeyFailure(200)).toBeNull()
    expect(classifyKeyFailure(500)).toBeNull()
    expect(classifyKeyFailure(404)).toBeNull()
  })
})

describe('createKeyRotator', () => {
  it('初始按优先级返回全部 key(粘性:调用方总是取第一个)', () => {
    const r = createKeyRotator(['a', 'b'])
    expect(r.candidates(0)).toEqual(['a', 'b'])
  })

  it('invalid 永久剔除,后续 candidates 不再出现', () => {
    const r = createKeyRotator(['a', 'b'])
    r.reportFailure('a', 'invalid', 0)
    expect(r.candidates(0)).toEqual(['b'])
    expect(r.candidates(999_999_999)).toEqual(['b'])
  })

  it('quota 冷却期内剔除,冷却结束后恢复且保持原优先级', () => {
    const r = createKeyRotator(['a', 'b'], 1000)
    r.reportFailure('a', 'quota', 0)
    expect(r.candidates(500)).toEqual(['b'])
    expect(r.candidates(1001)).toEqual(['a', 'b'])
  })

  it('全部不可用时返回空数组(调用方据此透出最后一次上游错误)', () => {
    const r = createKeyRotator(['a', 'b'], 1000)
    r.reportFailure('a', 'invalid', 0)
    r.reportFailure('b', 'quota', 0)
    expect(r.candidates(500)).toEqual([])
    expect(r.candidates(1001)).toEqual(['b'])
  })
})
