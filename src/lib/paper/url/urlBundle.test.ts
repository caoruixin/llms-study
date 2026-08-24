import { describe, expect, it } from 'vitest'
import { IngestError } from '../ingest'
import { normalizeHtmlSections } from '../normalizeHtml'
import { URL_BUNDLE_MIME, parseUrlBundleBytes, serializeUrlBundle } from './urlBundle'

const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)
const encode = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('URL_BUNDLE_MIME', () => {
  it('是稳定字面量', () => {
    expect(URL_BUNDLE_MIME).toBe('application/x-paper-url-bundle+json')
  })
})

describe('serializeUrlBundle', () => {
  it('同输入产出同字节（多次调用逐字节一致）', () => {
    const bundle = { sources: [{ url: 'https://a.com', title: 'A 页', html: '<p>x</p>' }] }
    const b1 = serializeUrlBundle(bundle)
    const b2 = serializeUrlBundle(bundle)
    expect(new Uint8Array(b1)).toEqual(new Uint8Array(b2))
  })

  it('固定字段顺序：kind → version → sources[].{url,title,html}', () => {
    const bytes = serializeUrlBundle({ sources: [{ url: 'https://a.com', title: 'T', html: '<p>x</p>' }] })
    expect(decode(bytes)).toBe(
      '{"kind":"url-bundle","version":1,"sources":[{"url":"https://a.com","title":"T","html":"<p>x</p>"}]}',
    )
  })

  it('不含 fetchedAt 等易变字段（即便调用方对象上挂了额外字段也不会泄漏进字节）', () => {
    const bundle = { sources: [{ url: 'https://a.com', html: '<p>x</p>', fetchedAt: 123, extra: 'nope' } as never] }
    const bytes = serializeUrlBundle(bundle)
    expect(decode(bytes)).not.toContain('fetchedAt')
    expect(decode(bytes)).not.toContain('extra')
  })

  it('title 缺失时不产出 title 字段（而不是 title:undefined 之类的脏值）', () => {
    const bytes = serializeUrlBundle({ sources: [{ url: 'https://a.com', html: '<p>x</p>' }] })
    expect(decode(bytes)).toBe('{"kind":"url-bundle","version":1,"sources":[{"url":"https://a.com","html":"<p>x</p>"}]}')
  })

  it('多节顺序即粘贴顺序：sources 数组顺序被原样保留', () => {
    const bytes = serializeUrlBundle({
      sources: [
        { url: 'https://a.com', html: '<p>1</p>' },
        { url: 'https://b.com', html: '<p>2</p>' },
      ],
    })
    const json = JSON.parse(decode(bytes))
    expect(json.sources.map((s: { url: string }) => s.url)).toEqual(['https://a.com', 'https://b.com'])
  })
})

describe('parseUrlBundleBytes（回环）', () => {
  it('serialize → parse 与直接调用 normalizeHtmlSections 语义等价（单节）', () => {
    const sources = [{ url: 'https://a.com', title: 'A 页', html: '<h1>A 页</h1><p>正文</p>' }]
    const result = parseUrlBundleBytes(serializeUrlBundle({ sources }))
    const direct = normalizeHtmlSections(sources.map((s) => ({ title: s.title, html: s.html })))
    expect(result.blocks).toEqual(direct)
    expect(result.title).toBe('A 页')
  })

  it('serialize → parse 与直接调用 normalizeHtmlSections 语义等价（多节，含标题下压/去重）', () => {
    const sources = [
      { url: 'https://a.com', title: '第一章', html: '<h1>第一章</h1><p>内容一</p>' },
      { url: 'https://b.com', title: '第二章', html: '<h2>小节</h2><p>内容二</p>' },
    ]
    const result = parseUrlBundleBytes(serializeUrlBundle({ sources }))
    const direct = normalizeHtmlSections(sources.map((s) => ({ title: s.title, html: s.html })))
    expect(result.blocks).toEqual(direct)
    expect(result.title).toBe('第一章')
  })

  it('title 返回值取第一个来源的标题', () => {
    const sources = [
      { url: 'https://a.com', title: '首页标题', html: '<p>x</p>' },
      { url: 'https://b.com', title: '次页标题', html: '<p>y</p>' },
    ]
    const result = parseUrlBundleBytes(serializeUrlBundle({ sources }))
    expect(result.title).toBe('首页标题')
  })
})

describe('parseUrlBundleBytes（损坏检测）', () => {
  const expectCorrupt = (bytes: ArrayBuffer) => {
    expect(() => parseUrlBundleBytes(bytes)).toThrow(IngestError)
    try {
      parseUrlBundleBytes(bytes)
      expect.fail('应当抛出 IngestError')
    } catch (e) {
      expect(e).toBeInstanceOf(IngestError)
      expect((e as IngestError).kind).toBe('corrupt')
    }
  }

  it('不是合法 JSON', () => expectCorrupt(encode('not json at all')))
  it('是 JSON 但不是对象（数组）', () => expectCorrupt(encode('[1,2,3]')))
  it('kind 字段不匹配', () => expectCorrupt(encode('{"kind":"something-else","version":1,"sources":[]}')))
  it('version 字段不匹配', () =>
    expectCorrupt(encode('{"kind":"url-bundle","version":2,"sources":[{"url":"https://a.com","html":"<p>x</p>"}]}')))
  it('sources 为空数组', () => expectCorrupt(encode('{"kind":"url-bundle","version":1,"sources":[]}')))
  it('sources 缺失', () => expectCorrupt(encode('{"kind":"url-bundle","version":1}')))
  it('某节缺少 url 字段', () => expectCorrupt(encode('{"kind":"url-bundle","version":1,"sources":[{"html":"<p>x</p>"}]}')))
  it('某节缺少 html 字段', () => expectCorrupt(encode('{"kind":"url-bundle","version":1,"sources":[{"url":"https://a.com"}]}')))
  it('空字节', () => expectCorrupt(new ArrayBuffer(0)))
})
