import type { NormalizedBlock, SourceAnchor } from './types'

/**
 * `SourceAnchor` → 阅读器滚动目标（§3.3「不能精确定位时，至少定位到正确页和章节」）。
 * 纯函数，不碰 DOM：组件只负责把 `domId` 交给 `document.getElementById` 并做短暂高亮。
 *
 * 这是 Phase 3 CiteBadge 的消费接口——引用点击链路 = resolveAnchor → scrollToTarget → flash。
 */

export type ReaderMode = 'original' | 'text'
export type AnchorPrecision = 'block' | 'page' | 'section' | 'none'

export interface ScrollTarget {
  mode: ReaderMode
  /** 实际达到的定位精度，UI 可据此提示「已定位到第 7 页（无法精确到段落）」 */
  precision: AnchorPrecision
  blockIndex?: number
  page?: number
  section?: string
  /** 目标 DOM 元素 id；precision 为 none 时缺省 */
  domId?: string
}

export const blockDomId = (blockIndex: number): string => `paper-block-${blockIndex}`
export const pageDomId = (page: number): string => `paper-page-${page}`

export interface AnchorContext {
  blockCount: number
  pageCount?: number
  /** 块序号 → 页码（PDF 才有） */
  pageOfBlock: readonly (number | undefined)[]
  /** 页码 → 该页第一个块序号 */
  firstBlockOfPage: Readonly<Record<number, number>>
  /** 章节标题 → 该章节第一个块序号 */
  firstBlockOfSection: Readonly<Record<string, number>>
  /** 章节标题 → 该章节所在页 */
  pageOfSection: Readonly<Record<string, number>>
}

/** 从正文块一次性建好各级回退所需的映射表 */
export function buildAnchorContext(blocks: readonly NormalizedBlock[], pageCount?: number): AnchorContext {
  const pageOfBlock: (number | undefined)[] = []
  const firstBlockOfPage: Record<number, number> = {}
  const firstBlockOfSection: Record<string, number> = {}
  const pageOfSection: Record<string, number> = {}
  let maxPage = 0

  for (const b of blocks) {
    const page = b.anchor.page
    pageOfBlock[b.index] = page
    if (page !== undefined) {
      if (firstBlockOfPage[page] === undefined) firstBlockOfPage[page] = b.index
      if (page > maxPage) maxPage = page
    }
    // 标题块自身的 section 就是它自己，因此「章节首块」总是落在标题上
    const section = b.anchor.section
    if (section && firstBlockOfSection[section] === undefined) {
      firstBlockOfSection[section] = b.index
      if (page !== undefined) pageOfSection[section] = page
    }
  }

  return {
    blockCount: blocks.length,
    pageCount: pageCount ?? (maxPage || undefined),
    pageOfBlock,
    firstBlockOfPage,
    firstBlockOfSection,
    pageOfSection,
  }
}

const isIndex = (v: unknown, count: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count

const isPage = (v: unknown, pageCount?: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && (pageCount === undefined || v <= pageCount)

/**
 * 回退阶梯：
 * - 文本视图：块序号 → 页首块 → 章节首块 → 无法定位
 * - 原版 PDF：页码（可由块序号反查）→ 章节所在页 → 无法定位
 *
 * 块序号是稳定主键（见 types.ts 的 SourceAnchor 注释），所以两种视图都优先用它，
 * 只有它越界（解析器版本漂移、引用来自旧索引）时才逐级降级。
 */
export function resolveAnchor(
  anchor: Partial<SourceAnchor> | null | undefined,
  ctx: AnchorContext,
  mode: ReaderMode,
): ScrollTarget {
  const a = anchor ?? {}
  const section = typeof a.section === 'string' && a.section ? a.section : undefined
  const sectionBlock = section !== undefined ? ctx.firstBlockOfSection[section] : undefined

  if (mode === 'text') {
    if (isIndex(a.blockIndex, ctx.blockCount)) {
      const page = ctx.pageOfBlock[a.blockIndex] ?? (isPage(a.page, ctx.pageCount) ? a.page : undefined)
      return { mode, precision: 'block', blockIndex: a.blockIndex, page, section, domId: blockDomId(a.blockIndex) }
    }
    if (isPage(a.page, ctx.pageCount) && ctx.firstBlockOfPage[a.page] !== undefined) {
      const blockIndex = ctx.firstBlockOfPage[a.page]
      return { mode, precision: 'page', blockIndex, page: a.page, section, domId: blockDomId(blockIndex) }
    }
    if (sectionBlock !== undefined) {
      return {
        mode,
        precision: 'section',
        blockIndex: sectionBlock,
        page: ctx.pageOfBlock[sectionBlock],
        section,
        domId: blockDomId(sectionBlock),
      }
    }
    return { mode, precision: 'none', section }
  }

  // 原版 PDF 模式：最细粒度就是「页」，块序号只用来反查页码
  const fromBlock = isIndex(a.blockIndex, ctx.blockCount) ? ctx.pageOfBlock[a.blockIndex] : undefined
  const page = isPage(fromBlock, ctx.pageCount) ? fromBlock : isPage(a.page, ctx.pageCount) ? a.page : undefined
  if (page !== undefined) {
    return {
      mode,
      precision: 'page',
      page,
      blockIndex: isIndex(a.blockIndex, ctx.blockCount) ? a.blockIndex : undefined,
      section,
      domId: pageDomId(page),
    }
  }
  if (section !== undefined && ctx.pageOfSection[section] !== undefined) {
    const sectionPage = ctx.pageOfSection[section]
    return { mode, precision: 'section', page: sectionPage, section, domId: pageDomId(sectionPage) }
  }
  return { mode, precision: 'none', section }
}

/** 原版 PDF 渲染窗口：可见页前后各多渲染几页（预渲染，滚动到时位图已就绪） */
export const RENDER_WINDOW_PAGES = 2

export interface PageRange {
  min: number
  max: number
}

/**
 * 一页是否落在渲染窗口内（PdfViewer 用它决定该页画位图还是留占位符）。
 *
 * range 为 null（IntersectionObserver 还没结算出可见集）时兜底为 `{min:1,max:1}`：
 * 首屏前 1+window 页无条件渲染——否则任何让 IO 首批回调全部「不可见」的时序
 * （移动端 WebView 懒布局、后台标签挂起等）都会让整篇 PDF 永远停在占位符上，
 * 这是手机端「原版 PDF 全白」的根因之一。
 */
export function isPageActive(page: number, range: PageRange | null, window: number = RENDER_WINDOW_PAGES): boolean {
  const r = range ?? { min: 1, max: 1 }
  return page >= r.min - window && page <= r.max + window
}

/**
 * 容器内滚动定位：把目标元素顶边对齐到滚动容器视口顶边下 margin 处，返回容器应设的 scrollTop。
 *
 * 与 `scrollIntoView({block:'start'})` 数学等价（margin 对应目标元素的 `scroll-mt-4` = 16px，
 * PDF 页与文本块都用这个值），区别在于**只滚阅读容器自己**——scrollIntoView 会把所有可滚祖先
 * 连文档一起滚，手机上（文档本不该滚）会把工作台 header 顶出屏幕。
 *
 * @param scrollTop 容器当前 scrollTop
 * @param elTop 目标元素顶边（视口坐标，getBoundingClientRect().top）
 * @param viewportTop 容器滚动视口顶边（视口坐标，含 clientTop 边框修正）
 * @param margin 顶部留白，默认 16 = scroll-mt-4
 */
export function readerScrollTop(scrollTop: number, elTop: number, viewportTop: number, margin: number = 16): number {
  // 元素与容器顶边的相对偏移在滚动中保持不变，所以目标 scrollTop 是简单的平移；负值钳到 0
  return Math.max(0, scrollTop + (elTop - viewportTop) - margin)
}

/** 一页在滚动容器坐标系里的上下边（同一参照系即可，通常直接用 getBoundingClientRect） */
export interface PageEdges {
  page: number
  top: number
  bottom: number
}

/**
 * 「贴边」容差：上一页底边与容器顶边零面积相切（对齐后的常态）以及亚像素舍入，
 * 都必须判给下一页。8px 足够吸收这两类误差，又远小于页间距（mb-4 = 16px）。
 */
export const CURRENT_PAGE_EPSILON = 8

/**
 * 从页矩形数组求「当前页」= **盖住滚动容器顶边的那一页**。
 *
 * 语义之所以要单独定义：原版 PDF 的渲染窗口用 IntersectionObserver + `rootMargin: '20% 0px'`
 * 把判定区向上扩了 20% 视口高（预渲染需要），可见集里因此永远混着上一页；
 * 拿它的 min 当当前页，会在「对齐到第 N 页 → 判成 N-1 → 下次按 N-1 对齐」里累积回退一页（QA P1）。
 *
 * 规则：探测线 = 容器顶边 + epsilon，取底边仍在探测线下方的最靠上一页。
 * - 页间空隙落在探测线上时（对齐后的常态）自然归下一页，不会退回上一页；
 * - 滚到最后一页之后（尾部留白）回退到最后一页；
 * - 空数组返回 undefined。
 *
 * 调用方约束：容器 `display:none` 时所有矩形塌成 0，必须先自行短路（见 PdfViewer）。
 */
export function pickCurrentPage(
  pages: readonly PageEdges[],
  viewportTop: number,
  epsilon: number = CURRENT_PAGE_EPSILON,
): number | undefined {
  const probe = viewportTop + epsilon
  let current: number | undefined
  let currentBottom = Infinity
  let last: number | undefined
  let lastBottom = -Infinity
  // 不假设入参有序：取「底边 > 探测线」中底边最小的那页，等价于视觉上最靠上的一页
  for (const p of pages) {
    if (p.bottom > lastBottom) {
      lastBottom = p.bottom
      last = p.page
    }
    if (p.bottom > probe && p.bottom < currentBottom) {
      currentBottom = p.bottom
      current = p.page
    }
  }
  return current ?? last
}

/** UI 文案：告诉用户这次跳转到底跳到了哪一级 */
export function describeTarget(t: ScrollTarget): string {
  switch (t.precision) {
    case 'block':
      return t.page !== undefined ? `第 ${t.page} 页 · 第 ${(t.blockIndex ?? 0) + 1} 段` : `第 ${(t.blockIndex ?? 0) + 1} 段`
    case 'page':
      return `第 ${t.page} 页`
    case 'section':
      return t.section ? `章节「${t.section}」` : '所在章节'
    case 'none':
      return '无法定位到原文位置'
  }
}
