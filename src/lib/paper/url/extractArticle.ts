import { sanitizeArticleHtml } from '../sanitize'
import { paragraphizeHtml } from './paragraphize'
import { WEIXIN_BLOCKED_MESSAGE, isWeixinArticleUrl, isWeixinCaptchaUrl } from './weixin'

/**
 * URL 导入的正文抽取：运行时层，浏览器 only（依赖 DOMParser + @mozilla/readability）。
 * Readability 主路径不进 vitest——与 parsePdf.ts 同待遇（真实解析靠 codex E2E 环覆盖）；
 * 微信直取路径不经 Readability，由 extractArticle.weixin.test.ts 在 happy-dom 下覆盖。
 * `decodeHtmlBytes` 是纯函数（不碰 DOM），单独导出给 decodeHtmlBytes.test.ts 覆盖；
 * readability 用**动态 import**，只有真正走 Readability 分支时才会被拉取，
 * 因此单测只 import { decodeHtmlBytes } 不会连带把 readability/DOM 依赖拖进 node 环境。
 *
 * 抽取阶梯（§Track 1）：
 *   finalUrl 是微信验证页（wappoc_appmsgcaptcha）→ 直接抛风控提示
 *   → 预处理（删脚本类标签、链接/图片绝对化、图片包 figure 规整；保不住的图降级为文本占位）
 *   → 微信文章页直取 #js_content（其 visibility:hidden 会被 Readability 整体丢弃，必须绕过）
 *   → 否则 isProbablyReaderable + Readability
 *   → 都不行时启发式后备（main/article/[role=main] 里取文本最长的一个，先删导航类噪声）
 *   → paragraphizeHtml 把容器内散落文本包进 <p>（必须在 sanitize 前固化段落边界）
 *   → sanitizeArticleHtml 做最终白名单清洗（DOCX 白名单 + img/figure/figcaption，见 sanitize.ts）
 *   → 正文过短（<200 字符）判定为「依赖脚本渲染，抓不到正文」（微信改抛风控提示）
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

/** 删脚本类标签 + 链接/图片绝对化 + 图片包 figure 规整。不下载任何外部资源 */
function preprocess(doc: Document, finalUrl: string): void {
  // svg 照删：tikz-svg 图已知缺失，本期只处理 img（ar5iv 公式主体是 MathML，math 由 sanitize FORBID，公式现状不变）
  doc.querySelectorAll('script,style,noscript,iframe,svg').forEach((el) => el.remove())

  // 解析基准：文档内 <base href>（相对 finalUrl 解析）→ 否则 finalUrl。
  // 陷阱：arxiv HTML 的图片是相对路径（x1.png），new URL('x1.png', finalUrl) 会丢 URL 末段，
  // 必须尊重文档内 <base href>；DOMParser 产出的 doc.baseURI 不反映它，须手动查。
  let base = finalUrl
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href')
  if (baseHref) {
    try {
      base = new URL(baseHref, finalUrl).toString()
    } catch {
      // 非法 <base href>：忽略，退回 finalUrl
    }
  }

  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')
    if (!href) return
    try {
      a.setAttribute('href', new URL(href, base).toString())
    } catch {
      a.removeAttribute('href')
    }
  })

  doc.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt')?.trim()
    /** 保不住的图按旧逻辑降级：有 alt 换成文本占位，无 alt 直接删 */
    const degrade = (): void => {
      if (alt) {
        const span = doc.createElement('span')
        span.textContent = `[图: ${alt}]`
        img.replaceWith(span)
      } else {
        img.remove()
      }
    }

    // src 缺失试 data-src（懒加载兜底），仍无 → 降级
    const rawSrc = img.getAttribute('src') || img.getAttribute('data-src')
    if (!rawSrc) return degrade()
    let abs: URL
    try {
      abs = new URL(rawSrc, base)
    } catch {
      return degrade()
    }
    // 只保留 https 图（http 图在 https 站内是混合内容，浏览器会拦；其余协议不该出现）
    if (abs.protocol !== 'https:') return degrade()

    img.setAttribute('src', abs.toString())
    // srcset/sizes 不进白名单也不想让浏览器另选源：显式移除，src 是唯一事实
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')

    // 无 figure 祖先的图包一层 <figure>，让 normalizeHtml 的 figure 分支统一接住
    let fig = img.closest('figure')
    if (!fig) {
      fig = doc.createElement('figure')
      img.replaceWith(fig)
      fig.appendChild(img)
    }
    // figure 是块级元素，不能留在 <p> 里（extractBlocks 只扫顶层块）：
    // 逐层移到最近 <p> 祖先之后，循环处理直到无 p 祖先（DOM 操作可造出嵌套 p）
    for (let p = fig.closest('p'); p; p = fig.closest('p')) {
      // afterend 需要 p 有父节点；万一 p 已游离（返回 null），停止避免死循环
      if (!p.insertAdjacentElement('afterend', fig)) break
    }
  })
  // figcaption 不再提为段落：它进了文章白名单，保持与 figure 的关联（normalizeHtml 落为 caption 块）
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
  // 服务端代理会跟随微信风控的 302 → 人机验证页，x-fetch-final-url 带回的 finalUrl 会暴露它
  if (isWeixinCaptchaUrl(input.finalUrl)) throw new Error(WEIXIN_BLOCKED_MESSAGE)

  const doc = new DOMParser().parseFromString(input.html, 'text/html')
  preprocess(doc, input.finalUrl)

  let contentHtml = ''
  let title = ''

  // 微信正文 #js_content 自带 style="visibility:hidden"（靠 JS 显示），Readability 的
  // _isProbablyVisible 会把它整体丢弃 → 直取绕过。必须在 preprocess 之后：
  // data-src 懒加载图此时已提升为 src 并包好 figure。style 属性不在文章白名单，sanitize 兜底剥除。
  if (isWeixinArticleUrl(input.finalUrl)) {
    const root = doc.querySelector('#js_content')
    // 200 状态但没有正文容器：被微信降级成 stub/验证壳页
    if (!root) throw new Error(WEIXIN_BLOCKED_MESSAGE)
    contentHtml = root.innerHTML
    title = doc.querySelector('#activity-name')?.textContent?.trim() ?? ''
  }

  if (!contentHtml) {
    // 动态 import：只有真正走 Readability 分支才拉取，不进主 chunk（微信直取路径完全跳过）
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
  }

  if (!contentHtml) contentHtml = fallbackExtract(doc)
  if (!title) title = doc.title || doc.querySelector('h1')?.textContent?.trim() || hostnameAndPath(input.finalUrl)

  // paragraphize 必须在 sanitize 之前：DOMPurify unwrap <section> 时文本无分隔符直接拼接，
  // 段落边界一旦丢失不可恢复（中文尤甚）。Readability 输出本就是 <p> 结构 → 近似 no-op。
  const cleaned = sanitizeArticleHtml(paragraphizeHtml(contentHtml))
  const plainLength = cleaned.replace(/<[^>]+>/g, '').trim().length
  if (plainLength < MIN_ARTICLE_CHARS) {
    // 微信被限流后可能返回 200 + 残缺 stub（空/近空的 #js_content）：给可行动的风控提示，
    // 而不是误导性的「依赖脚本渲染」
    if (isWeixinArticleUrl(input.finalUrl)) throw new Error(WEIXIN_BLOCKED_MESSAGE)
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
