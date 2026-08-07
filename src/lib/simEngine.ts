// 纯函数模拟引擎：显存 / 性能 / 经济估算
// ⚠️ 所有性能数字为 roofline 简化示意估算（非实测 benchmark）：
//   - prefill 视为算力瓶颈：FLOPs ≈ 2 × 激活参数 × prompt tokens，除以 (算力 × MFU)
//   - decode 视为带宽瓶颈：每步读一遍激活权重（batch 共享）+ 各请求 KV，除以 (带宽 × MBU)
//   - MFU/MBU 取保守经验值，真实系统受 kernel/并行/调度影响上下浮动
import type { KVSpec } from '../data/types'

export interface QuantOption {
  id: 'fp16' | 'fp8' | 'int4'
  label: string
  bytesPerParam: number
}

export const QUANTS: QuantOption[] = [
  { id: 'fp16', label: 'FP16/BF16', bytesPerParam: 2 },
  { id: 'fp8', label: 'FP8', bytesPerParam: 1 },
  { id: 'int4', label: 'INT4/FP4', bytesPerParam: 0.5 },
]

export const DEFAULT_MFU = 0.4 // prefill 算力利用率（经验值）
export const DEFAULT_MBU = 0.6 // decode 带宽利用率（经验值）
const KV_BYTES = 2 // KV 按 FP16 存储

// 权重显存：参数量(B) × 每参数字节 = GB（1e9 × bytes / 1e9）
export function weightMemoryGB(totalParamsB: number, bytesPerParam: number): number {
  return totalParamsB * bytesPerParam
}

// 每 token 每层之和的 KV 字节数；新型稀疏/线性注意力无公开参数时返回 null（不做伪精确估算）
export function kvBytesPerToken(kv: KVSpec): number | null {
  switch (kv.kind) {
    case 'mha-gqa':
      return 2 * kv.kvHeads * kv.headDim * kv.numLayers * KV_BYTES
    case 'mla':
      // MLA 只缓存压缩 latent（如 DeepSeek 512+64=576 维），无 K/V 两份
      return kv.kvLatentDim * kv.numLayers * KV_BYTES
    case 'unsupported':
      return null
  }
}

export function kvCacheGB(kv: KVSpec, contextTokens: number, batch: number): number | null {
  const per = kvBytesPerToken(kv)
  if (per === null) return null
  return (per * contextTokens * batch) / 1e9
}

export interface MemoryBreakdown {
  weightsGB: number
  kvGB: number | null
  overheadGB: number
  totalGB: number | null
}

// 开销：激活/运行时/碎片，简化为权重 10% + 2GB
export function memoryBreakdown(
  totalParamsB: number,
  bytesPerParam: number,
  kv: KVSpec,
  contextTokens: number,
  batch: number,
): MemoryBreakdown {
  const weightsGB = weightMemoryGB(totalParamsB, bytesPerParam)
  const kvGB = kvCacheGB(kv, contextTokens, batch)
  const overheadGB = weightsGB * 0.1 + 2
  return { weightsGB, kvGB, overheadGB, totalGB: kvGB === null ? null : weightsGB + kvGB + overheadGB }
}

// 最少 GPU 数（默认可用显存 90%，留服务余量）
export function minGpus(totalGB: number, gpuMemoryGB: number, usable = 0.9): number {
  return Math.max(1, Math.ceil(totalGB / (gpuMemoryGB * usable)))
}

// 按所选量化取 GPU 算力口径：仅在官方公布对应精度算力时切换（INT4/FP4 → fp4Tflops），
// 其余（含 FP16——数据层无官方 FP16 字段）回退 FP8 口径，basis 供 UI 标注「按 FP8 算力口径」；不编造硬件数字
export function tflopsForQuant(
  gpu: { fp8Tflops: number | null; fp4Tflops: number | null },
  quantId: QuantOption['id'],
): { tflops: number | null; basis: 'fp8' | 'fp4' } {
  if (quantId === 'int4' && gpu.fp4Tflops !== null) return { tflops: gpu.fp4Tflops, basis: 'fp4' }
  return { tflops: gpu.fp8Tflops, basis: 'fp8' }
}

// TTFT 估算（ms）：prefill FLOPs ≈ 2 × 激活参数 × prompt tokens
export function estTTFTms(
  activeParamsB: number,
  promptTokens: number,
  gpuTflops: number | null,
  gpuCount: number,
  mfu = DEFAULT_MFU,
): number | null {
  if (gpuTflops === null) return null
  const flops = 2 * activeParamsB * 1e9 * promptTokens
  return (flops / (gpuTflops * 1e12 * gpuCount * mfu)) * 1000
}

// 每 decode 步时长（ms）：读一遍激活权重（batch 共享）+ batch 份 KV
export function estStepMs(
  activeParamsB: number,
  bytesPerParam: number,
  kvPerTokenBytes: number | null,
  contextTokens: number,
  batch: number,
  bandwidthTBs: number,
  gpuCount: number,
  mbu = DEFAULT_MBU,
): number {
  const weightBytes = activeParamsB * 1e9 * bytesPerParam
  const kvBytes = kvPerTokenBytes === null ? 0 : kvPerTokenBytes * contextTokens * batch
  return ((weightBytes + kvBytes) / (bandwidthTBs * 1e12 * gpuCount * mbu)) * 1000
}

// 集群总吞吐 tokens/s：每步出 batch 个 token
export function tokensPerSecond(stepMs: number, batch: number): number {
  return (batch / stepMs) * 1000
}

// ─────────── 经济模型 ───────────

// 自建成本 $/MTok = 集群每小时总成本 ÷ (吞吐 tokens/s × 3600 × 利用率) × 1e6
// 利用率在分母：利用率越低单位成本越高
export function selfHostCostPerMTok(clusterHourlyUSD: number, tokensPerSec: number, utilization: number): number {
  return (clusterHourlyUSD / (tokensPerSec * 3600 * utilization)) * 1e6
}

// 一次请求的 API 成本（$）：未命中输入 + 命中输入 + 输出 分段计价
export function apiRequestCost(
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens: number,
  inputPerMTok: number,
  outputPerMTok: number,
  cachedPerMTok: number | null,
): number {
  const uncached = Math.max(0, inputTokens - cacheHitTokens)
  const cachedPrice = cachedPerMTok ?? inputPerMTok
  return (uncached * inputPerMTok + cacheHitTokens * cachedPrice + outputTokens * outputPerMTok) / 1e6
}

// 按流量结构混合出的 API 均价 $/MTok（输入/输出/缓存占比加权）
export function apiBlendedPerMTok(
  inputShare: number,
  outputShare: number,
  cacheHitRateOnInput: number,
  inputPerMTok: number,
  outputPerMTok: number,
  cachedPerMTok: number | null,
): number {
  const cachedPrice = cachedPerMTok ?? inputPerMTok
  const inputPrice = inputPerMTok * (1 - cacheHitRateOnInput) + cachedPrice * cacheHitRateOnInput
  return inputShare * inputPrice + outputShare * outputPerMTok
}

// 盈亏平衡日均 MTok：自建每日固定成本 ÷ API 均价
export function breakEvenDailyMTok(clusterHourlyUSD: number, apiPerMTok: number): number {
  return (clusterHourlyUSD * 24) / apiPerMTok
}

// token 数估算（无 tokenizer 的经验近似，UI 需标注"估算"并允许手动修改）：
// 中文 ≈ 1 字 / 0.6 token 即 chars/1.6；英文与代码 ≈ 4 字符 / token
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[一-鿿　-〿＀-￯]/.test(ch)) cjk++
    else other++
  }
  return Math.max(1, Math.round(cjk / 1.6 + other / 4))
}
