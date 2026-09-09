import DOMPurify, { type Config, type DOMPurify as DOMPurifyApi, type UponSanitizeAttributeHook } from 'dompurify'

/**
 * 「网页原貌」快照专用的 DOMPurify profile（PLAN-web-snapshot-sync §2.2 item 5）。
 *
 * 与 `../sanitize.ts` 的两个 profile 是**相反方向**的取舍：那两个是极窄白名单（只留语义标签），
 * 这里要尽量保住站点原样——`<style>`、内联 `<svg>`、MathML、MathJax 的 `mjx-*` 自定义元素、
 * `button/details/picture`、`style` 属性、`data-pc-*` 打标全部保留，只砍掉脚本执行面与外链装载面。
 *
 * 实例化 `DOMPurify(window)` 而不是复用默认单例：`sanitize.ts:77-89` 会在调用期往**全局单例**挂
 * `uponSanitizeAttribute` 钩子，两边共用会串味（本 profile 的钩子是常驻的，挂到全局单例上会
 * 反过来污染 DOCX/文章清洗）。惰性创建是因为 happy-dom 下 `window` 要等测试环境装好才存在。
 *
 * 边界说明：
 * - `foreignObject` 保持禁止（svgDisallowed 默认成员，且我们没加进 ADD_TAGS）——它能把 HTML
 *   重新塞进 SVG 命名空间，是经典 mXSS 面；代价是极少数站点的 SVG 内嵌 HTML 会丢。
 * - MathML 的 `annotation` / `annotation-xml` **不在这里处理**：它们是 DOMPurify 默认就禁的标签，
 *   而 KEEP_CONTENT 会把 `annotation` 里的 TeX 源码提升成可见文本，所以删除动作放在
 *   `captureStatic.ts` 的 preprocess 里（连元素带内容一起删），本模块只是兜底。
 * - `<style>` 里的 CSS 必须先过 `cssRewrite.ts` 的 `escapeCssForMarkup`：DOMPurify 3.4.13 的
 *   SAFE_FOR_XML 探测（purify.es.mjs:1564）会把含裸 `<` 的整个 `<style>` 删掉。
 */

/** 脚本执行面 + 外链装载面 + 表单面：这些标签一律删（配置级优先于 ALLOWED_TAGS） */
export const FIDELITY_FORBID_TAGS = [
  'script', 'noscript', 'iframe', 'object', 'embed', 'template',
  'form', 'input', 'textarea', 'select', 'option',
  'link', 'meta', 'base',
  'video', 'audio', 'source', 'track', 'canvas',
]

/**
 * `srcset/sizes` 在预处理阶段就已经被 `img.src := currentSrc` 取代（快照只固化一张实际显示的图），
 * 留着只会让阅读器 iframe 去联外网；`integrity/crossorigin/ping/formaction/autofocus` 是装载与
 * 副作用面。
 */
export const FIDELITY_FORBID_ATTR = ['integrity', 'crossorigin', 'srcset', 'sizes', 'ping', 'formaction', 'autofocus']

/**
 * 计划原文写的是 `ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i`。**只用这一条会毁掉原貌**：
 * DOMPurify 拿 ALLOWED_URI_REGEXP 去校验每一个不在 DEFAULT_URI_SAFE_ATTRIBUTES
 * （purify.es.mjs:682，只有 alt/class/for/id/label/name/pattern/placeholder/role/summary/title/
 * value/style/xmlns）里的属性值——实测（fidelitySanitize.test.ts 有护栏用例）会连带剥掉
 * `colspan="2"`、`width="300"`、`viewBox`、`d="M0 0L10 10"`、`fill="red"`、`media="screen"`、
 * `lang/dir`、`loading="lazy"`、`type="button"`……SVG 直接变空白。`sanitize.ts:20-26` 当年用
 * `ADD_URI_SAFE_ATTR` 只补了 colspan/rowspan/start，本 profile 白名单是 DOMPurify 全量默认
 * （html+svg+mathMl 三百多个属性），逐个枚举既不可维护、写错一个 URL 属性还会开洞。
 *
 * 所以把正则扩成 DOMPurify 默认正则同款语义、但协议集收窄：
 *   「http(s)/mailto/tel/页内锚点」**或**「压根不带协议的值」。
 * 带协议的一切（javascript:/vbscript:/data:/blob:/ftp:/intent: …）一律不过——
 * 校验前 DOMPurify 会先剥掉值里的空白与控制字符（ATTR_WHITESPACE），`java\nscript:` 这类混淆
 * 同样落到「带协议」分支被拒。真正承载 URL 的属性另由下面的钩子按计划原文的窄协议集收口，
 * 所以「不带协议」这条放宽只影响非 URL 属性（`red`、`0 0 10 10`、`M0 0L10 10`）。
 */
export const FIDELITY_URI_REGEXP = /^(?:https?:|mailto:|tel:|#)|^(?![a-z][a-z0-9+.\-]*:)/i

/** 计划原文的窄协议集：URL 属性只认这四种 */
const NARROW_URI = /^(?:https?:|mailto:|tel:|#)/i

/**
 * 值是 URL 的属性——这些必须逐个按窄协议集收口（正则那条对它们只是第一道闸）。
 * 漏列一个的后果只是「相对 URL 也被放行」（阅读器 iframe 里 CSP `default-src 'none'`，
 * 解析不出东西），不是执行面：带协议的值早在 FIDELITY_URI_REGEXP 那步就被拒了。
 */
const URL_ATTR = new Set([
  'href', 'xlink:href', 'src', 'poster', 'cite', 'action', 'formaction',
  'background', 'data', 'usemap', 'longdesc', 'ping', 'srcset',
  'manifest', 'profile', 'codebase', 'archive', 'patchsrc',
])

/** data: 图片是自包含的，保留（与 DOMPurify 自己的 DATA_URI_TAGS 豁免同口径，purify.es.mjs:679） */
const DATA_IMAGE = /^data:image\//i
const DATA_IMAGE_TAGS = new Set(['img', 'image'])

/** `expression()` 是 IE 老式脚本面，`url(javascript:)` 在部分引擎的 CSS 装载上下文里仍可执行 */
const DANGEROUS_STYLE = /expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i

/**
 * 常驻钩子（挂在本模块私有实例上）：
 * 1. `use` 只准引用文档内锚点（`#icon`）——跨站 sprite 会让阅读器 iframe 去联外网，
 *    而 `use` 本身是 svgDisallowed 成员，我们用 ADD_TAGS 放进来就得自己收口；
 * 2. `style` 属性里的 `expression(` / `url(javascript:` 一律剥（`style` 在 DOMPurify 的
 *    DEFAULT_URI_SAFE_ATTRIBUTES 里，值不会被任何正则校验）；
 * 3. URL 属性按窄协议集收口。
 *
 * `a[href="javascript:…"]` 不用在这里处理：ALLOWED_URI_REGEXP 已经拒掉（实测 href 被剥、
 * `<a>` 元素保留），这里只是顺带覆盖同一条路径。
 */
const enforceFidelityAttr: UponSanitizeAttributeHook = (node, data) => {
  const name = data.attrName
  const value = data.attrValue.trim()
  if (name === 'style') {
    if (DANGEROUS_STYLE.test(value)) data.keepAttr = false
    return
  }
  if (!URL_ATTR.has(name)) return
  const tag = node.nodeName.toLowerCase()
  if (tag === 'use') {
    if (!value.startsWith('#')) data.keepAttr = false
    return
  }
  if (NARROW_URI.test(value)) return
  if (DATA_IMAGE_TAGS.has(tag) && DATA_IMAGE.test(value)) return
  data.keepAttr = false
}

const FIDELITY_CONFIG: Config = {
  // 输入是 documentElement.outerHTML，要整篇进出（html/head/body 会被自动加进白名单，purify.es.mjs:870）
  WHOLE_DOCUMENT: true,
  // 不覆盖 ALLOWED_TAGS/ALLOWED_ATTR：默认集 = html + svg + svgFilters + mathMl，
  // 已含 style/button/details/summary/picture 与整套 SVG/MathML（purify.es.mjs:547,550）
  ADD_TAGS: ['use'],
  FORBID_TAGS: FIDELITY_FORBID_TAGS,
  FORBID_ATTR: FIDELITY_FORBID_ATTR,
  // MathJax CHTML 输出：mjx-container[jax][display]、mjx-c[class]、mjx-assistive-mml…
  // 命中 tagNameCheck 的自定义元素，其「不在白名单里」的属性名只走 attributeNameCheck，
  // **不再校验值**（purify.es.mjs:1844-1856 的 else-if 链：自定义元素分支与 URI 值校验分支互斥），
  // 所以 jax="CHTML" 能原样留下；反过来 display 因为在 mathMl 属性白名单里会走值校验。
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: /^mjx-/,
    attributeNameCheck: /^(?!on)[\w-]+$/i,
    allowCustomizedBuiltInElements: false,
  },
  ALLOWED_URI_REGEXP: FIDELITY_URI_REGEXP,
  // data-pc-block / data-pc-asset / data-pc-sheet … 靠默认放行（ALLOW_DATA_ATTR 默认 true）
}

let instance: DOMPurifyApi | null = null

function getInstance(): DOMPurifyApi {
  if (!instance) {
    instance = DOMPurify(window)
    instance.addHook('uponSanitizeAttribute', enforceFidelityAttr)
  }
  return instance
}

/**
 * 清洗整篇快照文档。
 * @param documentHtml `documentElement.outerHTML`（不含 doctype）
 * @returns 以 `<html` 开头的清洗后文档串；水合时由阅读器补 `<!DOCTYPE html>`
 */
export function sanitizeFidelityDocumentHtml(documentHtml: string): string {
  return getInstance().sanitize(documentHtml, FIDELITY_CONFIG)
}
