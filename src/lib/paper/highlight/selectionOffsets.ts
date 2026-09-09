import { blockDomId } from '../anchors'
import { hostText } from '../url/stampBlocks'
import { MAX_HIGHLIGHT_BLOCKS } from './highlightModel'

/**
 * Range → 逐块字符区间的 DOM 捕获层。
 *
 * 偏移相对「源字符串」而非 DOM 路径：每个 `hostText()` 恰好等于源字符串
 * （block.text 或该块译文）的元素带 `data-hl-host="orig" | "zh"`（BlockReader 与网页原貌快照
 * 都遵守），宿主内偏移用宿主**自己文档**的 Range 计算——高亮渲染把文本切成多个节点后
 * 再次划选，偏移口径依然不变。table 块不带宿主，天然排除。
 *
 * 两处跨文档要点（网页原貌视图的选区来自 iframe 文档）：
 * - Range 必须由 `host.ownerDocument` 创建：父文档的 Range 对 iframe 节点 `comparePoint` 会抛
 *   WrongDocumentError（此前被吞成 0，偏移悄悄算错）；
 * - 宿主文本走 `hostText`（排除嵌套 `[data-hl-host]` 与 `.pc-zh`）：对照模式下译文嵌在原文宿主
 *   内部，`textContent` 会把译文也算进去。
 */

export interface CapturedRange {
  blockIndex: number
  lang: 'orig' | 'zh'
  /** [start, end) 相对宿主源字符串 */
  start: number
  end: number
  /** 快照 = sourceText.slice(start, end) */
  text: string
  /** 宿主全文：合并吞并旧区间后重切快照用（瞬态，不落库） */
  sourceText: string
}

/** 选区边界点相对宿主内容的位置：宿主外的边界钳位到 0 / 全长 */
function hostOffset(host: Element, node: Node, offset: number, length: number): number {
  // 边界点不在宿主所在文档（跨文档混合选区，理论上不可能）：按「宿主之前」钳位
  if (node.ownerDocument !== host.ownerDocument) return 0
  const probe = host.ownerDocument.createRange()
  probe.selectNodeContents(host)
  let cmp: number
  try {
    cmp = probe.comparePoint(node, offset)
  } catch {
    // 异常节点（脱离文档等）：按「宿主之前」钳位，交集判空自然跳过
    return 0
  }
  if (cmp < 0) return 0
  if (cmp > 0) return length
  probe.setEnd(node, offset)
  // 边界点落进嵌套译文节点时 Range.toString 会把译文也数进去：钳到宿主原文长度
  return Math.min(probe.toString().length, length)
}

/** 不用 instanceof：iframe 文档的节点属于另一个 realm，父窗口的 Element 构造器认不出它们 */
const asElement = (node: Node | null): Element | null =>
  node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null)

/** 块容器：BlockReader 与快照都带 `data-block-index`；`#paper-block-N` 只作旧结构兜底 */
function findBlockElement(container: HTMLElement, index: number): Element | null {
  return container.querySelector(`[data-block-index="${index}"]`) ?? container.querySelector(`#${blockDomId(index)}`)
}

/** 目标语言的宿主：快照里打标元素自己就是 orig 宿主，BlockReader 里宿主是块容器的后代 */
function findHost(blockEl: Element, lang: 'orig' | 'zh'): Element | null {
  const selector = `[data-hl-host="${lang}"]`
  return blockEl.matches(selector) ? blockEl : blockEl.querySelector(selector)
}

/**
 * 跨块选区按块拆条：从起止点各自定位起止块，逐块取目标语言的宿主并钳位区间。
 * - 语言由**选区起点**所在宿主决定（与 SelectionActions 的 translated 判定同一口径），
 *   起点不在任何宿主内（表格/PDF 文字层等）返回 []；
 * - 终点不在块内（划到正文容器尾部留白）时扫到捕获上限为止，越过选区的块交集为空自然跳过；
 * - 上限 MAX_HIGHLIGHT_BLOCKS 防「全选整篇」造出上千条记录。
 *
 * `container` 可以是父文档的阅读列，也可以是快照 iframe 的 body；Range 的节点须属于 container 的文档。
 */
export function captureHighlightRanges(range: Range, container: HTMLElement): CapturedRange[] {
  const startHost = asElement(range.startContainer)?.closest('[data-hl-host]')
  if (!startHost || !container.contains(startHost)) return []
  const lang = startHost.getAttribute('data-hl-host')
  if (lang !== 'orig' && lang !== 'zh') return []

  const startBlockEl = startHost.closest('[data-block-index]')
  if (!startBlockEl) return []
  const startIndex = Number(startBlockEl.getAttribute('data-block-index'))
  if (!Number.isInteger(startIndex)) return []

  const endBlockEl = asElement(range.endContainer)?.closest('[data-block-index]')
  const rawEnd = endBlockEl ? Number(endBlockEl.getAttribute('data-block-index')) : NaN
  const endIndex =
    Number.isInteger(rawEnd) && rawEnd >= startIndex ? rawEnd : startIndex + MAX_HIGHLIGHT_BLOCKS - 1

  const out: CapturedRange[] = []
  const last = Math.min(endIndex, startIndex + MAX_HIGHLIGHT_BLOCKS - 1)
  for (let i = startIndex; i <= last; i++) {
    const blockEl = findBlockElement(container, i)
    if (!blockEl) continue
    // 只取目标语言的宿主：跨原文/译文的混合选区按起点语言归类，另一种语言的文本不捕获
    const host = findHost(blockEl, lang)
    if (!host) continue
    const source = hostText(host)
    if (!source) continue
    const start = hostOffset(host, range.startContainer, range.startOffset, source.length)
    const end = hostOffset(host, range.endContainer, range.endOffset, source.length)
    if (end <= start) continue
    const text = source.slice(start, end)
    // 纯空白交集（块间换行/项目符号间隙）不值得建行
    if (!text.trim()) continue
    out.push({ blockIndex: i, lang, start, end, text, sourceText: source })
  }
  return out
}
