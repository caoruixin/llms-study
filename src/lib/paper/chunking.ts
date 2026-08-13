import { buildDoc } from './bm25'
import type { NormalizedBlock, PaperChunk, SourceAnchor } from './types'

/**
 * 语义分块（§4.4）：按章节与语义边界把 `PaperBlock` 聚成检索用的 `PaperChunk`，
 * 目标 ~1200 token、15% 重叠，每块保留章节 / 页码 / 块序号范围锚点。
 *
 * 本地没有 tokenizer，token 一律用 `chars/3` 中英混合粗估——所有对外字段都叫
 * `tokenEstimate`，提醒下游（预算裁剪、成本预估）这是估算值而非真实计数。
 */

export const CHARS_PER_TOKEN = 3
export const DEFAULT_TARGET_TOKENS = 1200
export const DEFAULT_OVERLAP_RATIO = 0.15

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

export interface ChunkOptions {
  targetTokens?: number
  /** 相邻块重叠比例（相对 targetTokens），0 表示不重叠 */
  overlapRatio?: number
  /**
   * 遇到标题时，当前缓冲达到 `targetTokens * minSplitRatio` 才断块。
   * 否则「1 标题 + 2 行正文」的密集小节会被切成一堆碎块，反而拉低召回质量。
   */
  minSplitRatio?: number
}

/** id / paperId 由持久化层补齐，与 NormalizedBlock 的分工一致 */
export type ChunkDraft = Omit<PaperChunk, 'id' | 'paperId'>

interface Item {
  index: number
  text: string
  anchor: SourceAnchor
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 块内锚点：只保留定位必需的字段（charStart/charEnd 属于单个块，聚合后不再成立） */
function chunkAnchor(first: Item): SourceAnchor {
  const anchor: SourceAnchor = { kind: first.anchor.kind, blockIndex: first.index }
  if (first.anchor.page !== undefined) anchor.page = first.anchor.page
  if (first.anchor.section !== undefined) anchor.section = first.anchor.section
  return anchor
}

function makeDraft(items: Item[]): ChunkDraft {
  const text = items.map((i) => i.text).join('\n')
  return {
    order: 0, // 末尾统一重排
    text,
    anchor: chunkAnchor(items[0]),
    blockStart: items[0].index,
    blockEnd: items[items.length - 1].index,
    tokenEstimate: estimateTokens(text),
  }
}

/**
 * 在窗口内找一个体面的切分点：优先句末标点，其次空白；都没有就硬切。
 * `minPos` 防止把窗口切得过短（否则超长块会被切成一堆碎片）。
 */
function findBoundary(window: string, minPos: number): number {
  for (let i = window.length - 1; i >= minPos; i--) {
    const ch = window[i]
    if (ch === '.' || ch === '。' || ch === '!' || ch === '！' || ch === '?' || ch === '？' || ch === '\n' || ch === '；' || ch === ';') {
      return i + 1
    }
  }
  for (let i = window.length - 1; i >= minPos; i--) {
    if (/\s/.test(window[i])) return i + 1
  }
  return -1
}

/** 超长块（单块就超过 target）按字符切片，切片之间同样保持重叠 */
export function splitLongText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const cut = findBoundary(text.slice(start, end), Math.floor(maxChars * 0.6))
      if (cut > 0) end = start + cut
    }
    const piece = text.slice(start, end).trim()
    if (piece) parts.push(piece)
    if (end >= text.length) break
    // 至少推进 1 个字符：重叠再大也不会死循环
    start = Math.max(end - overlapChars, start + 1)
  }
  return parts
}

export function chunkBlocks(blocks: readonly NormalizedBlock[], opts: ChunkOptions = {}): ChunkDraft[] {
  const target = Math.max(50, opts.targetTokens ?? DEFAULT_TARGET_TOKENS)
  const overlapRatio = clamp(opts.overlapRatio ?? DEFAULT_OVERLAP_RATIO, 0, 0.5)
  const minSplit = target * clamp(opts.minSplitRatio ?? 0.35, 0, 1)
  const overlapTokens = target * overlapRatio

  const out: ChunkDraft[] = []
  let buf: Item[] = []
  let bufTokens = 0

  /** withOverlap=false 用于章节边界：新章节从标题开始更干净，不把上一节的尾巴带过来 */
  const flush = (withOverlap: boolean) => {
    if (!buf.length) return
    out.push(makeDraft(buf))
    if (!withOverlap) {
      buf = []
      bufTokens = 0
      return
    }
    const carry: Item[] = []
    let acc = 0
    // i >= 1：至少留一个块不进位，保证下一块的 blockStart 一定前进
    for (let i = buf.length - 1; i >= 1; i--) {
      const t = estimateTokens(buf[i].text)
      if (acc + t > overlapTokens) break
      carry.unshift(buf[i])
      acc += t
    }
    // 块粒度大于重叠预算时（长段落论文很常见）至少带上最后一块：
    // 否则「15% 重叠」会在这类文档上退化成 0，切口处的论证被拦腰截断。
    if (!carry.length && overlapTokens > 0 && buf.length >= 2) {
      const last = buf[buf.length - 1]
      if (estimateTokens(last.text) <= target * 0.5) {
        carry.push(last)
        acc = estimateTokens(last.text)
      }
    }
    buf = carry
    bufTokens = acc
  }

  for (const b of blocks) {
    const text = b.text.trim()
    if (!text) continue
    const item: Item = { index: b.index, text, anchor: b.anchor }
    const tokens = estimateTokens(text)

    if (b.kind === 'heading' && bufTokens >= minSplit) flush(false)

    if (tokens > target) {
      flush(false)
      const maxChars = target * CHARS_PER_TOKEN
      for (const piece of splitLongText(text, maxChars, Math.floor(maxChars * overlapRatio))) {
        out.push({
          order: 0,
          text: piece,
          anchor: chunkAnchor(item),
          blockStart: item.index,
          blockEnd: item.index,
          tokenEstimate: estimateTokens(piece),
        })
      }
      continue
    }

    buf.push(item)
    bufTokens += tokens
    if (bufTokens >= target) flush(true)
  }
  flush(false)

  return out.map((c, i) => ({ ...c, order: i }))
}

/**
 * 落库形态：补 id/paperId，并把 BM25 的 tf/len 一起算好存进 chunk 行。
 * 查询时直接由这些 tf 重建倒排表，因此不需要为索引单独建表。
 */
export function buildChunkRows(paperId: string, drafts: readonly ChunkDraft[]): PaperChunk[] {
  return drafts.map((d) => {
    const id = `${paperId}:c${d.order}`
    const doc = buildDoc(id, d.text)
    return { ...d, id, paperId, tf: doc.tf, len: doc.len }
  })
}

/** 一步到位：正文块 → 可直接写库的 chunk 行 */
export function chunkPaper(paperId: string, blocks: readonly NormalizedBlock[], opts?: ChunkOptions): PaperChunk[] {
  return buildChunkRows(paperId, chunkBlocks(blocks, opts))
}
