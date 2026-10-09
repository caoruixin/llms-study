import { planFontFit } from '../pdfLayout'
import type { FontMetrics } from './exportTypes'

/**
 * 导出 PDF 的文本排版工具（纯函数，node 单测）：分词、贪心折行（避头尾）、Tc 两端对齐、框内字号拟合、基线偏移。
 * 宽度一律由调用方的 measure 给出（cjkFont.measureAt：Σ advance × size / upm），这里不碰字体、不碰 DOM。
 */

export type Atom =
  | { kind: 'cjk'; text: string }
  | { kind: 'word'; text: string }
  | { kind: 'space'; text: string }
  | { kind: 'break' }

/** 行首禁排（闭标点、句读）与行尾禁排（开标点） */
const NO_LINE_START: ReadonlySet<string> = new Set('，。、；：？！”’）》」』】〕〉…,.;:?!)]}')
const NO_LINE_END: ReadonlySet<string> = new Set('“‘（《「『【〔〈([{')
/** Tc 对齐上限：间距 > 0.08 × 字号就放弃对齐（拉丁为主的短行拉得太开很难看） */
const JUSTIFY_MAX_RATIO = 0.08
const EPS = 1e-6

/** 中日韩统一表意文字 / 假名 / 谚文 / CJK 标点与全角形：逐字一个 atom */
export const isCjkCodePoint = (cp: number): boolean =>
  (cp >= 0x2e80 && cp <= 0x9fff) ||
  (cp >= 0xac00 && cp <= 0xd7af) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xffef) ||
  (cp >= 0x20000 && cp <= 0x3134f)

/** 空格、制表、NBSP、U+2000–200A 各式空格（按码点判，源码里不出现不可见字符） */
const isSpace = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? -1
  return cp === 0x20 || cp === 0x09 || cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200a)
}

/**
 * 分词：CJK 码点逐字一个 atom；其余非空白字符连成 `word`（拉丁字母数字串连同紧邻的 ASCII 标点——
 * 闭标点自然粘前、开标点自然粘后）；空白连成 `space`；`\n` 为 `break`（`\r` 丢弃）。
 */
export function tokenize(text: string): Atom[] {
  const out: Atom[] = []
  let word = ''
  let space = ''
  const flushWord = () => {
    if (word) out.push({ kind: 'word', text: word })
    word = ''
  }
  const flushSpace = () => {
    if (space) out.push({ kind: 'space', text: space })
    space = ''
  }
  for (const ch of text) {
    if (ch === '\r') continue
    if (ch === '\n') {
      flushWord()
      flushSpace()
      out.push({ kind: 'break' })
      continue
    }
    if (isSpace(ch)) {
      flushWord()
      space += ch
      continue
    }
    flushSpace()
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) {
      flushWord()
      out.push({ kind: 'cjk', text: ch })
    } else {
      word += ch
    }
  }
  flushWord()
  flushSpace()
  return out
}

export interface WrappedLine {
  text: string
  /** 字形总宽（不含缩进） */
  width: number
  /** 行首缩进（首行 firstLineIndent，其余 hangingIndent） */
  indent: number
  /** 以硬换行结束 */
  hard: boolean
  /** 段落末行 */
  last: boolean
}

export type Measure = (text: string) => number

export interface WrapOptions {
  firstLineIndent?: number
  hangingIndent?: number
  /** 逐字换行（代码块）：每个非空白码点单独成 atom，不做避头尾 */
  breakAll?: boolean
}

const atomText = (a: Atom): string => (a.kind === 'break' ? '' : a.text)
const firstChar = (a: Atom): string => (a.kind === 'break' ? '' : Array.from(a.text)[0] ?? '')
const lastChar = (a: Atom): string => {
  if (a.kind === 'break') return ''
  const cs = Array.from(a.text)
  return cs[cs.length - 1] ?? ''
}

/**
 * 贪心折行 + 避头尾：
 * - 行首禁 `，。、；：？！”’）》」』】〕〉…` 与 ASCII `, . ; : ? ! ) ] }`：放不下时把上一个 atom 一起带到下一行；
 *   整行只剩一个 atom 时允许悬挂（标点挤出右边界）而不是让它独占行首，也不会死循环；
 * - 行尾禁 `“‘（《「『【〔〈 ( [ {`：断行时若行末是开标点，把它带到下一行（同样整行只剩它时放行）；
 * - 超宽 atom（URL、长串）按码点硬切（= `overflow-wrap: anywhere`）；
 * - 行首空白丢弃（breakAll 的硬行行首缩进保留）、行尾空白不计宽；`\n` 硬换行；空文本 → []。
 */
export function wrapText(text: string, maxWidth: number, measure: Measure, opts: WrapOptions = {}): WrappedLine[] {
  const atoms = opts.breakAll ? tokenizeBreakAll(text) : tokenize(text)
  const kinsoku = !opts.breakAll
  const lines: WrappedLine[] = []
  let cur: { atom: Atom; w: number }[] = []
  const indentOf = (): number => (lines.length === 0 ? (opts.firstLineIndent ?? 0) : (opts.hangingIndent ?? 0))
  const avail = (): number => Math.max(1, maxWidth - indentOf())
  const curWidth = (): number => cur.reduce((s, c) => s + c.w, 0)
  const nonSpaceCount = (): number => cur.reduce((n, c) => n + (c.atom.kind === 'space' ? 0 : 1), 0)

  const flush = (hard: boolean) => {
    while (cur.length && cur[cur.length - 1].atom.kind === 'space') cur.pop()
    lines.push({
      text: cur.map((c) => atomText(c.atom)).join(''),
      width: cur.reduce((s, c) => s + c.w, 0),
      indent: indentOf(),
      hard,
      last: false,
    })
    cur = []
  }

  /** 断行前把行末的开标点带走（行尾禁排）；返回带走的 atom */
  const takeTrailingOpener = (): { atom: Atom; w: number } | null => {
    if (!kinsoku) return null
    while (cur.length && cur[cur.length - 1].atom.kind === 'space') cur.pop()
    const tail = cur[cur.length - 1]
    if (!tail || nonSpaceCount() < 2 || !NO_LINE_END.has(lastChar(tail.atom))) return null
    cur.pop()
    return tail
  }

  /** 超宽 atom 硬切：能放几个码点放几个（至少 1 个），余下换行继续 */
  const hardSplit = (a: Atom & { kind: 'word' | 'cjk' }) => {
    let rest = Array.from(a.text)
    while (rest.length) {
      if (cur.some((c) => c.atom.kind !== 'space')) flush(false)
      else cur = []
      let taken = 0
      let acc = ''
      let accW = 0
      for (const ch of rest) {
        const w = measure(acc + ch)
        if (taken > 0 && w > avail() + EPS) break
        acc += ch
        accW = w
        taken += 1
      }
      cur.push({ atom: { kind: 'word', text: acc }, w: accW })
      rest = rest.slice(taken)
    }
  }

  // 代码块（breakAll）的硬行行首缩进是内容（Python 等靠它表达结构），不能像正文那样丢掉；软换行的续行照旧丢
  let hardLineStart = true
  for (const a of atoms) {
    if (a.kind === 'break') {
      flush(true)
      hardLineStart = true
      continue
    }
    if (a.kind === 'space') {
      if (cur.length || (opts.breakAll && hardLineStart)) cur.push({ atom: a, w: measure(a.text) })
      continue
    }
    hardLineStart = false
    const w = measure(a.text)
    if (curWidth() + w <= avail() + EPS) {
      cur.push({ atom: a, w })
      continue
    }
    // 放不下
    const nonSpace = nonSpaceCount()
    if (nonSpace === 0) {
      // 空行上就放不下：硬切
      if (w > avail() + EPS) hardSplit(a)
      else cur.push({ atom: a, w })
      continue
    }
    if (kinsoku && NO_LINE_START.has(firstChar(a))) {
      if (nonSpace === 1) {
        // 整行只剩一个 atom：让标点悬挂，不独占行首
        cur.push({ atom: a, w })
        continue
      }
      // 把上一个 atom 一起带到下一行
      while (cur.length && cur[cur.length - 1].atom.kind === 'space') cur.pop()
      const carry = cur.pop()!
      flush(false)
      cur.push(carry)
      if (curWidth() + w <= avail() + EPS) cur.push({ atom: a, w })
      else if (w > avail() + EPS) hardSplit(a)
      else {
        flush(false)
        cur.push({ atom: a, w })
      }
      continue
    }
    const opener = takeTrailingOpener()
    flush(false)
    if (opener) cur.push(opener)
    if (curWidth() + w <= avail() + EPS) cur.push({ atom: a, w })
    else if (w > avail() + EPS) hardSplit(a)
    else {
      flush(false)
      cur.push({ atom: a, w })
    }
  }
  if (cur.some((c) => c.atom.kind !== 'space')) flush(false)
  if (lines.length) lines[lines.length - 1].last = true
  return lines
}

/** 逐字分词（代码块）：非空白码点各自一个 word，空白与换行同 tokenize */
function tokenizeBreakAll(text: string): Atom[] {
  const out: Atom[] = []
  for (const a of tokenize(text)) {
    if (a.kind === 'word') for (const ch of a.text) out.push({ kind: 'word', text: ch })
    else out.push(a)
  }
  return out
}

/**
 * 两端对齐的字符间距 Tc（pt）：**只用 Tc**——Tw 对 Identity-H 双字节 CID 字体无效（PDF 32000 §9.3.3）。
 * 硬换行 / 末行 → 0；间距 > 0.08 × size 则放弃对齐（左对齐）→ 0。
 */
export function justifySpacing(line: WrappedLine, maxWidth: number, size: number): number {
  if (line.hard || line.last) return 0
  const n = Array.from(line.text).length
  if (n < 2) return 0
  const extra = maxWidth - line.indent - line.width
  if (extra <= EPS) return 0
  const tc = extra / (n - 1)
  return tc > JUSTIFY_MAX_RATIO * size ? 0 : tc
}

export interface FitOptions {
  f0: number
  pitch0: number
  fMin: number
  /** 首行缩进（固定 pt，不随字号缩） */
  indent?: number
  measureAt: (text: string, size: number) => number
  maxRounds?: number
}

export interface FitResult {
  size: number
  pitch: number
  lines: WrappedLine[]
  /** 到字号下限仍放不下：lines 已截到能放下的行，末行尾部换 … */
  overflow: boolean
}

/**
 * 框内字号拟合：镜像 PdfZhOverlay.fitFonts 但无 DOM——每轮 wrap → `need = lines × pitch`，溢出用
 * `planFontFit(box.h, need, f, fMin)` 缩（行距按 f / f0 等比），到下限仍溢出 → overflow，保留能放下的行并把末行尾部换 `…`。
 */
export function fitTextInBox(text: string, box: { w: number; h: number }, opts: FitOptions): FitResult {
  const maxRounds = opts.maxRounds ?? 6
  const indent = opts.indent ?? 0
  const wrap = (size: number) => wrapText(text, box.w, (t) => opts.measureAt(t, size), { firstLineIndent: indent })
  let size = opts.f0
  let pitch = opts.pitch0
  let lines = wrap(size)
  for (let round = 0; round < maxRounds; round += 1) {
    const next = planFontFit(box.h, lines.length * pitch, size, opts.fMin)
    if (next === null) break
    pitch = (opts.pitch0 * next) / opts.f0
    size = next
    lines = wrap(size)
  }
  const overflow = lines.length * pitch > box.h + EPS
  if (overflow && lines.length) {
    const keep = Math.max(1, Math.floor((box.h + EPS) / pitch))
    lines = lines.slice(0, keep)
    const last = lines[keep - 1]
    const measure = (t: string) => opts.measureAt(t, size)
    const ell = '…'
    const chars = Array.from(last.text)
    while (chars.length && measure(chars.join('') + ell) > box.w - last.indent + EPS) chars.pop()
    const t = chars.join('') + ell
    lines[keep - 1] = { ...last, text: t, width: measure(t), hard: false, last: true }
  }
  return { size, pitch, lines, overflow }
}

/**
 * CSS 行盒模型的基线位置：行框顶到基线 = `(pitch − contentH) / 2 + ascent × size / upm`，
 * contentH = (ascent − descent) × size / upm（descent 为负）。覆盖层的 DOM 行就是这样排的，导出按同一公式落基线。
 */
export function baselineOffset(size: number, pitch: number, m: FontMetrics): number {
  const scale = size / m.unitsPerEm
  const contentH = (m.ascent - m.descent) * scale
  return (pitch - contentH) / 2 + m.ascent * scale
}
