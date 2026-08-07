import { describe, expect, it } from 'vitest'
import {
  apiBlendedPerMTok,
  apiRequestCost,
  breakEvenDailyMTok,
  estimateTokens,
  estStepMs,
  estTTFTms,
  kvBytesPerToken,
  kvCacheGB,
  memoryBreakdown,
  minGpus,
  selfHostCostPerMTok,
  tflopsForQuant,
  tokensPerSecond,
  weightMemoryGB,
} from './simEngine'

describe('显存公式', () => {
  it('70B FP8 权重 ≈ 70GB、FP16 ≈ 140GB、INT4 ≈ 35GB', () => {
    expect(weightMemoryGB(70, 1)).toBe(70)
    expect(weightMemoryGB(70, 2)).toBe(140)
    expect(weightMemoryGB(70, 0.5)).toBe(35)
  })

  it('GQA KV：Qwen3-235B（94 层 × 2×4×128 × 2B）= 192,512 B/token', () => {
    expect(kvBytesPerToken({ kind: 'mha-gqa', numLayers: 94, kvHeads: 4, headDim: 128 })).toBe(192512)
  })

  it('MLA KV：DeepSeek V3（61 层 × 576 × 2B）= 70,272 B/token —— 远小于 GQA', () => {
    expect(kvBytesPerToken({ kind: 'mla', numLayers: 61, kvLatentDim: 576 })).toBe(70272)
  })

  it('新型注意力（无公开参数）不做数值估算 → null', () => {
    expect(kvBytesPerToken({ kind: 'unsupported', note: 'KDA' })).toBeNull()
    expect(kvCacheGB({ kind: 'unsupported', note: 'KDA' }, 100_000, 8)).toBeNull()
  })

  it('KV cache 随上下文×并发线性增长', () => {
    const kv = { kind: 'mha-gqa', numLayers: 80, kvHeads: 8, headDim: 128 } as const
    const one = kvCacheGB(kv, 8000, 1)!
    expect(kvCacheGB(kv, 16000, 1)!).toBeCloseTo(one * 2)
    expect(kvCacheGB(kv, 8000, 4)!).toBeCloseTo(one * 4)
  })

  it('70B FP16 单请求 8K 上下文：总显存 >140GB → H100(80G) 需 2 卡以上', () => {
    const bd = memoryBreakdown(70, 2, { kind: 'mha-gqa', numLayers: 80, kvHeads: 8, headDim: 128 }, 8000, 1)
    expect(bd.totalGB!).toBeGreaterThan(140)
    expect(minGpus(bd.totalGB!, 80)).toBeGreaterThanOrEqual(2)
  })

  it('minGpus 留 10% 余量：72GB 模型在 80GB 卡 = 1 卡，73GB → 2 卡', () => {
    expect(minGpus(72, 80)).toBe(1)
    expect(minGpus(73, 80)).toBe(2)
  })
})

describe('性能估算（示意 roofline）', () => {
  it('TTFT 随 prompt 长度线性、随卡数反比', () => {
    const t1 = estTTFTms(70, 2000, 1979, 1)!
    expect(estTTFTms(70, 4000, 1979, 1)!).toBeCloseTo(t1 * 2)
    expect(estTTFTms(70, 2000, 1979, 2)!).toBeCloseTo(t1 / 2)
  })

  it('算力未知（如 H20 无官方 FP8 值）→ null 而非编数', () => {
    expect(estTTFTms(70, 2000, null, 1)).toBeNull()
  })

  it('decode 步时长：权重读取占主导时 batch 增大吞吐近线性提升', () => {
    const step1 = estStepMs(70, 1, null, 0, 1, 3.35, 1)
    const step32 = estStepMs(70, 1, null, 0, 32, 3.35, 1)
    expect(step32).toBeCloseTo(step1) // 无 KV 时步长与 batch 无关（权重 batch 共享）
    expect(tokensPerSecond(step32, 32)).toBeCloseTo(tokensPerSecond(step1, 1) * 32)
  })

  it('tflopsForQuant：INT4/FP4 仅在有官方 FP4 值时切换，否则回退 FP8 口径并标注 basis', () => {
    const b200 = { fp8Tflops: 4500, fp4Tflops: 9000 }
    const h100 = { fp8Tflops: 1979, fp4Tflops: null }
    const h20 = { fp8Tflops: null, fp4Tflops: null }
    expect(tflopsForQuant(b200, 'int4')).toEqual({ tflops: 9000, basis: 'fp4' })
    expect(tflopsForQuant(b200, 'fp8')).toEqual({ tflops: 4500, basis: 'fp8' })
    // 数据层无官方 FP16 算力字段 → FP16 也回退 FP8 口径（UI 标注，不编数）
    expect(tflopsForQuant(h100, 'fp16')).toEqual({ tflops: 1979, basis: 'fp8' })
    expect(tflopsForQuant(h100, 'int4')).toEqual({ tflops: 1979, basis: 'fp8' })
    // H20 无任何官方算力值 → null 透传（UI 显示 N/A）
    expect(tflopsForQuant(h20, 'int4')).toEqual({ tflops: null, basis: 'fp8' })
  })

  it('量级 sanity：70B FP8 在 H100 单卡 batch=1 的 TPOT 在几十 ms 量级', () => {
    const step = estStepMs(70, 1, null, 0, 1, 3.35, 1)
    expect(step).toBeGreaterThan(10)
    expect(step).toBeLessThan(100)
  })
})

describe('经济模型', () => {
  it('自建 $/MTok：利用率在分母（利用率越低成本越高）', () => {
    // $10/h ÷ (1000 tok/s × 3600 × 100%) × 1e6 = $2.78
    expect(selfHostCostPerMTok(10, 1000, 1)).toBeCloseTo(2.78, 2)
    expect(selfHostCostPerMTok(10, 1000, 0.5)).toBeCloseTo(5.56, 2)
  })

  it('API 请求成本分段计价：缓存命中部分按命中价', () => {
    // 2000 输入（1500 命中）+ 300 输出，$3/$15/MTok 命中 $0.3
    const cost = apiRequestCost(2000, 300, 1500, 3, 15, 0.3)
    expect(cost).toBeCloseTo((500 * 3 + 1500 * 0.3 + 300 * 15) / 1e6)
  })

  it('无缓存价时命中部分按原价（不虚报节省）', () => {
    expect(apiRequestCost(1000, 0, 500, 2, 10, null)).toBeCloseTo((1000 * 2) / 1e6)
  })

  it('混合均价与盈亏平衡', () => {
    // 输入占 80%（命中率 50%）输出占 20%，$2/$8，命中 $0.2
    const blended = apiBlendedPerMTok(0.8, 0.2, 0.5, 2, 8, 0.2)
    expect(blended).toBeCloseTo(0.8 * (2 * 0.5 + 0.2 * 0.5) + 0.2 * 8)
    // 集群 $50/h、API $2/MTok → 日均 600 MTok 打平
    expect(breakEvenDailyMTok(50, 2)).toBeCloseTo(600)
  })
})

describe('token 估算', () => {
  it('中文按 ~1.6 字/token、英文按 ~4 字符/token', () => {
    expect(estimateTokens('一二三四五六七八')).toBe(5) // 8/1.6
    expect(estimateTokens('abcdefgh')).toBe(2) // 8/4
    expect(estimateTokens('')).toBe(1)
  })
})
