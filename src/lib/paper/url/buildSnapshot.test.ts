// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { NormalizedBlock } from '../types'

/**
 * captureStatic 包一层 spy（行为原样透传）：选路的「贵路径」= 多做一次静态捕获，健康页面必须一次都不做。
 * 这件事从产物上看不出来，只能靠调用次数钉住。
 */
vi.mock('./captureStatic', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./captureStatic')>()
  return { ...mod, captureStatic: vi.fn(mod.captureStatic) }
})

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
let chooseCapture: Mod['chooseCapture']
let measure: Mod['measure']
let hostText: Stamp['hostText']
let stampBlocks: Stamp['stampBlocks']
let STAMP_ATTR: string
let decodeWebSnapshot: Snap['decodeWebSnapshot']
let IngestError: typeof import('../ingest').IngestError
let CAPTURE_AGENT_VERSION: number
let captureStaticSpy: Mock<typeof import('./captureStatic').captureStatic>

beforeAll(async () => {
  ;({ buildWebSnapshot, chooseCapture, measure } = await import('./buildSnapshot'))
  ;({ hostText, stampBlocks, STAMP_ATTR } = await import('./stampBlocks'))
  ;({ decodeWebSnapshot } = await import('./webSnapshot'))
  ;({ IngestError } = await import('../ingest'))
  ;({ CAPTURE_AGENT_VERSION } = await import('./captureAgent'))
  captureStaticSpy = vi.mocked((await import('./captureStatic')).captureStatic)
})

beforeEach(() => captureStaticSpy.mockClear())

const text = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer
const bin = (...n: number[]): ArrayBuffer => new Uint8Array(n).buffer as ArrayBuffer
const abortErr = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

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

  it('Tier 2 进行中被取消 → AbortError 原样冒出，不回退静态、不抓任何资源', async () => {
    const controller = new AbortController()
    const { deps, calls } = fakeDeps({
      signal: controller.signal,
      captureRendered: async () => {
        controller.abort()
        throw abortErr()
      },
    })
    await expect(buildWebSnapshot({ url: PAGE, html: HTML, finalUrl: PAGE }, deps)).rejects.toMatchObject({ name: 'AbortError' })
    expect(captureStaticSpy).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 渲染 vs 静态的公平对照（PLAN-url-import-csr-render.md §3 A2：缺陷 C / D / E / F）
// ---------------------------------------------------------------------------

type Rendered = Awaited<ReturnType<NonNullable<Parameters<Mod['buildWebSnapshot']>[1]['captureRendered']>>>

const page =(body: string, title = '页面标题'): string => `<html><head><title>${title}</title></head><body>${body}</body></html>`
/** 恰好 n 个字符的一段正文（单个 `<p>`，stampBlocks 口径下就是 n 字） */
const para = (n: number, ch = '文'): string => `<p>${ch.repeat(n)}</p>`
const paras = (count: number, each: number): string => Array.from({ length: count }, () => para(each)).join('')
/** 隐藏的大菜单：静态 HTML 里只是个带内联样式的 div（没有计算样式可看），渲染产物里被捕获代理标了 data-pc-hidden */
const megaMenu = (items: number, marked: boolean): string =>
  `<div class="mega" style="display:none"${marked ? ' data-pc-hidden="1"' : ''}><ul>${`<li>${'菜'.repeat(100)}</li>`.repeat(items)}</ul></div>`
/** 纯客户端渲染的空壳：抓回来的 HTML 与沙箱里渲染失败的产物都长这样 */
const SHELL = page('<div id="root"></div>', '空壳')

const renderedOf =
  (html: string, extra: Partial<Rendered> = {}) =>
  async (): Promise<Rendered> => ({ html, title: '渲染标题', finalUrl: PAGE, viewportWidth: 1280, agentVersion: 2, ...extra })

const totalChars = (blocks: NormalizedBlock[]): number => blocks.reduce((n, b) => n + b.text.length, 0)

describe('chooseCapture：渲染 vs 静态（纯函数）', () => {
  it.each([
    // 死区（缺陷 D）：渲染不到下限、静态够 → 静态，不看倍数
    ['渲染 150 / 静态 250 → 静态', { rendered: 150, renderedRaw: 150, static: 250 }, 'static'],
    ['下限边界：渲染 199 / 静态 200 → 静态', { rendered: 199, renderedRaw: 199, static: 200 }, 'static'],
    ['下限边界：渲染 200 / 静态 200 → 渲染', { rendered: 200, renderedRaw: 200, static: 200 }, 'rendered'],
    ['静态自己不到下限（199）→ 换了也白换，留渲染', { rendered: 0, renderedRaw: 0, static: 199 }, 'rendered'],
    ['两边都不到下限 → 渲染', { rendered: 150, renderedRaw: 150, static: 150 }, 'rendered'],
    // 倍数判据：恰好 2× 算退化，差 1 不算
    ['静态恰好 2× → 静态', { rendered: 500, renderedRaw: 500, static: 1000 }, 'static'],
    ['静态 2× 差 1 → 渲染', { rendered: 500, renderedRaw: 500, static: 999 }, 'rendered'],
    // 缺陷 C：倍数看的是 renderedRaw（隐藏文本也计），不是可见字数
    ['静态多出来的全是隐藏文本 → 渲染', { rendered: 600, renderedRaw: 5600, static: 5600 }, 'rendered'],
    ['计入隐藏文本后静态仍 ≥ 2× → 静态', { rendered: 600, renderedRaw: 5600, static: 11200 }, 'static'],
    // 缺陷 E 的形态：渲染只有导航 + 页脚
    ['渲染 1,200 / 静态 50,000 → 静态', { rendered: 1200, renderedRaw: 1200, static: 50000 }, 'static'],
    ['健康页面：两边相当 → 渲染', { rendered: 30000, renderedRaw: 80000, static: 81000 }, 'rendered'],
  ] as const)('%s', (_name, chars, expected) => {
    expect(chooseCapture(chars)).toBe(expected)
  })
})

describe('measure：不改动被量的文档（缺陷 F）', () => {
  it('量的是克隆：被量文档的序列化前后逐字节一致；ignoreHidden 也只撕克隆上的标记', () => {
    const doc = reparse(
      page(
        '<div>  松散的   行内文字，长度要超过二十个字符才会被包成一个 run。 <p>块级   段落\n  带着多余空白</p> 尾巴上又一段足够长的松散行内文字，同样凑够二十个字符。</div>' +
          `<div data-pc-hidden="1">${para(300, '藏')}</div>`,
      ),
    )
    const before = doc.documentElement.outerHTML
    const visible = measure(doc)
    const raw = measure(doc, { ignoreHidden: true })
    expect(doc.documentElement.outerHTML).toBe(before)
    expect(visible).toBeGreaterThan(40)
    expect(raw).toBe(visible + 300)

    // 对照组：直接在原文档上 stampBlocks 确实会改动它（否则上面的断言形同虚设），且 measure 与它同一口径
    const stamped = stampBlocks(doc)
    expect(doc.documentElement.outerHTML).not.toBe(before)
    expect(totalChars(stamped)).toBe(visible)
  })
})

describe('buildWebSnapshot：渲染与静态的公平对照', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it('死区（缺陷 D）：渲染 150 / 静态 250 → 改用静态，导入成功', async () => {
    const { deps } = fakeDeps({ captureRendered: renderedOf(page(para(150))) })
    const { header, renderFallback } = await buildWebSnapshot({ url: PAGE, html: page(para(250)), finalUrl: PAGE }, deps)
    expect(header.capture).toEqual({ mode: 'static', katex: false, viewportWidth: 0, agentVersion: 0 })
    expect(totalChars(header.blocks)).toBe(250)
    expect(renderFallback).toBe('渲染捕获退化（渲染 150 字 < 静态 250 字），改用静态捕获')
    // 没开 KaTeX：对照用的那份静态产物直接拿来用，不再捕获第二次
    expect(captureStaticSpy).toHaveBeenCalledTimes(1)
  })

  it('缺陷 E：渲染只拿到页脚 1,200 字（过了可疑线）、静态 5 万字 → 廉价口径触发对照，改用静态', async () => {
    const footer = `<footer>${para(1200, '脚')}</footer>`
    const html = page(`${footer}<article><h1>正文标题</h1>${paras(50, 1000)}</article>`)
    const { deps } = fakeDeps({ captureRendered: renderedOf(page(`${footer}<div id="app"></div>`)) })
    const { header, renderFallback } = await buildWebSnapshot({ url: PAGE, html, finalUrl: PAGE }, deps)
    const reason = '渲染捕获退化（渲染 1200 字 < 静态 51204 字），改用静态捕获'
    expect(header.capture.mode).toBe('static')
    expect(renderFallback).toBe(reason)
    expect(totalChars(header.blocks)).toBe(51204)
    // QA 回归脚本按这个前缀收日志
    expect(warn).toHaveBeenCalledWith('[web-snapshot]', reason)
  })

  it('静态胜出且开了 KaTeX：对照用 katex:false 探测，胜出后才按调用方选项重做一次', async () => {
    const { deps } = fakeDeps({ katex: true, captureRendered: renderedOf(SHELL) })
    const { header } = await buildWebSnapshot({ url: PAGE, html: HTML, finalUrl: PAGE }, deps)
    expect(header.capture.mode).toBe('static')
    expect(captureStaticSpy.mock.calls.map(([input]) => input.katex)).toEqual([false, true])
  })

  it('健康页面（缺陷 C + 回归红线）：静态多出来的全是隐藏大菜单 → 保持 rendered，且一次静态捕获都不做', async () => {
    const article = `<article><h1>正文标题</h1>${paras(3, 1000)}</article>`
    const { deps } = fakeDeps({ captureRendered: renderedOf(page(megaMenu(500, true) + article)) })
    const { header, renderFallback } = await buildWebSnapshot({ url: PAGE, html: page(megaMenu(500, false) + article), finalUrl: PAGE }, deps)
    expect(header.capture).toEqual({ mode: 'rendered', katex: false, viewportWidth: 1280, agentVersion: 2 })
    expect(renderFallback).toBeUndefined()
    expect(header.title).toBe('渲染标题')
    // 隐藏菜单不进块；正文一字不少
    expect(totalChars(header.blocks)).toBe(3004)
    expect(captureStaticSpy).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('缺陷 C：渲染字数可疑（600）而静态的 5,600 里有 5,000 是隐藏菜单 → 对照了，但不降级', async () => {
    // 旧判据拿「跳过隐藏的渲染 600」比「不跳隐藏的静态 5,600」，≥ 2× → 误判退化
    const { deps } = fakeDeps({ captureRendered: renderedOf(page(megaMenu(50, true) + para(600))) })
    const { header, renderFallback } = await buildWebSnapshot({ url: PAGE, html: page(megaMenu(50, false) + para(600)), finalUrl: PAGE }, deps)
    expect(header.capture.mode).toBe('rendered')
    expect(renderFallback).toBeUndefined()
    expect(totalChars(header.blocks)).toBe(600)
    expect(captureStaticSpy).toHaveBeenCalledTimes(1)
  })

  it('缺陷 C × E：廉价口径触发了对照（静态多一大块 nav），完整口径下两边相当 → 仍保持 rendered', async () => {
    // nav 不进块但计入廉价口径：静态 11.3 万 vs 渲染 5.3 万 → 触发；stampBlocks 口径下静态 53,004 vs renderedRaw 53,004
    const article = `<article><h1>正文标题</h1>${paras(3, 1000)}</article>`
    const html = page(`<nav>${para(60000, '导')}</nav>${megaMenu(500, false)}${article}`)
    const { deps } = fakeDeps({ captureRendered: renderedOf(page(`<nav>${para(10, '导')}</nav>${megaMenu(500, true)}${article}`)) })
    const { header, renderFallback } = await buildWebSnapshot({ url: PAGE, html, finalUrl: PAGE }, deps)
    expect(header.capture.mode).toBe('rendered')
    expect(renderFallback).toBeUndefined()
    expect(captureStaticSpy).toHaveBeenCalledTimes(1)
  })

  it('注入方没报 agentVersion → 按当前代理版本记，不再写死 1', async () => {
    const { deps } = fakeDeps({ captureRendered: renderedOf(page(paras(2, 1000)), { agentVersion: undefined }) })
    const { header } = await buildWebSnapshot({ url: PAGE, html: page(paras(2, 1000)), finalUrl: PAGE }, deps)
    expect(header.capture.agentVersion).toBe(CAPTURE_AGENT_VERSION)
  })

  /**
   * 代理 v2 为白纸陪等 10s，只在 HTML 是空壳时才值得。全库回归实测：minimax.io 渲染 0 字、静态 10,432 字，
   * 结果一样却从 18s 拖到 29s——HTML 自己有正文时，渲染出白纸等多久都没用，静态必定兜得住。
   */
  describe('内容感知等待只给空壳页面', () => {
    const seenOpts = (): { opts: unknown[]; capture: NonNullable<Parameters<Mod['buildWebSnapshot']>[1]['captureRendered']> } => {
      const opts: unknown[] = []
      return {
        opts,
        capture: async (_input, o) => {
          opts.push(o)
          return { html: SHELL, title: '渲染标题', finalUrl: PAGE, viewportWidth: 1280, agentVersion: 2, blockedScripts: 0 }
        },
      }
    }

    it('抓回的 HTML 自己有正文（SSR）→ 关掉内容感知（minTextChars: 0），不为沙箱弄坏的白纸陪等', async () => {
      const seen = seenOpts()
      const { deps } = fakeDeps({ captureRendered: seen.capture })
      const { header } = await buildWebSnapshot({ url: PAGE, html: page(paras(2, 1000)), finalUrl: PAGE }, deps)
      expect(seen.opts).toHaveLength(1)
      expect(seen.opts[0]).toMatchObject({ config: { minTextChars: 0 } })
      // 结果不变：渲染是白纸，静态兜住
      expect(header.capture.mode).toBe('static')
    })

    it('抓回的 HTML 是空壳（CSR）→ 不传 config，代理按默认值等正文出现', async () => {
      const seen = seenOpts()
      const { deps } = fakeDeps({ captureRendered: seen.capture })
      await expect(buildWebSnapshot({ url: PAGE, html: SHELL, finalUrl: PAGE }, deps)).rejects.toThrow()
      expect(seen.opts).toHaveLength(1)
      expect(seen.opts[0]).not.toHaveProperty('config')
    })

    it('HTML 正文刚好在下限两侧：199 字仍等、200 字不等', async () => {
      for (const [n, waits] of [[199, true], [200, false]] as const) {
        const seen = seenOpts()
        const { deps } = fakeDeps({ captureRendered: seen.capture })
        await buildWebSnapshot({ url: PAGE, html: page(para(n)), finalUrl: PAGE }, deps).catch(() => undefined)
        if (waits) expect(seen.opts[0]).not.toHaveProperty('config')
        else expect(seen.opts[0]).toMatchObject({ config: { minTextChars: 0 } })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 如实失败（§3 A3 的抛错端）：文案说清拿到多少字，hint 只在阅读模式确实没戏时给
// ---------------------------------------------------------------------------

describe('buildWebSnapshot：如实失败与 reader-wont-help', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  type Err = InstanceType<typeof IngestError>
  const failOf = async (html: string, overrides: Parameters<typeof fakeDeps>[0]): Promise<Err> => {
    const { deps } = fakeDeps(overrides)
    const err = await buildWebSnapshot({ url: PAGE, html, finalUrl: PAGE }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IngestError)
    expect((err as Err).kind).toBe('empty')
    return err as Err
  }

  /** 正文放在 `<xmp>` 里：stampBlocks 算它的字，DOMPurify 连内容一起删——「sanitize 之后才丢字」的最小复现 */
  const LOST_ON_SANITIZE = page(`<xmp>${'丢'.repeat(300)}</xmp>`)

  it('空壳 + 有脚本加载失败 → 「脚本被跨源策略拦截」，hint=reader-wont-help', async () => {
    const err = await failOf(SHELL, { captureRendered: renderedOf(SHELL, { blockedScripts: 1 }) })
    expect(err.message).toContain('该页面正文完全由脚本生成，且其脚本被浏览器跨源策略拦截；阅读模式同样无法抓取')
    expect(err.message).toContain('渲染 0 字 / 静态 0 字')
    expect(err.message).toContain('1 个脚本加载失败')
    expect(err.message).not.toContain('重试')
    expect(err.hint).toBe('reader-wont-help')
  })

  it('空壳 + 没有脚本加载失败 → 不提跨源拦截，但同样 hint=reader-wont-help', async () => {
    const err = await failOf(SHELL, { captureRendered: renderedOf(SHELL, { blockedScripts: 0 }) })
    expect(err.message).toContain('抓回的 HTML 里没有正文')
    expect(err.message).toContain('阅读模式同样无法抓取')
    expect(err.message).toContain('渲染 0 字 / 静态 0 字')
    expect(err.message).not.toContain('跨源')
    expect(err.message).not.toContain('重试')
    expect(err.hint).toBe('reader-wont-help')
  })

  it('空壳 + Tier 2 抛错 → 同上，文案带上抛错原因与静态字数', async () => {
    const err = await failOf(SHELL, {
      captureRendered: async () => {
        throw Object.assign(new Error('页面渲染超时'), { reason: 'timeout' })
      },
    })
    expect(err.message).toContain('抓回的 HTML 里没有正文')
    expect(err.message).toContain('静态 0 字')
    expect(err.message).toContain('渲染捕获失败：timeout: 页面渲染超时')
    expect(err.hint).toBe('reader-wont-help')
  })

  it('脚本加载失败但静态有正文、只是 sanitize 后丢了 → 沿用旧文案，不给 hint（阅读模式可能真能成）', async () => {
    const err = await failOf(LOST_ON_SANITIZE, { captureRendered: renderedOf(LOST_ON_SANITIZE, { blockedScripts: 3 }) })
    expect(err.message).toBe('渲染捕获只得到 0 字正文，未能生成网页原貌；可改用「阅读模式」重试')
    expect(err.hint).toBeUndefined()
  })

  it('渲染空壳、静态 ≥ 下限而胜出、sanitize 后才丢字 → 旧文案带退化原因，不给 hint', async () => {
    const err = await failOf(LOST_ON_SANITIZE, { captureRendered: renderedOf(SHELL, { blockedScripts: 1 }) })
    expect(err.message).toBe('静态捕获（渲染捕获退化（渲染 0 字 < 静态 300 字），改用静态捕获）只得到 0 字正文，未能生成网页原貌；可改用「阅读模式」重试')
    expect(err.hint).toBeUndefined()
  })

  it('没注入任何渲染层的纯静态路径 → 旧文案、不给 hint（没试过渲染，别一口咬定是脚本生成）', async () => {
    const err = await failOf(SHELL, {})
    expect(err.message).toBe('静态捕获只得到 0 字正文，未能生成网页原貌；可改用「阅读模式」重试')
    expect(err.hint).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tier 3 接缝（§4 B5 的客户端半边）：captureRemote 注入前行为不变，注入后只在本地两层都不到下限时才用
// ---------------------------------------------------------------------------

describe('buildWebSnapshot：Tier 3 服务器渲染接缝', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  const REMOTE_HTML = page(`<h1>服务器渲染出的标题</h1>${paras(2, 1000)}`)
  const remoteOk = (extra: Partial<Rendered> = {}) =>
    vi.fn(async (): Promise<Rendered> => ({ html: REMOTE_HTML, title: '服务器标题', finalUrl: `${PAGE}?remote`, viewportWidth: 1440, agentVersion: 7, ...extra }))

  it('本地两层都不到下限 → 走 Tier 3：报 remote 阶段，产物仍记 mode=rendered', async () => {
    const captureRemote = remoteOk()
    const phases: string[] = []
    const controller = new AbortController()
    const { deps } = fakeDeps({
      signal: controller.signal,
      captureRendered: renderedOf(SHELL, { blockedScripts: 1 }),
      captureRemote,
      onPhase: (p) => {
        if (phases[phases.length - 1] !== p) phases.push(p)
      },
    })
    const { header, capture, renderFallback } = await buildWebSnapshot({ url: `${PAGE}#frag`, html: SHELL, finalUrl: PAGE }, deps)
    expect(captureRemote).toHaveBeenCalledTimes(1)
    expect(captureRemote).toHaveBeenCalledWith({ url: `${PAGE}#frag`, finalUrl: PAGE }, { signal: controller.signal })
    expect(phases).toEqual(['rendering', 'remote', 'assets', 'sanitizing', 'packing'])
    // webSnapshot.ts 只认 rendered/static，旧客户端还要能解码同步过去的快照：Tier 3 不能发明第三种 mode
    expect(header.capture).toEqual({ mode: 'rendered', katex: false, viewportWidth: 1440, agentVersion: 7 })
    expect(capture.mode).toBe('rendered')
    expect(header.title).toBe('服务器标题')
    expect(header.finalUrl).toBe(`${PAGE}?remote`)
    expect(totalChars(header.blocks)).toBe(2009)
    expect(renderFallback).toBeUndefined()
    assertBlockInvariant(header.html, header.blocks)
  })

  it('Tier 2 抛错 + 静态空壳 + Tier 3 成功 → renderFallback 不带回（它说的是「最终走了静态」）；缺 agentVersion 按当前版本', async () => {
    const { deps } = fakeDeps({
      captureRendered: async () => {
        throw new Error('frame-buster')
      },
      captureRemote: remoteOk({ agentVersion: undefined }),
    })
    const { header, renderFallback } = await buildWebSnapshot({ url: PAGE, html: SHELL, finalUrl: PAGE }, deps)
    expect(header.capture.mode).toBe('rendered')
    expect(header.capture.agentVersion).toBe(CAPTURE_AGENT_VERSION)
    expect(renderFallback).toBeUndefined()
  })

  it('Tier 3 的产物仍不到下限 → 不采用，如实失败并附上原因', async () => {
    const captureRemote = vi.fn(renderedOf(page(para(50))))
    const { deps } = fakeDeps({ captureRendered: renderedOf(SHELL, { blockedScripts: 2 }), captureRemote })
    const err = await buildWebSnapshot({ url: PAGE, html: SHELL, finalUrl: PAGE }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IngestError)
    expect((err as Error).message).toContain('且其脚本被浏览器跨源策略拦截')
    expect((err as Error).message).toMatch(/；服务器渲染：只得到 50 字正文$/)
    expect((err as InstanceType<typeof IngestError>).hint).toBe('reader-wont-help')
    expect(captureRemote).toHaveBeenCalledTimes(1)
  })

  it('Tier 3 抛错（非取消）→ 不改变失败的性质，如实失败并附上原因', async () => {
    const { deps } = fakeDeps({
      captureRendered: renderedOf(SHELL),
      captureRemote: async () => {
        throw new Error('渲染服务暂不可用（503）')
      },
    })
    const err = await buildWebSnapshot({ url: PAGE, html: SHELL, finalUrl: PAGE }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IngestError)
    expect((err as Error).message).toContain('抓回的 HTML 里没有正文')
    expect((err as Error).message).toMatch(/；服务器渲染：渲染服务暂不可用（503）$/)
    expect((err as InstanceType<typeof IngestError>).hint).toBe('reader-wont-help')
  })

  it('Tier 3 期间取消（captureRemote 抛 AbortError）→ 原样冒出，不落成失败文案、不抓资源', async () => {
    const controller = new AbortController()
    const { deps, calls } = fakeDeps({
      signal: controller.signal,
      captureRendered: renderedOf(SHELL),
      captureRemote: async () => {
        controller.abort()
        throw abortErr()
      },
    })
    await expect(buildWebSnapshot({ url: PAGE, html: SHELL, finalUrl: PAGE }, deps)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([])
  })

  it('Tier 3 返回时信号已取消 → 同样是 AbortError，结果不被采用', async () => {
    const controller = new AbortController()
    const remote = remoteOk()
    const { deps, calls } = fakeDeps({
      signal: controller.signal,
      captureRendered: renderedOf(SHELL),
      captureRemote: async () => {
        controller.abort()
        return remote()
      },
    })
    await expect(buildWebSnapshot({ url: PAGE, html: SHELL, finalUrl: PAGE }, deps)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([])
  })

  it('健康页面 / 静态胜出且过了下限 → Tier 3 一次都不调用，也不报 remote 阶段', async () => {
    const captureRemote = remoteOk()
    const phases: string[] = []
    const onPhase = (p: string): void => void phases.push(p)

    // 渲染健康
    const healthy = fakeDeps({ captureRendered: renderedOf(page(paras(2, 1000))), captureRemote, onPhase })
    const a = await buildWebSnapshot({ url: PAGE, html: page(paras(2, 1000)), finalUrl: PAGE }, healthy.deps)
    expect(a.header.capture.mode).toBe('rendered')

    // 渲染空壳但静态够用（死区同款）
    const demoted = fakeDeps({ captureRendered: renderedOf(SHELL, { blockedScripts: 1 }), captureRemote, onPhase })
    const b = await buildWebSnapshot({ url: PAGE, html: page(para(250)), finalUrl: PAGE }, demoted.deps)
    expect(b.header.capture.mode).toBe('static')

    // 纯静态路径
    const staticOnly = fakeDeps({ captureRemote, onPhase })
    const c = await buildWebSnapshot({ url: PAGE, html: HTML, finalUrl: PAGE }, staticOnly.deps)
    expect(c.header.capture.mode).toBe('static')

    expect(captureRemote).not.toHaveBeenCalled()
    expect(phases).not.toContain('remote')
  })
})
