import type { LearnerIsland, VerdictIsland } from './blockSchemas'

/**
 * 概念级学习画像（§6.2 三层机制的纯函数内核）。
 *
 * 设计要点：
 * - 证据只追加不改写；mastery ∈ [0,1] 小步更新，单事件 |Δ| ≤ MAX_DELTA(0.08)。
 * - **跨层级调整需 ≥2 条独立同向证据**：mastery 落进新桶不等于层级立刻变——
 *   还要求「上次层级变更之后」有 ≥2 条同向且相互独立（source+ts 不同）的证据，
 *   落实「单次弱信号不得永久改变画像」。
 * - confidence = 一致性 × 数量饱和，两者都按半衰期给证据加时间权重（时间衰减）。
 * - pinnedLevel（用户手动 pin）永远优先并冻结自动调层；证据照记、mastery 照走，
 *   取消 pin 后立刻按最新证据生效。
 * - 全部函数无副作用、不碰 Date.now（now 由调用方注入），node 环境直测。
 */

export type LearnerLevel = '入门' | '进阶' | '研究'

export const LEARNER_LEVELS: readonly LearnerLevel[] = ['入门', '进阶', '研究']

/** 证据方向：+1 掌握得更好/要更深，0 刚好，-1 吃力/要更浅 */
export type EvidenceDir = 1 | 0 | -1

export type EvidenceSource =
  | 'quiz'
  | 'flashcard'
  | 'teach-back'
  | 'feedback'
  | 'shortcut'
  | 'question'
  | 'learner-island'

export interface ProfileEvidence {
  /** 关联概念（可空：只影响整体画像） */
  conceptIds: string[]
  dir: EvidenceDir
  /** (0,1]，越强的证据越接近 1 */
  weight: number
  ts: number
  source: EvidenceSource
}

export interface ConceptProfile {
  conceptId: string
  mastery: number
  confidence: number
  /** 生效层级（sticky：跨桶需要 ≥2 条独立同向证据才会变） */
  level: LearnerLevel
  /** 用户手动 pin 的层级（仅整体行 '*' 使用；存在时冻结自动调层） */
  pinnedLevel?: LearnerLevel
  levelChangedAt: number
  /** 最近证据窗口（≤ EVIDENCE_KEEP 条）：confidence 与跨层判定的输入 */
  evidence: ProfileEvidence[]
  updatedAt: number
}

/** 整体画像行的保留 conceptId：所有证据都会同时落到这一行 */
export const PAPER_LEVEL_CONCEPT = '*'

/** 单事件掌握度上限步长（§6.2） */
export const MAX_DELTA = 0.08
/** 跨层级所需的独立同向证据条数（§6.2） */
export const MIN_CROSS_LEVEL_EVIDENCE = 2
/** 证据窗口长度 */
export const EVIDENCE_KEEP = 24
/** 证据时间半衰期（14 天） */
export const EVIDENCE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
/** mastery → 层级桶边界 */
export const LEVEL_BOUNDS = { entry: 0.34, advanced: 0.67 } as const
/** 薄弱概念阈值（profileHint 用） */
export const WEAK_MASTERY = 0.45
export const DEFAULT_MASTERY = 0.5

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** 概念 id 归一：小写去空白，限长，空串丢弃 */
export function normalizeConceptId(raw: string): string | null {
  const id = raw.trim().toLowerCase().slice(0, 40)
  return id === '' ? null : id
}

export function levelOfMastery(mastery: number): LearnerLevel {
  if (mastery < LEVEL_BOUNDS.entry) return '入门'
  if (mastery < LEVEL_BOUNDS.advanced) return '进阶'
  return '研究'
}

const levelRank = (level: LearnerLevel): number => LEARNER_LEVELS.indexOf(level)

export function emptyProfile(conceptId: string, now: number): ConceptProfile {
  return {
    conceptId,
    mastery: DEFAULT_MASTERY,
    confidence: 0,
    level: levelOfMastery(DEFAULT_MASTERY),
    levelChangedAt: now,
    evidence: [],
    updatedAt: now,
  }
}

/** 时间权重：半衰期衰减，未来时间戳按 1 处理 */
const decayWeight = (ev: ProfileEvidence, now: number): number => {
  const age = Math.max(0, now - ev.ts)
  return ev.weight * Math.pow(0.5, age / EVIDENCE_HALF_LIFE_MS)
}

/**
 * confidence = 一致性 × 数量饱和（两项都吃时间衰减后的权重）。
 * - 一致性：有方向证据的加权净方向绝对值 / 加权总量；无方向证据时取中性 0.5。
 * - 数量饱和：W/(W+2)，两条满权证据 ≈ 0.5。
 */
export function computeConfidence(evidence: readonly ProfileEvidence[], now: number): number {
  let weightedAll = 0
  let weightedDirected = 0
  let net = 0
  for (const ev of evidence) {
    const w = decayWeight(ev, now)
    weightedAll += w
    if (ev.dir !== 0) {
      weightedDirected += w
      net += ev.dir * w
    }
  }
  if (weightedAll === 0) return 0
  const consistency = weightedDirected === 0 ? 0.5 : Math.abs(net) / weightedDirected
  const saturation = weightedAll / (weightedAll + 2)
  return clamp01(consistency * saturation)
}

/**
 * 独立同向证据计数：只数「上次层级变更之后」的记录，
 * 按 (source, ts) 去重——同一来源同一时刻重复上报只算一条。
 */
export function countIndependentEvidence(
  evidence: readonly ProfileEvidence[],
  dir: 1 | -1,
  sinceTs: number,
): number {
  const seen = new Set<string>()
  for (const ev of evidence) {
    if (ev.dir !== dir || ev.ts < sinceTs) continue
    seen.add(`${ev.source}|${ev.ts}`)
  }
  return seen.size
}

/** 单条证据作用于单个概念行（纯函数） */
export function applyEvidence(profile: ConceptProfile, ev: ProfileEvidence, now: number): ConceptProfile {
  const weight = clamp01(ev.weight)
  const delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, ev.dir * weight * MAX_DELTA))
  const mastery = clamp01(profile.mastery + delta)
  const evidence = [...profile.evidence, { ...ev, weight }].slice(-EVIDENCE_KEEP)

  let level = profile.level
  let levelChangedAt = profile.levelChangedAt
  const target = levelOfMastery(mastery)
  if (target !== level && !profile.pinnedLevel) {
    const dir: 1 | -1 = levelRank(target) > levelRank(level) ? 1 : -1
    if (countIndependentEvidence(evidence, dir, profile.levelChangedAt) >= MIN_CROSS_LEVEL_EVIDENCE) {
      level = target
      levelChangedAt = now
    }
  }

  return {
    ...profile,
    mastery,
    confidence: computeConfidence(evidence, now),
    level,
    levelChangedAt,
    evidence,
    updatedAt: now,
  }
}

/**
 * 单条证据作用于整个画像：命中概念行 + 整体行 '*' 一起更新。
 * 返回新数组（不变式：'*' 行始终存在于结果中）。
 */
export function applyEvidenceToStore(
  store: readonly ConceptProfile[],
  ev: ProfileEvidence,
  now: number,
): ConceptProfile[] {
  const ids = new Set<string>([PAPER_LEVEL_CONCEPT])
  for (const raw of ev.conceptIds) {
    const id = normalizeConceptId(raw)
    if (id && id !== PAPER_LEVEL_CONCEPT) ids.add(id)
  }
  const next = store.map((p) => (ids.has(p.conceptId) ? applyEvidence(p, ev, now) : p))
  for (const id of ids) {
    if (!next.some((p) => p.conceptId === id)) next.push(applyEvidence(emptyProfile(id, now), ev, now))
  }
  return next
}

/** 手动 pin / 取消 pin（写在整体行；证据与 mastery 不受影响） */
export function setPinnedLevel(
  store: readonly ConceptProfile[],
  level: LearnerLevel | null,
  now: number,
): ConceptProfile[] {
  const has = store.some((p) => p.conceptId === PAPER_LEVEL_CONCEPT)
  const base = has ? [...store] : [...store, emptyProfile(PAPER_LEVEL_CONCEPT, now)]
  return base.map((p) => {
    if (p.conceptId !== PAPER_LEVEL_CONCEPT) return p
    const next: ConceptProfile = { ...p, updatedAt: now }
    if (level) next.pinnedLevel = level
    else delete next.pinnedLevel
    return next
  })
}

export interface ProfileSummary {
  level: LearnerLevel
  /** manual = 用户 pin 生效；auto = 证据自动判定 */
  source: 'auto' | 'manual'
  /** 最多 3 个薄弱概念（mastery 升序，同值按 id 稳定排序） */
  weakConcepts: string[]
  /** 参与统计的概念数（不含整体行） */
  conceptCount: number
  masteryOverall: number
  confidenceOverall: number
}

export function summarizeProfile(store: readonly ConceptProfile[], now: number): ProfileSummary {
  const overall = store.find((p) => p.conceptId === PAPER_LEVEL_CONCEPT) ?? emptyProfile(PAPER_LEVEL_CONCEPT, now)
  const concepts = store.filter((p) => p.conceptId !== PAPER_LEVEL_CONCEPT)
  const weakConcepts = concepts
    .filter((p) => p.mastery < WEAK_MASTERY)
    .sort((a, b) => a.mastery - b.mastery || a.conceptId.localeCompare(b.conceptId))
    .slice(0, 3)
    .map((p) => p.conceptId)
  return {
    level: overall.pinnedLevel ?? overall.level,
    source: overall.pinnedLevel ? 'manual' : 'auto',
    weakConcepts,
    conceptCount: concepts.length,
    masteryOverall: overall.mastery,
    confidenceOverall: overall.confidence,
  }
}

// ---------------------------------------------------------------------------
// profileHint（contextBuilder 第 2 层注入点）
// ---------------------------------------------------------------------------

const LEVEL_GUIDE: Record<LearnerLevel, string> = {
  入门: '先给直觉、类比和简单例子，术语出现时先解释，公式最多给结论形式。',
  进阶: '给公式、算法步骤、设计选择与权衡，可假设读者熟悉基本术语。',
  研究: '给假设与证明思路、实验有效性、失败模式，以及与相关方法的差异。',
}

export interface ProfileHint {
  level: LearnerLevel
  source: 'auto' | 'manual'
  text: string
}

/**
 * 画像文案（字节稳定优先）：只有层级桶或 pin 状态变化时才生成新文案，
 * 否则原样返回上一版——system#2 层字节不变，最大化 provider 前缀缓存命中（§5.4）。
 */
export function nextProfileHint(prev: ProfileHint | null, summary: ProfileSummary): ProfileHint {
  if (prev && prev.level === summary.level && prev.source === summary.source) return prev
  const weak = summary.weakConcepts.length ? `当前较薄弱的概念：${summary.weakConcepts.join('、')}。` : ''
  const src = summary.source === 'manual' ? '（用户手动指定）' : ''
  return {
    level: summary.level,
    source: summary.source,
    text: `【读者画像】讲解层次：${summary.level}${src}。${LEVEL_GUIDE[summary.level]}${weak}读者要求更浅或更深时立即切换，不要反复确认。`,
  }
}

// ---------------------------------------------------------------------------
// L1/L2 证据构造（各交互点的唯一映射表）
// ---------------------------------------------------------------------------

/** 各来源的证据权重：显式行为 > 自评 > 模型自报弱信号 */
export const EVIDENCE_WEIGHTS = {
  quiz: 0.6,
  quizPartial: 0.4,
  flashcard: 0.4,
  flashcardFuzzy: 0.25,
  teachBack: 0.6,
  feedback: 0.5,
  shortcut: 0.35,
  question: 0.2,
  learnerIsland: 0.25,
} as const

const evidence = (
  conceptIds: readonly string[],
  dir: EvidenceDir,
  weight: number,
  ts: number,
  source: EvidenceSource,
): ProfileEvidence => ({
  conceptIds: conceptIds.map((c) => normalizeConceptId(c)).filter((c): c is string => c !== null),
  dir,
  weight,
  ts,
  source,
})

export type QuizOutcome = 'correct' | 'partial' | 'wrong'

export function evidenceFromQuiz(outcome: QuizOutcome, conceptIds: readonly string[], ts: number): ProfileEvidence {
  if (outcome === 'correct') return evidence(conceptIds, 1, EVIDENCE_WEIGHTS.quiz, ts, 'quiz')
  if (outcome === 'wrong') return evidence(conceptIds, -1, EVIDENCE_WEIGHTS.quiz, ts, 'quiz')
  return evidence(conceptIds, 0, EVIDENCE_WEIGHTS.quizPartial, ts, 'quiz')
}

export type FlashcardRating = 'known' | 'fuzzy' | 'unknown'

export function evidenceFromFlashcard(
  rating: FlashcardRating,
  conceptIds: readonly string[],
  ts: number,
): ProfileEvidence {
  if (rating === 'known') return evidence(conceptIds, 1, EVIDENCE_WEIGHTS.flashcard, ts, 'flashcard')
  if (rating === 'unknown') return evidence(conceptIds, -1, EVIDENCE_WEIGHTS.flashcard, ts, 'flashcard')
  return evidence(conceptIds, 0, EVIDENCE_WEIGHTS.flashcardFuzzy, ts, 'flashcard')
}

/** 显式深度反馈：太浅 → 读者在当前层级之上（+1）；太深 → -1；刚好 → 0 */
export type DepthFeedback = 'shallow' | 'right' | 'deep'

export function evidenceFromFeedback(
  kind: DepthFeedback,
  conceptIds: readonly string[],
  ts: number,
): ProfileEvidence {
  const dir: EvidenceDir = kind === 'shallow' ? 1 : kind === 'deep' ? -1 : 0
  return evidence(conceptIds, dir, EVIDENCE_WEIGHTS.feedback, ts, 'feedback')
}

/** 选区快捷键使用：更简单 → -1；推导 → +1（其余快捷键不构成画像证据） */
export function evidenceFromShortcut(
  action: string,
  conceptIds: readonly string[],
  ts: number,
): ProfileEvidence | null {
  if (action === 'simpler') return evidence(conceptIds, -1, EVIDENCE_WEIGHTS.shortcut, ts, 'shortcut')
  if (action === 'derive') return evidence(conceptIds, 1, EVIDENCE_WEIGHTS.shortcut, ts, 'shortcut')
  return null
}

/** teach-back 判定岛 → 证据：missed 越多越负；模型给了 verdict 以 verdict 为准 */
export function evidenceFromVerdict(island: VerdictIsland, conceptIds: readonly string[], ts: number): ProfileEvidence {
  const level = island.verdict ?? (island.missed.length === 0 ? 'ok' : island.missed.length >= 2 ? 'miss' : 'partial')
  const dir: EvidenceDir = level === 'ok' ? 1 : level === 'miss' ? -1 : 0
  const ids = island.concept ? [island.concept, ...conceptIds] : conceptIds
  return evidence(ids, dir, EVIDENCE_WEIGHTS.teachBack, ts, 'teach-back')
}

/** L2：流尾 learner 岛 → 每个信号一条弱证据（坏岛由校验层拦掉，这里只做映射） */
export function evidenceFromLearnerIsland(island: LearnerIsland, ts: number): ProfileEvidence[] {
  return island.signals
    .map((s) => evidence([s.concept], s.dir, EVIDENCE_WEIGHTS.learnerIsland, ts, 'learner-island'))
    .filter((e) => e.conceptIds.length > 0)
}

/** 抽象度启发式：问题里带公式/符号/证明诉求 → 高抽象弱信号；带「通俗/举例/不懂」→ 低抽象 */
const HIGH_ABSTRACTION_RE = /[$\\∑∫≤≥≈∇θλμσ]|公式|推导|证明|复杂度|收敛|梯度|上界|下界|渐近/
const LOW_ABSTRACTION_RE = /通俗|大白话|简单说|举个例子|举例|听不懂|不明白|是什么意思|入门/

export function evidenceFromQuestion(
  question: string,
  conceptIds: readonly string[],
  ts: number,
): ProfileEvidence | null {
  const low = LOW_ABSTRACTION_RE.test(question)
  const high = HIGH_ABSTRACTION_RE.test(question)
  // 同时命中视为无信号：避免「用通俗方式讲这个公式」被误判
  if (low === high) return null
  return evidence(conceptIds, low ? -1 : 1, EVIDENCE_WEIGHTS.question, ts, 'question')
}
