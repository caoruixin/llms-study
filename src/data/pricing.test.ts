// 价目数据一致性（对应 PLAN-page-audit-fixes.md P1-13）：
// - validUntil 为 YYYY-MM-DD 且可解析；「限时」措辞的行必须有 validUntil，或在 notes 里指明时限见官方/来源
// - isPromoExpired：validUntil 当天仍有效，次日起过期；无 validUntil 永不判过期
// - cases.ts 引用限时价的案例，其 priceValidUntil 与 pricing.ts 对应行同源（防两处漂移）
import { describe, expect, it } from 'vitest'
import { isPromoExpired, PRICING } from './pricing'
import { WORKED_CASES } from './cases'

describe('validUntil 格式与限时措辞', () => {
  it('validUntil 均为 YYYY-MM-DD 且是合法日期', () => {
    for (const p of PRICING) {
      if (p.validUntil === undefined) continue
      expect(p.validUntil, `${p.provider}|${p.modelId} validUntil 格式`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(new Date(`${p.validUntil}T00:00:00`).getTime())).toBe(false)
    }
  })

  it('notes 含「限时」的行：要么有 validUntil，要么 notes 指明时限以官方/来源为准', () => {
    const rows = PRICING.filter((p) => p.notes?.includes('限时'))
    expect(rows.length).toBeGreaterThan(0)
    for (const p of rows) {
      const ok = p.validUntil !== undefined || /官方|来源|定价页/.test(p.notes ?? '')
      expect(ok, `${p.provider}|${p.modelId} 的「限时」措辞既无 validUntil 也未指向来源`).toBe(true)
    }
  })
})

describe('isPromoExpired', () => {
  it('截止日当天仍有效，次日起过期；无 validUntil 永不过期', () => {
    expect(isPromoExpired('2026-08-31', new Date('2026-08-31T12:00:00'))).toBe(false)
    expect(isPromoExpired('2026-08-31', new Date('2026-09-01T00:00:01'))).toBe(true)
    expect(isPromoExpired('2026-08-31', new Date('2026-08-07T12:00:00'))).toBe(false)
    expect(isPromoExpired(undefined, new Date('2099-01-01T00:00:00'))).toBe(false)
    expect(isPromoExpired(null, new Date('2099-01-01T00:00:00'))).toBe(false)
  })
})

describe('cases.ts 限时价与 pricing.ts 同源', () => {
  // sonnet-5 的 $2/$10 已转为标准价（2026-08 官方定价页），两处的限时价截止日同步下线
  // → 断言保持「两处必须同源」：一处有 validUntil 另一处没有，同样判失败
  it('roi-global-saas 案例的 priceValidUntil = claude-sonnet-5 行的 validUntil（双方都无限时价时也须一致）', () => {
    const c = WORKED_CASES.find((x) => x.id === 'roi-global-saas')
    const p = PRICING.find((x) => x.modelId === 'claude-sonnet-5')
    expect(c).toBeDefined()
    expect(p).toBeDefined()
    expect(c!.priceValidUntil).toBe(p!.validUntil)
  })
})
