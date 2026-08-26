import { blockDomId } from '../anchors'
import { MAX_HIGHLIGHT_BLOCKS } from './highlightModel'

/**
 * Range → 逐块字符区间的 DOM 捕获层。
 *
 * 偏移相对「源字符串」而非 DOM 路径：每个 textContent 恰好等于源字符串
 * （block.text 或该块译文）的元素带 `data-hl-host="orig" | "zh"`（见 BlockReader），
 * 宿主内偏移用 Range.toString().length 计算——高亮渲染把文本切成多个节点后
 * 再次划选，偏移口径依然不变。table 块不带宿主，天然排除。
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
  const probe = document.createRange()
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
  return probe.toString().length
}

const asElement = (node: Node | null): Element | null =>
  node instanceof Element ? node : (node?.parentElement ?? null)

/**
 * 跨块选区按块拆条：从起止点各自定位起止块，逐块取目标语言的宿主并钳位区间。
 * - 语言由**选区起点**所在宿主决定（与 SelectionActions 的 translated 判定同一口径），
 *   起点不在任何宿主内（表格/PDF 文字层等）返回 []；
 * - 终点不在块内（划到正文容器尾部留白）时扫到捕获上限为止，越过选区的块交集为空自然跳过；
 * - 上限 MAX_HIGHLIGHT_BLOCKS 防「全选整篇」造出上千条记录。
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
    const blockEl = container.querySelector(`#${blockDomId(i)}`)
    if (!blockEl) continue
    // 只取目标语言的宿主：跨原文/译文的混合选区按起点语言归类，另一种语言的文本不捕获
    const host = blockEl.querySelector(`[data-hl-host="${lang}"]`)
    if (!host) continue
    const source = host.textContent ?? ''
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
