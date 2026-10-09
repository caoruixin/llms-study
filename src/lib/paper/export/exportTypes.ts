import type { Rect } from '../pdfLayout'
import type { PaperBlock, PaperRecord } from '../types'

/**
 * 导出 PDF 的公共类型（PLAN-export-pdf-copilot-compose A.5）。
 * 规划器（inPlacePlan / textDocPlan）只产出 `PagePlan`（PDF 用户空间，y 向上，单位 pt），执行器用 pdf-lib 落笔；
 * 规划器不碰 DOM、不碰 pdf-lib，全部可在 node 下单测。
 */

export type ExportFlavor = 'pdf-zh-overlay' | 'pdf-both-flow' | 'text-zh' | 'text-both'

/** 0–1 的 RGB（pdf-lib `rgb()` 口径） */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** 字体度量（fontkit 口径：ascent 正、descent 负，单位 unitsPerEm） */
export interface FontMetrics {
  unitsPerEm: number
  ascent: number
  descent: number
}

/** 规划器需要的全部字体能力：度量 + 按字号测宽 + 可选的字符清洗（缺字 → □），cjkFont.CjkFont 实现它 */
export interface PlanFont {
  metrics: FontMetrics
  /** 文本在 size pt 下的宽度（pt）：Σ advance × size / upm，与 pdf-lib 写出的 /W 一致 */
  measureAt(text: string, size: number): number
  sanitize?(text: string): string
}

export type DrawOp =
  | {
      kind: 'text'
      /** 基线左端 */
      x: number
      y: number
      text: string
      size: number
      color: Rgb
      /** Tc 字符间距（两端对齐）；缺省 0 */
      charSpacing?: number
      /** 描边仿粗（Tr 2，线宽 0.028 × size） */
      bold?: boolean
    }
  | {
      kind: 'rect'
      x: number
      y: number
      w: number
      h: number
      fill?: Rgb
      stroke?: Rgb
      strokeWidth?: number
      dash?: number[]
    }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: Rgb }
  | {
      /** 原页条带：裁切矩形 clip 内画整页 XObject，平移 (tx, ty)——见 inPlacePlan.planFlowPage 的坐标推导 */
      kind: 'strip'
      srcPage: number
      clip: Rect
      tx: number
      ty: number
    }
  | { kind: 'image'; blockIndex: number; x: number; y: number; w: number; h: number }

export interface PagePlan {
  width: number
  height: number
  /** existing = 在原文档第 index（0 起）页上叠画；new = 新建页；copy = 原样复制原页（旋转页） */
  base: { kind: 'existing'; index: number } | { kind: 'new' } | { kind: 'copy'; srcPage: number }
  ops: DrawOp[]
}

export type ExportPhase = 'lib' | 'font' | 'open' | 'pages' | 'save'

export interface ExportProgress {
  phase: ExportPhase
  done?: number
  total?: number
  /** font 阶段：已下载字节 */
  bytes?: number
}

export interface ExportInput {
  paper: PaperRecord
  blocks: readonly PaperBlock[]
  /** blockIndex → 译文（当前已有的全部译文；缺译块按版本语义保留原文） */
  texts: ReadonlyMap<number, string>
  flavor: ExportFlavor
  /** 原始文件字节（只有原版两种版本会调用；拿不到抛 ExportError('bytes') → 编排层回退文本排版版） */
  getBytes: () => Promise<ArrayBuffer>
  signal?: AbortSignal
  onProgress?: (p: ExportProgress) => void
}

export interface ExportResult {
  bytes: Uint8Array
  fileName: string
  pageCount: number
  /** 可译但缺译、输出里保留原文的块数：按实际产出版本计（覆盖版不含图内标签 / 旋转页等本不出译文的块） */
  untranslated: number
  /** 实际产出的版本（原版拿不到字节 / 解析失败会自动改走文本排版版） */
  flavor: ExportFlavor
  /** 自动回退到文本排版版时的完整提示（原因 + 「已改为导出 X」），可直接展示 */
  fellBackToText?: string
}

export type ExportErrorCode = 'aborted' | 'font' | 'bytes' | 'parse' | 'unknown'

export class ExportError extends Error {
  readonly code: ExportErrorCode
  constructor(code: ExportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ExportError'
    this.code = code
  }
}

export const isAbortError = (e: unknown): boolean =>
  (e instanceof ExportError && e.code === 'aborted') || (e as { name?: unknown } | null)?.name === 'AbortError'

export const abortError = (): ExportError => new ExportError('aborted', '已取消导出')

/** 取消信号已触发 → 抛 ExportError('aborted')（各阶段之间调用） */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

export const rgbHex = (hex: number): Rgb => ({
  r: ((hex >> 16) & 0xff) / 255,
  g: ((hex >> 8) & 0xff) / 255,
  b: (hex & 0xff) / 255,
})

/** `#rgb` / `#rrggbb` / `rgb(r, g, b)` / `rgba(r, g, b, a)` → Rgb；其它写法 → null（调用方回退白底） */
export function cssColorToRgb(css: string): Rgb | null {
  const s = css.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h
    return rgbHex(parseInt(full, 16))
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(s)
  if (fn) {
    const c = (v: string) => Math.min(1, Math.max(0, Number(v) / 255))
    return { r: c(fn[1]), g: c(fn[2]), b: c(fn[3]) }
  }
  return null
}
