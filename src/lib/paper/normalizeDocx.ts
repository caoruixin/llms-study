import type { NormalizedBlock, PaperBlockKind } from './types'

/**
 * DOCX（Mammoth 产出的 HTML）→ 规范化块。手写正则驱动的块级切分，
 * 风格与 grading.ts 的手写解析一致：零依赖、不碰 DOM，因此可直接进 node 单测。
 *
 * 纵深防御：即使有恶意标签绕过了 sanitizeDocxHtml，这里去标签后只剩纯文本，
 * 不会有任何可执行标记进入 IndexedDB 或渲染层。
 */

const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'table', 'pre', 'blockquote'])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', hellip: '…', mdash: '—', ndash: '–',
}

/** 实体解码在「去标签之后」执行：`&lt;script&gt;` 只会还原成普通文本，不会变回可执行标记 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? full
  })
}

/** script / style 连同其文本内容整段丢弃——否则去标签后脚本正文会作为「文本」留下来 */
const dropDangerous = (html: string): string =>
  html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')

/** 去标签 → 解码实体 → 空白规整。<br> 视作空格，其余内联标签直接抹掉（中文不会被插入多余空格） */
function toText(html: string): string {
  const withBreaks = dropDangerous(html).replace(/<br\s*\/?>/gi, ' ')
  const stripped = withBreaks.replace(/<[^>]*>/g, '')
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim()
}

interface RawBlock {
  tag: string
  inner: string
}

/**
 * 顶层块级元素扫描（带同名标签深度计数，支持嵌套列表）。
 * 遇到非块级容器（如 mammoth 偶尔产出的包裹 div）会继续向内扫描。
 */
function extractBlocks(html: string): RawBlock[] {
  const out: RawBlock[] = []
  const openTag = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g
  let i = 0

  while (i < html.length) {
    openTag.lastIndex = i
    const m = openTag.exec(html)
    if (!m) break

    const tag = m[1].toLowerCase()
    const contentStart = m.index + m[0].length
    if (!BLOCK_TAGS.has(tag)) {
      i = contentStart
      continue
    }

    const pair = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi')
    pair.lastIndex = m.index
    let depth = 0
    let closeStart = -1
    let closeEnd = -1
    let mm: RegExpExecArray | null
    while ((mm = pair.exec(html)) !== null) {
      if (mm[0][1] === '/') {
        depth--
        if (depth === 0) {
          closeStart = mm.index
          closeEnd = mm.index + mm[0].length
          break
        }
      } else {
        depth++
      }
    }

    if (closeStart === -1) {
      // 未闭合标签：把剩余内容整体作为该块，避免丢正文
      out.push({ tag, inner: html.slice(contentStart) })
      break
    }
    out.push({ tag, inner: html.slice(contentStart, closeStart) })
    i = closeEnd
  }
  return out
}

/** 拆 <li>：嵌套列表的子项会被外层 li 的 inner 一并带出，toText 后仍是可读文本 */
function listItems(inner: string): string[] {
  const items: string[] = []
  const re = /<li\b[^>]*>([\s\S]*?)(?=<li\b|<\/(?:ul|ol)\s*>|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    const text = toText(m[1].replace(/<\/li\s*>\s*$/i, ''))
    if (text) items.push(text)
  }
  return items
}

/** 表格文本化：单元格用 ` | ` 连接、行用换行连接，供检索与纯文本预览使用 */
function tableToText(inner: string): string {
  const rows: string[] = []
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi
  let r: RegExpExecArray | null
  while ((r = trRe.exec(inner)) !== null) {
    const cells: string[] = []
    const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
    let c: RegExpExecArray | null
    while ((c = cellRe.exec(r[1])) !== null) cells.push(toText(c[2]))
    if (cells.some((x) => x)) rows.push(cells.join(' | '))
  }
  return rows.join('\n')
}

export function normalizeDocxHtml(html: string): NormalizedBlock[] {
  const raw = extractBlocks(html)
  const blocks: NormalizedBlock[] = []
  let section = ''

  const push = (kind: PaperBlockKind, text: string, extra?: { level?: number; html?: string }) => {
    if (!text) return // 空块（例如只含被剥掉的图片的段落）直接跳过
    const index = blocks.length
    const block: NormalizedBlock = {
      index,
      kind,
      text,
      anchor: { kind: 'docx', blockIndex: index, section: section || undefined },
    }
    if (extra?.level !== undefined) block.level = extra.level
    if (extra?.html) block.html = extra.html
    blocks.push(block)
  }

  for (const b of raw) {
    switch (b.tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = toText(b.inner)
        if (!text) break
        // section 先于 push 更新：标题块自身的 anchor.section 就是它自己
        section = text
        push('heading', text, { level: Number(b.tag[1]) })
        break
      }
      case 'ul':
      case 'ol':
        for (const item of listItems(b.inner)) push('list', item)
        break
      case 'table': {
        const text = tableToText(b.inner)
        // 表格保留清洗后的 html，Phase 2 的预览可直接渲染结构
        push('table', text, { html: `<table>${b.inner}</table>` })
        break
      }
      case 'pre':
        push('code', toText(b.inner))
        break
      default:
        push('paragraph', toText(b.inner))
        break
    }
  }

  return blocks
}
