// 溯源字段：所有易变事实（价格/参数/规格）必带
export interface Sourced {
  sourceUrl: string
  asOf: string // YYYY-MM
}

export type AttentionType =
  | 'MHA'
  | 'MQA'
  | 'GQA'
  | 'MLA'
  | 'DSA'
  | 'KDA'
  | 'GDN'
  | 'CSA-HCA'

// KV cache 判别式 schema：无可靠公式参数的新型稀疏/线性注意力用 unsupported，不做数值估算
export type KVSpec =
  | { kind: 'mha-gqa'; numLayers: number; kvHeads: number; headDim: number }
  | { kind: 'mla'; numLayers: number; kvLatentDim: number }
  | { kind: 'unsupported'; note: string }

export interface Highlight {
  title: string
  what: string // 一句话机制
  why: string // 为什么重要 / 售前一句话
}

export interface ModelSpec extends Sourced {
  id: string
  name: string
  vendor: string
  year: number
  totalParamsB: number // 十亿（B）
  activeParamsB: number // MoE 激活参数；dense 与 total 相同
  // MoE 专家配置：官方未公布时整个字段缺省（勿用 0 占位）；experts 已公布而激活数未公布时 activePerToken 缺省
  moe?: { experts: number; activePerToken?: number; shared?: number }
  attentionType: AttentionType
  kvSpec: KVSpec
  contextK: number // 上下文（K tokens）
  license: string
  multimodal: boolean
  highlights: Highlight[]
  diffVsTransformer: string[] // 与经典 Transformer 的组件差异（diff 高亮用）
}

export interface PriceRow extends Sourced {
  provider: string
  modelId: string // 精确模型 ID/版本（行主键 = provider + modelId）
  inputPerMTok: number | null
  outputPerMTok: number | null
  cachedInputPerMTok: number | null
  currency: 'USD' | 'RMB'
  contextK: number | null
  maxOutputK: number | null
  practicalContextNote: string | null // 实用上下文；无可靠依据为 null → UI 显示 N/A
  modality: string
  toolCalling: boolean
  openWeights: boolean
  notes?: string
  validUntil?: string // YYYY-MM-DD：notes 中限时价的截止日；过期后 UI 标注「已过期」
}

// 硬件分层实体：GPU 芯片与机架系统是不同层级，只在同层比较
export interface GpuChip extends Sourced {
  id: string
  name: string
  memoryGB: number
  bandwidthTBs: number
  fp8Tflops: number | null
  fp4Tflops: number | null
  nvlinkGBs: number | null
  tdpW: number | null
  note?: string
}

export interface RackSystem extends Sourced {
  id: string
  name: string
  gpus: number
  gpuName: string
  cpus: number
  totalHbmTB: number | null
  fp4Pflops: number | null
  note?: string
}

export type QCategory =
  | 'token-econ'
  | 'model-compare'
  | 'agent'
  | 'compute'
  | 'inference-deploy'
  | 'presales'

export interface Question {
  id: string
  category: QCategory
  lang: 'zh' | 'en'
  prompt: string
  followUp?: string
  mustCover: string[]
  niceToHave: string[]
  redFlags: string[]
  referenceNotes: string // 参考要点：注入评分 prompt + 复盘展示
}

// 评分（LLM 返回四维度分数，A-D 等级由客户端确定性映射）
export interface ScoreResult {
  accuracy: number // 技术准确性 1-10
  structure: number // 结构化表达 1-10
  business: number // 业务与成本视角 1-10
  depth: number // 深度与实战感 1-10
  highlights: string[] // 回答中的亮点（答对/答得好的地方）
  comments: string[] // 逐条改进建议
  missed: string[] // 遗漏的 mustCover 要点
}

export type Grade = 'A' | 'B' | 'C' | 'D'

export interface AttemptRecord {
  id: string
  questionId: string
  answer: string
  score: ScoreResult | null
  grade: Grade | null
  createdAt: number
}
