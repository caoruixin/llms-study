/**
 * 结构岛校验器（§7.2/§7.5）：grading.parseScoreJson 风格的手写校验——
 * 首 { 末 } 切片、逐字段守卫、钳位、数组上限；不引 zod。
 *
 * Phase 3 落地：展示块 explanation / formula，控制岛 plan / memo / evidence。
 * Phase 4 补齐：展示块 stepper / comparison / concept-map / flow / timeline / quiz /
 * flashcard / teach-back，控制岛 learner / verdict。表外类型仍走「未知类型」降级卡。
 */

export const MAX_ISLAND_RAW_BYTES = 8 * 1024

/**
 * 各块的结构上限（§7.2）：校验器只钳位不报错，超限信息以 overflow 标志交给组件降级渲染。
 * 硬上限（hardNodes/hardEdges）额外防御超大图导致的渲染开销。
 */
export const BLOCK_LIMITS = {
  stepperSteps: 12,
  comparisonColumns: 6,
  comparisonRows: 12,
  graphNodes: 12,
  graphEdges: 24,
  graphHardNodes: 40,
  graphHardEdges: 80,
  timelineItems: 12,
  quizOptions: 8,
  learnerSignals: 6,
  verdictItems: 8,
} as const

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

// --- Phase 4 展示块 --------------------------------------------------------

export interface StepperStep {
  title: string
  detail?: string
  /** 可选伪代码行（固定等宽渲染，不执行、不高亮） */
  code?: string
}

export interface StepperBlockData {
  kind: 'stepper'
  title?: string
  steps: StepperStep[]
  cites: string[]
}

export interface ComparisonRow {
  label: string
  /** 长度已与 columns 对齐（缺补空串、多余截断） */
  cells: string[]
}

export interface ComparisonBlockData {
  kind: 'comparison'
  title?: string
  columns: string[]
  rows: ComparisonRow[]
  cites: string[]
}

export interface GraphNode {
  id: string
  label: string
  /** 可选分组（concept-map 用于着色，flow 用于区分 IO/处理节点） */
  group?: string
}

export interface GraphEdge {
  from: string
  to: string
  label?: string
}

/** concept-map 与 flow 共用形状：语义与渲染样式不同，校验与布局引擎共用 */
export interface GraphBlockData {
  kind: 'concept-map' | 'flow'
  title?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 原始节点/边超出 12/24：组件降级为列表渲染（§7.2） */
  overflow: boolean
  cites: string[]
}

export interface TimelineItem {
  at: string
  title: string
  detail?: string
}

export interface TimelineBlockData {
  kind: 'timeline'
  title?: string
  items: TimelineItem[]
  cites: string[]
}

export type QuizVariant = 'single' | 'multi' | 'short'

export interface QuizBlockData {
  kind: 'quiz'
  /** 岛 JSON 里的 "kind" 字段（single/multi/short）——与联合判别式 kind 区分命名 */
  variant: QuizVariant
  stem: string
  options: string[]
  /** single = 单个下标；multi = 升序下标数组；short = null（本地不判分，用户自评） */
  answer: number | number[] | null
  /** short 的参考答案 */
  reference?: string
  why?: string
  concept?: string
  cites: string[]
}

export interface FlashcardBlockData {
  kind: 'flashcard'
  front: string
  back: string
  concept?: string
  cites: string[]
}

export interface TeachBackBlockData {
  kind: 'teach-back'
  prompt: string
  concept?: string
  hints: string[]
  cites: string[]
}

// --- Phase 4 控制岛 --------------------------------------------------------

export interface LearnerSignal {
  concept: string
  dir: 1 | 0 | -1
  evidence?: string
}

export interface LearnerIsland {
  kind: 'learner'
  signals: LearnerSignal[]
}

export interface VerdictIsland {
  kind: 'verdict'
  /** 总判定：模型未给时由客户端按 missed 推断（决策留客户端，grading.ts 原则） */
  verdict?: 'ok' | 'partial' | 'miss'
  missed: string[]
  evidence: string[]
  concept?: string
}

export type CopilotDisplayBlock =
  | ExplanationBlock
  | FormulaBlockData
  | StepperBlockData
  | ComparisonBlockData
  | GraphBlockData
  | TimelineBlockData
  | QuizBlockData
  | FlashcardBlockData
  | TeachBackBlockData

export type CopilotControlIsland = PlanIsland | MemoIsland | EvidenceIsland | LearnerIsland | VerdictIsland

export type CopilotBlock = CopilotDisplayBlock | CopilotControlIsland

/** 已实现的岛类型；不在表内的走「未知类型」降级卡 */
export const KNOWN_ISLAND_TYPES = [
  'explanation',
  'formula',
  'stepper',
  'comparison',
  'concept-map',
  'flow',
  'timeline',
  'quiz',
  'flashcard',
  'teach-back',
  'plan',
  'memo',
  'evidence',
  'learner',
  'verdict',
] as const

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

// --- Phase 4 展示块校验 ----------------------------------------------------

function validateStepper(obj: Record<string, unknown>): StepperBlockData | null {
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : []
  const steps: StepperStep[] = []
  for (const s of rawSteps) {
    if (steps.length >= BLOCK_LIMITS.stepperSteps) break
    // 容错：模型可能直接给字符串数组
    if (typeof s === 'string') {
      const title = str(s, 200)
      if (title !== null) steps.push({ title })
      continue
    }
    if (typeof s !== 'object' || s === null) continue
    const o = s as Record<string, unknown>
    const title = str(o.title, 200) ?? str(o.name, 200) ?? str(o.text, 200)
    if (title === null) continue
    const step: StepperStep = { title }
    const detail = optStr(o.detail, 800) ?? optStr(o.desc, 800)
    if (detail) step.detail = detail
    const code = optStr(o.code, 600) ?? optStr(o.pseudo, 600)
    if (code) step.code = code
    steps.push(step)
  }
  if (steps.length === 0) return null
  const block: StepperBlockData = { kind: 'stepper', steps, cites: citeArr(obj.cites) }
  const title = optStr(obj.title, 120)
  if (title) block.title = title
  return block
}

function validateComparison(obj: Record<string, unknown>): ComparisonBlockData | null {
  const columns = strArr(obj.columns, BLOCK_LIMITS.comparisonColumns, 60)
  if (columns.length < 2) return null
  const rawRows = Array.isArray(obj.rows) ? obj.rows : []
  const rows: ComparisonRow[] = []
  for (const r of rawRows) {
    if (rows.length >= BLOCK_LIMITS.comparisonRows) break
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    const label = str(o.label, 80) ?? str(o.name, 80)
    if (label === null) continue
    const raw = Array.isArray(o.cells) ? o.cells : []
    const cells = raw
      .slice(0, columns.length)
      .map((c) => (typeof c === 'string' ? c.slice(0, 300) : typeof c === 'number' ? String(c) : ''))
    while (cells.length < columns.length) cells.push('') // 缺格补空：表格不塌
    rows.push({ label, cells })
  }
  if (rows.length === 0) return null
  const block: ComparisonBlockData = { kind: 'comparison', columns, rows, cites: citeArr(obj.cites) }
  const title = optStr(obj.title, 120)
  if (title) block.title = title
  return block
}

function validateGraph(kind: 'concept-map' | 'flow', obj: Record<string, unknown>): GraphBlockData | null {
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : []
  const nodes: GraphNode[] = []
  const seen = new Set<string>()
  for (const n of rawNodes) {
    if (nodes.length >= BLOCK_LIMITS.graphHardNodes) break
    let id: string | null = null
    let label: string | null = null
    if (typeof n === 'string') {
      id = str(n, 60)
      label = id
    } else if (typeof n === 'object' && n !== null) {
      const o = n as Record<string, unknown>
      id = str(o.id, 60) ?? str(o.label, 60)
      label = str(o.label, 60) ?? id
    }
    if (id === null || label === null || seen.has(id)) continue
    seen.add(id)
    const node: GraphNode = { id, label }
    const group = typeof n === 'object' && n !== null ? optStr((n as Record<string, unknown>).group, 40) : undefined
    if (group) node.group = group
    nodes.push(node)
  }
  if (nodes.length === 0) return null

  const rawEdges = Array.isArray(obj.edges) ? obj.edges : []
  const edges: GraphEdge[] = []
  for (const e of rawEdges) {
    if (edges.length >= BLOCK_LIMITS.graphHardEdges) break
    if (typeof e !== 'object' || e === null) continue
    const o = e as Record<string, unknown>
    const from = str(o.from, 60) ?? str(o.source, 60)
    const to = str(o.to, 60) ?? str(o.target, 60)
    // 悬空边（端点不在节点表）直接剔除，布局引擎只吃合法边
    if (from === null || to === null || !seen.has(from) || !seen.has(to) || from === to) continue
    const edge: GraphEdge = { from, to }
    const label = optStr(o.label, 40)
    if (label) edge.label = label
    edges.push(edge)
  }

  const block: GraphBlockData = {
    kind,
    nodes,
    edges,
    overflow: nodes.length > BLOCK_LIMITS.graphNodes || edges.length > BLOCK_LIMITS.graphEdges,
    cites: citeArr(obj.cites),
  }
  const title = optStr(obj.title, 120)
  if (title) block.title = title
  return block
}

function validateTimeline(obj: Record<string, unknown>): TimelineBlockData | null {
  const rawItems = Array.isArray(obj.items) ? obj.items : Array.isArray(obj.stages) ? obj.stages : []
  const items: TimelineItem[] = []
  for (const it of rawItems) {
    if (items.length >= BLOCK_LIMITS.timelineItems) break
    if (typeof it !== 'object' || it === null) continue
    const o = it as Record<string, unknown>
    const title = str(o.title, 120) ?? str(o.name, 120)
    if (title === null) continue
    const atRaw = o.at ?? o.time ?? o.stage
    const at = typeof atRaw === 'number' ? String(atRaw) : (str(atRaw, 40) ?? '')
    const item: TimelineItem = { at, title }
    const detail = optStr(o.detail, 400) ?? optStr(o.desc, 400)
    if (detail) item.detail = detail
    items.push(item)
  }
  if (items.length === 0) return null
  const block: TimelineBlockData = { kind: 'timeline', items, cites: citeArr(obj.cites) }
  const title = optStr(obj.title, 120)
  if (title) block.title = title
  return block
}

/** 下标归一：接受数字或数字字符串，越界剔除 */
const optionIndex = (v: unknown, count: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= 0 && n < count ? n : null
}

function validateQuiz(obj: Record<string, unknown>): QuizBlockData | null {
  const stem = str(obj.stem, 800) ?? str(obj.question, 800)
  if (stem === null) return null
  const rawVariant = (optStr(obj.kind, 20) ?? optStr(obj.variant, 20) ?? optStr(obj.qkind, 20) ?? '').toLowerCase()
  const options = strArr(obj.options, BLOCK_LIMITS.quizOptions, 300)
  const variant: QuizVariant =
    rawVariant === 'multi' || rawVariant === 'multiple' || Array.isArray(obj.answer)
      ? 'multi'
      : rawVariant === 'short' || rawVariant === 'text' || options.length === 0
        ? 'short'
        : 'single'

  const block: QuizBlockData = { kind: 'quiz', variant, stem, options: [], answer: null, cites: citeArr(obj.cites) }
  const why = optStr(obj.why, 800) ?? optStr(obj.explain, 800)
  if (why) block.why = why
  const concept = optStr(obj.concept, 60)
  if (concept) block.concept = concept

  if (variant === 'short') {
    const reference = optStr(obj.reference, 1200) ?? optStr(obj.answer, 1200)
    if (reference) block.reference = reference
    return block
  }

  if (options.length < 2) return null // 选择题至少两个选项，否则无从判分
  block.options = options
  if (variant === 'multi') {
    const raw = Array.isArray(obj.answer) ? obj.answer : [obj.answer]
    const picked = [...new Set(raw.map((a) => optionIndex(a, options.length)).filter((n): n is number => n !== null))]
    if (picked.length === 0) return null
    block.answer = picked.sort((a, b) => a - b)
  } else {
    const idx = optionIndex(obj.answer, options.length)
    if (idx === null) return null
    block.answer = idx
  }
  return block
}

function validateFlashcard(obj: Record<string, unknown>): FlashcardBlockData | null {
  const front = str(obj.front, 300) ?? str(obj.term, 300)
  const back = str(obj.back, 1200) ?? str(obj.definition, 1200)
  if (front === null || back === null) return null
  const block: FlashcardBlockData = { kind: 'flashcard', front, back, cites: citeArr(obj.cites) }
  const concept = optStr(obj.concept, 60)
  if (concept) block.concept = concept
  return block
}

function validateTeachBack(obj: Record<string, unknown>): TeachBackBlockData | null {
  const prompt = str(obj.prompt, 600) ?? str(obj.ask, 600) ?? str(obj.stem, 600)
  if (prompt === null) return null
  const block: TeachBackBlockData = { kind: 'teach-back', prompt, hints: strArr(obj.hints, 5, 200), cites: citeArr(obj.cites) }
  const concept = optStr(obj.concept, 60)
  if (concept) block.concept = concept
  return block
}

// --- Phase 4 控制岛校验 ----------------------------------------------------

function validateLearner(obj: Record<string, unknown>): LearnerIsland | null {
  const raw = Array.isArray(obj.signals) ? obj.signals : []
  const signals: LearnerSignal[] = []
  for (const s of raw) {
    if (signals.length >= BLOCK_LIMITS.learnerSignals) break
    if (typeof s !== 'object' || s === null) continue
    const o = s as Record<string, unknown>
    const concept = str(o.concept, 60)
    if (concept === null) continue
    const rawDir = typeof o.dir === 'number' ? o.dir : typeof o.dir === 'string' ? Number(o.dir) : 0
    const dir: 1 | 0 | -1 = rawDir > 0 ? 1 : rawDir < 0 ? -1 : 0 // 钳位到三值
    const signal: LearnerSignal = { concept, dir }
    const evidence = optStr(o.evidence, 200)
    if (evidence) signal.evidence = evidence
    signals.push(signal)
  }
  if (signals.length === 0) return null
  return { kind: 'learner', signals }
}

function validateVerdict(obj: Record<string, unknown>): VerdictIsland | null {
  const missed = strArr(obj.missed, BLOCK_LIMITS.verdictItems, 200)
  const evidence = strArr(obj.evidence, BLOCK_LIMITS.verdictItems, 200)
  const rawVerdict = (optStr(obj.verdict, 20) ?? '').toLowerCase()
  const verdict =
    rawVerdict === 'ok' || rawVerdict === 'pass' || rawVerdict === 'correct'
      ? 'ok'
      : rawVerdict === 'miss' || rawVerdict === 'wrong'
        ? 'miss'
        : rawVerdict === 'partial'
          ? 'partial'
          : undefined
  // 三项全空 = 无信息，按 invalid 处理（advisory 岛静默忽略）
  if (missed.length === 0 && evidence.length === 0 && verdict === undefined) return null
  const island: VerdictIsland = { kind: 'verdict', missed, evidence }
  if (verdict) island.verdict = verdict
  const concept = optStr(obj.concept, 60)
  if (concept) island.concept = concept
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
    case 'stepper':
      block = validateStepper(obj)
      break
    case 'comparison':
      block = validateComparison(obj)
      break
    case 'concept-map':
    case 'flow':
      block = validateGraph(normalized, obj)
      break
    case 'timeline':
      block = validateTimeline(obj)
      break
    case 'quiz':
      block = validateQuiz(obj)
      break
    case 'flashcard':
      block = validateFlashcard(obj)
      break
    case 'teach-back':
      block = validateTeachBack(obj)
      break
    case 'learner':
      block = validateLearner(obj)
      break
    case 'verdict':
      block = validateVerdict(obj)
      break
  }
  return block ? { ok: true, block } : { ok: false, failure: 'invalid' }
}
