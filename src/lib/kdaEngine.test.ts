// kdaEngine 测试（PLAN-kda-demo.md §4 测试组 A–G；组 H 文案一致性由 src/data/kda.ts 交付时补）
// 容差约定：恒等类 1e-12，分块对拍 1e-10（恒等变形，对拍失败先查实现禁放宽容差），
// 已知算例 toBeCloseTo(…,10) 或整数 toEqual。
import { describe, expect, it } from 'vitest'
import {
  addMat,
  buildKdaTrace,
  DEFAULT_SCENARIO,
  dplrTransition,
  fmt,
  identity,
  matMul,
  matVec,
  maxAbsDiff,
  normalize,
  outer,
  runChunkedTrace,
  runVariantTrace,
  scaleColumns,
  selectChunk,
  selectErrorChartData,
  selectErrorCurve,
  selectProbeSeries,
  selectStep,
  solveUnitLower,
  stepDeltaNet,
  stepKda,
  stepNaive,
  subMat,
  transpose,
  validateScenario,
  zeros,
} from './kdaEngine'
import type { Mat, ScenarioSpec, Vec } from './kdaEngine'

// ─────────── 测试工具（确定性：全文件禁 Math.random，随机压力用 seeded mulberry32） ───────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const randVec = (rnd: () => number, n: number, scale = 2): number[] =>
  Array.from({ length: n }, () => (rnd() - 0.5) * scale)

const randMat = (rnd: () => number, rows: number, cols: number, scale = 2): Mat =>
  Array.from({ length: rows }, () => randVec(rnd, cols, scale))

const col = (m: Mat, j: number): Vec => m.map((row) => row[j])

const maxVecDiff = (a: Vec, b: Vec): number => Math.max(...a.map((x, i) => Math.abs(x - b[i])))

function expectVecClose(actual: Vec, expected: readonly number[], digits = 10): void {
  expect(actual.length).toBe(expected.length)
  expected.forEach((x, i) => expect(actual[i]).toBeCloseTo(x, digits))
}

// 随机场景（分块压力对拍用）：8 token、d_k=d_v=4，α ∈ [0.05,1]（分块数值边界内）、β ∈ [0.2,1]
function randomScenario(rnd: () => number, chunkSize: number): ScenarioSpec {
  return {
    id: `rand-c${chunkSize}`,
    dK: 4,
    dV: 4,
    chunkSize,
    tokens: Array.from({ length: 8 }, (_, i) => ({
      t: i + 1,
      kRaw: randVec(rnd, 4),
      v: randVec(rnd, 4, 4),
      role: 'write-ortho' as const,
    })),
    defaults: {
      beta: 0.2 + 0.8 * rnd(),
      alphaScalar: 0.9,
      alphaVec: Array.from({ length: 4 }, () => 0.05 + 0.95 * rnd()),
    },
  }
}

// ─────────── A. 线代原语 ───────────

describe('A. 线代原语与 fmt', () => {
  it('matMul / outer / transpose 已知算例', () => {
    expect(
      matMul(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [5, 6],
          [7, 8],
        ],
      ),
    ).toEqual([
      [19, 22],
      [43, 50],
    ])
    expect(outer([1, 2, 3], [4, 5])).toEqual([
      [4, 5],
      [8, 10],
      [12, 15],
    ])
    expect(
      transpose([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ])
  })

  it('solveUnitLower 前代替换：回代 (I+L)·X ≡ B', () => {
    const L = [
      [0, 0, 0],
      [2, 0, 0],
      [-1, 3, 0],
    ]
    const B = [
      [1, 2],
      [3, 4],
      [5, 6],
    ]
    const X = solveUnitLower(L, B)
    expect(maxAbsDiff(matMul(addMat(identity(3), L), X), B)).toBeLessThan(1e-12)
  })

  it('normalize：√2/2 分量、单位模长、零向量 throw', () => {
    const n = normalize([1, 1, 0, 0])
    expect(n[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(Math.sqrt(n.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 12)
    expect(() => normalize([0, 0, 0, 0])).toThrow()
  })

  it('fmt 全站唯一格式化：√2/2→0.71、−0→0、去尾零、digits 可调', () => {
    expect(fmt(Math.SQRT1_2)).toBe('0.71')
    expect(fmt(2)).toBe('2')
    expect(fmt(0.5)).toBe('0.5')
    expect(fmt(-0)).toBe('0')
    expect(fmt(-1e-13)).toBe('0')
    expect(fmt(-2)).toBe('-2')
    expect(fmt(1.414, 1)).toBe('1.4')
  })
})

// ─────────── B. Naive ───────────

describe('B. Naive 线性注意力', () => {
  it('t1/t2 正交两写：S₂ 为精确整数矩阵', () => {
    const tr = runVariantTrace(DEFAULT_SCENARIO, 'naive')
    expect(tr.steps[1].sAfter).toEqual([
      [2, 0, 0, 0],
      [0, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ])
  })

  it('t3 非正交冲突后 probe(1)：v₃/√2 泄漏进 e₁ 槽，误差 = √2', () => {
    const tr = runVariantTrace(DEFAULT_SCENARIO, 'naive')
    const probe = tr.steps[2].retrieval.find((p) => p.srcT === 1)
    if (!probe) throw new Error('缺少 srcT=1 探针')
    expectVecClose(probe.retrieved, [2, 0, Math.SQRT2, 0])
    expect(probe.errorL2).toBeCloseTo(Math.SQRT2, 10)
  })

  it('重复 key 叠加（只加不减）：S·k = v_a + v_b', () => {
    const k = [1, 0, 0, 0]
    let s = stepNaive(zeros(4, 4), k, [2, 0, 0, 0])
    s = stepNaive(s, k, [-1, 3, 0, 0])
    expectVecClose(matVec(s, k), [1, 3, 0, 0])
  })
})

// ─────────── C. DeltaNet ───────────

describe('C. DeltaNet', () => {
  it('转移形式 ≡ 残差形式 S+β(v−Sk)k^T（mulberry32 随机对拍 20 组）', () => {
    const rnd = mulberry32(42)
    for (let trial = 0; trial < 20; trial++) {
      const s = randMat(rnd, 4, 4)
      const k = normalize(randVec(rnd, 4))
      const v = randVec(rnd, 4)
      const beta = rnd()
      const residual = v.map((x, i) => x - matVec(s, k)[i])
      const viaResidual = addMat(
        s,
        outer(
          residual.map((x) => beta * x),
          k,
        ),
      )
      expect(maxAbsDiff(stepDeltaNet(s, k, v, beta), viaResidual)).toBeLessThan(1e-12)
    }
  })

  it('覆盖写公理：‖k‖=1 且 β=1 ⇒ S_t·k = v 精确（任意先前状态）', () => {
    const rnd = mulberry32(43)
    for (let trial = 0; trial < 10; trial++) {
      const s = randMat(rnd, 4, 4, 6)
      const k = normalize(randVec(rnd, 4))
      const v = randVec(rnd, 4, 4)
      expect(maxVecDiff(matVec(stepDeltaNet(s, k, v, 1), k), v)).toBeLessThan(1e-12)
    }
  })

  it('β=0 ⇒ 状态严格不变', () => {
    const rnd = mulberry32(44)
    const s = randMat(rnd, 4, 4)
    expect(maxAbsDiff(stepDeltaNet(s, normalize(randVec(rnd, 4)), randVec(rnd, 4), 0), s)).toBe(0)
  })

  it('β=0.5 中点插值：S_t·k = 0.5·v̂ + 0.5·v', () => {
    const rnd = mulberry32(45)
    const s = randMat(rnd, 4, 4)
    const k = normalize(randVec(rnd, 4))
    const v = randVec(rnd, 4)
    const vHat = matVec(s, k)
    const mid = vHat.map((x, i) => 0.5 * x + 0.5 * v[i])
    expect(maxVecDiff(matVec(stepDeltaNet(s, k, v, 0.5), k), mid)).toBeLessThan(1e-12)
  })

  it('与 k 正交方向不受 (I−βkk^T) 影响：S_t·w ≡ S_{t-1}·w（w ⊥ k）', () => {
    const rnd = mulberry32(46)
    for (let trial = 0; trial < 10; trial++) {
      const s = randMat(rnd, 4, 4)
      const k = normalize(randVec(rnd, 4))
      const w0 = randVec(rnd, 4)
      const proj = w0.reduce((acc, x, i) => acc + x * k[i], 0)
      const w = w0.map((x, i) => x - proj * k[i]) // Gram-Schmidt：w ⊥ k
      expect(maxVecDiff(matVec(stepDeltaNet(s, k, randVec(rnd, 4), rnd()), w), matVec(s, w))).toBeLessThan(1e-12)
    }
  })

  it('已知算例锚点（β=1）：S₃e₁ = (1,−1,√2,0)、S₄e₁ = (−2,0,0,0)', () => {
    const tr = runVariantTrace(DEFAULT_SCENARIO, 'deltanet')
    expectVecClose(col(tr.steps[2].sAfter, 0), [1, -1, Math.SQRT2, 0])
    expectVecClose(col(tr.steps[3].sAfter, 0), [-2, 0, 0, 0])
  })
})

// ─────────── D. Gated ───────────

describe('D. Gated DeltaNet', () => {
  it('α=1 全 trace ≡ DeltaNet（退化）', () => {
    const g = runVariantTrace(DEFAULT_SCENARIO, 'gated', { alphaScalar: 1 })
    const d = runVariantTrace(DEFAULT_SCENARIO, 'deltanet')
    g.steps.forEach((step, i) => expect(maxAbsDiff(step.sAfter, d.steps[i].sAfter)).toBeLessThan(1e-12))
  })

  it('α=0 完全遗忘：每步 S_t = β·v_t·k_t^T', () => {
    const g = runVariantTrace(DEFAULT_SCENARIO, 'gated', { alphaScalar: 0, beta: 0.8 })
    g.steps.forEach((step) => {
      const expected = outer(
        step.v.map((x) => 0.8 * x),
        step.k,
      )
      expect(maxAbsDiff(step.sAfter, expected)).toBeLessThan(1e-12)
    })
  })

  it('衰减存在时覆盖写仍精确：β=1 ⇒ 每步 S_t·k_t = v_t', () => {
    const g = runVariantTrace(DEFAULT_SCENARIO, 'gated') // 默认 α=0.9、β=1
    g.steps.forEach((step) => expect(maxVecDiff(matVec(step.sAfter, step.k), step.v)).toBeLessThan(1e-12))
  })

  it('标量衰减已知算例：α=0.9 ⇒ S₂e₁ = (1.8,0,0,0)', () => {
    const g = runVariantTrace(DEFAULT_SCENARIO, 'gated')
    expectVecClose(col(g.steps[1].sAfter, 0), [1.8, 0, 0, 0])
  })
})

// ─────────── E. KDA ───────────

describe('E. KDA', () => {
  it('退化链全 trace：KDA(αVec=c·1) ≡ Gated(α=c)；KDA(αVec=1) ≡ DeltaNet', () => {
    const kdaC = runVariantTrace(DEFAULT_SCENARIO, 'kda', { alphaVec: [0.7, 0.7, 0.7, 0.7], beta: 0.8 })
    const gatedC = runVariantTrace(DEFAULT_SCENARIO, 'gated', { alphaScalar: 0.7, beta: 0.8 })
    kdaC.steps.forEach((step, i) => expect(maxAbsDiff(step.sAfter, gatedC.steps[i].sAfter)).toBeLessThan(1e-12))
    const kda1 = runVariantTrace(DEFAULT_SCENARIO, 'kda', { alphaVec: [1, 1, 1, 1] })
    const dn = runVariantTrace(DEFAULT_SCENARIO, 'deltanet')
    kda1.steps.forEach((step, i) => expect(maxAbsDiff(step.sAfter, dn.steps[i].sAfter)).toBeLessThan(1e-12))
  })

  it('通道级选择性：β=0、αVec=(1,0.5,1,1) ⇒ 仅第 2 列 ×0.5，其余列不动', () => {
    const rnd = mulberry32(11)
    const s = randMat(rnd, 4, 4)
    const out = stepKda(s, normalize(randVec(rnd, 4)), randVec(rnd, 4), 0, [1, 0.5, 1, 1])
    s.forEach((row, i) => row.forEach((x, j) => expect(out[i][j]).toBeCloseTo(j === 1 ? x * 0.5 : x, 12)))
  })

  it('trace 分解字段自洽：prediction ≡ S_{t-1}·Diag(α)·k、sAfter ≡ sDecayed + writeOuter', () => {
    const tr = runVariantTrace(DEFAULT_SCENARIO, 'kda')
    tr.steps.forEach((step) => {
      if (step.kind !== 'delta') throw new Error('kda trace 步骤应为 delta')
      expect(maxVecDiff(step.prediction, matVec(scaleColumns(step.sBefore, step.alpha), step.k))).toBeLessThan(1e-12)
      expect(maxAbsDiff(step.sAfter, addMat(step.sDecayed, step.writeOuter))).toBeLessThan(1e-12)
    })
  })

  it('DPLR：a=−β(α⊙k)、b=k、full ≡ Diag(α)+a·b^T，且 stepKda ≡ S·full + βvk^T', () => {
    const alphaVec = [1, 1, 0.5, 0.9]
    const beta = 0.8
    const rnd = mulberry32(13)
    const k = normalize(randVec(rnd, 4))
    const v = randVec(rnd, 4)
    const s = randMat(rnd, 4, 4)
    const tr = dplrTransition(k, beta, alphaVec)
    expectVecClose(
      tr.lowRankA,
      alphaVec.map((a, i) => -beta * a * k[i]),
      12,
    )
    expectVecClose(tr.lowRankB, k, 12)
    const rebuilt = addMat(scaleColumns(identity(4), alphaVec), outer(tr.lowRankA, tr.lowRankB))
    expect(maxAbsDiff(tr.full, rebuilt)).toBeLessThan(1e-15)
    const viaDplr = addMat(
      matMul(s, tr.full),
      outer(
        v.map((x) => beta * x),
        k,
      ),
    )
    expect(maxAbsDiff(stepKda(s, k, v, beta, alphaVec), viaDplr)).toBeLessThan(1e-12)
  })
})

// ─────────── F. 分块 ≡ 递推（核心验收：恒等变形，对拍失败先查实现禁放宽容差） ───────────

describe('F. 分块并行 ≡ 逐步递推', () => {
  it('默认场景 DeltaNet：maxAbsDiffVsRecurrent < 1e-10，逐块结构与逐 token 输出对拍', () => {
    const rec = runVariantTrace(DEFAULT_SCENARIO, 'deltanet')
    const ch = runChunkedTrace(DEFAULT_SCENARIO, 'deltanet', rec)
    expect(ch.chunks.length).toBe(2)
    expect(ch.chunks[0].tokenRange).toEqual([1, 4])
    expect(ch.chunks[1].tokenRange).toEqual([5, 8])
    expect(ch.maxAbsDiffVsRecurrent).toBeLessThan(1e-10)
    expect(maxAbsDiff(ch.finalS, rec.finalS)).toBeLessThan(1e-10)
    // 测试侧独立重比逐 token 输出（不信引擎自报的 maxAbsDiffVsRecurrent）
    ch.chunks.forEach((stage, ci) =>
      stage.outputs.forEach((row, i) => expect(maxVecDiff(row, rec.steps[ci * 4 + i].output)).toBeLessThan(1e-10)),
    )
  })

  it('默认场景 KDA（αVec=(1,1,0.5,0.9)）：maxAbsDiffVsRecurrent < 1e-10，块尾状态对拍', () => {
    const rec = runVariantTrace(DEFAULT_SCENARIO, 'kda')
    const ch = runChunkedTrace(DEFAULT_SCENARIO, 'kda', rec)
    expect(ch.maxAbsDiffVsRecurrent).toBeLessThan(1e-10)
    expect(maxAbsDiff(ch.chunks[0].sOut, rec.steps[3].sAfter)).toBeLessThan(1e-10)
    expect(maxAbsDiff(ch.chunks[1].sOut, rec.steps[7].sAfter)).toBeLessThan(1e-10)
  })

  it('WY 结构恒等：W ≡ T·K⁺、U ≡ T·V、(I+gram)·T ≡ diag(β)', () => {
    for (const variant of ['deltanet', 'kda'] as const) {
      const ch = runChunkedTrace(DEFAULT_SCENARIO, variant, runVariantTrace(DEFAULT_SCENARIO, variant))
      ch.chunks.forEach((stage) => {
        expect(maxAbsDiff(stage.W, matMul(stage.T, stage.kPlus))).toBeLessThan(1e-12)
        expect(maxAbsDiff(stage.U, matMul(stage.T, stage.V))).toBeLessThan(1e-12)
        const n = stage.T.length
        expect(
          maxAbsDiff(matMul(addMat(identity(n), stage.gram), stage.T), scaleColumns(identity(n), stage.betaVec)),
        ).toBeLessThan(1e-12)
      })
    }
  })

  it('经典 WY 状态双路径（α≡1）：sIn(I−W^TK)+U^TK ≡ sIn+X^TK ≡ sOut', () => {
    const ch = runChunkedTrace(DEFAULT_SCENARIO, 'deltanet', runVariantTrace(DEFAULT_SCENARIO, 'deltanet'))
    ch.chunks.forEach((stage) => {
      const path1 = addMat(
        subMat(stage.sIn, matMul(matMul(stage.sIn, transpose(stage.W)), stage.K)),
        matMul(transpose(stage.U), stage.K),
      )
      const path2 = addMat(stage.sIn, matMul(transpose(stage.X), stage.K))
      expect(maxAbsDiff(path1, path2)).toBeLessThan(1e-12)
      expect(maxAbsDiff(path1, stage.sOut)).toBeLessThan(1e-12)
    })
  })

  it('gram 公式重算对拍：gram[i][j] = i>j ? β·⟨K⁺行i, K⁻行j⟩ : 0', () => {
    const ch = runChunkedTrace(DEFAULT_SCENARIO, 'kda', runVariantTrace(DEFAULT_SCENARIO, 'kda'))
    ch.chunks.forEach((stage) => {
      stage.gram.forEach((row, i) =>
        row.forEach((x, j) => {
          const expected =
            j < i ? stage.betaVec[i] * stage.kPlus[i].reduce((acc, y, p) => acc + y * stage.kMinus[j][p], 0) : 0
          expect(x).toBeCloseTo(expected, 12)
        }),
      )
    })
  })

  it('正交块手算例：K=标准基 ⇒ gram=0、T=diag(β)=I、X=V、S_out=V^T、o_t=v_t', () => {
    const V = [
      [1, 0, 2, 0],
      [0, 3, 0, 0],
      [0, 0, 4, 1],
      [5, 0, 0, 6],
    ]
    const ortho: ScenarioSpec = {
      id: 'ortho-basis',
      dK: 4,
      dV: 4,
      chunkSize: 4,
      tokens: V.map((v, i) => ({
        t: i + 1,
        kRaw: [0, 0, 0, 0].map((_, j) => (j === i ? 1 : 0)),
        v,
        role: 'write-ortho' as const,
      })),
      defaults: { beta: 1, alphaScalar: 1, alphaVec: [1, 1, 1, 1] },
    }
    const ch = runChunkedTrace(ortho, 'deltanet', runVariantTrace(ortho, 'deltanet'))
    const stage = ch.chunks[0]
    expect(maxAbsDiff(stage.gram, zeros(4, 4))).toBe(0)
    expect(maxAbsDiff(stage.T, identity(4))).toBe(0)
    expect(maxAbsDiff(stage.X, V)).toBeLessThan(1e-12)
    expect(maxAbsDiff(stage.sOut, transpose(V))).toBeLessThan(1e-12)
    stage.outputs.forEach((row, i) => expectVecClose(row, V[i]))
    expect(ch.maxAbsDiffVsRecurrent).toBeLessThan(1e-12)
  })

  it('mulberry32 随机压力：5 seeds × chunkSize∈{4,1,3}（含退化与非整除尾块）× 两变体全部 < 1e-10', () => {
    for (let seed = 1; seed <= 5; seed++) {
      for (const chunkSize of [4, 1, 3]) {
        const sc = randomScenario(mulberry32(seed * 100 + chunkSize), chunkSize)
        for (const variant of ['deltanet', 'kda'] as const) {
          const rec = runVariantTrace(sc, variant)
          expect(runChunkedTrace(sc, variant, rec).maxAbsDiffVsRecurrent).toBeLessThan(1e-10)
        }
      }
    }
  })

  it('跨块状态传递：chunks[1].sIn ≡ chunks[0].sOut；chunkSize=1 退化为逐步递推', () => {
    const ch = runChunkedTrace(DEFAULT_SCENARIO, 'kda', runVariantTrace(DEFAULT_SCENARIO, 'kda'))
    expect(maxAbsDiff(ch.chunks[1].sIn, ch.chunks[0].sOut)).toBe(0)
    const c1: ScenarioSpec = { ...DEFAULT_SCENARIO, chunkSize: 1 }
    const chd = runChunkedTrace(c1, 'kda', runVariantTrace(c1, 'kda'))
    expect(chd.chunks.length).toBe(8)
    expect(chd.maxAbsDiffVsRecurrent).toBeLessThan(1e-10)
  })

  it('α 含 0：递推可跑（有限值），分块 throw（α ≥ 0.05 数值边界）；deltanet 分块不受 αVec 影响', () => {
    const withZero: ScenarioSpec = {
      ...DEFAULT_SCENARIO,
      defaults: { ...DEFAULT_SCENARIO.defaults, alphaVec: [1, 1, 0, 0.9] },
    }
    const rec = runVariantTrace(withZero, 'kda')
    expect(rec.finalS.every((row) => row.every(Number.isFinite))).toBe(true)
    expect(() => runChunkedTrace(withZero, 'kda', rec)).toThrow()
    // 边界内侧：α=0.04 < 0.05 同样 throw
    const below: ScenarioSpec = {
      ...DEFAULT_SCENARIO,
      defaults: { ...DEFAULT_SCENARIO.defaults, alphaVec: [1, 1, 0.04, 0.9] },
    }
    expect(() => runChunkedTrace(below, 'kda', runVariantTrace(below, 'kda'))).toThrow()
    // deltanet 分块用 α≡1，不受场景 αVec 含 0 影响
    expect(() => runChunkedTrace(withZero, 'deltanet', runVariantTrace(withZero, 'deltanet'))).not.toThrow()
  })

  it('一致性守卫：recurrent 变体或参数不匹配 throw', () => {
    const rec = runVariantTrace(DEFAULT_SCENARIO, 'deltanet')
    expect(() => runChunkedTrace(DEFAULT_SCENARIO, 'kda', rec)).toThrow()
    expect(() => runChunkedTrace(DEFAULT_SCENARIO, 'deltanet', rec, { beta: 0.5 })).toThrow()
  })
})

// ─────────── G. 组装与 selectors ───────────

describe('G. buildKdaTrace 与 selectors', () => {
  it('确定性：两次构建 deep-equal（禁 Date.now/Math.random 的行为验证）', () => {
    expect(buildKdaTrace()).toEqual(buildKdaTrace())
  })

  it('validateScenario：维度/取值/顺序违规 throw，默认场景通过', () => {
    const base = DEFAULT_SCENARIO
    expect(() => validateScenario(base)).not.toThrow()
    expect(() => validateScenario({ ...base, dK: 0 })).toThrow()
    expect(() => validateScenario({ ...base, defaults: { ...base.defaults, alphaVec: [1, 1, 1.2, 0.9] } })).toThrow()
    expect(() => validateScenario({ ...base, defaults: { ...base.defaults, beta: -0.1 } })).toThrow()
    expect(() =>
      validateScenario({ ...base, tokens: base.tokens.map((tok, i) => (i === 2 ? { ...tok, t: 9 } : tok)) }),
    ).toThrow()
    expect(() => validateScenario({ ...base, tokens: [{ ...base.tokens[0], kRaw: [0, 0, 0, 0] }] })).toThrow()
    expect(() => validateScenario({ ...base, tokens: [{ ...base.tokens[0], kRaw: [1, 0, 0] }] })).toThrow()
  })

  it('LabOverrides 生效：β=0 且 α≡1 ⇒ delta 系全程 S=0，naive 不受影响；chunked 恒用 defaults', () => {
    const tr = buildKdaTrace(DEFAULT_SCENARIO, { beta: 0, alphaScalar: 1, alphaVec: [1, 1, 1, 1] })
    for (const variant of ['deltanet', 'gated', 'kda'] as const) {
      tr.variants[variant].steps.forEach((step) => expect(maxAbsDiff(step.sAfter, zeros(4, 4))).toBeLessThan(1e-15))
    }
    expect(tr.variants.naive.steps[0].sAfter[0][0]).toBe(2)
    // Tab3 分块固定默认参数：不吃 overrides，与无 overrides 构建完全一致
    const plain = buildKdaTrace()
    expect(tr.chunked.kda.finalS).toEqual(plain.chunked.kda.finalS)
    expect(tr.chunked.kda.params.beta).toBe(1)
    expect(tr.chunked.deltanet.maxAbsDiffVsRecurrent).toBeLessThan(1e-10)
  })

  it('探针语义：第 t 步恰 t 个探针；覆盖写后 target 切换为最新写入值（误差归零而非升高）', () => {
    const dn = buildKdaTrace().variants.deltanet
    dn.steps.forEach((step) => expect(step.retrieval.length).toBe(step.t))
    const at3 = dn.steps[2].retrieval.find((p) => p.srcT === 1)
    const at4 = dn.steps[3].retrieval.find((p) => p.srcT === 1)
    const at8 = dn.steps[7].retrieval.find((p) => p.srcT === 2)
    if (!at3 || !at4 || !at8) throw new Error('缺少探针')
    expect(at3.targetT).toBe(1) // t3 时 t1 尚未被覆盖
    expect(at4.targetT).toBe(4) // t4 覆盖 t1（同 key 方向）→ target 切到 v₄
    expectVecClose(at4.target, [-2, 0, 0, 0])
    expectVecClose(at4.originalTarget, [2, 0, 0, 0])
    expect(at4.errorL2).toBeCloseTo(0, 10) // β=1 覆盖写成功 ⇒ 检索误差归零
    expect(at8.targetT).toBe(7) // t7 跨块覆盖 t2
  })

  it('selectors：selectStep 锚点、误差曲线已知点 (2+√6)/4、chart 四键、probeSeries、selectChunk', () => {
    const tr = buildKdaTrace()
    expectVecClose(col(selectStep(tr, 'deltanet', 4).sAfter, 0), [-2, 0, 0, 0])
    const curve = selectErrorCurve(tr, 'deltanet')
    expect(curve.length).toBe(8)
    expect(curve.map((pt) => pt.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // 手算：t=4 时 4 个探针误差 = (0, 2, √6, 0) ⇒ meanErr=(2+√6)/4、maxErr=√6
    expect(curve[3].meanErr).toBeCloseTo((2 + Math.sqrt(6)) / 4, 10)
    expect(curve[3].maxErr).toBeCloseTo(Math.sqrt(6), 10)
    const chart = selectErrorChartData(tr)
    expect(chart.length).toBe(8)
    expect(Object.keys(chart[0]).sort()).toEqual(['deltanet', 'gated', 'kda', 'naive', 't'])
    expect(chart[3].deltanet).toBeCloseTo((2 + Math.sqrt(6)) / 4, 10)
    const series = selectProbeSeries(tr, 'deltanet', 1)
    expect(series.length).toBe(8)
    expect(series[0].t).toBe(1)
    expect(series[0].err).toBeCloseTo(0, 10) // β=1 写入即精确
    expect(series[2].err).toBeCloseTo(2, 10) // t3 冲突污染
    expect(series[3].err).toBeCloseTo(0, 10) // t4 覆盖写：target 切换后误差归零
    expect(selectChunk(tr, 'kda', 1).sIn).toEqual(selectChunk(tr, 'kda', 0).sOut)
  })

  it('selectors 越界 throw', () => {
    const tr = buildKdaTrace()
    expect(() => selectStep(tr, 'kda', 0)).toThrow()
    expect(() => selectStep(tr, 'kda', 9)).toThrow()
    expect(() => selectProbeSeries(tr, 'kda', 9)).toThrow()
    expect(() => selectChunk(tr, 'kda', 2)).toThrow()
  })
})
