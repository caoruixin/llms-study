import type { IngestFailureKind, PaperFormat } from './types'

// §4.5 默认约束
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_PDF_PAGES = 500
export const MAX_TEXT_CHARS = 2_000_000

export interface FileMeta {
  name: string
  size: number
  type: string
}

export type ValidateResult =
  | { ok: true; format: PaperFormat; mime: string }
  | { ok: false; kind: IngestFailureKind; message: string }

/** MIME 白名单：浏览器/系统给出的 type 差异极大，空串与 octet-stream 一律放行，只拒绝明确冲突的 */
const MIME_BY_FORMAT: Record<PaperFormat, string[]> = {
  pdf: ['application/pdf', 'application/x-pdf'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
  ],
}

const LENIENT_MIME = ['', 'application/octet-stream']

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

/** magic bytes 粗检：'%PDF-' → pdf；'PK\x03\x04'（zip 容器）→ docx */
export function sniffMagic(head: Uint8Array): PaperFormat | null {
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) {
    return 'pdf'
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return 'docx'
  }
  return null
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

/** 第一层：扩展名 + MIME + 大小（不看文件内容，可在读字节前先跑，超大文件不必先读进内存） */
export function validateFileMeta(meta: FileMeta): ValidateResult {
  const ext = extOf(meta.name)

  if (ext === 'doc') {
    return { ok: false, kind: 'unsupported-format', message: '不支持旧版 .doc 格式，请用 Word 另存为 .docx 后重试' }
  }
  if (ext !== 'pdf' && ext !== 'docx') {
    return { ok: false, kind: 'unsupported-format', message: '仅支持 PDF 与 DOCX 两种格式' }
  }
  const format: PaperFormat = ext

  const type = (meta.type || '').toLowerCase()
  if (!LENIENT_MIME.includes(type) && !MIME_BY_FORMAT[format].includes(type)) {
    return { ok: false, kind: 'unsupported-format', message: `文件类型（${meta.type}）与扩展名 .${ext} 不匹配` }
  }

  if (meta.size === 0) {
    return { ok: false, kind: 'empty', message: '文件是空的（0 字节）' }
  }
  if (meta.size > MAX_FILE_BYTES) {
    return { ok: false, kind: 'too-large', message: `文件 ${mb(meta.size)} MB，超过 50 MB 上限` }
  }

  return { ok: true, format, mime: MIME_BY_FORMAT[format][0] }
}

/**
 * 第二层：在元数据校验通过后再联合 magic bytes 判定内容与扩展名是否一致。
 * DOCX 在这里只做 zip 容器粗检——OOXML 深检（word/document.xml 是否存在）留给浏览器端
 * mammoth 解压失败时分类为 corrupt，避免在纯函数层引入 zip 解析依赖。
 */
export function validateFile(meta: FileMeta, head: Uint8Array): ValidateResult {
  const base = validateFileMeta(meta)
  if (!base.ok) return base

  const magic = sniffMagic(head)
  if (magic === null) {
    return { ok: false, kind: 'corrupt', message: '无法识别文件内容（文件头缺失或已损坏）' }
  }
  if (magic !== base.format) {
    return { ok: false, kind: 'corrupt', message: '文件内容与扩展名不符（可能已损坏或被重命名）' }
  }
  return base
}

const HEX = '0123456789abcdef'

/** SHA-256 十六进制摘要，用于导入去重。node 24 与浏览器均原生提供 WebCrypto 全局，无需 polyfill */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let out = ''
  for (const b of view) out += HEX[b >> 4] + HEX[b & 15]
  return out
}
