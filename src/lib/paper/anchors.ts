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
