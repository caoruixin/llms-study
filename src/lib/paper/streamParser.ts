import { splitFences } from '../liteMd'
import { validateIsland, type IslandFailure, type CopilotBlock } from './blockSchemas'

/**
 * 流式线协议解析（§7.1/§7.4）：在 liteMd.splitFences（含 closed 标志）之上，
 * 把累计全文映射为 CopilotSeg[]。纯函数：每个 delta 对全文重扫（AskDialog 模式），
 * 记忆化选择见文末 createStreamParserMemo 的说明。
 */

/** island 识别：info-string 形如 copilot:formula / copilot-formula / copilot formula（大小写不敏感） */
const ISLAND_LANG_RE = /^copilot[:\-\s]+([a-z-]+)\s*$/i

/** citeToken：[[cite:c3]]，ID 为本轮白名单别名 c1..cN */
const CITE_TOKEN_RE = /\[\[cite:(c\d{1,3})\]\]/g

/**
 * 行尾残缺 citeToken 抑制（§7.4）：流式中文本可能停在 '[[cite:c1' 处，
 * 匹配「能补全成合法 citeToken 的后缀」，下个 delta 到来自然补全，无闪烁。
 * 覆盖 '['、'[['、'[[c'…'[[cite:'、'[[cite:cN(NN)' 以及收尾半个 ']'。
 */
const PARTIAL_CITE_RE = /\[(?:\[(?:c(?:i(?:t(?:e(?::(?:c\d{0,3}(?:\])?)?)?)?)?)?)?)?$/

export type ProseRun = { kind: 'text'; text: string } | { kind: 'cite'; alias: string }

export type CopilotSeg =
  | { type: 'prose'; text: string; runs: ProseRun[] }
  | { type: 'code'; lang: string; text: string; closed: boolean }
  | {
      type: 'island'
      islandType: string
      raw: string
      closed: boolean
      /** closed 且校验通过时存在 */
      block?: CopilotBlock
      /** closed 且校验失败时存在（§7.5 降级矩阵档位） */
      failure?: IslandFailure
    }

/** text → ProseRun 交替（citeToken 拆出）；suppressPartial 时剥掉行尾残缺 token */
export function splitProseRuns(text: string, suppressPartial: boolean): ProseRun[] {
  let src = text
  if (suppressPartial && !src.endsWith(']]')) {
    // 完整 token 以 ']]' 收尾；PARTIAL_CITE_RE 只匹配未完整收尾的形态
    const m = PARTIAL_CITE_RE.exec(src)
    if (m) src = src.slice(0, m.index)
  }
  const runs: ProseRun[] = []
  let last = 0
  CITE_TOKEN_RE.lastIndex = 0
  for (let m = CITE_TOKEN_RE.exec(src); m !== null; m = CITE_TOKEN_RE.exec(src)) {
    if (m.index > last) runs.push({ kind: 'text', text: src.slice(last, m.index) })
    runs.push({ kind: 'cite', alias: m[1] })
    last = m.index + m[0].length
  }
  if (last < src.length) runs.push({ kind: 'text', text: src.slice(last) })
  return runs
}

export interface SplitOptions {
  /**
   * 流仍开放（还有后续 delta）：true 时抑制最末 prose 段的行尾残缺 citeToken。
   * finalize（流结束/Stop）后传 false：残缺 token 原样保留为文本（诚实显示）。
   */
  open?: boolean
  /** 已闭合岛的校验结果缓存（createStreamParserMemo 注入；键 = type + raw） */
  islandCache?: Map<string, CopilotSeg>
}

function parseClosedIsland(islandType: string, raw: string, cache?: Map<string, CopilotSeg>): CopilotSeg {
  const key = `${islandType} ${raw}`
  const hit = cache?.get(key)
  if (hit) return hit
  const result = validateIsland(islandType, raw)
  const seg: CopilotSeg = result.ok
    ? { type: 'island', islandType, raw, closed: true, block: result.block }
    : { type: 'island', islandType, raw, closed: true, failure: result.failure }
  cache?.set(key, seg)
  return seg
}

export function splitCopilotStream(src: string, opts: SplitOptions = {}): CopilotSeg[] {
  const open = opts.open ?? false
  const fences = splitFences(src)
  const out: CopilotSeg[] = []

  fences.forEach((seg, i) => {
    if (seg.type === 'code') {
      const islandMatch = ISLAND_LANG_RE.exec(seg.lang)
      if (islandMatch) {
        const islandType = islandMatch[1].toLowerCase()
        if (!seg.closed) {
          out.push({ type: 'island', islandType, raw: seg.text, closed: false })
        } else {
          out.push(parseClosedIsland(islandType, seg.text, opts.islandCache))
        }
        return
      }
      // 普通代码块直通（含未闭合半截）
      out.push({ type: 'code', lang: seg.lang, text: seg.text, closed: seg.closed })
      return
    }
    // prose：只有整个流的最末段才可能停在残缺 citeToken 上
    const isTail = i === fences.length - 1
    out.push({ type: 'prose', text: seg.text, runs: splitProseRuns(seg.text, open && isTail) })
  })

  return out
}

/**
 * 收集某一类已闭合结构岛（按出现顺序）。
 * 画像接线用：finalize 后从 TurnOutcome.segs 里取 learner / verdict / plan 岛（§6.2 L2）。
 * 坏岛没有 block 字段，天然被过滤掉——「坏则静默忽略」的降级语义在这里落地。
 */
export function collectIslands<K extends CopilotBlock['kind']>(
  segs: readonly CopilotSeg[],
  kind: K,
): Extract<CopilotBlock, { kind: K }>[] {
  const out: Extract<CopilotBlock, { kind: K }>[] = []
  for (const seg of segs) {
    if (seg.type === 'island' && seg.closed && seg.block?.kind === kind) {
      out.push(seg.block as Extract<CopilotBlock, { kind: K }>)
    }
  }
  return out
}

/**
 * 前缀记忆化辅助（§7.4，可选）。
 *
 * 选择说明：splitCopilotStream 保持纯函数（测试与 finalize 复用），本包装做两件事——
 * 1. 全文与 open 均未变时直接返回上次结果（rAF 批量合并下常见）；
 * 2. 注入闭包内的 Map 缓存「已闭合岛」的校验结果（JSON.parse + 逐字段校验是每 delta
 *    重扫中唯一的非线性成本；append-only 流中已闭合岛的 raw 不再变化，天然命中）。
 * React 渲染层的段级记忆化（只重渲开放尾段）由 CopilotMessage 按 seg 内容 memo 完成，
 * 两层配合覆盖 §7.6 的性能要求。
 */
export function createStreamParserMemo() {
  let lastSrc: string | null = null
  let lastOpen = false
  let lastResult: CopilotSeg[] = []
  const islandCache = new Map<string, CopilotSeg>()

  return function parse(src: string, opts: Omit<SplitOptions, 'islandCache'> = {}): CopilotSeg[] {
    const open = opts.open ?? false
    if (lastSrc === src && lastOpen === open) return lastResult
    const segs = splitCopilotStream(src, { open, islandCache })
    lastSrc = src
    lastOpen = open
    lastResult = segs
    return segs
  }
}
