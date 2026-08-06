// 测试组 H：文案一致性（PLAN-kda-demo.md §4-H / §5 第 3 层）
// 核心断言：src/data/kda.ts 的讲解文案与 kdaEngine 不得脱钩——
// 每条 body 都在真实 trace 上求值，产出 NaN/undefined 或引用越界字段即测试失败。
import { describe, expect, it } from 'vitest'
import { buildKdaTrace, DEFAULT_SCENARIO, fmt, selectChunk, selectStep, type VariantId } from '../lib/kdaEngine'
import {
  buildLayerBand,
  CHUNK_MATRIX_LABELS,
  CHUNK_MATRIX_NOTES,
  CHUNK_VIEWS,
  DERIV_PHASES,
  K3_STRUCTURE,
  KDA_DERIV_STEPS,
  KDA_LAYER_ACTS,
  KDA_SUMMARY,
  LAB_TAKEAWAYS,
  NETWORK_NODES,
  VARIANT_META,
  VARIANT_ORDER,
  type ChunkMatrixKey,
  type DerivPhase,
} from './kda'
import { MODELS } from './models'

const TRACE = buildKdaTrace()
const BAD_TOKENS = ['NaN', 'undefined', 'null', 'Infinity', '[object']

describe('H 文案一致性 / KDA_DERIV_STEPS', () => {
  it('步骤定位合法：variant 在四变体内、tokenT 在场景范围内、id 唯一', () => {
    const n = DEFAULT_SCENARIO.tokens.length
    const ids = new Set<string>()
    for (const s of KDA_DERIV_STEPS) {
      expect(VARIANT_ORDER).toContain(s.variant)
      expect(Number.isInteger(s.tokenT)).toBe(true)
      expect(s.tokenT).toBeGreaterThanOrEqual(1)
      expect(s.tokenT).toBeLessThanOrEqual(n)
      expect(ids.has(s.id)).toBe(false)
      ids.add(s.id)
      expect(s.title.length).toBeGreaterThan(0)
      expect(s.formula.length).toBeGreaterThan(0)
      expect(s.views.length).toBeGreaterThan(0)
    }
    expect(ids.size).toBe(KDA_DERIV_STEPS.length)
  })

  it('每条 body 在默认 trace 上求值：非空且不含 NaN/undefined 等脱钩痕迹', () => {
    for (const s of KDA_DERIV_STEPS) {
      const step = selectStep(TRACE, s.variant, s.tokenT)
      const text = s.body(step, fmt)
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(20)
      for (const bad of BAD_TOKENS) {
        expect(text.includes(bad), `${s.id} 的 body 含「${bad}」`).toBe(false)
      }
      // 取数函数必须真的取到数：至少出现一个数字
      expect(/\d/.test(text), `${s.id} 的 body 没有引用任何 trace 数值`).toBe(true)
    }
  })

  it('body 在 LabOverrides 极端参数下同样不崩、不产出 NaN', () => {
    for (const overrides of [
      { beta: 0 },
      { beta: 1, alphaScalar: 0, alphaVec: [0, 0, 0, 0] },
      { beta: 0.5, alphaScalar: 0.5, alphaVec: [1, 0.05, 0.5, 0.95] },
    ]) {
      const tr = buildKdaTrace(DEFAULT_SCENARIO, overrides)
      for (const s of KDA_DERIV_STEPS) {
        const text = s.body(selectStep(tr, s.variant, s.tokenT), fmt)
        for (const bad of BAD_TOKENS) {
          expect(text.includes(bad), `${s.id} @ ${JSON.stringify(overrides)} 含「${bad}」`).toBe(false)
        }
      }
    }
  })

  it('naive 步不得声明 delta 专属视图（判别式联合的内容层对应关系）', () => {
    const DELTA_ONLY = ['prediction', 'transition', 'gate-compare', 'dplr', 'transition-chain']
    for (const s of KDA_DERIV_STEPS) {
      const step = selectStep(TRACE, s.variant, s.tokenT)
      if (step.kind === 'naive') {
        for (const v of s.views) {
          expect(DELTA_ONLY.includes(v), `${s.id} 是 naive 步却声明了 ${v}`).toBe(false)
        }
      }
    }
  })

  it('五阶段齐全、按顺序分组且每阶段至少一步；共 11 步覆盖 ①–⑪', () => {
    expect(KDA_DERIV_STEPS.length).toBe(11)
    const order: DerivPhase[] = DERIV_PHASES.map((p) => p.id)
    expect(order).toEqual(['naive', 'delta', 'gate', 'dplr', 'position'])
    const seen = KDA_DERIV_STEPS.map((s) => s.phase)
    // 每个阶段至少一步
    for (const p of order) expect(seen).toContain(p)
    // 分组连续：阶段序号单调不减
    const idx = seen.map((p) => order.indexOf(p))
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThanOrEqual(idx[i - 1])
    // ①–⑪ 序号标注与顺序一致
    const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪']
    KDA_DERIV_STEPS.forEach((s, i) => expect(s.title.startsWith(marks[i])).toBe(true))
  })

  it('易变事实必带溯源：sourceUrl 与 asOf 成对出现', () => {
    for (const s of KDA_DERIV_STEPS) {
      expect(s.sourceUrl === undefined).toBe(s.asOf === undefined)
      if (s.asOf !== undefined) expect(/^\d{4}-\d{2}$/.test(s.asOf)).toBe(true)
    }
    // ⑩ DPLR 的 ≈2× kernel 加速必须带论文出处
    const dplr = KDA_DERIV_STEPS.find((s) => s.id === 'dplr')
    expect(dplr?.sourceUrl).toBe('https://arxiv.org/abs/2510.26692')
  })
})

describe('H 文案一致性 / 变体元信息与观察要点', () => {
  it('VARIANT_META 四变体齐全、色值唯一且与 VARIANT_ORDER 一致', () => {
    expect(VARIANT_ORDER.length).toBe(4)
    const colors = new Set<string>()
    for (const id of VARIANT_ORDER) {
      const meta = VARIANT_META[id as VariantId]
      expect(meta.id).toBe(id)
      expect(meta.name.length).toBeGreaterThan(0)
      expect(/^#[0-9a-f]{6}$/.test(meta.color), `${id} 色值须为小写 hex`).toBe(true)
      colors.add(meta.color)
    }
    expect(colors.size).toBe(4)
    // KDA 徽章为实心酒红白字（主题红线：text-white 仅用于实心深色填充）
    expect(VARIANT_META.kda.badgeClass).toContain('bg-accent')
    expect(VARIANT_META.kda.color).toBe('#9e2b3a')
  })

  it('LAB_TAKEAWAYS 只描述定性趋势：不得混入场景小数（防与滑块/曲线漂移）', () => {
    expect(LAB_TAKEAWAYS.length).toBeGreaterThanOrEqual(4)
    for (const t of LAB_TAKEAWAYS) {
      expect(t.length).toBeGreaterThan(10)
      expect(/\d+\.\d+/.test(t), `观察要点写死了具体数值：${t}`).toBe(false)
    }
  })

  it('KDA_SUMMARY 与 KDA_LAYER_ACTS 非空', () => {
    expect(KDA_SUMMARY.length).toBeGreaterThan(40)
    expect(KDA_LAYER_ACTS.length).toBe(4)
    for (const a of KDA_LAYER_ACTS) expect(a.title.length + a.desc.length).toBeGreaterThan(10)
  })
})

describe('H 文案一致性 / 分块矩阵注释', () => {
  it('CHUNK_MATRIX_NOTES 的键全部是 ChunkStage 上真实存在的字段', () => {
    const chunk = selectChunk(TRACE, 'kda', 0) as unknown as Record<string, unknown>
    for (const key of Object.keys(CHUNK_MATRIX_NOTES)) {
      expect(chunk[key], `ChunkStage 上没有字段 ${key}`).toBeDefined()
      expect(CHUNK_MATRIX_NOTES[key as ChunkMatrixKey].length).toBeGreaterThan(8)
    }
  })

  it('ChunkStage 的矩阵字段全部有注释（新增字段必须补文案）', () => {
    const chunk = selectChunk(TRACE, 'kda', 0) as unknown as Record<string, unknown>
    const SKIP = ['chunkIndex', 'tokenRange', 'betaVec']
    for (const key of Object.keys(chunk)) {
      if (SKIP.includes(key)) continue
      expect(Object.keys(CHUNK_MATRIX_NOTES), `ChunkStage.${key} 缺少 CHUNK_MATRIX_NOTES 注释`).toContain(key)
    }
  })

  it('CHUNK_MATRIX_LABELS 与 CHUNK_MATRIX_NOTES 的键完全一致（标题/注释不得单边缺失）', () => {
    expect(Object.keys(CHUNK_MATRIX_LABELS).sort()).toEqual(Object.keys(CHUNK_MATRIX_NOTES).sort())
    for (const v of Object.values(CHUNK_MATRIX_LABELS)) expect(v.length).toBeGreaterThan(0)
  })

  it('CHUNK_VIEWS 与引擎的两条分块路径一一对应', () => {
    expect(CHUNK_VIEWS.map((v) => v.id)).toEqual(['deltanet', 'kda'])
    for (const v of CHUNK_VIEWS) expect(TRACE.chunked[v.id].chunks.length).toBeGreaterThan(0)
  })
})

describe('H 文案一致性 / K3 结构与 models.ts 口径互锁', () => {
  it('K3_STRUCTURE 计数自洽', () => {
    expect(K3_STRUCTURE.kdaLayers).toBe(69)
    expect(K3_STRUCTURE.mlaLayers).toBe(24)
    expect(K3_STRUCTURE.totalLayers).toBe(K3_STRUCTURE.kdaLayers + K3_STRUCTURE.mlaLayers)
    expect(K3_STRUCTURE.interleaveNote).toContain('示意')
  })

  it('buildLayerBand 产出的条带计数与 K3_STRUCTURE 严格一致', () => {
    const band = buildLayerBand()
    expect(band.length).toBe(K3_STRUCTURE.totalLayers)
    expect(band.filter((x) => x === 'kda').length).toBe(K3_STRUCTURE.kdaLayers)
    expect(band.filter((x) => x === 'mla').length).toBe(K3_STRUCTURE.mlaLayers)
  })

  it('69/24 与 models.ts 的 kimi-k3 条目文案一致（防两处漂移）', () => {
    const k3 = MODELS.find((m) => m.id === 'kimi-k3')
    expect(k3).toBeDefined()
    if (!k3) return
    const note = k3.kvSpec.kind === 'unsupported' ? k3.kvSpec.note : ''
    const text = [note, ...k3.diffVsTransformer, ...k3.highlights.map((h) => `${h.what} ${h.why}`)].join(' ')
    expect(text).toContain(String(K3_STRUCTURE.kdaLayers))
    expect(text).toContain(String(K3_STRUCTURE.mlaLayers))
    expect(k3.attentionType).toBe('KDA')
    // 溯源同源：K3_STRUCTURE 直接引用 models.ts 的 sourceUrl/asOf
    expect(K3_STRUCTURE.sourceUrl).toBe(k3.sourceUrl)
    expect(K3_STRUCTURE.asOf).toBe(k3.asOf)
  })

  it('NETWORK_NODES id 唯一、字段完整，且 ~2.5× 文案不单项归因 KDA', () => {
    const ids = new Set(NETWORK_NODES.map((n) => n.id))
    expect(ids.size).toBe(NETWORK_NODES.length)
    expect(ids.has('kda-layer')).toBe(true)
    for (const n of NETWORK_NODES) {
      expect(n.name.length).toBeGreaterThan(0)
      expect(n.what.length).toBeGreaterThan(10)
      expect(n.why.length).toBeGreaterThan(10)
      expect(n.interview.length).toBeGreaterThan(10)
    }
    // PLAN.md:20 文案红线：提到 2.5× 必须同时点明是综合收益
    const all = NETWORK_NODES.map((n) => `${n.what} ${n.why} ${n.interview}`).join(' ')
    if (all.includes('2.5')) {
      expect(all).toMatch(/综合收益|不能单项归因|不宜单项归因/)
    }
  })
})
