/**
 * 网页原貌快照的 CSS 字符串改写（纯函数，零 DOM 依赖，node 可测）。
 *
 * 快照把站点样式表整体内联进 `<style>`，中间要做四件事：
 * 1. `absolutizeCssUrls`：相对 URL 相对**样式表自身**的地址解析成绝对 URL（内联后原 base 就没了）；
 * 2. `inlineImports`：把 `@import` 拉平成正文（抓不到的保留绝对形式的 `@import`）；
 * 3. `substituteCssAssets`：已固化成资源的远程 URL 换成 `url("pc-asset:<id>")` 占位；
 * 4. `escapeCssForMarkup`：把 `<` 转义成 `\3c `——DOMPurify 3.4.13 的 SAFE_FOR_XML 探测
 *    （purify.es.mjs:1564，`ELEMENT_MARKUP_PROBE = /<[/\w!]/`）只要发现某元素的 textContent
 *    与 innerHTML 同时含「`<` + 字母/`/`/`!`」就整个删掉；`<style>` 是 raw text 元素，
 *    序列化后两者都是原文，于是任何含 `</style>`、`url(data:image/svg+xml,<svg …>)`
 *    的样式表都会被整块吞掉。CSS 十六进制转义 `\3c ` 在字符串、url() token 里语义等价于 `<`。
 * 阅读器水合时再用 `hydrateCssTokens` 把占位换回 blob: URL。
 *
 * 为什么手写扫描器而不是正则：`url(` 可能出现在注释与字符串里、`@import` 有 url()/字符串两种
 * 写法且可带媒体查询、`@font-face` 里的 `src` 需要与普通 `url()` 区分——这些歧义正则处理不了。
 * 扫描器逐字符走一遍，认注释、认字符串、认块层级，只把「真正的 url token / @import 头」摘出来。
 */

/** CSS 里资源占位的自定义协议（与 2.1 冻结契约一致；DOMPurify 不会碰 `<style>` 文本内容） */
export const CSS_ASSET_SCHEME = 'pc-asset:'

export interface CssRef {
  kind: 'import' | 'url'
  /** 样式表里原样写的目标（已解 CSS 转义，未解引号） */
  raw: string
  /** 相对 baseUrl 解析后的绝对 http(s) URL */
  abs: string
  /** 仅 `@import` 有：跟在目标后面的媒体查询串（`screen and (min-width: 600px)`） */
  media?: string
  /** 仅 `@import` 有：`layer(<name>)` 的层名；匿名 `layer` 为 `''`；没写则无此键 */
  layer?: string
  /** 仅 `@import` 有：`supports(<cond>)` 括号内的条件（`display: grid` / `(a:b) and (c:d)`） */
  supports?: string
  /** 是否位于 `@font-face { src: … }` 内——字体有独立的抓取配额（2.2 item 4） */
  isFont: boolean
}

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

interface ScannedToken {
  kind: 'import' | 'url'
  /** 整条 token 的起止：url token 是 `url(` … `)`；import 是 `@import` … `;` */
  start: number
  end: number
  /** 目标字符串在原文里的起止（**不含**引号），改写时只替换这一段以保留引号风格 */
  targetStart: number
  targetEnd: number
  /** '' 表示无引号 */
  quote: string
  /** 已解 CSS 转义的目标 */
  target: string
  media: string
  /** `@import` 的 `layer` / `layer(<name>)`：null = 没写，'' = 匿名层 */
  layer: string | null
  /** `@import` 的 `supports(<cond>)` 括号内文本；'' = 没写 */
  supports: string
  isFont: boolean
}

const AT_RULE_RE = /@([\w-]+)/y
const URL_FUNC_RE = /url\(/iy
const IDENT_TAIL_RE = /[\w\-\\]/
/** `@import` 目标后的 `layer` / `layer(<name>)`（后面不能紧跟标识符字符，免得吃掉别的词） */
const IMPORT_LAYER_RE = /layer(?:\(\s*([^)]*?)\s*\))?(?![\w-])/iy
const IMPORT_SUPPORTS_RE = /supports\(/iy

/** 跳过一段带转义的字符串字面量，返回收尾引号之后的下标 */
function skipString(css: string, start: number): number {
  const quote = css[start]
  let i = start + 1
  while (i < css.length) {
    const c = css[i]
    if (c === '\\') { i += 2; continue }
    if (c === quote) return i + 1
    // CSS 字符串不能跨行；遇到裸换行按「未闭合」处理，避免把后面整篇 CSS 都当字符串吃掉
    if (c === '\n') return i
    i++
  }
  return i
}

function skipWsAndComments(css: string, start: number): number {
  let i = start
  while (i < css.length) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2)
      i = e < 0 ? css.length : e + 2
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue }
    return i
  }
  return i
}

/** CSS 转义解码：`\3c ` → `<`、`\)` → `)`、行末续行 → 空 */
function unescapeCss(raw: string): string {
  if (!raw.includes('\\')) return raw
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue }
    const hex = /^([0-9a-fA-F]{1,6})[ \t\n\r\f]?/.exec(raw.slice(i + 1, i + 9))
    if (hex) {
      const cp = parseInt(hex[1], 16)
      out += cp === 0 ? '�' : String.fromCodePoint(cp)
      i += hex[0].length
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) break
    if (next !== '\n') out += next
    i += 1
  }
  return out
}

/** 写回目标时的转义：带引号只需转义反斜杠与同名引号；无引号还要转义空白与括号 */
function escapeTarget(value: string, quote: string): string {
  const escaped = value.replace(/\\/g, '\\\\')
  if (quote) return escaped.split(quote).join(`\\${quote}`)
  return escaped.replace(/[()'"\s]/g, (ch) => `\\${ch}`)
}

/**
 * 判断 url token 所在声明是不是 `src:`——`@font-face` 块里只有 src 指向字体文件，
 * 其余（比如 `@font-face` 内联的注释、非法声明）不该被记成字体。
 * 从 token 起点往回找到最近的 `;`/`{`/`}`，那之间就是当前声明的属性名部分。
 */
function declIsFontSrc(css: string, urlStart: number): boolean {
  let j = urlStart - 1
  while (j >= 0 && css[j] !== ';' && css[j] !== '{' && css[j] !== '}') j--
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*)*src\s*:/i.test(css.slice(j + 1, urlStart))
}

/** 解析一个 `url(` … `)`；start 指向 `u`。解析不出闭合括号则返回 null（原文原样保留） */
function parseUrlToken(css: string, start: number, isFont: boolean): ScannedToken | null {
  let i = skipWsAndComments(css, start + 4)
  let quote = ''
  let targetStart = i
  let targetEnd = i
  if (css[i] === '"' || css[i] === "'") {
    quote = css[i]
    targetStart = i + 1
    const after = skipString(css, i)
    targetEnd = css[after - 1] === quote ? after - 1 : after
    i = after
  } else {
    while (i < css.length && css[i] !== ')' && !/\s/.test(css[i])) {
      i += css[i] === '\\' ? 2 : 1
    }
    targetEnd = Math.min(i, css.length)
  }
  const close = css.indexOf(')', i)
  if (close < 0) return null
  return {
    kind: 'url',
    start,
    end: close + 1,
    targetStart,
    targetEnd,
    quote,
    target: unescapeCss(css.slice(targetStart, targetEnd)),
    media: '',
    layer: null,
    supports: '',
    isFont,
  }
}

/** 找到与 `(` 配对的 `)`（认嵌套括号、跳过字符串与转义）；start 指向 `(`；找不到返回 -1 */
function matchParen(css: string, start: number): number {
  let depth = 0
  for (let i = start; i < css.length; i++) {
    const c = css[i]
    if (c === '\\') { i++; continue }
    if (c === '"' || c === "'") { i = skipString(css, i) - 1; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/**
 * 单遍扫描，摘出所有 url token 与 @import 头。
 * 注释、字符串内的 `url(` 一律不算；`@import url(…)` 只产出一个 import token（不重复计 url）。
 */
function scanCss(css: string): ScannedToken[] {
  const tokens: ScannedToken[] = []
  /** 块层级栈：元素是开这层块的 at-rule 名（普通选择器块为 ''） */
  const stack: string[] = []
  let pendingAt = ''
  let i = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2)
      i = e < 0 ? css.length : e + 2
      continue
    }
    // 转义优先于引号：选择器里的 `\'` / `\"` 是**被转义的字符**，不是字符串开头。
    // Tailwind 的任意值工具类（`.bg-\[url\(\'…\'\)\]`）满页都是这种写法，误当字符串会
    // 一路吞到下一个引号，把其后整段样式表（连同 @font-face 与背景图）从扫描结果里抹掉。
    if (c === '\\') { i += 2; continue }
    if (c === '"' || c === "'") { i = skipString(css, i); continue }
    if (c === '{') { stack.push(pendingAt); pendingAt = ''; i++; continue }
    if (c === '}') { stack.pop(); pendingAt = ''; i++; continue }
    if (c === ';') { pendingAt = ''; i++; continue }
    if (c === '@') {
      AT_RULE_RE.lastIndex = i
      const m = AT_RULE_RE.exec(css)
      if (!m) { i++; continue }
      const name = m[1].toLowerCase()
      if (name === 'import') {
        const token = parseImport(css, i)
        if (token) { tokens.push(token); i = token.end; continue }
      }
      pendingAt = name
      i += m[0].length
      continue
    }
    if ((c === 'u' || c === 'U') && !(i > 0 && IDENT_TAIL_RE.test(css[i - 1]))) {
      URL_FUNC_RE.lastIndex = i
      if (URL_FUNC_RE.test(css)) {
        const isFont = stack[stack.length - 1] === 'font-face' && declIsFontSrc(css, i)
        const token = parseUrlToken(css, i, isFont)
        if (token) { tokens.push(token); i = token.end; continue }
        i += 4
        continue
      }
    }
    i++
  }
  return tokens
}

/**
 * 解析 `@import "x.css" screen;` / `@import url(x.css);`；start 指向 `@`。
 * 目标之后按规范顺序认 `[layer | layer(<name>)]? [supports(<cond>)]? <media-list>?`——
 * 三者语义各异（层归属 / 特性条件 / 媒体条件），不能一股脑当媒体查询：`@media layer(theme)`
 * 是非法媒体查询，整张被拉平进来的样式表会被浏览器整块忽略。
 */
function parseImport(css: string, start: number): ScannedToken | null {
  let i = skipWsAndComments(css, start + '@import'.length)
  let quote = ''
  let targetStart = i
  let targetEnd = i
  if (css[i] === '"' || css[i] === "'") {
    quote = css[i]
    targetStart = i + 1
    const after = skipString(css, i)
    targetEnd = css[after - 1] === quote ? after - 1 : after
    i = after
  } else {
    URL_FUNC_RE.lastIndex = i
    if (!URL_FUNC_RE.test(css)) return null
    const inner = parseUrlToken(css, i, false)
    if (!inner) return null
    quote = inner.quote
    targetStart = inner.targetStart
    targetEnd = inner.targetEnd
    i = inner.end
  }
  let k = skipWsAndComments(css, i)
  let layer: string | null = null
  IMPORT_LAYER_RE.lastIndex = k
  const lm = IMPORT_LAYER_RE.exec(css)
  if (lm) {
    layer = lm[1] === undefined ? '' : unescapeCss(lm[1])
    k = skipWsAndComments(css, k + lm[0].length)
  }
  let supports = ''
  IMPORT_SUPPORTS_RE.lastIndex = k
  if (IMPORT_SUPPORTS_RE.test(css)) {
    const open = k + 'supports'.length
    const close = matchParen(css, open)
    if (close > 0) {
      supports = css.slice(open + 1, close).trim()
      k = skipWsAndComments(css, close + 1)
    }
  }
  // 媒体查询 = 余下到 `;` 之间的一切（容错：遇到块开合或 EOF 也收口）
  let end = k
  while (end < css.length && css[end] !== ';' && css[end] !== '{' && css[end] !== '}') end++
  return {
    kind: 'import',
    start,
    end: css[end] === ';' ? end + 1 : end,
    targetStart,
    targetEnd,
    quote,
    target: unescapeCss(css.slice(targetStart, targetEnd)),
    media: css.slice(k, end).trim(),
    layer,
    supports,
    isFont: false,
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/** 这些目标不参与抓取/改写：已自包含（data:/blob:）、页内引用（#soft-shadow）、我们自己的占位 */
function isSkippableTarget(target: string): boolean {
  if (target === '') return true
  const t = target.trim().toLowerCase()
  return t.startsWith('#') || t.startsWith('data:') || t.startsWith('blob:') ||
    t.startsWith('about:') || t.startsWith(CSS_ASSET_SCHEME)
}

/**
 * 只认 http(s) 的绝对化：其余协议（chrome-extension:、mailto:、data: 等）与解析失败一律 null。
 * 样式表 url()、`<link href>`、img/poster 与 svg image 的资源地址都用它——
 * 「能不能交给 fetch-url 代理去抓」的判定只有这一处口径。
 */
export function toHttpUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null
  try {
    const u = new URL(value.trim(), base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * 收集样式表里所有可抓取的外部引用（按文档序，**不去重**——去重与配额归资源计划层）。
 * data:/blob:/#frag/pc-asset:/about: 与非 http(s) 一律跳过。
 */
export function collectCssRefs(css: string, baseUrl: string): CssRef[] {
  const refs: CssRef[] = []
  for (const t of scanCss(css)) {
    if (isSkippableTarget(t.target)) continue
    const abs = toHttpUrl(t.target, baseUrl)
    if (!abs) continue
    refs.push({
      kind: t.kind,
      raw: t.target,
      abs,
      ...(t.kind === 'import' && t.media ? { media: t.media } : {}),
      ...(t.kind === 'import' && t.layer !== null ? { layer: t.layer } : {}),
      ...(t.kind === 'import' && t.supports ? { supports: t.supports } : {}),
      isFont: t.isFont,
    })
  }
  return refs
}

/**
 * 相对 URL → 绝对 URL（`url()` 与 `@import` 都改）。引号风格原样保留；
 * data:/blob:/#frag/pc-asset: 与解析不出 http(s) 的目标不动。
 */
export function absolutizeCssUrls(css: string, baseUrl: string): string {
  const tokens = scanCss(css)
  let out = css
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (isSkippableTarget(t.target)) continue
    const abs = toHttpUrl(t.target, baseUrl)
    if (!abs || abs === css.slice(t.targetStart, t.targetEnd)) continue
    out = out.slice(0, t.targetStart) + escapeTarget(abs, t.quote) + out.slice(t.targetEnd)
  }
  return out
}

/**
 * 把拉平进来的样式表按 `@import` 自带的条件包起来，保住原语义：
 * `@layer <name> { @supports (<cond>) { @media <list> { … } } }`——层在最外（层归属与条件无关，
 * 放外面最直观），条件规则往里嵌，浏览器对嵌套的 @supports/@media 的判定与原 @import 一致。
 */
function wrapImported(t: ScannedToken, text: string): string {
  let body = text
  if (t.media) body = `@media ${t.media} {\n${body}\n}`
  if (t.supports) body = `@supports (${t.supports}) {\n${body}\n}`
  if (t.layer !== null) body = t.layer ? `@layer ${t.layer} {\n${body}\n}` : `@layer {\n${body}\n}`
  return body
}

/**
 * 拉平**一层** `@import`：`resolve(absTarget)` 返回样式文本就替换掉整条 `@import …;`，
 * 带 layer / supports / 媒体查询的按 `wrapImported` 包起来以保语义；返回 null 表示抓不到，
 * 原样留着——连同它的 layer/supports/媒体条件（前置跑过 `absolutizeCssUrls` 的话，留下的就是
 * 绝对形式，阅读器里仍能按需远程加载）。
 *
 * 深度由调用方控制（≤2 层）：对 resolve 回来的文本再调一次本函数即可。被内联进来的文本
 * 必须先由调用方按**它自己的地址**做 absolutizeCssUrls，否则里面的相对 URL 会错基准。
 */
export function inlineImports(css: string, resolve: (abs: string) => string | null): string {
  const tokens = scanCss(css)
  let out = css
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.kind !== 'import' || isSkippableTarget(t.target)) continue
    const text = resolve(t.target)
    if (text === null) continue
    out = out.slice(0, t.start) + wrapImported(t, text) + out.slice(t.end)
  }
  return out
}

/**
 * 已固化的资源换成占位：`url("https://x/y.png")` → `url("pc-asset:<id>")`。
 * 只改 `url()`（`@import` 到这一步应已拉平，抓不到的那些要保持可远程加载的绝对形式）。
 */
export function substituteCssAssets(css: string, tokenFor: (absUrl: string) => string | null): string {
  const tokens = scanCss(css)
  let out = css
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.kind !== 'url' || isSkippableTarget(t.target)) continue
    const id = tokenFor(t.target)
    if (!id) continue
    out = out.slice(0, t.targetStart) + escapeTarget(CSS_ASSET_SCHEME + id, t.quote) + out.slice(t.targetEnd)
  }
  return out
}

/**
 * 阅读器水合：`url("pc-asset:<id>")` → `url("blob:…")`。
 * `urlFor` 返回 null（资源缺失/尚未建 blob）时**原样保留占位**，不写成 `url("")`——
 * 空 URL 会退化成「加载当前文档」的请求，且丢掉了 id 就没法后续补齐。
 */
export function hydrateCssTokens(css: string, urlFor: (id: string) => string | null): string {
  const tokens = scanCss(css)
  let out = css
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.kind !== 'url') continue
    const target = t.target.trim()
    if (!target.toLowerCase().startsWith(CSS_ASSET_SCHEME)) continue
    const url = urlFor(target.slice(CSS_ASSET_SCHEME.length))
    if (!url) continue
    out = out.slice(0, t.targetStart) + escapeTarget(url, t.quote) + out.slice(t.targetEnd)
  }
  return out
}

/**
 * 只对**声明值**跑改写函数，其余一律原样复制：选择器与 at-rule 前置（以 `{` 收尾的段）、
 * at 语句（`@import …;`、`@charset …;`）、字符串、注释、url() token。
 * 段的归属只看收尾符：`{` 收尾是前置；`;` / `}` / EOF 收尾且不以 `@` 开头的是声明，
 * 声明里第一个 `:` 之后才是值。嵌套块（@media/@supports/@layer、CSS nesting）不需要特殊处理——
 * 前置与声明的判定与层级无关；裸声明列表（style 属性）同样适用。
 *
 * 为什么不直接对整段 CSS 跑正则：Tailwind 风格的选择器 `.min-h-\[100dvh\]` 会被改成 `.min-h-\[720px\]`
 * 而不再匹配元素，`url(data:…;base64,…9vh/…)` 里的载荷也会被改坏。
 */
export function rewriteDeclarationValues(css: string, fn: (value: string) => string): string {
  let out = ''
  /** 当前段的片段：verbatim 片段（字符串/注释/url）永远原样，plain 片段收尾时决定要不要过 fn */
  let parts: { text: string; verbatim: boolean }[] = []
  let runStart = 0
  const flushPlain = (upTo: number): void => {
    if (upTo > runStart) parts.push({ text: css.slice(runStart, upTo), verbatim: false })
  }
  const pushVerbatim = (from: number, to: number): void => {
    flushPlain(from)
    parts.push({ text: css.slice(from, to), verbatim: true })
    runStart = to
  }
  const endSegment = (at: number, terminator: string): void => {
    flushPlain(at)
    const lead = parts.find((p) => !p.verbatim)?.text.trimStart() ?? ''
    const isDecl = terminator !== '{' && !lead.startsWith('@')
    let seenColon = false
    for (const p of parts) {
      if (p.verbatim || !isDecl) { out += p.text; continue }
      if (seenColon) { out += fn(p.text); continue }
      const idx = p.text.indexOf(':')
      if (idx < 0) { out += p.text; continue }
      seenColon = true
      out += p.text.slice(0, idx + 1) + fn(p.text.slice(idx + 1))
    }
    parts = []
  }
  let i = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2)
      const end = e < 0 ? css.length : e + 2
      pushVerbatim(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      const end = skipString(css, i)
      pushVerbatim(i, end)
      i = end
      continue
    }
    if ((c === 'u' || c === 'U') && !(i > 0 && IDENT_TAIL_RE.test(css[i - 1]))) {
      URL_FUNC_RE.lastIndex = i
      if (URL_FUNC_RE.test(css)) {
        const token = parseUrlToken(css, i, false)
        if (token) {
          pushVerbatim(i, token.end)
          i = token.end
          continue
        }
      }
    }
    if (c === '{' || c === ';' || c === '}') {
      endSegment(i, c)
      out += c
      i++
      runStart = i
      continue
    }
    i++
  }
  endSegment(css.length, '')
  return out
}

/**
 * `<` → `\3c `（十六进制转义 + 一个终止空格），让样式表能安全地待在 `<style>` 里穿过 DOMPurify。
 * 见文件头注：SAFE_FOR_XML 的标记探测会把含裸 `<` 的整个 `<style>` 删掉。
 *
 * 语义等价：CSS 词法层面 `\3c ` 在字符串、url token、标识符里都解码为 `<`
 * （`content:"\3c "` 仍渲染 `<`，`url(data:image/svg+xml,\3c svg …)` 仍是同一个 data URI）。
 * 已经写成 `\<` 的（同样是「字面量 `<`」）一并归一成 `\3c `——留着 `\<` 里的裸 `<` 照样会被探测到。
 */
export function escapeCssForMarkup(css: string): string {
  if (!css.includes('<')) return css
  let out = ''
  let backslashes = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '\\') { backslashes++; continue }
    if (ch === '<') {
      // 前面反斜杠为奇数个 ⇒ 最后一个是转义这个 `<` 的，丢掉它，统一用 \3c 表达
      out += '\\'.repeat(backslashes - (backslashes % 2)) + '\\3c '
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  return out + '\\'.repeat(backslashes)
}
