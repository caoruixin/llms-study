/**
 * 结构岛校验器（§7.2/§7.5）：grading.parseScoreJson 风格的手写校验——
 * 首 { 末 } 切片、逐字段守卫、钳位、数组上限；不引 zod。
 *
 * Phase 3 落地类型：展示块 explanation / formula，控制岛 plan / memo / evidence。
 * learner / verdict 及其余展示块留 Phase 4：未知类型不报错，走降级卡（§7.5 矩阵）。
 */

export const MAX_ISLAND_RAW_BYTES = 8 * 1024

export interface ExplanationBlock {
  kind: 'explanation'
  text: string
  level?: '入门' | '进阶' | '研究'
  points: string[]
  cites: string[]
}

export interface FormulaTerm {
  sym: string
  mean: string
}

export interface FormulaBlockData {
  kind: 'formula'
  expr: string
  terms: FormulaTerm[]
  steps: string[]
  cites: string[]
}

export interface PlanIsland {
  kind: 'plan'
  concepts: string[]
  level?: string
  strategy?: string
  blocks: string[]
}

export interface MemoIsland {
  kind: 'memo'
  summary: string
}

export interface EvidenceIsland {
  kind: 'evidence'
  status: 'insufficient' | 'ok'
  note?: string
}

export type CopilotBlock = ExplanationBlock | FormulaBlockData | PlanIsland | MemoIsland | EvidenceIsland

/** Phase 3 已实现的岛类型；不在表内的走「未知类型」降级卡 */
export const KNOWN_ISLAND_TYPES = ['explanation', 'formula', 'plan', 'memo', 'evidence'] as const

export type IslandFailure = 'too-large' | 'bad-json' | 'invalid' | 'unknown-type'

export type IslandParseResult = { ok: true; block: CopilotBlock } | { ok: false; failure: IslandFailure; detail?: string }

// ---------------------------------------------------------------------------
// 基础守卫（宽松修复优先：钳位/剔坏项，实在不行才判 invalid）
// ---------------------------------------------------------------------------

const CITE_ID_RE = /^c\d{1,3}$/

const str = (v: unknown, maxLen: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.slice(0, maxLen) : null

const optStr = (v: unknown, maxLen: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.slice(0, maxLen) : undefined

/** 字符串数组：剔除非字符串项，钳制条数与单条长度 */
const strArr = (v: unknown, maxItems: number, maxLen: number): string[] => {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .slice(0, maxItems)
    .map((x) => x.slice(0, maxLen))
}

/** cites：剔除不合白名单语法的别名（存在性校验在 citations.ts，这里只管语法） */
const citeArr = (v: unknown): string[] => strArr(v, 12, 8).filter((x) => CITE_ID_RE.test(x))

/** 首 { 末 } 切片 + JSON.parse（parseScoreJson 同法） */
export function parseIslandJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 逐类型校验
// ---------------------------------------------------------------------------

function validateExplanation(obj: Record<string, unknown>): ExplanationBlock | null {
  const text = str(obj.text, 8000)
  if (text === null) return null
  const rawLevel = optStr(obj.level, 8)
  const level = rawLevel === '入门' || rawLevel === '进阶' || rawLevel === '研究' ? rawLevel : undefined
  const block: ExplanationBlock = {
    kind: 'explanation',
    text,
    points: strArr(obj.points, 12, 400),
    cites: citeArr(obj.cites),
  }
  if (level) block.level = level
  return block
}

function validateFormula(obj: Record<string, unknown>): FormulaBlockData | null {
  const expr = str(obj.expr, 2000)
  if (expr === null) return null
  const rawTerms = Array.isArray(obj.terms) ? obj.terms : []
  const terms: FormulaTerm[] = []
  for (const t of rawTerms) {
    if (terms.length >= 24) break
    if (typeof t !== 'object' || t === null) continue // 剔坏项
    const sym = str((t as Record<string, unknown>).sym, 80)
    const mean = str((t as Record<string, unknown>).mean, 400)
    if (sym !== null && mean !== null) terms.push({ sym, mean })
  }
  return {
    kind: 'formula',
    expr,
    terms,
    steps: strArr(obj.steps, 16, 600),
    cites: citeArr(obj.cites),
  }
}

function validatePlan(obj: Record<string, unknown>): PlanIsland | null {
  const concepts = strArr(obj.concepts, 8, 60)
  const level = optStr(obj.level, 20)
  const strategy = optStr(obj.strategy, 120)
  const blocks = strArr(obj.blocks, 6, 24)
  // plan 是 advisory 岛：只要有任意一项有效信息即可接受
  if (concepts.length === 0 && !level && !strategy && blocks.length === 0) return null
  const island: PlanIsland = { kind: 'plan', concepts, blocks }
  if (level) island.level = level
  if (strategy) island.strategy = strategy
  return island
}

function validateMemo(obj: Record<string, unknown>): MemoIsland | null {
  const summary = str(obj.summary, 2400) ?? str(obj.text, 2400) // 容错：模型可能用 text 字段
  if (summary === null) return null
  return { kind: 'memo', summary }
}

function validateEvidence(obj: Record<string, unknown>): EvidenceIsland | null {
  const rawStatus = optStr(obj.status, 20)
  const status = rawStatus === 'insufficient' ? 'insufficient' : rawStatus === 'ok' ? 'ok' : null
  if (status === null) return null
  const island: EvidenceIsland = { kind: 'evidence', status }
  const note = optStr(obj.note, 600)
  if (note) island.note = note
  return island
}

/**
 * 岛入口校验（§7.5 降级矩阵的判定源）：
 * >8KB → too-large；JSON 坏 → bad-json；未知 TYPE → unknown-type；字段无法修复 → invalid。
 */
export function validateIsland(type: string, raw: string): IslandParseResult {
  if (raw.length > MAX_ISLAND_RAW_BYTES) return { ok: false, failure: 'too-large' }
  const normalized = type.toLowerCase()
  if (!(KNOWN_ISLAND_TYPES as readonly string[]).includes(normalized)) {
    return { ok: false, failure: 'unknown-type', detail: normalized }
  }
  const obj = parseIslandJson(raw)
  if (obj === null) return { ok: false, failure: 'bad-json' }

  let block: CopilotBlock | null = null
  switch (normalized) {
    case 'explanation':
      block = validateExplanation(obj)
      break
    case 'formula':
      block = validateFormula(obj)
      break
    case 'plan':
      block = validatePlan(obj)
      break
    case 'memo':
      block = validateMemo(obj)
      break
    case 'evidence':
      block = validateEvidence(obj)
      break
  }
  return block ? { ok: true, block } : { ok: false, failure: 'invalid' }
}
