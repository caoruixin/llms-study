// 模型数据一致性（对应 PLAN-page-audit-fixes.md P0-2 / P1-14）：
// - moe 字段不得再用 {experts:0} 哨兵占位——未公布就整个字段缺省，公布部分就只带公布字段
// - DeepSeek-V3 各文案字段与 totalParamsB 671B 自洽（曾把 567B 写进 highlights）
import { describe, expect, it } from 'vitest'
import { MODELS } from './models'

describe('moe 字段（可选，无 0 哨兵）', () => {
  it('moe 存在时 experts > 0；activePerToken 存在时 > 0（未公布 → 字段缺省而非 0）', () => {
    for (const m of MODELS) {
      if (!m.moe) continue
      expect(m.moe.experts, `${m.id} 的 moe.experts 不得为 0 哨兵`).toBeGreaterThan(0)
      if (m.moe.activePerToken !== undefined) {
        expect(m.moe.activePerToken, `${m.id} 的 moe.activePerToken 不得为 0 哨兵`).toBeGreaterThan(0)
      }
      if (m.moe.shared !== undefined) {
        expect(m.moe.shared, `${m.id} 的 moe.shared 不得为 0 哨兵`).toBeGreaterThan(0)
      }
    }
  })

  it('专家配置未公布的条目（deepseek-v4-pro / glm-45 / glm-5 / glm-52）moe 字段缺省', () => {
    for (const id of ['deepseek-v4-pro', 'glm-45', 'glm-5', 'glm-52']) {
      const m = MODELS.find((x) => x.id === id)
      expect(m, `models.ts 缺少 ${id}`).toBeDefined()
      expect(m!.moe, `${id} 专家配置官方未公布，moe 应缺省`).toBeUndefined()
    }
  })
})

describe('DeepSeek-V3 参数口径', () => {
  it('totalParamsB = 671，且全部文案不再出现 567B 笔误', () => {
    const v3 = MODELS.find((m) => m.id === 'deepseek-v3')
    expect(v3).toBeDefined()
    if (!v3) return
    expect(v3.totalParamsB).toBe(671)
    const text = [
      ...v3.diffVsTransformer,
      ...v3.highlights.map((h) => `${h.title} ${h.what} ${h.why}`),
    ].join(' ')
    expect(text.includes('567'), 'DeepSeek-V3 文案仍含 567（应为 671B）').toBe(false)
    expect(text).toContain('671B')
  })
})
