import { describe, expect, it } from 'vitest'
import { findPersona, PERSONA_DEFS, personaHintText } from './personas'

describe('PERSONA_DEFS', () => {
  it('恰好两档，id 依次为 none / presales', () => {
    expect(PERSONA_DEFS.map((p) => p.id)).toEqual(['none', 'presales'])
  })
  it('none 无 directive（整层可省略）；presales 有非空 directive', () => {
    expect(findPersona('none').directive).toBeNull()
    expect(findPersona('presales').directive).toBeTruthy()
  })
})

describe('findPersona：未知/缺省 id 回退', () => {
  it('未知 id 回退到 none', () => {
    expect(findPersona('bogus').id).toBe('none')
  })
  it('null/undefined 回退到 none', () => {
    expect(findPersona(null).id).toBe('none')
    expect(findPersona(undefined).id).toBe('none')
  })
})

describe('personaHintText', () => {
  it("'none' → null", () => {
    expect(personaHintText('none')).toBeNull()
  })
  it('未知/缺省 id 视同 none → null', () => {
    expect(personaHintText(undefined)).toBeNull()
    expect(personaHintText(null)).toBeNull()
    expect(personaHintText('bogus')).toBeNull()
  })
  it("'presales' → 非空文案，覆盖 PLAN 草稿的五个要点", () => {
    const text = personaHintText('presales')
    expect(text).toBeTruthy()
    expect(text).toContain('售前解决方案架构师')
    expect(text).toContain('可以这样向客户讲')
    expect(text).toContain('竞品')
    expect(text).toContain('论文没有覆盖')
    expect(text).toContain('切换回正常讲解模式')
  })
  it('presales 文案字节稳定（快照）：变更需显式更新快照并知悉这会改变 system#2 前缀缓存', () => {
    expect(personaHintText('presales')).toMatchSnapshot()
  })
})
