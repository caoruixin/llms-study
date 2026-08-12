import { describe, expect, it } from 'vitest'
import { blockDomId, buildAnchorContext, describeTarget, pageDomId, resolveAnchor } from './anchors'
import type { NormalizedBlock } from './types'

const pdfBlocks: NormalizedBlock[] = [
  { index: 0, kind: 'heading', level: 1, text: 'Abstract', anchor: { kind: 'pdf', blockIndex: 0, page: 1, section: 'Abstract' } },
  { index: 1, kind: 'paragraph', text: '摘要正文', anchor: { kind: 'pdf', blockIndex: 1, page: 1, section: 'Abstract' } },
  { index: 2, kind: 'heading', level: 1, text: '3 Method', anchor: { kind: 'pdf', blockIndex: 2, page: 4, section: '3 Method' } },
  { index: 3, kind: 'paragraph', text: '方法正文', anchor: { kind: 'pdf', blockIndex: 3, page: 4, section: '3 Method' } },
  { index: 4, kind: 'paragraph', text: '方法续', anchor: { kind: 'pdf', blockIndex: 4, page: 5, section: '3 Method' } },
]

const docxBlocks: NormalizedBlock[] = [
  { index: 0, kind: 'heading', level: 1, text: '引言', anchor: { kind: 'docx', blockIndex: 0, section: '引言' } },
  { index: 1, kind: 'paragraph', text: '正文', anchor: { kind: 'docx', blockIndex: 1, section: '引言' } },
]

const pdfCtx = buildAnchorContext(pdfBlocks, 9)
const docxCtx = buildAnchorContext(docxBlocks)

describe('buildAnchorContext', () => {
  it('建立块→页、页→首块、章节→首块/页 的映射', () => {
    expect(pdfCtx.blockCount).toBe(5)
    expect(pdfCtx.pageCount).toBe(9)
    expect(pdfCtx.pageOfBlock[3]).toBe(4)
    expect(pdfCtx.firstBlockOfPage[4]).toBe(2)
    expect(pdfCtx.firstBlockOfSection['3 Method']).toBe(2)
    expect(pdfCtx.pageOfSection['3 Method']).toBe(4)
  })

  it('DOCX 无页概念：pageCount 与页映射为空', () => {
    expect(docxCtx.pageCount).toBeUndefined()
    expect(docxCtx.pageOfBlock[1]).toBeUndefined()
    expect(docxCtx.firstBlockOfPage).toEqual({})
  })
})

describe('resolveAnchor · 文本视图', () => {
  it('块序号有效 → 精确到块，并带出页码', () => {
    const t = resolveAnchor({ kind: 'pdf', blockIndex: 3, page: 4 }, pdfCtx, 'text')
    expect(t).toMatchObject({ precision: 'block', blockIndex: 3, page: 4, domId: blockDomId(3) })
  })

  it('块序号越界（旧索引/解析器漂移）→ 回退到该页首块', () => {
    const t = resolveAnchor({ kind: 'pdf', blockIndex: 999, page: 4 }, pdfCtx, 'text')
    expect(t).toMatchObject({ precision: 'page', blockIndex: 2, page: 4, domId: blockDomId(2) })
  })

  it('页码也无效 → 回退到章节首块', () => {
    const t = resolveAnchor({ kind: 'pdf', blockIndex: -1, page: 99, section: '3 Method' }, pdfCtx, 'text')
    expect(t).toMatchObject({ precision: 'section', blockIndex: 2, section: '3 Method' })
  })

  it('什么都定位不到 → none，且不给 domId', () => {
    const t = resolveAnchor({ kind: 'pdf', blockIndex: 999, section: '不存在的章节' }, pdfCtx, 'text')
    expect(t.precision).toBe('none')
    expect(t.domId).toBeUndefined()
  })

  it('anchor 缺失（null/undefined）不抛错', () => {
    expect(resolveAnchor(null, pdfCtx, 'text').precision).toBe('none')
    expect(resolveAnchor(undefined, pdfCtx, 'text').precision).toBe('none')
  })

  it('DOCX 段落锚点精确到块', () => {
    expect(resolveAnchor({ kind: 'docx', blockIndex: 1 }, docxCtx, 'text')).toMatchObject({
      precision: 'block',
      blockIndex: 1,
      domId: blockDomId(1),
    })
  })

  it('非整数块序号按无效处理', () => {
    expect(resolveAnchor({ blockIndex: 1.5, page: 4 }, pdfCtx, 'text').precision).toBe('page')
  })
})

describe('resolveAnchor · 原版 PDF 视图', () => {
  it('由块序号反查页码（块序号是稳定主键，优先于 anchor 自带页码）', () => {
    const t = resolveAnchor({ kind: 'pdf', blockIndex: 4, page: 2 }, pdfCtx, 'original')
    expect(t).toMatchObject({ precision: 'page', page: 5, blockIndex: 4, domId: pageDomId(5) })
  })

  it('块序号越界 → 用 anchor 自带页码', () => {
    expect(resolveAnchor({ blockIndex: 999, page: 7 }, pdfCtx, 'original')).toMatchObject({
      precision: 'page',
      page: 7,
      domId: pageDomId(7),
    })
  })

  it('页码超过总页数 → 视为无效，落到章节所在页', () => {
    const t = resolveAnchor({ blockIndex: 999, page: 100, section: '3 Method' }, pdfCtx, 'original')
    expect(t).toMatchObject({ precision: 'section', page: 4, domId: pageDomId(4) })
  })

  it('页与章节都无从得知 → none', () => {
    expect(resolveAnchor({ section: '不存在' }, pdfCtx, 'original').precision).toBe('none')
  })

  it('DOCX 没有页：原版模式一律 none（DOCX 只有语义化视图）', () => {
    expect(resolveAnchor({ kind: 'docx', blockIndex: 1 }, docxCtx, 'original').precision).toBe('none')
  })
})

describe('describeTarget', () => {
  it('把定位精度翻译成用户可读文案', () => {
    expect(describeTarget(resolveAnchor({ blockIndex: 3 }, pdfCtx, 'text'))).toBe('第 4 页 · 第 4 段')
    expect(describeTarget(resolveAnchor({ blockIndex: 3 }, pdfCtx, 'original'))).toBe('第 4 页')
    expect(describeTarget(resolveAnchor({ section: '3 Method' }, pdfCtx, 'original'))).toBe('章节「3 Method」')
    expect(describeTarget(resolveAnchor({ section: '不存在' }, pdfCtx, 'original'))).toBe('无法定位到原文位置')
  })
})
