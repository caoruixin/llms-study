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
