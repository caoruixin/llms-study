import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import QuoteBlock, { isQuoteExpandable, quoteLocation } from './CopilotQuote'

/** 引用块的静态渲染（node，renderToStaticMarkup）：折叠、徽章、位置标签、回跳按钮的出现条件 */

const anchor = { kind: 'pdf', blockIndex: 3, page: 7, section: '4.2 Method' } as const

describe('QuoteBlock', () => {
  it('默认 line-clamp-3；短引用没有展开按钮', () => {
    const html = renderToStaticMarkup(createElement(QuoteBlock, { quote: { text: '短引用', anchor } }))
    expect(html).toContain('data-copilot-quote')
    expect(html).toContain('line-clamp-3')
    expect(html).toContain('短引用')
    expect(html).not.toContain('展开')
  })

  it('位置标签 §section · p.N；译文徽章只在 translated 时出', () => {
    const html = renderToStaticMarkup(createElement(QuoteBlock, { quote: { text: 't', anchor, translated: true } }))
    expect(html).toContain('§4.2 Method · p.7')
    expect(html).toContain('译文')
    const plain = renderToStaticMarkup(createElement(QuoteBlock, { quote: { text: 't', anchor } }))
    expect(plain).not.toContain('译文')
  })

  it('无 onJump 不出「回到原文」；有 onJump 才出', () => {
    const without = renderToStaticMarkup(createElement(QuoteBlock, { quote: { text: 't', anchor } }))
    expect(without).not.toContain('回到原文')
    expect(without).not.toContain('<button')
    const withJump = renderToStaticMarkup(createElement(QuoteBlock, { quote: { text: 't', anchor }, onJump: () => undefined }))
    expect(withJump).toContain('回到原文 ↗')
  })

  it('长引用 / 多行引用出「展开 ▾」，且按钮与回跳按钮互为兄弟（不嵌套）', () => {
    const html = renderToStaticMarkup(
      createElement(QuoteBlock, { quote: { text: 'x'.repeat(200), anchor }, onJump: () => undefined }),
    )
    expect(html).toContain('展开 ▾')
    // 两个按钮之间没有未闭合的 <button>：每个 <button 都紧跟自己的 </button>
    const opens = html.match(/<button/g)?.length ?? 0
    const closes = html.match(/<\/button>/g)?.length ?? 0
    expect(opens).toBe(2)
    expect(closes).toBe(2)
    expect(html).not.toMatch(/<button[^>]*>[^<]*<button/)
  })

  it('无锚点时没有位置标签；className 追加到根节点', () => {
    const html = renderToStaticMarkup(createElement(QuoteBlock, { quote: { text: 't' }, className: 'mb-1' }))
    expect(html).not.toContain('§')
    expect(html).not.toContain('p.')
    expect(html).toContain('mb-1')
  })
})

describe('纯函数', () => {
  it('isQuoteExpandable：>160 字或含换行', () => {
    expect(isQuoteExpandable('短')).toBe(false)
    expect(isQuoteExpandable('a\nb')).toBe(true)
    expect(isQuoteExpandable('x'.repeat(161))).toBe(true)
    expect(isQuoteExpandable('x'.repeat(160))).toBe(false)
  })

  it('quoteLocation：只有页 / 只有节 / 都没有', () => {
    expect(quoteLocation({ kind: 'pdf', blockIndex: 1, page: 3 })).toBe('p.3')
    expect(quoteLocation({ kind: 'docx', blockIndex: 1, section: 'Intro' })).toBe('§Intro')
    expect(quoteLocation({ kind: 'docx', blockIndex: 1 })).toBe('')
    expect(quoteLocation(undefined)).toBe('')
  })
})
