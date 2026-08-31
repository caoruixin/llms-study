// @vitest-environment happy-dom
// paragraphizeHtml 依赖 DOMParser：仿 sanitize.test.ts 用 happy-dom（不涉及 DOMPurify，无需补丁）。
import { describe, expect, it } from 'vitest'
import { paragraphizeHtml } from './paragraphize'

describe('paragraphizeHtml', () => {
  it('section 内裸文本被包进 <p>', () => {
    expect(paragraphizeHtml('<section>正文一段</section>')).toBe('<section><p>正文一段</p></section>')
  })

  it('相邻 section 各自成段：unwrap 后仍是两个独立段落（段界保全的核心保证）', () => {
    expect(paragraphizeHtml('<section>甲</section><section>乙</section>')).toBe(
      '<section><p>甲</p></section><section><p>乙</p></section>',
    )
  })

  it('混合容器：只包散落 run，既有 <p> 不动且保序', () => {
    expect(paragraphizeHtml('<div>开头散文本<p>已有段落</p>结尾散文本</div>')).toBe(
      '<div><p>开头散文本</p><p>已有段落</p><p>结尾散文本</p></div>',
    )
  })

  it('嵌套 section > section：内外层都被处理', () => {
    expect(paragraphizeHtml('<section>外层文本<section>内层文本</section></section>')).toBe(
      '<section><p>外层文本</p><section><p>内层文本</p></section></section>',
    )
  })

  it('纯空白 run 不动，不制造空 <p>', () => {
    const html = '<section>  \n  </section><div><p>甲</p>\n<p>乙</p></div>'
    expect(paragraphizeHtml(html)).toBe(html)
  })

  it('连续行内元素合为一个 run，只包一个 <p>', () => {
    expect(paragraphizeHtml('<section><span>a</span><strong>b</strong></section>')).toBe(
      '<section><p><span>a</span><strong>b</strong></p></section>',
    )
  })

  it('body 顶层的散落文本同样被包段', () => {
    expect(paragraphizeHtml('顶层散文本<p>段落</p>')).toBe('<p>顶层散文本</p><p>段落</p>')
  })

  it('已干净的 p/heading 结构原样通过（arxiv 形态守护）', () => {
    const html =
      '<h1>标题</h1><p>第一段</p><h2>小节</h2><p>第二段</p><figure><img src="https://x.org/a.png"><figcaption>图注</figcaption></figure><ul><li>项</li></ul><blockquote><p>引文</p></blockquote>'
    expect(paragraphizeHtml(html)).toBe(html)
  })
})
