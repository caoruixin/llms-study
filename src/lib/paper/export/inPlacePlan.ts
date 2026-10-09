import { pieceText, type FlowRow, type PageGeom, type Piece, type PortionRect, type Rect, type Strip } from '../pdfLayout'
import { cssColorToRgb, rgbHex, type DrawOp, type PagePlan, type PlanFont, type Rgb } from './exportTypes'
import { baselineOffset, fitTextInBox, justifySpacing, wrapText } from './textLayout'

/**
 * 原版 PDF 导出的纯规划器（PLAN A.5）：中文覆盖版 `planOverlayPage`、中英对照流版 `planFlowPage`。
 * 输入全部是 scale = 1 的页面 CSS 空间几何（pdfLayout 的 PortionRect / Piece / FlowRow，与屏幕同一份），
 * 输出 PDF 用户空间（y 向上）的 DrawOp；坐标换算只在这里做一次：
 *   `x' = cssX + pageX`，`y'(底) = pageY + pageHeight − (cssY + h)`，基线 `y' = pageY + pageHeight − baseline`。
 * 几何来自 pdf.js `page.getViewport({scale:1}).rawDims`（与 viewer 同源），不用 pdf-lib `getSize()`（MediaBox 口径）。
 */

/** 覆盖译文字色（= .paper-zh-block color #1a1814） */
export const OVERLAY_TEXT_COLOR: Rgb = rgbHex(0x1a1814)
/** 对照译文字色（= --color-fg #211f1a） */
export const FLOW_TEXT_COLOR: Rgb = rgbHex(0x211f1a)
/** 对照译文框：accent #9e2b3a 混白 5% 底、40% 左线（屏幕 color-mix 的实值） */
export const FLOW_BOX_FILL: Rgb = { r: 0.981, g: 0.958, b: 0.961 }
export const FLOW_BOX_BAR: Rgb = { r: 0.848, g: 0.667, b: 0.691 }
const WHITE: Rgb = { r: 1, g: 1, b: 1 }

/** 对照流译文框：字号 = clamp(0.92 × 正文行高, 7, 12)，行距 1.7 × 字号 */
export const FLOW_FONT_RATIO = 0.92
export const FLOW_FONT_MIN = 7
export const FLOW_FONT_MAX = 12
export const FLOW_PITCH_RATIO = 1.7
/** 框内边：左 6（文字起点）、右 4、上下 3；框外边：上 2、下 4；左线 1.5 pt */
export const FLOW_PAD_LEFT = 6
export const FLOW_PAD_RIGHT = 4
export const FLOW_PAD_Y = 3
export const FLOW_MARGIN_TOP = 2
export const FLOW_MARGIN_BOTTOM = 4
export const FLOW_BAR_W = 1.5
/** 译文框 x 范围：条带内至少留 4；无 bounds 或范围 < 40 → 条带内缩 8（镜像 PdfFlowPage.zhInset） */
const FLOW_EDGE = 4
const FLOW_INSET = 8
const FLOW_MIN_W = 40
const DEFAULT_LINE_H = 12

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const sortedIndices = (set: ReadonlySet<number>): number[] => [...set].sort((a, b) => a - b)

const median = (nums: readonly number[]): number => {
  if (nums.length === 0) return NaN
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 本页正文行高：全部行框高的中位数，没有行框 → 12 */
export function pageBodyLineH(portions: readonly PortionRect[]): number {
  const m = median(portions.flatMap((p) => p.lines.map((l) => l.h)))
  return m > 0 ? m : DEFAULT_LINE_H
}

/** 页面 CSS 空间（y 向下）→ PDF 用户空间（y 向上） */
export const toPdfX = (geom: PageGeom, cssX: number): number => cssX + geom.pageX
export const toPdfY = (geom: PageGeom, cssY: number): number => geom.pageY + geom.pageHeight - cssY

// ---------------------------------------------------------------------------
// 中文覆盖版
// ---------------------------------------------------------------------------

export interface OverlayPlanArgs {
  geom: PageGeom
  /** `buildPieces(portions, blockOf, 1, { round: false })` 的结果（含未译片） */
  pieces: readonly Piece[]
  texts: ReadonlyMap<number, string>
  /** piece.key → CSS 颜色（sampleBackgrounds）；缺省白底 */
  backgrounds?: ReadonlyMap<string, string>
  font: PlanFont
}

export interface OverlayPlan {
  ops: DrawOp[]
  /** 本页有覆盖片但缺译的块数（原文可见） */
  untranslated: number
  /** 同上的块号（升序）：跨页块每页都会出片，执行器按块号取并集，全篇只计一次 */
  untranslatedBlocks: number[]
}

/**
 * 每个覆盖片：底色矩形 + 逐行译文（`fitTextInBox` 拟合字号；居中片按 `(box.w − line.width) / 2`，
 * 其余首行缩进 + Tc 两端对齐；heading 描边仿粗）。缺译片跳过（按块计一次未译）。
 */
export function planOverlayPage({ geom, pieces, texts, backgrounds, font }: OverlayPlanArgs): OverlayPlan {
  const ops: DrawOp[] = []
  const missing = new Set<number>()
  for (const piece of pieces) {
    const full = texts.get(piece.block.index)
    if (full === undefined) {
      missing.add(piece.block.index)
      continue
    }
    const raw = pieceText(piece, full)
    const text = font.sanitize ? font.sanitize(raw) : raw
    const box = piece.box
    const fill = (backgrounds?.get(piece.key) && cssColorToRgb(backgrounds.get(piece.key)!)) || WHITE
    ops.push({ kind: 'rect', x: toPdfX(geom, box.x), y: toPdfY(geom, box.y + box.h), w: box.w, h: box.h, fill })
    if (text.trim() === '') continue
    const fit = fitTextInBox(text, { w: box.w, h: box.h }, {
      f0: piece.f0,
      pitch0: piece.lh0,
      fMin: piece.fMin,
      indent: piece.indent,
      measureAt: (t, s) => font.measureAt(t, s),
    })
    const bold = piece.block.kind === 'heading'
    for (let k = 0; k < fit.lines.length; k += 1) {
      const line = fit.lines[k]
      if (line.text === '') continue
      const top = box.y + k * fit.pitch
      const baseline = top + baselineOffset(fit.size, fit.pitch, font.metrics)
      const x = piece.center ? box.x + (box.w - line.width) / 2 : box.x + line.indent
      const cs = piece.center ? 0 : justifySpacing(line, box.w, fit.size)
      ops.push({
        kind: 'text',
        x: toPdfX(geom, x),
        y: toPdfY(geom, baseline),
        text: line.text,
        size: fit.size,
        color: OVERLAY_TEXT_COLOR,
        ...(cs > 0 ? { charSpacing: cs } : {}),
        ...(bold ? { bold: true } : {}),
      })
    }
  }
  return { ops, untranslated: missing.size, untranslatedBlocks: sortedIndices(missing) }
}

// ---------------------------------------------------------------------------
// 中英对照流版
// ---------------------------------------------------------------------------

export interface FlowPlanArgs {
  /** 1-based 原页码（strip op 的 srcPage） */
  page: number
  geom: PageGeom
  /** `partitionPageFlow` 的结果（与屏幕同序） */
  rows: readonly FlowRow[]
  /** `translationBounds` 的结果 */
  textBounds: ReadonlyMap<number, readonly [number, number]>
  texts: ReadonlyMap<number, string>
  /** `pageBodyLineH(portions)` */
  bodyLineH: number
  font: PlanFont
}

export interface FlowPlan extends PagePlan {
  base: { kind: 'new' }
  /** showTranslation 条带里缺译的块数 */
  untranslated: number
  /** 同上的块号（升序）；showTranslation 只落在块的最后一个 seg，跨页块本就只计一次，执行器照样取并集 */
  untranslatedBlocks: number[]
}

interface PendingStrip {
  src: Rect
  dst: { x: number; y: number }
}

/**
 * 自上而下走 rows：full 行 = 条带 `[0, pageWidth) × rect.h`；columns 行 = 左右两栈各自累加、行高取 max。
 * `showTranslation && texts.has(i)` 的条带下接译文框：x 范围 `[max(s.x + 4, bounds[0]), min(s.x + s.w − 4, bounds[1])]`
 * （无 bounds 或 < 40 → 条带内缩 8），`boxH = 2 × 3 + lines × pitch`，上下外边 2 / 4；无译条带精确前进 rect.h。
 * 页高 `H = 末 y`；条带 op：`clip = {x: dst.x, y: H − dst.y − src.h, w, h}`，`tx = dst.x − src.x − pageX`，
 * `ty = H − dst.y − pageY − pageHeight + src.y`（整页 XObject 的 BBox 是 cropbox，平移后恰好把 src 对到 dst）。
 */
export function planFlowPage({ page, geom, rows, textBounds, texts, bodyLineH, font }: FlowPlanArgs): FlowPlan {
  const fz = clamp(FLOW_FONT_RATIO * bodyLineH, FLOW_FONT_MIN, FLOW_FONT_MAX)
  const pitch = FLOW_PITCH_RATIO * fz
  const strips: PendingStrip[] = []
  /** 译文框 / 文字 op 先按 CSS 空间收集，H 定了再翻转 */
  const cssOps: { kind: 'rect'; x: number; top: number; w: number; h: number; fill: Rgb }[] = []
  const cssText: { x: number; baseline: number; text: string; cs: number }[] = []
  const missing = new Set<number>()

  const place = (s: Strip, y: number): number => {
    strips.push({ src: s.rect, dst: { x: s.rect.x, y } })
    let next = y + s.rect.h
    if (!s.showTranslation || s.blockIndex === undefined) return next
    const i = s.blockIndex
    const full = texts.get(i)
    if (full === undefined) {
      missing.add(i)
      return next
    }
    const text = font.sanitize ? font.sanitize(full) : full
    const b = textBounds.get(i)
    let x0 = b ? Math.max(s.rect.x + FLOW_EDGE, b[0]) : s.rect.x + FLOW_INSET
    let x1 = b ? Math.min(s.rect.x + s.rect.w - FLOW_EDGE, b[1]) : s.rect.x + s.rect.w - FLOW_INSET
    if (!b || x1 - x0 < FLOW_MIN_W) {
      x0 = s.rect.x + FLOW_INSET
      x1 = s.rect.x + s.rect.w - FLOW_INSET
    }
    const boxW = Math.max(1, x1 - x0)
    const textW = Math.max(1, boxW - FLOW_PAD_LEFT - FLOW_PAD_RIGHT)
    const lines = wrapText(text, textW, (t) => font.measureAt(t, fz))
    const boxTop = next + FLOW_MARGIN_TOP
    const boxH = 2 * FLOW_PAD_Y + lines.length * pitch
    cssOps.push({ kind: 'rect', x: x0, top: boxTop, w: boxW, h: boxH, fill: FLOW_BOX_FILL })
    cssOps.push({ kind: 'rect', x: x0, top: boxTop, w: FLOW_BAR_W, h: boxH, fill: FLOW_BOX_BAR })
    for (let k = 0; k < lines.length; k += 1) {
      const line = lines[k]
      if (line.text === '') continue
      const top = boxTop + FLOW_PAD_Y + k * pitch
      cssText.push({
        x: x0 + FLOW_PAD_LEFT + line.indent,
        baseline: top + baselineOffset(fz, pitch, font.metrics),
        text: line.text,
        cs: justifySpacing(line, textW, fz),
      })
    }
    next = boxTop + boxH + FLOW_MARGIN_BOTTOM
    return next
  }

  let y = 0
  for (const row of rows) {
    if (row.kind === 'full') {
      y = place(row.strip, y)
      continue
    }
    let yl = y
    for (const s of row.left) yl = place(s, yl)
    let yr = y
    for (const s of row.right) yr = place(s, yr)
    y = Math.max(yl, yr)
  }
  const H = Math.max(y, 1)

  const ops: DrawOp[] = []
  for (const { src, dst } of strips) {
    ops.push({
      kind: 'strip',
      srcPage: page,
      clip: { x: dst.x, y: H - dst.y - src.h, w: src.w, h: src.h },
      tx: dst.x - src.x - geom.pageX,
      ty: H - dst.y - geom.pageY - geom.pageHeight + src.y,
    })
  }
  for (const r of cssOps) ops.push({ kind: 'rect', x: r.x, y: H - r.top - r.h, w: r.w, h: r.h, fill: r.fill })
  for (const t of cssText) {
    ops.push({
      kind: 'text',
      x: t.x,
      y: H - t.baseline,
      text: t.text,
      size: fz,
      color: FLOW_TEXT_COLOR,
      ...(t.cs > 0 ? { charSpacing: t.cs } : {}),
    })
  }
  return { width: geom.pageWidth, height: H, base: { kind: 'new' }, ops, untranslated: missing.size, untranslatedBlocks: sortedIndices(missing) }
}

/** 旋转页（/Rotate ≠ 0）：viewer 本就不给块，对照流原样复制原页 */
export function planCopiedPage(page: number, width: number, height: number): PagePlan {
  return { width, height, base: { kind: 'copy', srcPage: page }, ops: [] }
}
