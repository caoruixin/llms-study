import { describe, expect, it } from 'vitest'
import { IngestError } from '../ingest'
import type { NormalizedBlock } from '../types'
import { sha256Hex } from '../validate'
import {
  MAX_SNAPSHOT_HTML_BYTES,
  WEB_SNAPSHOT_MIME,
  WEB_SNAPSHOT_VERSION,
  decodeWebSnapshot,
  encodeWebSnapshot,
  parseWebSnapshotBytes,
  type WebSnapshotInput,
} from './webSnapshot'
import { WEB_SNAPSHOT_MAGIC, looksLikeWebSnapshot } from './webSnapshotMime'
import { serializeUrlBundle } from './urlBundle'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const blocks: NormalizedBlock[] = [
  { index: 0, kind: 'heading', level: 1, text: '标题', anchor: { kind: 'html', blockIndex: 0 } },
  { index: 1, kind: 'paragraph', text: '正文一段', anchor: { kind: 'html', blockIndex: 1, section: '标题' } },
  {
    index: 2,
    kind: 'image',
    text: '[图: 示意图]',
    src: 'https://a.com/x.png',
    anchor: { kind: 'html', blockIndex: 2, section: '标题' },
  },
]

const baseHeader = (): WebSnapshotInput['header'] => ({
  url: 'https://a.com',
  finalUrl: 'https://a.com/final',
  title: 'A 页',
  capture: { mode: 'rendered', katex: true, viewportWidth: 1280, agentVersion: 1 },
  html: '<html><body><p data-pc-block="1">正文一段</p></body></html>',
  blocks,
  stats: { assetBytes: 0, skipped: [] },
})

const bytesOf = (...values: number[]) => new Uint8Array(values)
/** 覆盖全部 256 个字节值的二进制资源：验证容器对任意字节透明（含 0x00 与魔数片段） */
const allByteValues = () => Uint8Array.from({ length: 256 }, (_, i) => i)

const assetsFixture = () => [
  { id: 'bbb', url: 'https://a.com/b.png', mime: 'image/png', bytes: allByteValues() },
  { id: 'aaa', url: 'https://a.com/a.css', mime: 'text/css', bytes: new Uint8Array(0) },
  { id: 'ccc', url: 'https://a.com/c.woff2', mime: 'font/woff2', bytes: bytesOf(1, 2, 3) },
]

/** 手搓容器：'PCS1' | u32 LE 头长 | 头字节 | 资源区。损坏用例与「原样透传」用例都靠它构造 */
const container = (headerBytes: Uint8Array, assetRegion: Uint8Array = new Uint8Array(0), headerLength?: number): ArrayBuffer => {
  const out = new Uint8Array(8 + headerBytes.byteLength + assetRegion.byteLength)
  out.set(WEB_SNAPSHOT_MAGIC, 0)
  new DataView(out.buffer).setUint32(4, headerLength ?? headerBytes.byteLength, true)
  out.set(headerBytes, 8)
  out.set(assetRegion, 8 + headerBytes.byteLength)
  return out.buffer as ArrayBuffer
}
const containerOf = (header: unknown, assetRegion?: Uint8Array, headerLength?: number) =>
  container(new TextEncoder().encode(JSON.stringify(header)), assetRegion, headerLength)

const validHeaderJson = () => ({
  kind: 'web-snapshot',
  version: 1,
  url: 'https://a.com',
  finalUrl: 'https://a.com',
  title: 'T',
  capture: { mode: 'static', katex: false, viewportWidth: 1024, agentVersion: 1 },
  html: '<html></html>',
  assets: [],
  blocks: [],
  stats: { assetBytes: 0, skipped: [] },
})

const expectCorrupt = (bytes: ArrayBuffer) => {
  expect(() => decodeWebSnapshot(bytes)).toThrow(IngestError)
  try {
    decodeWebSnapshot(bytes)
    expect.fail('应当抛出 IngestError')
  } catch (e) {
    expect(e).toBeInstanceOf(IngestError)
    expect((e as IngestError).kind).toBe('corrupt')
  }
}

// ---------------------------------------------------------------------------

describe('webSnapshotMime', () => {
  it('mime / 魔数 / 版本 / html 上限都是稳定字面量', () => {
    expect(WEB_SNAPSHOT_MIME).toBe('application/x-paper-web-snapshot')
    expect(WEB_SNAPSHOT_MAGIC).toEqual([0x50, 0x43, 0x53, 0x31])
    expect(new TextDecoder().decode(new Uint8Array(WEB_SNAPSHOT_MAGIC))).toBe('PCS1')
    expect(WEB_SNAPSHOT_VERSION).toBe(1)
    expect(MAX_SNAPSHOT_HTML_BYTES).toBe(8 * 1024 * 1024)
  })

  it('looksLikeWebSnapshot：快照字节为真', () => {
    const { bytes } = encodeWebSnapshot({ header: baseHeader(), assets: [] })
    expect(looksLikeWebSnapshot(bytes)).toBe(true)
  })

  it('looksLikeWebSnapshot：URL 合集 JSON / 空字节 / 不足 4 字节为假', () => {
    expect(looksLikeWebSnapshot(serializeUrlBundle({ sources: [{ url: 'https://a.com', html: '<p>x</p>' }] }))).toBe(
      false,
    )
    expect(looksLikeWebSnapshot(new ArrayBuffer(0))).toBe(false)
    expect(looksLikeWebSnapshot(bytesOf(0x50, 0x43, 0x53).buffer as ArrayBuffer)).toBe(false)
    expect(looksLikeWebSnapshot(bytesOf(0x50, 0x43, 0x53, 0x32).buffer as ArrayBuffer)).toBe(false)
  })
})

describe('encodeWebSnapshot（字节布局）', () => {
  it('布局为 魔数 | u32 LE 头长 | UTF-8 JSON 头 | 资源区', () => {
    const { bytes, header } = encodeWebSnapshot({ header: baseHeader(), assets: assetsFixture() })
    const view = new Uint8Array(bytes)
    expect(Array.from(view.slice(0, 4))).toEqual(WEB_SNAPSHOT_MAGIC)

    const headerLength = new DataView(bytes).getUint32(4, true)
    const headerText = new TextDecoder().decode(new Uint8Array(bytes, 8, headerLength))
    expect(JSON.parse(headerText)).toEqual(header)
    expect(headerText.startsWith('{"kind":"web-snapshot","version":1,"url":')).toBe(true)
    expect(bytes.byteLength).toBe(8 + headerLength + 256 + 0 + 3)
  })

  it('资源按 id 升序排列，offset 相对资源区起点且首尾相接', () => {
    const { header } = encodeWebSnapshot({ header: baseHeader(), assets: assetsFixture() })
    expect(header.assets.map((a) => a.id)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(header.assets.map((a) => [a.offset, a.length])).toEqual([
      [0, 0],
      [0, 256],
      [256, 3],
    ])
  })

  it('stats.assetBytes 由实际写入的资源重算（不透传调用方的值）', () => {
    const header = baseHeader()
    header.stats = { assetBytes: 999999, skipped: [] }
    const encoded = encodeWebSnapshot({ header, assets: assetsFixture() })
    expect(encoded.header.stats.assetBytes).toBe(259)
  })

  it('stats.skipped 截断到 50 条', () => {
    const header = baseHeader()
    header.stats = {
      assetBytes: 0,
      skipped: Array.from({ length: 73 }, (_, i) => ({ url: `https://a.com/${i}`, reason: 'cap' as const })),
    }
    const { header: out } = encodeWebSnapshot({ header, assets: [] })
    expect(out.stats.skipped).toHaveLength(50)
    expect(out.stats.skipped[49].url).toBe('https://a.com/49')
  })

  it('id 重复时先到先得（后来的同 id 资源被丢弃，字节不重复写入）', () => {
    const { bytes, header } = encodeWebSnapshot({
      header: baseHeader(),
      assets: [
        { id: 'dup', url: 'https://a.com/first.png', mime: 'image/png', bytes: bytesOf(9, 9) },
        { id: 'dup', url: 'https://a.com/second.png', mime: 'image/webp', bytes: bytesOf(7, 7) },
      ],
    })
    expect(header.assets).toHaveLength(1)
    expect(header.assets[0]).toMatchObject({ url: 'https://a.com/first.png', mime: 'image/png', length: 2 })
    expect(header.stats.assetBytes).toBe(2)
    expect(Array.from(decodeWebSnapshot(bytes).assetBytes('dup')!)).toEqual([9, 9])
  })
})

describe('encodeWebSnapshot（确定性）', () => {
  it('同输入两次编码逐字节一致，且 sha256 相同', async () => {
    const a = encodeWebSnapshot({ header: baseHeader(), assets: assetsFixture() })
    const b = encodeWebSnapshot({ header: baseHeader(), assets: assetsFixture() })
    expect(new Uint8Array(a.bytes)).toEqual(new Uint8Array(b.bytes))
    expect(await sha256Hex(a.bytes)).toBe(await sha256Hex(b.bytes))
  })

  it('资源顺序不同 + 头对象属性插入顺序不同 → 仍是同一份字节与同一个 sha256', async () => {
    const shuffled = [assetsFixture()[2], assetsFixture()[0], assetsFixture()[1]]
    // 属性插入顺序刻意与 baseHeader() 相反：不透传调用方对象，字节只由内容决定
    const reordered: WebSnapshotInput['header'] = {
      stats: { assetBytes: 0, skipped: [] },
      blocks: blocks.map((b) => ({ anchor: b.anchor, text: b.text, kind: b.kind, index: b.index, ...(b.level !== undefined ? { level: b.level } : {}), ...(b.src !== undefined ? { src: b.src } : {}) })),
      html: baseHeader().html,
      capture: { agentVersion: 1, viewportWidth: 1280, katex: true, mode: 'rendered' },
      title: 'A 页',
      finalUrl: 'https://a.com/final',
      url: 'https://a.com',
    }
    const a = encodeWebSnapshot({ header: baseHeader(), assets: assetsFixture() })
    const b = encodeWebSnapshot({ header: reordered, assets: shuffled })
    expect(new Uint8Array(b.bytes)).toEqual(new Uint8Array(a.bytes))
    expect(await sha256Hex(b.bytes)).toBe(await sha256Hex(a.bytes))
  })

  it('字节里不含时间戳类字段（调用方对象上挂的额外字段也不会泄漏）', () => {
    const header = { ...baseHeader(), fetchedAt: 123, extra: 'nope' } as unknown as WebSnapshotInput['header']
    const { bytes } = encodeWebSnapshot({ header, assets: [] })
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toContain('fetchedAt')
    expect(text).not.toContain('extra')
  })
})

describe('decodeWebSnapshot（往返）', () => {
  it('头字段与资源字节完整往返（含 0 字节资源与全字节值二进制资源）', () => {
    const input = { header: baseHeader(), assets: assetsFixture() }
    const { bytes, header } = encodeWebSnapshot(input)
    const decoded = decodeWebSnapshot(bytes)

    expect(decoded.header).toEqual(header)
    expect(decoded.header.url).toBe('https://a.com')
    expect(decoded.header.finalUrl).toBe('https://a.com/final')
    expect(decoded.header.title).toBe('A 页')
    expect(decoded.header.capture).toEqual({ mode: 'rendered', katex: true, viewportWidth: 1280, agentVersion: 1 })
    expect(decoded.header.html).toBe(input.header.html)

    expect(decoded.assetBytes('aaa')).toEqual(new Uint8Array(0))
    expect(decoded.assetBytes('bbb')).toEqual(allByteValues())
    expect(decoded.assetBytes('ccc')).toEqual(bytesOf(1, 2, 3))
    expect(decoded.assetBytes('missing')).toBeNull()
  })

  it('assetBytes 返回的是视图而非拷贝（不为 30MB 资源集再复制一份）', () => {
    const { bytes } = encodeWebSnapshot({ header: baseHeader(), assets: assetsFixture() })
    const view = decodeWebSnapshot(bytes).assetBytes('ccc')!
    expect(view.buffer).toBe(bytes)
    expect(view.byteLength).toBe(3)
  })

  it('块原样透传：未知新增字段不被吞掉', () => {
    const header = { ...validHeaderJson(), blocks: [{ index: 0, kind: 'paragraph', text: 'x', anchor: {}, future: 1 }] }
    const decoded = decodeWebSnapshot(containerOf(header))
    expect(decoded.header.blocks[0]).toEqual({ index: 0, kind: 'paragraph', text: 'x', anchor: {}, future: 1 })
  })
})

describe('decodeWebSnapshot（损坏检测）', () => {
  it('文件长度不足 8 字节', () => expectCorrupt(new ArrayBuffer(0)))
  it('魔数不匹配（URL 合集 JSON 被喂进来）', () =>
    expectCorrupt(serializeUrlBundle({ sources: [{ url: 'https://a.com', html: '<p>x</p>' }] })))
  it('魔数被改写一个字节', () => {
    const { bytes } = encodeWebSnapshot({ header: baseHeader(), assets: [] })
    new Uint8Array(bytes)[0] = 0x51
    expectCorrupt(bytes)
  })
  it('头长度越界（超过文件长度）', () => expectCorrupt(containerOf(validHeaderJson(), undefined, 0xffff)))
  it('头不是合法 JSON', () => expectCorrupt(container(new TextEncoder().encode('not json at all'))))
  it('头是 JSON 但不是对象', () => expectCorrupt(containerOf([1, 2, 3])))
  it('kind 字段不匹配', () => expectCorrupt(containerOf({ ...validHeaderJson(), kind: 'url-bundle' })))
  it('version 字段不匹配', () => expectCorrupt(containerOf({ ...validHeaderJson(), version: 2 })))
  it('url 字段缺失', () => {
    const h: Record<string, unknown> = validHeaderJson()
    delete h.url
    expectCorrupt(containerOf(h))
  })
  it('title 不是字符串', () => expectCorrupt(containerOf({ ...validHeaderJson(), title: 123 })))
  it('html 字段缺失', () => {
    const h: Record<string, unknown> = validHeaderJson()
    delete h.html
    expectCorrupt(containerOf(h))
  })
  it('capture 不是对象', () => expectCorrupt(containerOf({ ...validHeaderJson(), capture: 'rendered' })))
  it('capture.mode 取值非法', () =>
    expectCorrupt(containerOf({ ...validHeaderJson(), capture: { mode: 'x', katex: false, viewportWidth: 1, agentVersion: 1 } })))
  it('assets 不是数组', () => expectCorrupt(containerOf({ ...validHeaderJson(), assets: {} })))
  it('资源 offset/length 越出资源区（伪造的头声称资源比文件还长）', () => {
    const header = { ...validHeaderJson(), assets: [{ id: 'a', url: 'https://a.com/a', mime: 'image/png', offset: 0, length: 99 }] }
    expectCorrupt(containerOf(header, bytesOf(1, 2, 3)))
  })
  it('资源 offset 为负数', () => {
    const header = { ...validHeaderJson(), assets: [{ id: 'a', url: 'https://a.com/a', mime: 'image/png', offset: -1, length: 1 }] }
    expectCorrupt(containerOf(header, bytesOf(1, 2, 3)))
  })
  it('blocks 不是数组', () => expectCorrupt(containerOf({ ...validHeaderJson(), blocks: 'nope' })))
  it('某个块缺少 index/kind/text/anchor', () => {
    expectCorrupt(containerOf({ ...validHeaderJson(), blocks: [{ kind: 'paragraph', text: 'x', anchor: {} }] }))
    expectCorrupt(containerOf({ ...validHeaderJson(), blocks: [{ index: 0, text: 'x', anchor: {} }] }))
    expectCorrupt(containerOf({ ...validHeaderJson(), blocks: [{ index: 0, kind: 'paragraph', anchor: {} }] }))
    expectCorrupt(containerOf({ ...validHeaderJson(), blocks: [{ index: 0, kind: 'paragraph', text: 'x' }] }))
  })
  it('stats 缺失或 skipped.reason 非法', () => {
    const h: Record<string, unknown> = validHeaderJson()
    delete h.stats
    expectCorrupt(containerOf(h))
    expectCorrupt(
      containerOf({ ...validHeaderJson(), stats: { assetBytes: 0, skipped: [{ url: 'https://a.com', reason: 'wat' }] } }),
    )
  })
})

describe('parseWebSnapshotBytes', () => {
  it('原样返回 header.blocks 与 title（解析 = 解 JSON，不重推 DOM）', () => {
    const { bytes } = encodeWebSnapshot({ header: baseHeader(), assets: assetsFixture() })
    const result = parseWebSnapshotBytes(bytes)
    expect(result.blocks).toEqual(blocks)
    expect(result.title).toBe('A 页')
    expect(result.pageCount).toBeUndefined()
  })

  it('损坏字节沿用 decode 的分类（corrupt）', () => {
    expect(() => parseWebSnapshotBytes(container(new TextEncoder().encode('{'))))
      .toThrow(IngestError)
  })
})
