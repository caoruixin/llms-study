import type { GpuChip, RackSystem, Sourced } from './types'

// GPU 芯片级（算力口径均为稠密 dense；NVIDIA 官方稀疏值 = 2× 稠密）
export const GPUS: GpuChip[] = [
  {
    id: 'h100',
    name: 'H100 SXM',
    memoryGB: 80,
    bandwidthTBs: 3.35,
    fp8Tflops: 1979,
    fp4Tflops: null,
    nvlinkGBs: 900,
    tdpW: 700,
    sourceUrl: 'https://www.nvidia.com/en-us/data-center/h100/',
    asOf: '2026-07',
  },
  {
    id: 'h200',
    name: 'H200 SXM',
    memoryGB: 141,
    bandwidthTBs: 4.8,
    fp8Tflops: 1979,
    fp4Tflops: null,
    nvlinkGBs: 900,
    tdpW: 700,
    note: '与 H100 同算力，显存 141GB / 带宽 4.8TB/s 提升——decode 场景直接受益',
    sourceUrl: 'https://www.nvidia.com/en-us/data-center/h200/',
    asOf: '2026-07',
  },
  {
    id: 'h20',
    name: 'H20（中国特供）',
    memoryGB: 96,
    bandwidthTBs: 4.0,
    fp8Tflops: null,
    fp4Tflops: null,
    nvlinkGBs: 900,
    tdpW: 350,
    note: '算力大幅阉割（FP8 口径无官方页，INT8≈296 TOPS）但显存带宽保留——decode 尚可、prefill 弱，适合推理不适合训练',
    sourceUrl: 'https://getdeploying.com/gpus/nvidia-h20',
    asOf: '2026-07',
  },
  {
    id: 'b200',
    name: 'B200',
    memoryGB: 180,
    bandwidthTBs: 8,
    fp8Tflops: 4500,
    fp4Tflops: 9000,
    nvlinkGBs: 1800,
    tdpW: null,
    note: '由 DGX B200 官方整机值 ÷8 折算；FP4 原生支持是推理代际红利',
    sourceUrl: 'https://www.nvidia.com/en-us/data-center/dgx-b200/',
    asOf: '2026-07',
  },
  {
    id: 'b300',
    name: 'B300（Blackwell Ultra）',
    memoryGB: 278,
    bandwidthTBs: 8,
    fp8Tflops: null,
    fp4Tflops: 15000,
    nvlinkGBs: 1800,
    tdpW: null,
    note: '由 GB300 NVL72 官方系统值 ÷72 折算；HBM 较 B200 大 1.5×、稠密 FP4 算力 1.5×',
    sourceUrl: 'https://www.nvidia.com/en-us/data-center/gb300-nvl72/',
    asOf: '2026-07',
  },
]

// 机架系统级——与单卡是不同层级实体，只在同层比较
export const RACKS: RackSystem[] = [
  {
    id: 'gb200-nvl72',
    name: 'GB200 NVL72',
    gpus: 72,
    gpuName: 'Blackwell GPU',
    cpus: 36,
    totalHbmTB: 13.4,
    fp4Pflops: 720,
    note: '72 GPU 全互联 NVLink 域（聚合 130 TB/s）+ 17TB LPDDR5X CPU 内存',
    sourceUrl: 'https://www.nvidia.com/en-us/data-center/gb200-nvl72/',
    asOf: '2026-07',
  },
  {
    id: 'gb300-nvl72',
    name: 'GB300 NVL72',
    gpus: 72,
    gpuName: 'Blackwell Ultra GPU',
    cpus: 36,
    totalHbmTB: 20,
    fp4Pflops: 1080,
    note: '20TB HBM3e、Fast Memory 合计 37TB；官方营销口径：DeepSeek-R1 场景 AI factory 产出最高 50×（vs H100，含功耗成本因子）',
    sourceUrl: 'https://www.nvidia.com/en-us/data-center/gb300-nvl72/',
    asOf: '2026-07',
  },
]

// GPU 云按需时租（USD/卡/小时）：neocloud 与 hyperscaler 价差 2~5×，取区间用于盈亏平衡计算
export interface CloudPrice extends Sourced {
  gpuId: string
  lowUSD: number
  highUSD: number
  typicalUSD: number // 计算器默认值（全网中位附近）
  note: string
}

export const CLOUD_PRICES: CloudPrice[] = [
  {
    gpuId: 'h100',
    lowUSD: 2.4,
    highUSD: 12.3,
    typicalUSD: 3.4,
    note: 'Lambda $2.49~3.44 / CoreWeave $2.46 / AWS ~$6.9 / Azure ~$12.3；全网中位 $3.39',
    sourceUrl: 'https://getdeploying.com/gpus',
    asOf: '2026-07',
  },
  {
    gpuId: 'h200',
    lowUSD: 2.6,
    highUSD: 13.8,
    typicalUSD: 4.0,
    note: 'CoreWeave $2.62 / Runpod $4.39 / AWS ~$5.0 / Azure ~$13.8；全网中位 $4.00',
    sourceUrl: 'https://getdeploying.com/gpus',
    asOf: '2026-07',
  },
  {
    gpuId: 'b200',
    lowUSD: 4.3,
    highUSD: 14.2,
    typicalUSD: 6.2,
    note: 'CoreWeave $4.26 / Lambda $6.69~6.99 / AWS ~$14.2；全网中位 $6.23',
    sourceUrl: 'https://getdeploying.com/gpus',
    asOf: '2026-07',
  },
  {
    gpuId: 'b300',
    lowUSD: 4.5,
    highUSD: 16.7,
    typicalUSD: 8.2,
    note: 'CoreWeave HGX B300 $4.48；getdeploying B300 中位 $8.18、GB300 $16.68',
    sourceUrl: 'https://getdeploying.com/gpus',
    asOf: '2026-07',
  },
]

export const INTERCONNECT_NOTES: string[] = [
  'Scale-up（机架内）：NVLink 5 每 GPU 1.8 TB/s，NVL72 域聚合 130 TB/s；NVLink 6（Rubin 代）翻倍到 3.6 TB/s',
  'Scale-out（跨节点）：InfiniBand XDR / Spectrum-X 以太每端口 800 Gb/s ≈ 0.1 TB/s——只有 NVLink 的 1/18，这就是「TP/EP 尽量留在 NVLink 域内、跨机架只做 DP/PP」的原因',
]
