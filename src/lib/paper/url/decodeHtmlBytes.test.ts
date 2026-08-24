import { describe, expect, it } from 'vitest'
import { decodeHtmlBytes } from './extractArticle'

/**
 * 只 import { decodeHtmlBytes }：extractArticle.ts 的其余部分（extractArticle/
 * extractFromFetchedHtml）依赖 DOMParser + 动态 import('@mozilla/readability')，
 * 但那些引用都在函数体内，模块顶层不会在 import 时触发，因此本文件可以在纯
 * node 环境（vite.config.ts 的默认 test.environment）安全运行，无需 happy-dom。
 */

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('decodeHtmlBytes', () => {
  it('HTTP 头 charset 优先级最高', () => {
    // gbk 编码的「中」= 0xd6 0xd0；用 header 声明 gbk 时应按 gbk 解码出「中」
    const bytes = new Uint8Array([0xd6, 0xd0]).buffer
    expect(decodeHtmlBytes(bytes, 'text/html; charset=gbk')).toBe('中')
  })

  it('无 header 时识别 UTF-8 BOM，且 BOM 本身不残留进解码结果', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new Uint8Array(enc('hello'))])
    const decoded = decodeHtmlBytes(withBom.buffer, 'text/html')
    expect(decoded).toBe('hello')
    expect(decoded.charCodeAt(0)).not.toBe(0xfeff) // 不含 BOM 字符本体
  })

  it('UTF-16LE BOM 被识别并正确解码', () => {
    // "AB" 的 UTF-16LE 字节：FF FE 41 00 42 00
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]).buffer
    expect(decodeHtmlBytes(bytes, 'text/html')).toBe('AB')
  })

  it('无 header 无 BOM 时从首 1024 字节内的 <meta charset> 识别', () => {
    const html = '<html><head><meta charset="gbk"></head><body></body></html>'
    // 用 ASCII 构造字节（meta 声明本身必须是 ASCII 才能被识别，这里正文全 ASCII）
    const bytes = enc(html)
    expect(decodeHtmlBytes(bytes, 'text/html')).toBe(html)
  })

  it('从 http-equiv content-type meta 中识别 charset', () => {
    const html = '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'
    expect(decodeHtmlBytes(enc(html), 'text/html')).toBe(html)
  })

  it('都没有时默认 utf-8', () => {
    const html = '<p>纯 UTF-8 正文，无任何 charset 声明</p>'
    expect(decodeHtmlBytes(enc(html), 'text/html')).toBe(html)
  })

  it('非法/不认识的 charset label 回退 utf-8，不抛异常', () => {
    const html = '<p>fallback ok</p>'
    expect(decodeHtmlBytes(enc(html), 'text/html; charset=not-a-real-charset')).toBe(html)
  })

  it('header charset 优先于 BOM（即便字节带着 UTF-16LE BOM，header 显式 utf-8 时也不走 BOM 判定）', () => {
    // "AB" 的 UTF-16LE 字节（含 BOM）：FF FE 41 00 42 00；若按 BOM 判定应解出 "AB"
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]).buffer
    const viaBom = decodeHtmlBytes(bytes, 'text/html') // 无 header：走 BOM 判定，解出 "AB"
    const viaHeader = decodeHtmlBytes(bytes, 'text/html; charset=utf-8') // header 显式 utf-8：跳过 BOM 判定
    expect(viaBom).toBe('AB')
    expect(viaHeader).not.toBe('AB') // FF FE 按 utf-8 解码是非法序列，不会得到干净的 "AB"
  })
})
