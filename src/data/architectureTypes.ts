export type MechanismId = 'mha' | 'mqa' | 'gqa' | 'mla' | 'dsa' | 'qsa' | 'msa' | 'swa' | 'csa' | 'hca' | 'gdn' | 'kda' | 'csa2'
export type TermId = MechanismId | 'ced' | 'rope' | 'moe' | 'mtp' | 'dspark' | 'engram' | 'ngram' | 'gr' | 'mhc' | 'attnres' | 'ssm' | 'kv-sharing' | 'state' | 'indexer'
export interface ArchitectureTerm {
  id: TermId
  short: string
  english: string
  chinese: string
  explanation: string
  sourceUrl: string
}
export type AxisId = 'topology' | 'input' | 'position' | 'attention' | 'residual' | 'ffn' | 'decoding' | 'training'
export interface SourceRef {
  id: string
  title: string
  url: string
  locator: string
  verifiedOn: string
}
export interface ArchitectureChange {
  axis: AxisId
  label: string
  terms: TermId[]
  explanation: string
  implication: string
  sourceIds: string[]
  disclosed: boolean
}
export interface BenchmarkEvidence {
  id: string
  metric: string
  value: number
  unit: string
  baseline: string
  baselineValue?: number
  kind: 'model' | 'ablation' | 'runtime' | 'architecture'
  conditions: string
  sourceId: string
  locator: string
}
export interface ArchitectureParameters {
  backboneB: number | null
  activeB: number | null
  prefillActiveB?: number
  decodeActiveB?: number
  lookupB?: number
  predictionHeadB?: number
  note?: string
}
export interface ArchitectureModel {
  id: string
  legacyModelId?: string
  family: string
  name: string
  vendor: string
  released: string // YYYY-MM or YYYY-MM-DD; never invent the day
  verifiedOn: string
  weightsUrl: string
  weightsRevision?: string
  releaseNote?: string
  license: string
  parameters: ArchitectureParameters
  context: string
  predecessorId?: string
  mechanisms: MechanismId[]
  summary: string
  changes: ArchitectureChange[]
  evidence: BenchmarkEvidence[]
  sources: SourceRef[]
  topology: { label: string; detail: string; term?: TermId }[]
  variants?: string[]
}
export const ARCHITECTURE_AXES: { id: AxisId; english: string; chinese: string }[] = [
  { id: 'topology', english: 'Architecture', chinese: '整体拓扑与层编排' },
  { id: 'input', english: 'Embedding & Memory', chinese: '输入与附加记忆' },
  { id: 'position', english: 'Position Encoding', chinese: '位置编码' },
  { id: 'attention', english: 'Attention & State', chinese: '注意力与序列状态' },
  { id: 'residual', english: 'Residual & Normalization', chinese: '纵向信息传递' },
  { id: 'ffn', english: 'FFN & Experts', chinese: '前馈与专家结构' },
  { id: 'decoding', english: 'Prediction & Decoding', chinese: '预测与解码' },
  { id: 'training', english: 'Training & Precision', chinese: '训练与精度' },
]
