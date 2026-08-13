// @vitest-environment happy-dom
// DOMPurify 需要真实 DOM：这是整个测试树里唯一的 DOM 例外（其余全部是 node 环境纯函数）。
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * happy-dom 兼容性补丁（仅测试环境，生产浏览器无需也不会执行）。
 *
 * DOMPurify 3.4 用 `lookupGetter(Node.prototype, 'nodeName')` 做「realm 无关」的标签名探针。
 * 按 DOM 规范 nodeName 定义在 Node 接口上，真实浏览器里这个 getter 就是权威实现；
 * 而 happy-dom 把 Node.prototype.nodeName 写成恒返回 '' 的基类桩，真正的实现放在
 * Element/Text 等子类上。于是 DOMPurify 读到的每个标签名都是空串 → 全部判为「不在白名单」
 * 而被删除，测试将完全失真。
 *
 * 这里把 Node.prototype.nodeName 改成向子类实现委派，使 happy-dom 在这一点上与规范一致。
 * 补丁必须在 dompurify 模块被求值之前生效，而 ESM 的静态 import 会先于模块体执行——
 * 所以本文件对 ./sanitize **不做任何静态 import**，一律走 beforeAll 里的动态 import。
 */
const baseNodeName = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName')
Object.defineProperty(Node.prototype, 'nodeName', {
  configurable: true,
  get(this: Node) {
    let proto: object | null = Object.getPrototypeOf(this)
    while (proto && proto !== Node.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'nodeName')
      if (desc?.get) return desc.get.call(this)
      proto = Object.getPrototypeOf(proto)
    }
    return baseNodeName?.get?.call(this)
  },
})

/**
 * 已知 happy-dom 限制：其 NodeIterator 未实现规范的 pre-removing steps，
 * DOMPurify 删掉第一个节点后遍历就会中断，同一份 HTML 里的第二个危险节点不会被处理。
 * 因此下面每条用例的输入**只含一个会被删除的元素**——这样走到的是与真实浏览器完全一致的路径。
 * 多危险元素混排的行为归 §11.2 浏览器回归覆盖。
 */
let sanitizeDocxHtml: (html: string) => string
let DOCX_ALLOWED_TAGS: string[]
let DOCX_ALLOWED_ATTR: string[]

beforeAll(async () => {
  ;({ sanitizeDocxHtml, DOCX_ALLOWED_TAGS, DOCX_ALLOWED_ATTR } = await import('./sanitize'))
})

describe('sanitizeDocxHtml', () => {
  it('script 标签连同其正文一并剥除', () => {
    const out = sanitizeDocxHtml('<p>正文</p><script>fetch("//evil")</script>')
    expect(out).toBe('<p>正文</p>')
  })

  it('style 标签连同样式正文一并剥除', () => {
    expect(sanitizeDocxHtml('<style>body{display:none}</style><p>正文</p>')).toBe('<p>正文</p>')
  })

  it('on* 事件属性被属性白名单天然剥除，元素本身保留', () => {
    expect(sanitizeDocxHtml('<p onclick="steal()" onmouseover="x()">正文</p>')).toBe('<p>正文</p>')
  })

  it('javascript: 链接被剥除，http(s) 链接保留', () => {
    expect(sanitizeDocxHtml('<a href="javascript:alert(1)">点我</a>')).toBe('<a>点我</a>')
    expect(sanitizeDocxHtml('<a href="https://example.com">站外</a>')).toBe('<a href="https://example.com">站外</a>')
  })

  it('外部资源标签被剥除：img / iframe / svg（各自单独一份 HTML）', () => {
    expect(sanitizeDocxHtml('<p>A<img src="http://x/y.png" onerror="alert(1)">B</p>')).toBe('<p>AB</p>')
    expect(sanitizeDocxHtml('<p>A<iframe src="http://x"></iframe>B</p>')).toBe('<p>AB</p>')
    expect(sanitizeDocxHtml('<p>A<svg><circle /></svg>B</p>')).toBe('<p>AB</p>')
  })

  it('语义标签与表格结构属性（colspan / rowspan / start）保留', () => {
    // 回归护栏：ALLOWED_URI_REGEXP 收紧后，非 URI 属性必须列进 ADD_URI_SAFE_ATTR，
    // 否则 colspan="2" 会因为「不是合法 URI」被静默丢弃。
    expect(sanitizeDocxHtml('<table><thead><tr><th colspan="2">方法</th></tr></thead></table>')).toBe(
      '<table><thead><tr><th colspan="2">方法</th></tr></thead></table>',
    )
    expect(sanitizeDocxHtml('<table><tbody><tr><td rowspan="3">Ours</td></tr></tbody></table>')).toBe(
      '<table><tbody><tr><td rowspan="3">Ours</td></tr></tbody></table>',
    )
    expect(sanitizeDocxHtml('<ol start="3"><li>x</li></ol>')).toBe('<ol start="3"><li>x</li></ol>')
    expect(sanitizeDocxHtml('<h2>标题</h2><ul><li>项</li></ul><strong>粗</strong><sup>2</sup>')).toBe(
      '<h2>标题</h2><ul><li>项</li></ul><strong>粗</strong><sup>2</sup>',
    )
  })

  it('data-* 属性不透传', () => {
    expect(sanitizeDocxHtml('<p data-x="1">A</p>')).toBe('<p>A</p>')
  })

  it('纯文本与不含危险内容的 HTML 原样通过', () => {
    expect(sanitizeDocxHtml('就是一段纯文本')).toBe('就是一段纯文本')
    expect(sanitizeDocxHtml('<p>普通段落</p>')).toBe('<p>普通段落</p>')
  })

  it('白名单常量本身是收敛的：不含任何脚本/外部资源标签与事件属性', () => {
    for (const bad of ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'img', 'svg', 'math', 'form', 'input']) {
      expect(DOCX_ALLOWED_TAGS).not.toContain(bad)
    }
    expect(DOCX_ALLOWED_ATTR.every((a) => !a.startsWith('on'))).toBe(true)
    expect(DOCX_ALLOWED_ATTR).toEqual(['colspan', 'rowspan', 'start', 'href'])
  })
})
