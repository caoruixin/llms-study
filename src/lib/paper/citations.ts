import { tokenize } from './bm25'
import type { CiteMapEntry } from './retrieval'
import type { CopilotSeg } from './streamParser'

/**
 * 引用校验（§8.1 第 4 步 · 每轮确定性本地层）：
 * 1. 存在性：alias 必须在本轮白名单（CiteMap）内，幻觉 ID → missing（灰徽章，不重试）；
 * 2. 词面支持启发式：含 cite 的句子与对应 chunk 做内容词/数字重叠打分，
 *    低分降为 weak（空心徽章 + 页脚「引用体检」）。启发式只降展示、不删句。
 * 模型支持性校验不进热路径（§8.1）。
 */

export type CiteLevel = 'ok' | 'weak' | 'missing'

export interface CiteOccurrence {
  alias: string
  /** 该引用所在句（岛内 cites 无句概念，为空串） */
  sentence: string
  score: number
  level: CiteLevel
}

export interface CitationAudit {
  occurrences: CiteOccurrence[]
  /** 每个 alias 的最终徽章档位（多处出现取最差档） */
  badges: Record<string, CiteLevel>
  missingCount: number
  weakCount: number
}

/** 词面支持阈值：低于此为 weak（内容词重叠比例，数字命中双倍计权） */
export const WEAK_SUPPORT_THRESHOLD = 0.22

const isNumberTerm = (t: string): boolean => /^\d+(?:\.\d+)?$/.test(t)

/** 内容词：≥2 字符的词元或数字（单字 CJK 词权重太弱，剔除降噪） */
const contentTerms = (text: string): string[] => tokenize(text).filter((t) => t.length >= 2 || isNumberTerm(t))

/**
 * 句子与 chunk 的词面支持打分 ∈ [0,1]。
 * 句内无内容词（如纯符号句）→ 1（无可检查项，不惩罚）。
 */
export function lexicalSupportScore(sentence: string, chunkText: string): number {
  const sentTerms = [...new Set(contentTerms(sentence))]
  if (sentTerms.length === 0) return 1
  const chunkSet = new Set(contentTerms(chunkText))
  let hit = 0
  let total = 0
  for (const t of sentTerms) {
    const w = isNumberTerm(t) ? 2 : 1
    total += w
    if (chunkSet.has(t)) hit += w
  }
  return total === 0 ? 1 : hit / total
}

const SENTENCE_BOUNDARY = /[。！？!?；;\n]/

/** 取 pos 所在句（按中英句界切分；引用通常紧跟句末，pos 落在句界之前） */
export function sentenceAt(text: string, pos: number): string {
  let start = 0
  for (let i = Math.min(pos, text.length) - 1; i >= 0; i--) {
    if (SENTENCE_BOUNDARY.test(text[i])) {
      start = i + 1
      break
    }
  }
  let end = text.length
  for (let i = Math.min(pos, text.length); i < text.length; i++) {
    if (SENTENCE_BOUNDARY.test(text[i])) {
      end = i + 1
      break
    }
  }
  return text.slice(start, end).trim()
}

/**
 * 对一条完整回复（CopilotSeg[]）做引用体检。
 * - prose 段：每个 cite run 定位其所在句并对白名单 chunk 打词面分；
 * - island 段：block.cites 只做存在性校验（公式/结构数据无句可比，不打词面分）。
 */
export function auditCitations(
  segs: readonly CopilotSeg[],
  citeMap: readonly CiteMapEntry[],
  chunkTextByAlias: Readonly<Record<string, string>>,
): CitationAudit {
  const whitelist = new Set(citeMap.map((e) => e.alias))
  const occurrences: CiteOccurrence[] = []

  for (const seg of segs) {
    if (seg.type === 'prose') {
      // 用 runs 重建纯文本并记录每个 cite 在纯文本中的位置（token 本身不计入句文本）
      let plain = ''
      const citesAt: { alias: string; pos: number }[] = []
      for (const run of seg.runs) {
        if (run.kind === 'text') plain += run.text
        else citesAt.push({ alias: run.alias, pos: plain.length })
      }
      for (const { alias, pos } of citesAt) {
        if (!whitelist.has(alias)) {
          occurrences.push({ alias, sentence: sentenceAt(plain, pos), score: 0, level: 'missing' })
          continue
        }
        const sentence = sentenceAt(plain, pos)
        const chunkText = chunkTextByAlias[alias] ?? ''
        const score = chunkText ? lexicalSupportScore(sentence, chunkText) : 0
        occurrences.push({ alias, sentence, score, level: score >= WEAK_SUPPORT_THRESHOLD ? 'ok' : 'weak' })
      }
    } else if (seg.type === 'island' && seg.closed && seg.block) {
      const cites = 'cites' in seg.block ? seg.block.cites : []
      for (const alias of cites) {
        occurrences.push(
          whitelist.has(alias)
            ? { alias, sentence: '', score: 1, level: 'ok' }
            : { alias, sentence: '', score: 0, level: 'missing' },
        )
      }
    }
  }

  const rank: Record<CiteLevel, number> = { ok: 0, weak: 1, missing: 2 }
  const badges: Record<string, CiteLevel> = {}
  for (const o of occurrences) {
    const prev = badges[o.alias]
    if (prev === undefined || rank[o.level] > rank[prev]) badges[o.alias] = o.level
  }
  const missingCount = occurrences.filter((o) => o.level === 'missing').length
  const weakCount = occurrences.filter((o) => o.level === 'weak').length
  return { occurrences, badges, missingCount, weakCount }
}
