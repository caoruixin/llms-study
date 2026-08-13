/**
 * 本地 BM25 索引与检索（§4.4）。纯函数、零运行时依赖，直接进 node 单测。
 *
 * 这是「模型不可用时仍能全文搜索」的兜底路径，也是引用白名单（§8.1）的召回来源，
 * 因此排序必须**完全确定**：同分时按文档入库序号打破平局，任何环境跑出的结果都一致。
 */

export interface Bm25Params {
  k1: number
  b: number
}

/** 常规取值：k1 控制词频饱和，b 控制长度归一化 */
export const DEFAULT_BM25_PARAMS: Bm25Params = { k1: 1.2, b: 0.75 }

/**
 * 单篇文档的索引形态：词频表 + 词元总数。
 * 它同时也是**持久化形态**——把每个 chunk 的 tf/len 直接存进 Dexie 的 chunks 行，
 * 查询时用 `buildBm25Index(docs)` 在内存里重建倒排表（O(总词元数)，毫秒级），
 * 因此不需要为索引单独建表（schema 只加字段、不加 migration）。
 */
export interface Bm25Doc {
  id: string
  tf: Record<string, number>
  len: number
}

export interface SerializedBm25Index {
  v: 1
  docs: Bm25Doc[]
}

export interface Bm25Index {
  docs: Bm25Doc[]
  /** term → [文档序号, 词频][]，查询只遍历命中词的倒排链 */
  postings: Map<string, [number, number][]>
  df: Map<string, number>
  avgdl: number
  n: number
}

export interface Bm25Hit {
  id: string
  score: number
  /** 命中的查询词元，供搜索结果做片段高亮 */
  matched: string[]
}

export interface Bm25SearchOptions {
  topK?: number
  params?: Bm25Params
  /** 每篇文档的乘性权重（如「当前阅读章节」加权），默认 1；必须是纯函数以保持确定性 */
  boost?: (id: string) => number
}

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

/** 中日韩表意文字 + 假名 + 谚文：判定是否走 CJK 处理分支 */
const CJK_CHAR = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'
const CJK_TEST = new RegExp(`[${CJK_CHAR}]`)
const CJK_RUN = new RegExp(`[${CJK_CHAR}]+`, 'g')
/** 无 Intl.Segmenter 时的降级分词：拉丁字母/数字串 */
const LATIN_RUN = /[a-z0-9]+(?:['’][a-z]+)?/g

let cachedSegmenter: Intl.Segmenter | null | undefined

function getSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter
  try {
    cachedSegmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('zh', { granularity: 'word' })
        : null
  } catch {
    cachedSegmenter = null
  }
  return cachedSegmenter
}

/**
 * 极简英文词干化（§4.4「英文词干可选简化」）：只处理复数，不碰 -ed/-ing。
 * 目标是让 models/model 命中同一词元，同时避免激进词干把 bases→base、bus→bu 这类误伤。
 */
export function stemLatin(word: string): string {
  const w = word.replace(/['’]s$/, '')
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is|as|os)$/.test(w)) return w.slice(0, -1)
  return w
}

/**
 * 中英混排分词：
 * 1. `Intl.Segmenter`（zh，word 粒度）切出词元，小写化，拉丁词过轻量词干；
 * 2. **额外**为每段 CJK 连续文本发射字符二元组。
 *
 * 为什么要二元组：ICU 对「显存」这类词会切成「显」「存」，只靠单字会让
 * "显存" 与 "显示存储" 得到同样的召回；二元组把词序信息补回来，
 * 且查询与文档走同一套分词，命中天然对齐。
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const norm = text.normalize('NFKC').toLowerCase()
  const out: string[] = []

  const seg = getSegmenter()
  if (seg) {
    for (const piece of seg.segment(norm)) {
      if (!piece.isWordLike) continue
      const w = piece.segment.trim()
      if (!w) continue
      out.push(CJK_TEST.test(w) ? w : stemLatin(w))
    }
  } else {
    // 降级路径：拉丁串按正则切，CJK 单字逐字发射（二元组在下面统一补）
    for (const m of norm.matchAll(LATIN_RUN)) out.push(stemLatin(m[0]))
    for (const run of norm.matchAll(CJK_RUN)) for (const ch of run[0]) out.push(ch)
  }

  for (const run of norm.matchAll(CJK_RUN)) {
    const s = run[0]
    for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2))
  }
  return out
}

// ---------------------------------------------------------------------------
// 建索引
// ---------------------------------------------------------------------------

export function buildDoc(id: string, text: string): Bm25Doc {
  const tokens = tokenize(text)
  const tf: Record<string, number> = Object.create(null) as Record<string, number>
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1
  return { id, tf, len: tokens.length }
}

export function buildBm25Index(docs: readonly Bm25Doc[]): Bm25Index {
  const postings = new Map<string, [number, number][]>()
  const df = new Map<string, number>()
  let total = 0

  docs.forEach((doc, i) => {
    total += doc.len
    for (const term of Object.keys(doc.tf)) {
      const f = doc.tf[term]
      if (!f) continue
      const list = postings.get(term)
      if (list) list.push([i, f])
      else postings.set(term, [[i, f]])
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  })

  return {
    docs: docs as Bm25Doc[],
    postings,
    df,
    avgdl: docs.length ? total / docs.length : 0,
    n: docs.length,
  }
}

export function indexTexts(items: readonly { id: string; text: string }[]): Bm25Index {
  return buildBm25Index(items.map((it) => buildDoc(it.id, it.text)))
}

export function serializeBm25Index(index: Bm25Index): SerializedBm25Index {
  return { v: 1, docs: index.docs.map((d) => ({ id: d.id, tf: { ...d.tf }, len: d.len })) }
}

/**
 * 反序列化：对存量数据保持宽容（坏行跳过而不是整篇索引作废）——
 * 论文正文永远是不可信输入，索引也可能来自上一个解析器版本。
 */
export function deserializeBm25Index(data: unknown): Bm25Index {
  const raw = (data as SerializedBm25Index | null)?.docs
  if (!Array.isArray(raw)) return buildBm25Index([])
  const docs: Bm25Doc[] = []
  for (const d of raw) {
    if (!d || typeof d.id !== 'string' || typeof d.tf !== 'object' || d.tf === null) continue
    const tf: Record<string, number> = {}
    let len = 0
    for (const [term, f] of Object.entries(d.tf as Record<string, unknown>)) {
      if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) continue
      tf[term] = f
      len += f
    }
    docs.push({ id: d.id, tf, len: typeof d.len === 'number' && d.len > 0 ? d.len : len })
  }
  return buildBm25Index(docs)
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * idf 用 `ln(1 + (n - df + 0.5) / (df + 0.5))` 这一支：恒为正，
 * 高频词（如「的」）自然趋近 0，因此不需要维护停用词表。
 */
function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

export function bm25Search(index: Bm25Index, query: string, opts: Bm25SearchOptions = {}): Bm25Hit[] {
  const terms = tokenize(query)
  if (!terms.length || index.n === 0) return []

  const { k1, b } = opts.params ?? DEFAULT_BM25_PARAMS
  const scores = new Float64Array(index.n)
  const matched: Set<string>[] = []
  const seen = new Set<string>()

  for (const term of terms) {
    if (seen.has(term)) continue // 查询里重复出现的词只计一次，避免长查询自我放大
    seen.add(term)
    const list = index.postings.get(term)
    if (!list) continue
    const w = idf(index.n, index.df.get(term) ?? list.length)
    for (const [d, f] of list) {
      const len = index.docs[d].len || 1
      const norm = f + k1 * (1 - b + (b * len) / (index.avgdl || len))
      scores[d] += (w * f * (k1 + 1)) / norm
      ;(matched[d] ??= new Set()).add(term)
    }
  }

  const hits: { hit: Bm25Hit; order: number }[] = []
  for (let d = 0; d < index.n; d++) {
    if (scores[d] <= 0) continue
    const id = index.docs[d].id
    const boost = opts.boost ? opts.boost(id) : 1
    hits.push({
      hit: { id, score: scores[d] * boost, matched: [...(matched[d] ?? [])] },
      order: d,
    })
  }
  // 同分按入库序号：结果与调用次数、Map 迭代顺序无关
  hits.sort((a, b2) => b2.hit.score - a.hit.score || a.order - b2.order)
  const topK = opts.topK ?? hits.length
  return hits.slice(0, Math.max(0, topK)).map((h) => h.hit)
}
