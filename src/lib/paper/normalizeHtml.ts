import { detectPseudoHeading, extractBlocks, listItems, tableToText, toText } from './normalizeDocx'
import type { NormalizedBlock, PaperBlockKind } from './types'

/**
 * URL 导入的 HTML → 规范化块。与 normalizeDocxHtml 同构（复用它的块级扫描/去标签/
 * 列表拆分/表格文本化/伪标题识别工具，不迁移不复制），纯函数、不碰 DOM——
 * 与 normalizeDocx.ts 一样可以在 node 环境直接跑 vitest。
 *
 * 与 DOCX 管线的唯一区别在于「多节合并」语义（一节 = 一个 URL 抽取出的正文）：
 * - 单节（单 URL 导入）：原样输出，不下压标题、不合成任何 heading——与 DOCX 行为一致，
 *   这也是为什么单节调用与 normalizeDocxHtml(html) 的输出在 kind/level/text 上完全等价
 *   （唯一区别是 anchor.kind 是 'html' 而不是 'docx'）。
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
  /** 已净化的正文 HTML（调用方负责在这之前完成 sanitizeDocxHtml，本函数不做 XSS 防护） */
  html: string
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

export function normalizeHtmlSections(sections: readonly HtmlSectionInput[]): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = []
  let section = ''
  const multi = sections.length > 1
  const levelShift = multi ? 1 : 0

  const push = (kind: PaperBlockKind, text: string, extra?: { level?: number; html?: string }) => {
    if (!text) return
    const index = blocks.length
    const block: NormalizedBlock = {
      index,
      kind,
      text,
      anchor: { kind: 'html', blockIndex: index, section: section || undefined },
    }
    if (extra?.level !== undefined) block.level = extra.level
    if (extra?.html) block.html = extra.html
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
