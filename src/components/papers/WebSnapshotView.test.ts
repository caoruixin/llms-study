import { readFileSync } from 'node:fs'
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

/**
 * 接线护栏（源码级，沿 captureAgent.test.ts 断言函数体字面量的先例）：「当前块」观察器建在父窗口、
 * root 是隐式的顶层视口，rootMargin 必须由阅读窗格的实时几何换算（currentBlockRootMargin → bandMargin）。
 * 写死成 `-8px 0px -75% 0px` 量的是浏览器视口的上 1/4：窗口一矮带子就落到窗格之外，当前块冻住，
 * 译文窗口不再跟着滚动走（屏幕上的骨架永远等不到译文）。node 环境没有布局，effect 也不跑，
 * 真实行为由 .e2e-qa-fixtures/diag-translate-window.mjs 在浏览器里验；这里只防那句字面量被改回来。
 */
describe('WebSnapshotView「当前块」观察带护栏', () => {
  const src = readFileSync(new URL('./WebSnapshotView.tsx', import.meta.url), 'utf8')

  it('观察带按阅读窗格换算，并用专属内缩量', () => {
    expect(src).toMatch(/currentBlockRootMargin\(/)
    expect(src).toMatch(/SNAPSHOT_BAND_INSET,\s*\)/)
    expect(src).toMatch(/rootMargin:\s*bandMargin\b/)
  })

  it('任何观察器都不写相对视口的百分比 rootMargin', () => {
    expect(src).not.toMatch(/rootMargin:\s*[`'"][^`'"]*%/)
  })
})
