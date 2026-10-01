// @vitest-environment happy-dom
// 只覆盖 extractArticle 的**微信直取路径**：它完全绕过 Readability（动态 import 不触发），
// 因此可以在 happy-dom 下跑；Readability 主路径仍归 codex E2E 环覆盖（见 extractArticle.ts 头注）。
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * happy-dom 兼容性补丁：与 sanitize.test.ts 完全同源（DOMPurify 3.4 依赖
 * Node.prototype.nodeName getter，happy-dom 的基类桩恒返回 ''，不打补丁则白名单全灭）。
 * 补丁必须在 dompurify 模块求值前生效 → 对 ./extractArticle（静态 import ../sanitize）
 * 不做静态 import，一律走 beforeAll 里的动态 import。
 * 同样继承 happy-dom NodeIterator 的已知限制：DOMPurify 删第一个节点后遍历中断，
 * 所以下面的断言只认「段落边界存在」，不断言残留 <section> 是否被完全 unwrap。
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

let extractArticle: (input: { html: string; finalUrl: string }) => Promise<{ title: string; html: string }>
let WEIXIN_BLOCKED_MESSAGE: string

beforeAll(async () => {
  ;({ extractArticle } = await import('./extractArticle'))
  ;({ WEIXIN_BLOCKED_MESSAGE } = await import('./weixin'))
})

const ARTICLE_URL = 'https://mp.weixin.qq.com/s/PY3KJuUyhPdwvCQGOlRvHg'
const CAPTCHA_URL = 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x&target_url=y'

/** 微信文章页形态：#activity-name 标题 + visibility:hidden 的 #js_content + section 排版 */
function weixinPage(jsContent: string, activityName = ' 测试文章标题 '): string {
  return (
    '<html><head><title>doc.title 兜底</title></head><body>' +
    `<h1 class="rich_media_title" id="activity-name">${activityName}</h1>` +
    `<div id="js_content" style="visibility: hidden;">${jsContent}</div>` +
    '</body></html>'
  )
}

describe('extractArticle 微信路径', () => {
  it('finalUrl 是人机验证页 → 直接抛风控提示', async () => {
    await expect(extractArticle({ html: '<p>壳</p>', finalUrl: CAPTCHA_URL })).rejects.toThrow(WEIXIN_BLOCKED_MESSAGE)
  })

  it('标题取自 #activity-name（trim 后），相邻 section 产出各自独立的 <p>', async () => {
    const para1 = '甲'.repeat(120)
    const para2 = '乙'.repeat(120)
    const out = await extractArticle({
      html: weixinPage(`<section>${para1}</section><section>${para2}</section>`),
      finalUrl: ARTICLE_URL,
    })
    expect(out.title).toBe('测试文章标题')
    expect(out.html).toContain(`<p>${para1}</p>`)
    expect(out.html).toContain(`<p>${para2}</p>`)
    // 段界保全的核心断言：两段文字绝不无分隔地拼在一起
    expect(out.html).not.toContain('甲乙')
  })

  it('#activity-name 缺失时标题沿用既有兜底链（doc.title）', async () => {
    const html =
      '<html><head><title>doc.title 兜底</title></head><body>' +
      `<div id="js_content"><section>${'丙'.repeat(240)}</section></div>` +
      '</body></html>'
    const out = await extractArticle({ html, finalUrl: ARTICLE_URL })
    expect(out.title).toBe('doc.title 兜底')
  })

  it('200 状态但无 #js_content（降级壳页）→ 抛风控提示', async () => {
    const html = `<html><body><div>${'壳'.repeat(300)}</div></body></html>`
    await expect(extractArticle({ html, finalUrl: ARTICLE_URL })).rejects.toThrow(WEIXIN_BLOCKED_MESSAGE)
  })

  it('#js_content 存在但正文过短（限流 stub）→ 抛风控提示而非「依赖脚本渲染」', async () => {
    const promise = extractArticle({ html: weixinPage('<section>短</section>'), finalUrl: ARTICLE_URL })
    await expect(promise).rejects.toThrow(WEIXIN_BLOCKED_MESSAGE)
    await expect(promise).rejects.not.toThrow('脚本渲染')
  })
})

/**
 * preprocess 的图片型 object/embed 提升：preprocess 是模块私有函数，借微信直取路径观察
 * （同样不触发 Readability）。Readability 主路径上的同一处理归 codex E2E 环覆盖。
 */
describe('extractArticle 预处理：图片型 object/embed 提升为 img', () => {
  it('<object type="image/svg+xml"> 按 base 绝对化成 https 的 <img> 并包进 <figure>；PDF object 与 1×1 追踪像素不出图', async () => {
    const para = '丁'.repeat(240)
    const out = await extractArticle({
      html: weixinPage(
        `<section>${para}</section>` +
          '<object type="image/svg+xml" data="fig/arch.svg" width="476" height="273"></object>' +
          '<object type="application/pdf" data="paper.pdf"></object>' +
          '<object type="image/svg+xml" data="px.svg" width="1" height="1"></object>',
      ),
      finalUrl: ARTICLE_URL,
    })
    expect(out.html).toContain(`<p>${para}</p>`)
    expect(out.html).toMatch(/<figure><img[^>]*src="https:\/\/mp\.weixin\.qq\.com\/s\/fig\/arch\.svg"/)
    // PDF object 不出图（它本身由 sanitize 的 FORBID 删除——happy-dom 的 NodeIterator 限制见文件头，
    // 这里不断言残留，sanitize.test.ts 已锁住 object 被禁）；1×1 追踪像素由预处理直接删
    expect(out.html.match(/<img\b/g)).toHaveLength(1)
    expect(out.html).not.toContain('px.svg')
  })
})
