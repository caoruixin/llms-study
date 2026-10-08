import type { ReaderMode } from '../anchors'
import type { LangMode } from '../types'
import type { ExportFlavor } from './exportTypes'

/**
 * 导出版本判定与标签（A.0 口径）。单独成轻模块：工作台页面要同步算按钮可见性与 title，
 * 只能静态引这里；导出内核（exportPaper 及其依赖）由 ExportDialog 动态 import，不进工作台 chunk。
 */

export const FLAVOR_LABEL: Record<ExportFlavor, string> = {
  'pdf-zh-overlay': '中文覆盖版',
  'pdf-both-flow': '中英对照流版',
  'text-zh': '文本排版版（中文）',
  'text-both': '文本排版版（中英对照）',
}

export const isInPlaceFlavor = (f: ExportFlavor): f is 'pdf-zh-overlay' | 'pdf-both-flow' =>
  f === 'pdf-zh-overlay' || f === 'pdf-both-flow'

/** 原版版本 → 对应语言的文本排版版（解析失败回退用） */
export const textFlavorOf = (f: ExportFlavor): 'text-zh' | 'text-both' =>
  f === 'pdf-zh-overlay' || f === 'text-zh' ? 'text-zh' : 'text-both'

/**
 * 当前视图 → 导出版本（A.0 口径）：原文 → null（不显示按钮）；原版 PDF 视图且带几何 → 覆盖 / 对照流；
 * 其余（文本视图 / 网页原貌 / DOCX / URL / 旧版解析）→ 文本排版版。`pdfInPlace` 不含视图判断——带 layout 的 PDF
 * 在文本视图下必须导出文本排版版，所以这里同时看 mode。
 */
export function exportFlavorFor(args: { mode: ReaderMode; pdfInPlace: boolean; langMode: LangMode }): ExportFlavor | null {
  const { mode, pdfInPlace, langMode } = args
  if (langMode === 'orig') return null
  const zh = langMode === 'zh'
  if (mode === 'original' && pdfInPlace) return zh ? 'pdf-zh-overlay' : 'pdf-both-flow'
  return zh ? 'text-zh' : 'text-both'
}
