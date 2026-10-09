import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaperBlock, PaperBlockKind, PaperRecord } from '../types'
import { createCjkFont, loadFontkit } from './cjkFont'
import { classifyImageSrc, exportTextDoc, fetchImageBytes, loadImageForExport } from './exportTextDoc'

/**
 * 文本排版版执行器：图片取字节的路由（data: / blob: 直取、同源直取、跨域走代理、无法解析的相对地址跳过），
 * 以及「从不调用 getBytes」（原版导出拿不到字节时回退到这里）。代理客户端整体 mock。
 */

const proxy = vi.hoisted(() => ({
  fetchUrl: vi.fn<(url: string, opts?: { kind?: string; signal?: AbortSignal }) => Promise<{ bytes: ArrayBuffer; contentType: string; finalUrl: string }>>(),
}))
vi.mock('../url/fetchUrlApi', () => proxy)

const APP = 'https://llm-pro.cn'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

afterEach(() => {
  vi.unstubAllGlobals()
  proxy.fetchUrl.mockReset()
})

describe('classifyImageSrc', () => {
  it('data: / blob: → direct（不论有没有页面 origin，绝不发给代理）', () => {
    for (const origin of [APP, null, 'null']) {
      expect(classifyImageSrc('data:image/png;base64,iVBORw0KGgo=', origin)).toBe('direct')
      expect(classifyImageSrc('DATA:image/svg+xml,%3Csvg%2F%3E', origin)).toBe('direct')
      expect(classifyImageSrc(`blob:${APP}/0b6f6a1e-1111-2222-3333-444455556666`, origin)).toBe('direct')
    }
  })

  it('绝对 http(s)：同源 → direct，跨域 / 协议不同 → proxy；没有页面 origin 也照样走代理', () => {
    expect(classifyImageSrc(`${APP}/api/app/files/x.png`, APP)).toBe('direct')
    expect(classifyImageSrc('https://arxiv.org/html/2609.36054v1/x1.png', APP)).toBe('proxy')
    expect(classifyImageSrc('http://llm-pro.cn/x.png', APP)).toBe('proxy')
    expect(classifyImageSrc('https://cdn.example.com/x.png', null)).toBe('proxy')
    expect(classifyImageSrc('  https://arxiv.org/x.png  ', APP)).toBe('proxy')
  })

  it('协议相对：有真实页面 origin 时借协议补全再判同源；没有（node / file: / null）→ skip', () => {
    expect(classifyImageSrc('//cdn.example.com/x.png', APP)).toBe('proxy')
    expect(classifyImageSrc('//llm-pro.cn/x.png', APP)).toBe('direct')
    expect(classifyImageSrc('//cdn.example.com/x.png', null)).toBe('skip')
    expect(classifyImageSrc('//cdn.example.com/x.png', 'null')).toBe('skip')
    expect(classifyImageSrc('//cdn.example.com/x.png', 'file://')).toBe('skip')
  })

  it('相对路径一律 skip（基址已丢失，不按应用 origin 去取）；空串、非 http 协议、坏 URL → skip', () => {
    for (const src of ['figures/x1.png', './x.png', '../x.png', '/x.png', '?v=1', '', '   ']) {
      expect(classifyImageSrc(src, APP)).toBe('skip')
      expect(classifyImageSrc(src, null)).toBe('skip')
    }
    expect(classifyImageSrc('file:///Users/me/x.png', APP)).toBe('skip')
    expect(classifyImageSrc('javascript:alert(1)', APP)).toBe('skip')
    expect(classifyImageSrc('https://[::1', APP)).toBe('skip')
  })
})

describe('fetchImageBytes / loadImageForExport 路由', () => {
  const stubPage = () => {
    vi.stubGlobal('location', { origin: APP, href: `${APP}/#/papers/p1` })
    const fetchSpy = vi.fn(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  it('data: → 直接 fetch，不走代理', async () => {
    const fetchSpy = stubPage()
    const src = 'data:image/png;base64,iVBORw0KGgo='
    const got = await fetchImageBytes(src)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect((fetchSpy.mock.calls[0] as unknown[])[0]).toBe(src)
    expect(proxy.fetchUrl).not.toHaveBeenCalled()
    expect(got?.mime).toBe('image/png')
    expect(got?.bytes).toEqual(PNG)
  })

  it('跨域 → 代理（kind: asset），不直接 fetch', async () => {
    const fetchSpy = stubPage()
    proxy.fetchUrl.mockResolvedValue({ bytes: PNG.slice().buffer, contentType: 'application/octet-stream', finalUrl: 'x' })
    const img = await loadImageForExport('https://arxiv.org/html/x/x1.png')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(proxy.fetchUrl).toHaveBeenCalledWith('https://arxiv.org/html/x/x1.png', expect.objectContaining({ kind: 'asset' }))
    expect(img?.format).toBe('png')
  })

  it('协议相对 → 补全协议后交给代理（代理只认绝对地址）', async () => {
    const fetchSpy = stubPage()
    proxy.fetchUrl.mockResolvedValue({ bytes: PNG.slice().buffer, contentType: 'image/png', finalUrl: 'x' })
    await fetchImageBytes('//cdn.example.com/a b.png')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(proxy.fetchUrl).toHaveBeenCalledWith('https://cdn.example.com/a%20b.png', expect.objectContaining({ kind: 'asset' }))
  })

  it('相对地址 → null（占位框），既不 fetch 也不走代理', async () => {
    const fetchSpy = stubPage()
    expect(await fetchImageBytes('figures/x1.png')).toBeNull()
    expect(await loadImageForExport('/x1.png')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(proxy.fetchUrl).not.toHaveBeenCalled()
  })
})

const FONT = fileURLToPath(new URL('../../../assets/fonts/NotoSerifSC-sub.ttf', import.meta.url))

describe.skipIf(!fs.existsSync(FONT))('exportTextDoc（真实字体）', () => {
  const block = (index: number, kind: PaperBlockKind, text: string): PaperBlock => ({
    id: `p:${index}`,
    paperId: 'p',
    index,
    kind,
    text,
    anchor: { kind: 'pdf', blockIndex: index, page: 1 },
  })

  it('从不调用 getBytes；untranslated = 规划器计数（缺译的可译块）', async () => {
    const buf = fs.readFileSync(FONT)
    const font = await createCjkFont(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
    const getBytes = vi.fn(async (): Promise<ArrayBuffer> => {
      throw new Error('文本排版版不该要原始字节')
    })
    const blocks = [block(0, 'heading', 'Intro'), block(1, 'paragraph', 'Alpha beta.'), block(2, 'formula', 'x = y'), block(3, 'paragraph', 'Gamma delta.')]
    const r = await exportTextDoc(
      {
        paper: { id: 'p', title: 'T', fileName: 't.pdf', byteSize: 0 } as PaperRecord,
        blocks,
        texts: new Map([[1, '甲乙。']]),
        flavor: 'text-zh',
        getBytes,
      },
      { pdfLib: await import('pdf-lib'), fontkit: await loadFontkit(), font, dom: null },
    )
    expect(getBytes).not.toHaveBeenCalled()
    expect(r.untranslated).toBe(2)
    expect(r.pageCount).toBe(1)
    expect(r.bytes.byteLength).toBeGreaterThan(1000)
  }, 60_000)
})
