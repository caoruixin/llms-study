// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * happy-dom 兼容性补丁：与 stampBlocks.test.ts 同源（DOMPurify 3.4 依赖 Node.prototype.nodeName getter）。
 * selectionOffsets 静态 import stampBlocks（→ sanitize → dompurify），补丁必须先于模块求值，故走 beforeAll 动态 import。
 *
 * 「第二个文档」用 iframe 的 contentDocument 而不是 DOMParser：happy-dom 里 DOMParser 文档的
 * `createRange()` 绑定的是主窗口文档（comparePoint 一律抛 WrongDocumentError），iframe 文档才有
 * 自己的窗口与 Range 实现——这也正是生产里网页原貌视图的形态。
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

let captureHighlightRanges: typeof import('./selectionOffsets')['captureHighlightRanges']

beforeAll(async () => {
  ;({ captureHighlightRanges } = await import('./selectionOffsets'))
})

/** 独立文档（自己的 window / Range 实现），模拟网页原貌 iframe */
function secondDocument(body: string): Document {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('happy-dom iframe 没有 contentDocument')
  doc.body.innerHTML = body
  return doc
}

const textNode = (el: Element | null | undefined): Text => {
  const n = el?.firstChild
  if (!n || n.nodeType !== 3) throw new Error('expected text node')
  return n as Text
}

const brief = (rows: ReturnType<typeof captureHighlightRanges>) =>
  rows.map((r) => [r.blockIndex, r.lang, r.start, r.end, r.text])

/** 快照形态：打标元素自己就是 orig 宿主，译文 .pc-zh 嵌在宿主内部 */
const SNAPSHOT_BODY =
  '<h1 data-pc-block="0" data-block-index="0" data-hl-host="orig">Title</h1>' +
  '<p data-pc-block="1" data-block-index="1" data-hl-host="orig">Hello <b>wor</b>ld' +
  '<span class="pc-zh" data-hl-host="zh" data-translated="zh">你好世界</span></p>' +
  '<p data-pc-block="2" data-block-index="2" data-hl-host="orig">Second para</p>'

describe('captureHighlightRanges：跨文档（iframe）Range', () => {
  it('偏移用宿主自己文档的 Range 计算；父文档 Range 对这些节点会抛错', () => {
    const doc = secondDocument(SNAPSHOT_BODY)
    const p = doc.querySelector('[data-block-index="1"]')!
    const b = doc.querySelector('b')!
    // 选区 "o wor"：起点在 "Hello " 的偏移 4，终点在 <b> 文本末尾
    const range = doc.createRange()
    range.setStart(textNode(p), 4)
    range.setEnd(textNode(b), 3)
    expect(brief(captureHighlightRanges(range, doc.body))).toEqual([[1, 'orig', 4, 9, 'o wor']])

    // 修前的症结：父文档的 Range 认不出 iframe 节点
    const parentProbe = document.createRange()
    expect(() => parentProbe.comparePoint(textNode(b), 1)).toThrow()
  })

  it('sourceText 用 hostText：对照模式下嵌在宿主里的译文不算进原文', () => {
    const doc = secondDocument(SNAPSHOT_BODY)
    const p = doc.querySelector('[data-block-index="1"]')!
    const range = doc.createRange()
    range.setStart(textNode(p), 0)
    range.setEnd(textNode(p), 5)
    const rows = captureHighlightRanges(range, doc.body)
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceText).toBe('Hello world')
    expect(rows[0].text).toBe('Hello')
  })

  it('起点在译文里 → lang=zh，宿主是 .pc-zh，偏移相对译文', () => {
    const doc = secondDocument(SNAPSHOT_BODY)
    const zh = doc.querySelector('.pc-zh')!
    const range = doc.createRange()
    range.setStart(textNode(zh), 2)
    range.setEnd(textNode(zh), 4)
    expect(brief(captureHighlightRanges(range, doc.body))).toEqual([[1, 'zh', 2, 4, '世界']])
  })

  it('原文起点、终点划进译文：终点钳到原文末尾，不把译文算进区间', () => {
    const doc = secondDocument(SNAPSHOT_BODY)
    const p = doc.querySelector('[data-block-index="1"]')!
    const zh = doc.querySelector('.pc-zh')!
    const range = doc.createRange()
    range.setStart(textNode(p), 6)
    range.setEnd(textNode(zh), 2)
    expect(brief(captureHighlightRanges(range, doc.body))).toEqual([[1, 'orig', 6, 11, 'world']])
  })

  it('跨块选区逐块拆条，中间块整段、末块钳位；起点不在宿主内返回 []', () => {
    const doc = secondDocument(SNAPSHOT_BODY)
    const h1 = doc.querySelector('[data-block-index="0"]')!
    const p2 = doc.querySelector('[data-block-index="2"]')!
    const range = doc.createRange()
    range.setStart(textNode(h1), 2)
    range.setEnd(textNode(p2), 6)
    expect(brief(captureHighlightRanges(range, doc.body))).toEqual([
      [0, 'orig', 2, 5, 'tle'],
      [1, 'orig', 0, 11, 'Hello world'],
      [2, 'orig', 0, 6, 'Second'],
    ])

    // 容器不含宿主 → []
    const other = secondDocument('<div></div>')
    expect(captureHighlightRanges(range, other.body)).toEqual([])
  })
})

describe('captureHighlightRanges：父文档（BlockReader 形态）', () => {
  it('宿主是块容器的后代，#paper-block-N 兜底查找仍可用', () => {
    document.body.innerHTML =
      '<main id="m"><div id="paper-block-0" data-block-index="0"><p data-hl-host="orig">The quick brown fox</p></div>' +
      '<div id="paper-block-1" data-block-index="1"><p class="flex"><span>·</span><span data-hl-host="orig">item text</span></p></div></main>'
    const main = document.getElementById('m') as HTMLElement
    const p0 = document.querySelector('#paper-block-0 p')!
    const host1 = document.querySelector('#paper-block-1 [data-hl-host]')!
    const range = document.createRange()
    range.setStart(textNode(p0), 4)
    range.setEnd(textNode(host1), 4)
    expect(brief(captureHighlightRanges(range, main))).toEqual([
      [0, 'orig', 4, 19, 'quick brown fox'],
      [1, 'orig', 0, 4, 'item'],
    ])
    document.body.innerHTML = ''
  })
})
