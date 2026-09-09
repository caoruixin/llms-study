// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { NormalizedBlock } from '../types'

/**
 * happy-dom 兼容性补丁：与 fidelitySanitize.test.ts / stampBlocks.test.ts 同源
 * （DOMPurify 3.4 依赖 Node.prototype.nodeName getter，happy-dom 的基类桩恒返回 ''）。
 * buildSnapshot 静态 import fidelitySanitize/stampBlocks（→ dompurify），补丁必须先于模块求值，故走 beforeAll 动态 import。
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

type Mod = typeof import('./buildSnapshot')
type Stamp = typeof import('./stampBlocks')
type Snap = typeof import('./webSnapshot')
let buildWebSnapshot: Mod['buildWebSnapshot']
let hostText: Stamp['hostText']
let STAMP_ATTR: string
let decodeWebSnapshot: Snap['decodeWebSnapshot']
let IngestError: typeof import('../ingest').IngestError

beforeAll(async () => {
  ;({ buildWebSnapshot } = await import('./buildSnapshot'))
  ;({ hostText, STAMP_ATTR } = await import('./stampBlocks'))
  ;({ decodeWebSnapshot } = await import('./webSnapshot'))
  ;({ IngestError } = await import('../ingest'))
})

const text = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer
const bin = (...n: number[]): ArrayBuffer => new Uint8Array(n).buffer as ArrayBuffer

const SITE = 'https://site.test'
const PAGE = `${SITE}/blog/post`

/** 站点资源表：主样式表带 @import + 相对 url() + 字体 + `<`；图片若干；第三方字体不该被抓 */
const SERVED: Record<string, { bytes: ArrayBuffer; contentType: string } | Error> = {
  [`${SITE}/css/main.css`]: {
    bytes: text(
      '@import url("theme.css");\n' +
        '@import "print.css" print;\n' +
        'body{background:url(../img/bg.png)}\n' +
        '.icon::before{content:"<"}\n' +
        '@font-face{font-family:F;src:url(../fonts/f.woff2) format("woff2")}\n' +
        '@font-face{font-family:G;src:url(https://fonts.gstatic.com/s/g.woff2)}\n',
    ),
    contentType: 'text/css; charset=utf-8',
  },
  [`${SITE}/css/theme.css`]: { bytes: text('h1{color:red;background:url("hero.jpg")}'), contentType: 'text/css' },
  [`${SITE}/css/print.css`]: { bytes: text('p{margin:0}'), contentType: 'text/css' },
  [`${SITE}/img/bg.png`]: { bytes: bin(1, 1), contentType: 'image/png' },
  [`${SITE}/css/hero.jpg`]: { bytes: bin(2, 2), contentType: 'image/jpeg' },
  [`${SITE}/fonts/f.woff2`]: { bytes: bin(3, 3), contentType: 'font/woff2' },
  [`${SITE}/img/fig.png`]: { bytes: bin(4, 4), contentType: 'image/png' },
  [`${SITE}/img/inline.png`]: { bytes: bin(5, 5), contentType: 'image/png' },
  [`${SITE}/img/missing.png`]: Object.assign(new Error('not found'), { status: 404 }),
}

function fakeDeps(overrides: Partial<Parameters<Mod['buildWebSnapshot']>[1]> = {}) {
  const calls: string[] = []
  const deps: Parameters<Mod['buildWebSnapshot']>[1] = {
    fetchAsset: async (url) => {
      calls.push(url)
      const s = SERVED[url]
      if (!s) throw new Error(`no fake for ${url}`)
      if (s instanceof Error) throw s
      return s
    },
    hash: async (b) => `id${Array.from(new Uint8Array(b)).join('')}`,
    ...overrides,
  }
  return { deps, calls }
}

/** 30 字 × 8 = 240 字符：单独一段就越过 200 字符的「未得到正文」门槛（rendered 用例只有标题 + 这一段） */
const LONG = '这是一段足够长的正文，用来让全文字符数超过二百字符的门槛。'.repeat(8)

const HTML =
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>快照标题</title>' +
  '<link rel="stylesheet" href="/css/main.css" media="screen">' +
  '<style>.inline{background:url(/img/inline.png)}</style>' +
  '<script>window.x=1</script></head><body>' +
  '<h1>一级标题</h1>' +
  `<p>${LONG}</p>` +
  '<figure><img src="/img/fig.png" alt="示意图"><figcaption>图 1：示意</figcaption></figure>' +
  '<p>另一段 <span style="background:url(deco.png)">带内联样式</span> 的文字，长度也要够二十个字符。</p>' +
  '<img src="/img/missing.png" alt="缺图">' +
  '</body></html>'

const reparse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

/** 不变式：每个文本块在 sanitize 后的 DOM 里 hostText(el) === block.text，索引连续 */
function assertBlockInvariant(html: string, blocks: NormalizedBlock[]): void {
  const doc = reparse(html)
  blocks.forEach((b, i) => {
    expect(b.index).toBe(i)
    expect(b.anchor.blockIndex).toBe(i)
    const el = doc.querySelector(`[${STAMP_ATTR}="${i}"]`)
    expect(el, `block ${i} 的打标元素`).not.toBeNull()
    if (b.kind !== 'table' && b.kind !== 'image') expect(hostText(el!)).toBe(b.text)
  })
}

describe('buildWebSnapshot：静态路径全链路', () => {
  it('样式表内联（@import 拉平、带 media 的包 @media、相对 url() 绝对化并换占位、\\3c 转义）', async () => {
    const { deps, calls } = fakeDeps()
    const { header, bytes, capture } = await buildWebSnapshot({ url: PAGE, html: HTML, finalUrl: PAGE }, deps)

    const sheet = /<style data-pc-sheet="https:\/\/site\.test\/css\/main\.css" media="screen">([\s\S]*?)<\/style>/.exec(header.html)
    expect(sheet, '主样式表变成 <style data-pc-sheet>').not.toBeNull()
    const css = sheet![1]
    expect(css).toContain('h1{color:red') // theme.css 已拉平
    expect(css).toContain('@media print {') // 带 media 的 @import 包成 @media
    expect(css).toContain('p{margin:0}')
    expect(css).not.toContain('@import')
    expect(css).toContain('url("pc-asset:id22")') // hero.jpg（theme.css 内的相对路径，按 theme.css 地址解析）
    expect(css).toContain('url(pc-asset:id11)') // bg.png
    expect(css).toContain('url(pc-asset:id33)') // 同站字体
    expect(css).toContain('url(https://fonts.gstatic.com/s/g.woff2)') // 第三方字体保持远程
    expect(css).toContain('content:"\\3c "')
    expect(css).not.toContain('content:"<"')
    expect(calls).not.toContain('https://fonts.gstatic.com/s/g.woff2')

    // 内联 <style> 同样按页面基准绝对化 + 占位
    expect(header.html).toContain('.inline{background:url(pc-asset:id55)}')
    // style 属性只绝对化，不换占位（阅读器不水合属性）
    expect(header.html).toContain('url(https://site.test/blog/deco.png)')

    // img 命中的资源加 data-pc-asset，src 保留原 https URL 作兜底
    expect(header.html).toMatch(/<img[^>]*src="https:\/\/site\.test\/img\/fig\.png"[^>]*data-pc-asset="id44"/)
    // 抓不到的图没有 data-pc-asset，但记入 skipped
    expect(header.html).toMatch(/<img[^>]*src="https:\/\/site\.test\/img\/missing\.png"(?![^>]*data-pc-asset)/)
    expect(header.stats.skipped).toEqual([{ url: `${SITE}/img/missing.png`, reason: 'fetch' }])

    // 资源区：只有图片与字体（CSS 内联进 html，不进资源区），按 id 排序
    expect(header.assets.map((a) => a.id)).toEqual(['id11', 'id22', 'id33', 'id44', 'id55'])
    expect(header.assets.every((a) => !a.mime.startsWith('text/css'))).toBe(true)
    expect(header.stats.assetBytes).toBe(10)

    // 头部元数据
    expect(header.title).toBe('快照标题')
    expect(header.url).toBe(PAGE)
    expect(header.finalUrl).toBe(PAGE)
    expect(header.capture).toEqual({ mode: 'static', katex: false, viewportWidth: 0, agentVersion: 0 })
    expect(header.html.startsWith('<html')).toBe(true)
    expect(header.html).not.toContain('<script')
    expect(header.html).not.toContain('<link')

    // capture 摘要与字节可解
    expect(capture).toEqual({ mode: 'static', assetCount: 5, assetBytes: 10, skipped: 1, katex: false })
    const decoded = decodeWebSnapshot(bytes)
    expect(Array.from(decoded.assetBytes('id44')!)).toEqual([4, 4])
    expect(decoded.header.blocks).toEqual(header.blocks)
  })

  it('blocks：sanitize 后重解析仍满足 hostText 不变式，索引连续、section 跟随标题', async () => {
    const { deps } = fakeDeps()
    const { header } = await buildWebSnapshot({ url: PAGE, html: HTML, finalUrl: PAGE }, deps)
    expect(header.blocks.length).toBeGreaterThanOrEqual(4)
    assertBlockInvariant(header.html, header.blocks)
    expect(header.blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: '一级标题', anchor: { section: '一级标题' } })
    expect(header.blocks.find((b) => b.kind === 'image')).toMatchObject({ text: '[图: 示意图]', src: `${SITE}/img/fig.png` })
    expect(header.blocks.find((b) => b.kind === 'caption')?.text).toBe('图 1：示意')
    expect(header.blocks.every((b) => b.anchor.kind === 'html' && b.anchor.section === '一级标题')).toBe(true)
  })

  it('阶段回调：rendering → assets（含 done/total）→ sanitizing → packing', async () => {
    const { deps } = fakeDeps()
    const phases: string[] = []
    let lastDetail: { done: number; total: number } | undefined
    await buildWebSnapshot(
      { url: PAGE, html: HTML, finalUrl: PAGE },
      {
        ...deps,
        onPhase: (p, d) => {
          if (!phases.length || phases[phases.length - 1] !== p) phases.push(p)
          if (d) lastDetail = d
        },
      },
    )
    expect(phases).toEqual(['rendering', 'assets', 'sanitizing', 'packing'])
    // 图片计划：bg.png, hero.jpg, fig.png, inline.png, missing.png（去重后 5）+ 同站字体 1 = 6
    expect(lastDetail).toEqual({ done: 6, total: 6 })
  })
})

describe('buildWebSnapshot：Tier 2 开关', () => {
  it('captureRendered 成功 → mode=rendered，视口/标题/finalUrl 取捕获值，页面已有公式时跳过 KaTeX', async () => {
    const { deps } = fakeDeps()
    const rendered =
      '<html><head><title>ignored</title><link data-pc-sheet="" href="https://site.test/css/theme.css"></head><body>' +
      `<h1>渲染后</h1><p>${LONG}</p><mjx-container jax="CHTML"><mjx-math></mjx-math></mjx-container></body></html>`
    const { header, capture, renderFallback } = await buildWebSnapshot(
      { url: PAGE, html: HTML, finalUrl: PAGE },
      {
        ...deps,
        katex: true,
        captureRendered: async () => ({ html: rendered, title: '代理标题', finalUrl: `${PAGE}?rendered`, viewportWidth: 1280, agentVersion: 3 }),
      },
    )
    expect(renderFallback).toBeUndefined()
    expect(header.capture).toEqual({ mode: 'rendered', katex: false, viewportWidth: 1280, agentVersion: 3 })
    expect(header.title).toBe('代理标题')
    expect(header.finalUrl).toBe(`${PAGE}?rendered`)
    expect(capture.mode).toBe('rendered')
    // 捕获代理形态的 link 也被内联
    expect(header.html).toContain('<style data-pc-sheet="https://site.test/css/theme.css">h1{color:red')
    expect(header.html).toContain('<mjx-container')
    assertBlockInvariant(header.html, header.blocks)
  })

  it('captureRendered 抛错 → 回退静态路径（mode=static），原因带回 renderFallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { deps } = fakeDeps()
      const { header, renderFallback } = await buildWebSnapshot(
        { url: PAGE, html: HTML, finalUrl: PAGE },
        {
          ...deps,
          captureRendered: async () => {
            throw new Error('frame-buster')
          },
        },
      )
      expect(header.capture.mode).toBe('static')
      expect(renderFallback).toBe('frame-buster')
      expect(header.title).toBe('快照标题')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  /**
   * 回归：openai.com 文章页。SSR 的 HTML 里正文完好，但在不透明源沙箱里跑站点 JS 后
   * 捕获到的是空壳，而 Tier 2 **没有抛错** —— 旧代码原样采信，一路到「未得到正文」才炸。
   */
  it('captureRendered 成功但产物近乎空白 → 与静态对照后改用静态，不再误报「未得到正文」', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { deps } = fakeDeps()
      const blank = '<html><head><title>空壳</title></head><body><div id="root"></div></body></html>'
      const { header, renderFallback } = await buildWebSnapshot(
        { url: PAGE, html: HTML, finalUrl: PAGE },
        { ...deps, captureRendered: async () => ({ html: blank, title: '空壳', finalUrl: PAGE, viewportWidth: 1280, agentVersion: 3 }) },
      )
      expect(header.capture.mode).toBe('static')
      expect(renderFallback).toMatch(/渲染捕获退化/)
      expect(header.title).toBe('快照标题')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('渲染产物本来就短、静态也没更多 → 保持 rendered，不因字数少就误退静态', async () => {
    const { deps } = fakeDeps()
    const short = '<html><head><title>短</title></head><body><h1>标题</h1><p>都很短。</p></body></html>'
    const err = await buildWebSnapshot(
      { url: PAGE, html: short, finalUrl: PAGE },
      { ...deps, captureRendered: async () => ({ html: short, title: '短', finalUrl: PAGE, viewportWidth: 1280, agentVersion: 3 }) },
    ).catch((e: unknown) => e)
    // 两边一样少 → 不切静态，最终仍按「正文太少」失败，但文案要说清是渲染捕获
    expect((err as Error).message).toContain('渲染捕获')
  })
})

describe('buildWebSnapshot：失败判定', () => {
  it('全文 < 200 字符 → IngestError(empty)，文案提示改用阅读模式', async () => {
    const { deps } = fakeDeps()
    const html = '<html><head><title>短</title></head><body><h1>标题</h1><p>正文太短了，脚本渲染的页面就是这样。</p></body></html>'
    const err = await buildWebSnapshot({ url: PAGE, html, finalUrl: PAGE }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IngestError)
    expect((err as InstanceType<typeof IngestError>).kind).toBe('empty')
    expect((err as Error).message).toContain('阅读模式')
    // 文案要说清「哪条路、拿到多少字」，不再一口咬定「依赖脚本渲染」
    expect((err as Error).message).toMatch(/静态捕获只得到 \d+ 字/)
  })

  it('sanitize 后 html > 8MB → IngestError(too-large)', async () => {
    const { deps } = fakeDeps()
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1024)
    const html = `<html><head><title>大</title></head><body><h1>标题</h1><pre>${huge}</pre></body></html>`
    const err = await buildWebSnapshot({ url: PAGE, html, finalUrl: PAGE }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IngestError)
    expect((err as InstanceType<typeof IngestError>).kind).toBe('too-large')
  }, 60_000)

  it('signal 已中止 → AbortError，不发起任何抓取', async () => {
    const { deps, calls } = fakeDeps()
    const controller = new AbortController()
    controller.abort()
    await expect(buildWebSnapshot({ url: PAGE, html: HTML, finalUrl: PAGE }, { ...deps, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([])
  })
})
