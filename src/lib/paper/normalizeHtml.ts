import { decodeEntities, detectPseudoHeading, extractBlocks, listItems, tableToText, toText } from './normalizeDocx'
import type { NormalizedBlock, PaperBlockKind } from './types'

/**
 * URL 导入的 HTML → 规范化块。与 normalizeDocxHtml 同构（复用它的块级扫描/去标签/
 * 列表拆分/表格文本化/伪标题识别工具，不迁移不复制），纯函数、不碰 DOM——
 * 与 normalizeDocx.ts 一样可以在 node 环境直接跑 vitest。
 *
 * 与 DOCX 管线的唯一区别在于「多节合并」语义（一节 = 一个 URL 抽取出的正文）：
 * - 单节（单 URL 导入）：原样输出，不下压标题、不合成任何 heading——与 DOCX 行为一致，
 *   这也是为什么单节调用与 normalizeDocxHtml(html) 的输出在 kind/level/text 上完全等价
 *   （区别只有二：anchor.kind 是 'html' 而不是 'docx'；figure 在这里落 image/caption 块，
 *   在 DOCX 管线落 default→paragraph——DOCX 的 img 早被 sanitize 剥掉，没有图片通道）。
 * - 多节（多 URL 合并成一篇）：每节最前面插入一个 level-1 heading（该节的页面标题），
 *   节内原有标题统一下压一级（cap 到 6，避免 h6 下压后无级可用），
 *   若节内第一个标题恰好与节标题文本相同（Readability 抽取时常把 <title> 重复成正文首个
 *   h1），跳过这个重复标题，避免同一标题连续出现两次。
 *
 * anchor.blockIndex 在全部小节之间连续递增（不按节重置）；anchor.section 沿用
 * normalizeDocxHtml 的「最近一级标题」追踪语义——多节下每进入新节先被合成 heading 刷新。
 */

export interface HtmlSectionInput {
  /** 该节（该 URL）抽取出的页面标题；单节时不参与输出，仅多节合并时用作合成 heading */
  title?: string
  /** 已净化的正文 HTML（调用方负责在这之前完成 sanitizeArticleHtml，本函数不做 XSS 防护） */
  html: string
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const IMG_TAG_RE = /<img\b[^>]*>/gi
const FIGCAPTION_RE = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i

/**
 * 从单个 `<img ...>` 标签字符串里抠属性值（双引号/单引号/无引号三种写法）。
 * 属性值做 HTML 实体解码（src 里的 &amp; 等）——保持本文件「正则实现、不碰 DOM」的纯函数设计。
 */
function imgAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  if (!m) return undefined
  const raw = m[1] ?? m[2] ?? m[3] ?? ''
  return decodeEntities(raw)
}

export function normalizeHtmlSections(sections: readonly HtmlSectionInput[]): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = []
  let section = ''
  const multi = sections.length > 1
  const levelShift = multi ? 1 : 0

  const push = (kind: PaperBlockKind, text: string, extra?: { level?: number; html?: string; src?: string }) => {
    // 空 text 但带结构 html（纯图表格）或图片 src 的块保留——修「纯图表格被整块丢弃」bug + 放行 image 块
    if (!text && !extra?.html && !extra?.src) return
    const index = blocks.length
    const block: NormalizedBlock = {
      index,
      kind,
      text,
      anchor: { kind: 'html', blockIndex: index, section: section || undefined },
    }
    if (extra?.level !== undefined) block.level = extra.level
    if (extra?.html) block.html = extra.html
    if (extra?.src) block.src = extra.src
    blocks.push(block)
  }

  for (const sec of sections) {
    const title = (sec.title ?? '').trim()

    if (multi && title) {
      section = title
      push('heading', title, { level: 1 })
    }

    // 本节内是否还有机会触发「首标题与节 title 同文本」去重：只在本节第一个非空块之前为 true
    let dedupPending = multi && title.length > 0

    for (const b of extractBlocks(sec.html)) {
      if (HEADING_TAGS.has(b.tag)) {
        const text = toText(b.inner)
        if (!text) continue
        if (dedupPending && text === title) {
          dedupPending = false
          continue
        }
        dedupPending = false
        section = text
        push('heading', text, { level: Math.min(6, Number(b.tag[1]) + levelShift) })
        continue
      }
      if (b.tag === 'ul' || b.tag === 'ol') {
        for (const item of listItems(b.inner)) {
          dedupPending = false
          push('list', item)
        }
        continue
      }
      if (b.tag === 'table') {
        const text = tableToText(b.inner)
        if (text) dedupPending = false
        push('table', text, { html: `<table>${b.inner}</table>` })
        continue
      }
      if (b.tag === 'pre') {
        const text = toText(b.inner)
        if (text) dedupPending = false
        push('code', text)
        continue
      }
      if (b.tag === 'figure') {
        // 每张图独立成 image 块：text 是 [图: alt] 占位（供检索/翻译兜底展示），src 是远程 https URL
        for (const tag of b.inner.match(IMG_TAG_RE) ?? []) {
          const src = imgAttr(tag, 'src')
          const alt = imgAttr(tag, 'alt')?.trim()
          dedupPending = false
          push('image', alt ? `[图: ${alt}]` : '[图]', src ? { src } : undefined)
        }
        // 图注独立落为既有 caption kind：可译/可高亮/可检索全部走既有机制
        const capText = toText(FIGCAPTION_RE.exec(b.inner)?.[1] ?? '')
        if (capText) {
          dedupPending = false
          push('caption', capText)
        }
        // figure 内其余内容（非 img/figcaption）忽略
        continue
      }
      const text = toText(b.inner)
      const pseudo = b.tag === 'p' ? detectPseudoHeading(b.inner, text) : null
      if (pseudo) {
        if (dedupPending && text === title) {
          dedupPending = false
          continue
        }
        dedupPending = false
        section = text
        push('heading', text, { level: Math.min(6, pseudo.level + levelShift) })
        continue
      }
      if (text) dedupPending = false
      push('paragraph', text)
    }
  }

  return blocks
}
