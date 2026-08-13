import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_BYTES,
  extOf,
  sha256Hex,
  sniffMagic,
  validateFile,
  validateFileMeta,
} from './validate'

const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // '%PDF-1.7'
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]) // 'PK\x03\x04'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('extOf', () => {
  it('取最后一个点之后的小写扩展名；无点则空串', () => {
    expect(extOf('a.b.PDF')).toBe('pdf')
    expect(extOf('noext')).toBe('')
  })
})

describe('sniffMagic', () => {
  it('%PDF- → pdf', () => {
    expect(sniffMagic(PDF_HEAD)).toBe('pdf')
  })

  it('PK\\x03\\x04 → docx（zip 容器）', () => {
    expect(sniffMagic(ZIP_HEAD)).toBe('docx')
  })

  it('头部过短或无签名 → null', () => {
    expect(sniffMagic(new Uint8Array([0x25, 0x50]))).toBeNull()
    expect(sniffMagic(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull()
  })
})

describe('validateFileMeta', () => {
  it('合法 PDF 通过并归一化 mime', () => {
    const r = validateFileMeta({ name: 'paper.pdf', size: 1024, type: 'application/pdf' })
    expect(r).toEqual({ ok: true, format: 'pdf', mime: 'application/pdf' })
  })

  it('合法 DOCX 通过', () => {
    const r = validateFileMeta({ name: 'paper.docx', size: 2048, type: DOCX_MIME })
    expect(r.ok).toBe(true)
  })

  it('.doc 被单独拒绝并给出可操作提示', () => {
    const r = validateFileMeta({ name: 'old.doc', size: 1024, type: 'application/msword' })
    expect(r).toMatchObject({ ok: false, kind: 'unsupported-format' })
    expect(r.ok === false && r.message).toContain('.docx')
  })

  it('其他扩展名（.txt）被拒绝', () => {
    expect(validateFileMeta({ name: 'note.txt', size: 10, type: 'text/plain' })).toMatchObject({
      ok: false,
      kind: 'unsupported-format',
    })
  })

  it('MIME 明确冲突时拒绝', () => {
    expect(validateFileMeta({ name: 'paper.pdf', size: 10, type: 'image/png' })).toMatchObject({
      ok: false,
      kind: 'unsupported-format',
    })
  })

  it('MIME 为空串或 octet-stream 时放行（浏览器差异大）', () => {
    expect(validateFileMeta({ name: 'paper.pdf', size: 10, type: '' }).ok).toBe(true)
    expect(validateFileMeta({ name: 'paper.docx', size: 10, type: 'application/octet-stream' }).ok).toBe(true)
  })

  it('0 字节 → empty', () => {
    expect(validateFileMeta({ name: 'paper.pdf', size: 0, type: 'application/pdf' })).toMatchObject({
      ok: false,
      kind: 'empty',
    })
  })

  it('超过 50MB → too-large，消息里带实际大小', () => {
    const r = validateFileMeta({ name: 'big.pdf', size: MAX_FILE_BYTES + 1, type: 'application/pdf' })
    expect(r).toMatchObject({ ok: false, kind: 'too-large' })
    expect(r.ok === false && r.message).toContain('50 MB')
  })
})

describe('validateFile（联合 magic bytes）', () => {
  it('扩展名与 magic 一致 → 通过', () => {
    expect(validateFile({ name: 'p.pdf', size: 100, type: 'application/pdf' }, PDF_HEAD).ok).toBe(true)
    expect(validateFile({ name: 'p.docx', size: 100, type: DOCX_MIME }, ZIP_HEAD).ok).toBe(true)
  })

  it('magic 与扩展名不符 → corrupt', () => {
    const r = validateFile({ name: 'fake.pdf', size: 100, type: 'application/pdf' }, ZIP_HEAD)
    expect(r).toMatchObject({ ok: false, kind: 'corrupt' })
    expect(r.ok === false && r.message).toContain('扩展名')
  })

  it('头部过短 → corrupt', () => {
    expect(validateFile({ name: 'p.pdf', size: 100, type: 'application/pdf' }, new Uint8Array([0x25]))).toMatchObject({
      ok: false,
      kind: 'corrupt',
    })
  })

  it('元数据层先失败时不再看 magic（大小优先于内容）', () => {
    expect(validateFile({ name: 'p.pdf', size: 0, type: 'application/pdf' }, PDF_HEAD)).toMatchObject({
      ok: false,
      kind: 'empty',
    })
  })
})

describe('sha256Hex', () => {
  it('空输入 = 已知向量 e3b0c442...', async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('"abc" = 已知向量 ba7816bf...；相同字节得到相同摘要', async () => {
    const bytes = new TextEncoder().encode('abc')
    const a = await sha256Hex(bytes.buffer as ArrayBuffer)
    expect(a).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe(a)
  })
})
