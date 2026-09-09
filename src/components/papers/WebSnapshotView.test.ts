import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import WebSnapshotView from './WebSnapshotView'
import { encodeWebSnapshot } from '../../lib/paper/url/webSnapshot'

/**
 * 安全护栏（node 环境，renderToStaticMarkup——effect 不跑，blob/iframe 都不会被触碰）：
 * 网页原貌 iframe 的 sandbox 必须**恰好**是 allow-same-origin。同源沙箱一旦再加 allow-scripts，
 * 页面脚本就能摘掉自己的沙箱——这是整个原貌视图的安全底线，任何人改动都要先撞到这里。
 */

const fixtureBytes = () =>
  encodeWebSnapshot({
    header: {
      url: 'https://a.com',
      finalUrl: 'https://a.com/final',
      title: 'A',
      capture: { mode: 'static', katex: false, viewportWidth: 1280, agentVersion: 1 },
      html: '<html><head></head><body><p data-pc-block="0">hi</p></body></html>',
      blocks: [{ index: 0, kind: 'paragraph', text: 'hi', anchor: { kind: 'html', blockIndex: 0 } }],
      stats: { assetBytes: 0, skipped: [] },
    },
    assets: [],
  }).bytes

const noop = () => undefined

function render(bytes: ArrayBuffer): string {
  return renderToStaticMarkup(
    createElement(WebSnapshotView as never, { bytes, blocks: [], containerRef: { current: null }, onVisibleBlock: noop }),
  )
}

describe('WebSnapshotView 安全护栏', () => {
  it('iframe sandbox 恰为 allow-same-origin，referrerpolicy=no-referrer，不内滚', () => {
    const html = render(fixtureBytes())
    const sandbox = html.match(/sandbox="([^"]*)"/)
    expect(sandbox?.[1]).toBe('allow-same-origin')
    expect(html).not.toContain('allow-scripts')
    // React 18 按 camelCase 输出 referrerPolicy；HTML 属性名不分大小写，按不分大小写断言
    expect(html).toMatch(/referrerpolicy="no-referrer"/i)
    expect(html).toContain('scrolling="no"')
    expect(html).toContain('title="网页原貌"')
    // srcdoc 由 effect 里的 blob 水合后才赋值：首次渲染不带 srcdoc（不会在 SSR/首帧就加载站点内容）
    expect(html).not.toContain('srcdoc=')
  })

  it('损坏的快照字节：渲染错误框而不是 iframe，不抛错', () => {
    const html = render(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)
    expect(html).not.toContain('<iframe')
    expect(html).toContain('无法解析')
  })
})
