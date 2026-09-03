import type { PaperBlock } from '../types'

/**
 * 「当前屏幕上的正文」上下文（纯函数）。
 *
 * 语音提问里的「这个」「这段」「它为什么这么设计」全靠它落地：把可见块区间渲染成一段纯文本，
 * 由 contextBuilder 包上【当前屏幕上的正文】外壳后插进本轮 user 消息。
 *
 * 三条设计约束：
 * 1. **超帽不截尾，而是从视口顶块向外扩**——截尾会把用户正在看的那一屏切掉一半，
 *    向外扩至少保证「用户眼睛落点」那几块一定在里面（centerIndex 默认 = range.min）。
 * 2. **image 只取 `[图: alt]` 占位、table 只取 text 不取 html**：语音链路把 HTML 标签
 *    与图片 URL 当噪声，它们既不会被朗读也挤占预算（block.text 本就是这个形态，见 types.ts）。
 * 3. **与选区去重**：选区已经作为独立段落先于本段出现（contextBuilder 顺序），
 *    正文里再出现一次就是纯粹的重复计费，替换成一句指代说明即可。
 *
 * 这里只产出正文体（含一行 `§章节 · p.页码` 位置头，格式沿 renderChunkHeader），
 * 【】外壳与「仅用于理解指代」的守卫声明归 contextBuilder。
 */

/** ≈667 token（chars/3 口径），约占 chat 12k 输入预算的 5.5% */
export const VIEWPORT_MAX_CHARS = 2000

/** 选区去重的最小长度：太短的选区在正文里重合可能是巧合，替换反而丢信息 */
export const SELECTION_DEDUPE_MIN_CHARS = 40

export const SELECTION_DEDUPE_PLACEHOLDER = '（此处即上面的「选中内容」）'

/** 无页码格式（DOCX / URL 导入）的默认窗口半径，真正的裁剪交给字符预算 */
export const DEFAULT_BLOCK_WINDOW = 8

export interface BlockRange {
  min: number
  max: number
}

export interface ViewportContextOpts {
  /** 发送瞬间的划词选区（原文），用于去重 */
  selection?: string | null
  maxChars?: number
  /** 向外扩张的锚点，默认 range.min（视口顶块） */
  centerIndex?: number
}

export interface ViewportContext {
  text: string
  /** 有块被丢弃或被硬切：调用方据此在 BudgetReport 里记 viewportTruncated */
  truncated: boolean
}

const EMPTY: ViewportContext = { text: '', truncated: false }

/** 位置头：`§4.2 Method · p.7`（renderChunkHeader 去掉别名前缀） */
function headerOf(block: PaperBlock): string {
  const parts: string[] = []
  if (block.anchor.section) parts.push(`§${block.anchor.section}`)
  if (block.anchor.page !== undefined) parts.push(`p.${block.anchor.page}`)
  return parts.join(' · ')
}

/** 单块 → 一行文本；返回 '' 表示这块没有可用信息（不进上下文，也不算被截断） */
function renderBlock(block: PaperBlock): string {
  const text = (block.text ?? '').trim()
  switch (block.kind) {
    case 'heading':
      return text === '' ? '' : `## ${text}`
    case 'image':
      // types.ts：image 块的 text 存 `[图: alt]` 占位；没有 alt 时至少留个占位说明这里有图
      return text !== '' ? text : block.src ? '[图]' : ''
    default:
      // table 走 text 不走 html；code / caption / formula 原样带上（trim 过）
      return text
  }
}

export function buildViewportContext(
  blocks: readonly PaperBlock[],
  range: BlockRange,
  opts: ViewportContextOpts = {},
): ViewportContext {
  const maxChars = opts.maxChars ?? VIEWPORT_MAX_CHARS
  if (maxChars <= 0 || range.max < range.min) return EMPTY

  // 按 index 字段取区间（不按数组下标：块数组可能因过滤/分页而非稠密）
  const inRange = blocks.filter((b) => b.index >= range.min && b.index <= range.max).sort((a, b) => a.index - b.index)
  const rendered = inRange.map((b) => ({ block: b, line: renderBlock(b) })).filter((r) => r.line !== '')
  if (rendered.length === 0) return EMPTY

  // 锚点 = 落在 centerIndex 上或紧邻其上方的块（视口顶块），越界时钳到两端
  const center = opts.centerIndex ?? range.min
  let pivot = 0
  for (let i = 0; i < rendered.length; i++) {
    if (rendered[i].block.index <= center) pivot = i
    else break
  }

  const header = headerOf(rendered[pivot].block)
  const picked: (string | null)[] = new Array<string | null>(rendered.length).fill(null)
  let truncated = false
  let used = header.length

  // 锚点块优先；单块就吃满预算时硬切一刀，保证至少给出用户眼睛落点那段
  const pivotRoom = maxChars - used - (header === '' ? 0 : 1)
  if (pivotRoom <= 0) return { text: header, truncated: true }
  const pivotLine = rendered[pivot].line
  if (pivotLine.length > pivotRoom) {
    picked[pivot] = pivotLine.slice(0, pivotRoom)
    truncated = true
  } else {
    picked[pivot] = pivotLine
  }
  used += (header === '' ? 0 : 1) + (picked[pivot] as string).length

  // 从锚点向外逐块扩张：先向下（屏幕上更靠后的正文，用户正读到的方向），再向上。
  // 某个方向一旦装不下就封死该方向——跳过一块再收后面的块会让上下文出现无声跳段。
  let down = pivot + 1
  let up = pivot - 1
  let downOpen = true
  let upOpen = true
  while (downOpen || upOpen) {
    if (downOpen) {
      if (down >= rendered.length) downOpen = false
      else if (used + rendered[down].line.length + 1 > maxChars) downOpen = false
      else {
        used += rendered[down].line.length + 1
        picked[down] = rendered[down].line
        down += 1
      }
    }
    if (upOpen) {
      if (up < 0) upOpen = false
      else if (used + rendered[up].line.length + 1 > maxChars) upOpen = false
      else {
        used += rendered[up].line.length + 1
        picked[up] = rendered[up].line
        up -= 1
      }
    }
  }

  const body = picked.filter((s): s is string => s !== null)
  if (body.length < rendered.length) truncated = true

  let text = (header === '' ? body : [header, ...body]).join('\n')

  // 选区去重：选区已作为独立段落排在本段之前，正文里重复一遍纯属重复计费
  const selection = (opts.selection ?? '').trim()
  if (selection.length >= SELECTION_DEDUPE_MIN_CHARS) {
    const at = text.indexOf(selection)
    if (at >= 0) {
      text = text.slice(0, at) + SELECTION_DEDUPE_PLACEHOLDER + text.slice(at + selection.length)
    }
  }

  return { text, truncated }
}

/**
 * PDF 原版模式的块区间：视口只知道页码，块区间靠 anchors.buildAnchorContext 的
 * `firstBlockOfPage` 反推——本页首块 → 下一有块页首块前一块。
 *
 * 退化：
 * - 该页没有文本块（整页大图/表）→ 退到最近的、不晚于它的有块页（区间成为超集，宁多勿空）；
 * - 该页早于第一个有块页 / 无任何映射 / blockCount≤0 → 返回空区间（max < min），
 *   buildViewportContext 收到后返回空文本，调用方据此整段省略。
 */
export function pageBlockRange(
  firstBlockOfPage: Readonly<Record<number, number>>,
  page: number,
  blockCount: number,
): BlockRange {
  const empty: BlockRange = { min: 0, max: -1 }
  if (blockCount <= 0) return empty

  const pages = Object.keys(firstBlockOfPage)
    .map(Number)
    .filter((p) => Number.isFinite(p))
    .sort((a, b) => a - b)
  if (pages.length === 0) return empty

  let startPage: number | undefined
  for (const p of pages) {
    if (p <= page) startPage = p
    else break
  }
  if (startPage === undefined) return empty

  const nextPage = pages.find((p) => p > page)
  const clamp = (i: number) => Math.max(0, Math.min(blockCount - 1, i))
  const min = clamp(firstBlockOfPage[startPage])
  const max = nextPage === undefined ? blockCount - 1 : clamp(firstBlockOfPage[nextPage] - 1)
  return { min, max: Math.max(min, max) }
}

/** 无页码格式（或可见区间尚未结算）的兜底窗口：以当前块为中心的上下各 span 块 */
export function windowAroundBlock(blockIndex: number, blockCount: number, span: number = DEFAULT_BLOCK_WINDOW): BlockRange {
  if (blockCount <= 0) return { min: 0, max: -1 }
  const center = Math.max(0, Math.min(blockCount - 1, Math.trunc(blockIndex)))
  const reach = Math.max(0, Math.trunc(span))
  return { min: Math.max(0, center - reach), max: Math.min(blockCount - 1, center + reach) }
}
