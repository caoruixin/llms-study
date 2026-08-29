import DOMPurify from 'dompurify'

/**
 * DOCX → HTML 的白名单清洗（§8：论文正文始终是不可信输入）。
 * 只保留语义结构标签，外部资源（img/svg/iframe/link）与一切脚本执行面全部剥除。
 */
export const DOCX_ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br',
  'strong', 'em', 'b', 'i', 'u', 's', 'sup', 'sub',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'pre', 'code', 'blockquote',
  'a', 'hr', 'span', 'div',
]

/** 属性白名单极窄：on* 事件属性因为不在白名单里而被天然剥除，无需逐个枚举 */
export const DOCX_ALLOWED_ATTR = ['colspan', 'rowspan', 'start', 'href']

/**
 * 非 URI 属性必须显式声明为 URI-safe。
 * DOMPurify 会拿 ALLOWED_URI_REGEXP 去校验**每一个**不在其默认 URI_SAFE_ATTRIBUTES 里的属性值；
 * 我们把该正则收紧成只认 http(s)/mailto/# 之后，colspan="2" 这种纯数字值会校验不过而被静默丢弃。
 * 列在这里表示「这个属性不是 URI，不要拿 URI 规则校验它」——只有 href 需要走 URI 校验。
 */
const URI_SAFE_ATTR = ['colspan', 'rowspan', 'start']

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'img', 'svg', 'math', 'form', 'input']

export function sanitizeDocxHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: DOCX_ALLOWED_TAGS,
    ALLOWED_ATTR: DOCX_ALLOWED_ATTR,
    ADD_URI_SAFE_ATTR: URI_SAFE_ATTR,
    FORBID_TAGS,
    // 不启用 data-* 透传；URI 只允许 http(s) / mailto / 页内锚点，javascript: 与外部资源一律剥离
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  })
}

// ---------------------------------------------------------------------------
// URL 导入（文章）变体：在 DOCX 白名单之上放行远程图片
// ---------------------------------------------------------------------------

/** 文章白名单 = DOCX 白名单 + 图片三件套；svg/math 不扩面（tikz-svg 图已知缺失，公式现状不动） */
export const ARTICLE_ALLOWED_TAGS = [...DOCX_ALLOWED_TAGS, 'img', 'figure', 'figcaption']

export const ARTICLE_ALLOWED_ATTR = [...DOCX_ALLOWED_ATTR, 'src', 'alt']

/**
 * FORBID_TAGS 是配置级优先于 ALLOWED_TAGS 的（DOMPurify 先查 FORBID 再查 ALLOW），
 * 文章变体必须用去掉 img 的 FORBID 列表，否则 ALLOWED_TAGS 里的 img 仍会被剥。
 */
const ARTICLE_FORBID_TAGS = FORBID_TAGS.filter((t) => t !== 'img')

/**
 * src 的 https 收口不能只靠 ALLOWED_URI_REGEXP：DOMPurify 对 img/audio/video 等标签的
 * `data:` src 有**内建豁免**（DEFAULT_DATA_URI_TAGS 含 img，且该分支优先于正则校验，
 * 配置面只有加法的 ADD_DATA_URI_TAGS、没法移除），所以用调用期钩子把非 https 的 src
 * 一律剥掉——与 extractArticle preprocess 的「仅 https 图」协议闸同一口径（javascript:
 * 本就过不了正则，这里是纵深防御 + 封死 data: 豁免）。
 */
const stripNonHttpsSrc = (_node: Node, data: { attrName: string; attrValue: string; keepAttr: boolean }): void => {
  if (data.attrName === 'src' && !/^https:/i.test(data.attrValue.trim())) data.keepAttr = false
}

/**
 * alt 不是 URI 属性，但无需列进 URI_SAFE_ATTR——DOMPurify 的默认 URI_SAFE_ATTRIBUTES
 * 本身就含 alt（ADD_URI_SAFE_ATTR 是加法而非替换），alt="2x" 这类值不会被
 * ALLOWED_URI_REGEXP 误校验剥掉（sanitize.test.ts 有护栏用例）。
 *
 * 钩子只在本函数调用期挂载（finally 摘除）：不污染 sanitizeDocxHtml 的行为
 * （DOCX 白名单本就没有 src，挂着也无副作用，但信任边界各自独立更可审计）。
 */
export function sanitizeArticleHtml(html: string): string {
  DOMPurify.addHook('uponSanitizeAttribute', stripNonHttpsSrc)
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ARTICLE_ALLOWED_TAGS,
      ALLOWED_ATTR: ARTICLE_ALLOWED_ATTR,
      ADD_URI_SAFE_ATTR: URI_SAFE_ATTR,
      FORBID_TAGS: ARTICLE_FORBID_TAGS,
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
    })
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute', stripNonHttpsSrc)
  }
}
