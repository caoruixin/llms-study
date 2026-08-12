import { bm25Search, buildBm25Index, buildDoc, tokenize, type Bm25Doc, type Bm25Index } from './bm25'
import { hybridRetrieve, type HybridOptions } from './hybrid'
import type { PaperChunk, SourceAnchor } from './types'

/**
 * 检索入口（§4.3 RetrievalService / §4.4 检索策略 / §8.1 引用白名单前置）。
 *
 * 一次检索的产物有两份：
 * 1. `chunks`：带别名的原文片段，供上下文组装；
 * 2. `citeMapEntries`：`alias → { chunkId, anchor, page, section }` 的本轮白名单。
 *    模型只被允许使用别名 `c1..cN`，页码由应用从这张表映射（模型永不产出页码）。
 */

export interface CiteMapEntry {
  /** 本轮短别名 c1..cN：省 token、抄错率低，持久 chunkId 不外发 */
  alias: string
  chunkId: string
  anchor: SourceAnchor
  page?: number
  section?: string
}

export interface RetrievedChunk {
  alias: string
  chunk: PaperChunk
  score: number
  /** 命中的查询词元，供 UI 片段高亮 */
  matched: string[]
}

export interface RetrieveContext {
  /** 当前阅读位置所在章节 */
  currentSection?: string
  /** 用户选区文本（上限截断后参与查询扩展） */
  selection?: string
  /** 全文章节标题表：与问题有词面交集的标题会被并入查询 */
  sectionTitles?: readonly string[]
}

export interface RetrieveOptions extends RetrieveContext {
  /** 最终返回条数（§8.1：常规 6，深度任务 12） */
  topK?: number
  /** BM25 一阶段召回条数 */
  recallK?: number
  hybrid?: HybridOptions
}

export interface RetrieveResult {
  chunks: RetrievedChunk[]
  citeMapEntries: CiteMapEntry[]
  /** 实际送进 BM25 的扩展查询，便于排查召回问题 */
  expandedQuery: string
  usedRerank: boolean
}

/** 选区参与查询扩展时的截断长度：整段选区会稀释问题本身的关键词 */
const SELECTION_QUERY_CHARS = 300
/** 当前阅读章节的乘性加权：轻微倾斜，不足以压过词面强相关的其他章节 */
const CURRENT_SECTION_BOOST = 1.12

/**
 * 查询扩展（§4.4：综合问题关键词、章节标题、当前阅读位置、用户选区）。
 * 纯字符串拼接而非同义词扩展——BM25 对噪声敏感，只加确定相关的上下文。
 */
export function expandQuery(query: string, ctx: RetrieveContext = {}): string {
  const parts: string[] = [query.trim()]
  if (ctx.selection?.trim()) parts.push(ctx.selection.trim().slice(0, SELECTION_QUERY_CHARS))
  if (ctx.currentSection?.trim()) parts.push(ctx.currentSection.trim())

  if (ctx.sectionTitles?.length) {
    const qTerms = new Set(tokenize(query))
    const matchedTitles: string[] = []
    for (const title of ctx.sectionTitles) {
      if (matchedTitles.length >= 3) break
      if (title === ctx.currentSection) continue
      if (tokenize(title).some((t) => qTerms.has(t))) matchedTitles.push(title)
    }
    parts.push(...matchedTitles)
  }
  return parts.filter(Boolean).join(' ')
}

/** chunk 行里已存好 tf/len（见 chunking.buildChunkRows）；缺失的行（旧数据）现场补算 */
function chunkToDoc(chunk: PaperChunk): Bm25Doc {
  if (chunk.tf && typeof chunk.len === 'number' && chunk.len > 0) {
    return { id: chunk.id, tf: chunk.tf, len: chunk.len }
  }
  return buildDoc(chunk.id, chunk.text)
}

export function indexChunks(chunks: readonly PaperChunk[]): Bm25Index {
  return buildBm25Index(chunks.map(chunkToDoc))
}

export function buildCiteMap(chunks: readonly { chunk: PaperChunk }[]): CiteMapEntry[] {
  return chunks.map(({ chunk }, i) => {
    const entry: CiteMapEntry = { alias: `c${i + 1}`, chunkId: chunk.id, anchor: chunk.anchor }
    if (chunk.anchor.page !== undefined) entry.page = chunk.anchor.page
    if (chunk.anchor.section !== undefined) entry.section = chunk.anchor.section
    return entry
  })
}

/**
 * 核心检索：BM25 召回 → hybrid 合并/重排（Phase 2 默认只有 BM25）→ 别名与 CiteMap。
 * 传 chunks 而不是 paperId，纯函数化后可直接单测；仓储版本见 createRetrievalService。
 */
export async function retrieveFromChunks(
  chunks: readonly PaperChunk[],
  query: string,
  opts: RetrieveOptions = {},
  index?: Bm25Index,
): Promise<RetrieveResult> {
  const topK = opts.topK ?? 6
  const recallK = opts.recallK ?? 20
  const expandedQuery = expandQuery(query, opts)
  if (!chunks.length || !expandedQuery.trim()) {
    return { chunks: [], citeMapEntries: [], expandedQuery, usedRerank: false }
  }

  const idx = index ?? indexChunks(chunks)
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const current = opts.currentSection
  const hits = bm25Search(idx, expandedQuery, {
    topK: recallK,
    boost: current ? (id) => (byId.get(id)?.anchor.section === current ? CURRENT_SECTION_BOOST : 1) : undefined,
  })
  if (!hits.length) return { chunks: [], citeMapEntries: [], expandedQuery, usedRerank: false }

  const matchedById = new Map(hits.map((h) => [h.id, h.matched]))
  const hybrid = await hybridRetrieve(
    {
      query: expandedQuery,
      bm25: hits.map((h) => ({ id: h.id, score: h.score })),
      docs: hits.map((h) => ({ id: h.id, text: byId.get(h.id)?.text ?? '' })),
    },
    { topN: topK, ...opts.hybrid },
  )

  const picked: RetrievedChunk[] = []
  hybrid.results.forEach((r, i) => {
    const chunk = byId.get(r.id)
    if (!chunk) return
    picked.push({ alias: `c${i + 1}`, chunk, score: r.score, matched: matchedById.get(r.id) ?? [] })
  })
  // 别名必须与最终顺序一致：hybrid 结果里若有 chunk 已被删除，重排别名避免出现空号
  const finalChunks = picked.map((p, i) => ({ ...p, alias: `c${i + 1}` }))

  return {
    chunks: finalChunks,
    citeMapEntries: buildCiteMap(finalChunks),
    expandedQuery,
    usedRerank: hybrid.usedRerank,
  }
}

// ---------------------------------------------------------------------------
// 全文搜索（模型不可用时的兜底路径）
// ---------------------------------------------------------------------------

export interface SearchHit {
  chunkId: string
  order: number
  score: number
  snippet: string
  matched: string[]
  anchor: SourceAnchor
  section?: string
  page?: number
}

/** 取第一处命中词附近的一段文本作为结果摘要 */
export function makeSnippet(text: string, matched: readonly string[], radius = 60): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of matched) {
    const i = lower.indexOf(term.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return text.length <= radius * 2 ? text : `${text.slice(0, radius * 2).trim()}…`
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** 把片段按命中词切成 {text, hit} 段，供 UI 高亮（纯函数，不产出 HTML） */
export function splitHighlight(text: string, terms: readonly string[]): { text: string; hit: boolean }[] {
  const useful = [...new Set(terms.filter((t) => t.length > 0))].sort((a, b) => b.length - a.length)
  if (!useful.length) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const out: { text: string; hit: boolean }[] = []
  let i = 0
  while (i < text.length) {
    let found = -1
    let len = 0
    for (const term of useful) {
      const at = lower.indexOf(term.toLowerCase(), i)
      if (at >= 0 && (found < 0 || at < found || (at === found && term.length > len))) {
        found = at
        len = term.length
      }
    }
    if (found < 0) {
      out.push({ text: text.slice(i), hit: false })
      break
    }
    if (found > i) out.push({ text: text.slice(i, found), hit: false })
    out.push({ text: text.slice(found, found + len), hit: true })
    i = found + len
  }
  return out.filter((p) => p.text.length > 0)
}

export function searchChunks(
  chunks: readonly PaperChunk[],
  query: string,
  opts: { limit?: number; index?: Bm25Index } = {},
): SearchHit[] {
  if (!query.trim() || !chunks.length) return []
  const idx = opts.index ?? indexChunks(chunks)
  const byId = new Map(chunks.map((c) => [c.id, c]))
  return bm25Search(idx, query, { topK: opts.limit ?? 20 })
    .map((h) => {
      const chunk = byId.get(h.id)
      if (!chunk) return null
      const hit: SearchHit = {
        chunkId: chunk.id,
        order: chunk.order,
        score: h.score,
        snippet: makeSnippet(chunk.text, h.matched),
        matched: h.matched,
        anchor: chunk.anchor,
      }
      if (chunk.anchor.section !== undefined) hit.section = chunk.anchor.section
      if (chunk.anchor.page !== undefined) hit.page = chunk.anchor.page
      return hit
    })
    .filter((h): h is SearchHit => h !== null)
}

// ---------------------------------------------------------------------------
// 仓储绑定（浏览器侧使用）
// ---------------------------------------------------------------------------

export interface RetrievalDeps {
  loadChunks: (paperId: string) => Promise<PaperChunk[]>
}

export interface RetrievalService {
  retrieve(paperId: string, query: string, opts?: RetrieveOptions): Promise<RetrieveResult>
  search(paperId: string, query: string, opts?: { limit?: number }): Promise<SearchHit[]>
  /** 论文重新解析后必须调用，否则会拿旧索引查新正文 */
  invalidate(paperId: string): void
}

/**
 * 每篇论文的 chunk + 倒排表缓存在内存：一次查询几毫秒，翻页/连续搜索不重复建表。
 * 索引本身不落额外的表——tf/len 已随 chunk 行持久化（见 chunking.buildChunkRows）。
 */
export function createRetrievalService(deps: RetrievalDeps): RetrievalService {
  const cache = new Map<string, { chunks: PaperChunk[]; index: Bm25Index }>()

  async function load(paperId: string) {
    const hit = cache.get(paperId)
    if (hit) return hit
    const chunks = await deps.loadChunks(paperId)
    const entry = { chunks, index: indexChunks(chunks) }
    cache.set(paperId, entry)
    return entry
  }

  return {
    async retrieve(paperId, query, opts) {
      const { chunks, index } = await load(paperId)
      return retrieveFromChunks(chunks, query, opts, index)
    },
    async search(paperId, query, opts) {
      const { chunks, index } = await load(paperId)
      return searchChunks(chunks, query, { ...opts, index })
    },
    invalidate(paperId) {
      cache.delete(paperId)
    },
  }
}
