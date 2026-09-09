import { describe, expect, it } from 'vitest'
import { IngestError } from '../ingest'
import type { NormalizedBlock } from '../types'
import { parseHtmlBytes } from './parseHtmlBytes'
import { serializeUrlBundle } from './urlBundle'
import { encodeWebSnapshot } from './webSnapshot'

const snapshotBlocks: NormalizedBlock[] = [
  { index: 0, kind: 'heading', level: 1, text: '快照标题', anchor: { kind: 'html', blockIndex: 0 } },
  { index: 1, kind: 'paragraph', text: '快照正文', anchor: { kind: 'html', blockIndex: 1, section: '快照标题' } },
]

const snapshotBytes = () =>
  encodeWebSnapshot({
    header: {
      url: 'https://a.com',
      finalUrl: 'https://a.com',
      title: '快照标题',
      capture: { mode: 'rendered', katex: false, viewportWidth: 1280, agentVersion: 1 },
      html: '<html><body><p data-pc-block="1">快照正文</p></body></html>',
      blocks: snapshotBlocks,
      stats: { assetBytes: 0, skipped: [] },
    },
    assets: [{ id: 'aaa', url: 'https://a.com/a.css', mime: 'text/css', bytes: new Uint8Array([1, 2]) }],
  }).bytes

describe('parseHtmlBytes（按魔数分流）', () => {
  it('PCS1 字节 → 快照解析器：原样返回头里的块与标题', async () => {
    const result = await parseHtmlBytes(snapshotBytes())
    expect(result.blocks).toEqual(snapshotBlocks)
    expect(result.title).toBe('快照标题')
  })

  it('URL 合集 JSON → urlBundle 解析器：走 normalizeHtmlSections 推块', async () => {
    const bytes = serializeUrlBundle({
      sources: [{ url: 'https://a.com', title: '合集标题', html: '<h1>合集标题</h1><p>合集正文</p>' }],
    })
    const result = await parseHtmlBytes(bytes)
    expect(result.title).toBe('合集标题')
    expect(result.blocks.map((b) => b.text)).toContain('合集正文')
    // 快照头里的块不会出现在这条分支上（两个解析器互不串味）
    expect(result.blocks.some((b) => b.text === '快照正文')).toBe(false)
  })

  it('两条分支的损坏字节都归类为 corrupt', async () => {
    const notJson = new TextEncoder().encode('not json at all').buffer as ArrayBuffer
    await expect(parseHtmlBytes(notJson)).rejects.toThrow(IngestError)

    const truncatedSnapshot = snapshotBytes().slice(0, 10)
    await expect(parseHtmlBytes(truncatedSnapshot)).rejects.toBeInstanceOf(IngestError)
  })
})
