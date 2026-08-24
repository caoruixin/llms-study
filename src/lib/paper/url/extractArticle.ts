import { sanitizeDocxHtml } from '../sanitize'

/**
 * URL 导入的正文抽取：运行时层，浏览器 only（依赖 DOMParser + @mozilla/readability），
 * 本文件不进 vitest——与 parsePdf.ts 同待遇（真实解析靠 codex E2E 环覆盖）。
 * 只有 `decodeHtmlBytes` 是纯函数（不碰 DOM），单独导出给 decodeHtmlBytes.test.ts 覆盖；
 * readability 用**动态 import**，只有真正调用 extractArticle() 时才会被拉取，
 * 因此单测只 import { decodeHtmlBytes } 不会连带把 readability/DOM 依赖拖进 node 环境。
 *
 * 抽取阶梯（§Track 1）：
 *   预处理（删脚本类标签、链接绝对化、图片转文本占位、figcaption 提为段落）
 *   → isProbablyReaderable + Readability
 *   → 都不行时启发式后备（main/article/[role=main] 里取文本最长的一个，先删导航类噪声）
 *   → 正文过短（<200 字符）判定为「依赖脚本渲染，抓不到正文」
 *   → 复用 sanitizeDocxHtml 做最终白名单清洗（与 DOCX 正文同一套信任边界）
 */

export interface ExtractedArticle {
  title: string
  html: string
}

const MIN_ARTICLE_CHARS = 200

// ---------------------------------------------------------------------------
// decodeHtmlBytes：纯函数，字节 → 文本
// ---------------------------------------------------------------------------

/**
 * 字节 → 文本，charset 判定阶梯：HTTP 头 charset 参数 → BOM → 首 1024 字节内的
 * `<meta charset>` / `<meta http-equiv=Content-Type content=...charset=...>` → 默认 utf-8。
 * 非法/不认识的 label 时 `new TextDecoder` 会抛，兜底回退 utf-8 而不是让整次导入失败。
 */
export function decodeHtmlBytes(bytes: ArrayBuffer, contentType: string): string {
  const headerCharset = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim().toLowerCase()

  const head = new Uint8Array(bytes.slice(0, 1024))
  let bomCharset: string | undefined
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    bomCharset = 'utf-8'
  } else if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    bomCharset = 'utf-16le'
  } else if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    bomCharset = 'utf-16be'
  }

  let metaCharset: string | undefined
  if (!headerCharset && !bomCharset) {
    // 只在首 1024 字节里找 meta 声明：charset 声明规范要求出现在文档最前面；
    // 用 latin1 逐字节转字符串足够识别 ASCII 的 <meta ...> 标记本身
    let ascii = ''
    for (let i = 0; i < head.length; i++) ascii += String.fromCharCode(head[i])
    const m =
      /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(ascii) ||
      /<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=["'][^"']*charset=([a-zA-Z0-9._-]+)/i.exec(ascii)
    metaCharset = m?.[1]?.trim().toLowerCase()
  }

  const label = headerCharset || bomCharset || metaCharset || 'utf-8'
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    // 不认识的 label（如上游写错、罕见编码）：不能让整次抓取失败，退回 utf-8 尽力而为
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

// ---------------------------------------------------------------------------
// 预处理 / 启发式后备（碰 DOM，只在 extractArticle 内部调用）
// ---------------------------------------------------------------------------

/** 删脚本类标签 + 链接绝对化 + 图片转文本占位 + figcaption 提为段落。不下载任何外部资源 */
function preprocess(doc: Document, finalUrl: string): void {
  doc.querySelectorAll('script,style,noscript,iframe,svg').forEach((el) => el.remove())

  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')
    if (!href) return
    try {
      a.setAttribute('href', new URL(href, finalUrl).toString())
    } catch {
      a.removeAttribute('href')
    }
  })

  doc.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt')?.trim()
    if (alt) {
      const span = doc.createElement('span')
      span.textContent = `[图: ${alt}]`
      img.replaceWith(span)
    } else {
      img.remove()
    }
  })

  doc.querySelectorAll('figcaption').forEach((cap) => {
    const p = doc.createElement('p')
    p.innerHTML = cap.innerHTML
    cap.replaceWith(p)
  })
}

const NOISE_SELECTOR = 'nav,header,footer,aside,form,[role="navigation"],[aria-hidden="true"],.breadcrumb,.sidebar,.toc'

/** Readability 判定不可读时的后备：main/article/[role=main] 里取纯文本最长的一个 */
function fallbackExtract(doc: Document): string {
  const clone = doc.cloneNode(true) as Document
  clone.querySelectorAll(NOISE_SELECTOR).forEach((el) => el.remove())

  let best: Element | null = null
  let bestLen = 0
  for (const el of clone.querySelectorAll('main,article,[role="main"]')) {
    const len = (el.textContent ?? '').trim().length
    if (len > bestLen) {
      bestLen = len
      best = el
    }
  }
  return best?.innerHTML ?? clone.body?.innerHTML ?? ''
}

function hostnameAndPath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname !== '/' ? `${u.hostname}${u.pathname}` : u.hostname
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// 正文抽取主入口
// ---------------------------------------------------------------------------

export async function extractArticle(input: { html: string; finalUrl: string }): Promise<ExtractedArticle> {
  const doc = new DOMParser().parseFromString(input.html, 'text/html')
  preprocess(doc, input.finalUrl)

  let contentHtml = ''
  let title = ''

  // 动态 import：只有真正抽取网页时才拉取 readability，不进主 chunk
  const { Readability, isProbablyReaderable } = await import('@mozilla/readability')
  if (isProbablyReaderable(doc)) {
    // Readability.parse() 会破坏性地改写传入的 document，克隆一份避免影响后续的启发式后备
    const clone = doc.cloneNode(true) as Document
    const article = new Readability(clone, { keepClasses: false }).parse()
    if (article?.content) {
      contentHtml = article.content
      title = article.title ?? ''
    }
  }

  if (!contentHtml) contentHtml = fallbackExtract(doc)
  if (!title) title = doc.title || doc.querySelector('h1')?.textContent?.trim() || hostnameAndPath(input.finalUrl)

  const cleaned = sanitizeDocxHtml(contentHtml)
  const plainLength = cleaned.replace(/<[^>]+>/g, '').trim().length
  if (plainLength < MIN_ARTICLE_CHARS) {
    throw new Error('页面依赖脚本渲染，无法抓取正文')
  }

  return { title, html: cleaned }
}

/** urlImport.ts 的 deps.extract 直接实现：字节 + content-type → 解码 → 抽取 */
export async function extractFromFetchedHtml(input: {
  bytes: ArrayBuffer
  contentType: string
  finalUrl: string
  url: string
}): Promise<ExtractedArticle> {
  const html = decodeHtmlBytes(input.bytes, input.contentType)
  return extractArticle({ html, finalUrl: input.finalUrl || input.url })
}
