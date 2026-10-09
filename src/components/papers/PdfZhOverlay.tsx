import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react'
import type { LlmAuthCode } from '../../lib/llmClient'
import {
  buildPieces,
  pieceText,
  planFontFit,
  scaleRect,
  segmentsOnPage,
  type PageGeom,
  type Piece,
  type Rect,
} from '../../lib/paper/pdfLayout'
import type { PaperBlock, PaperHighlight } from '../../lib/paper/types'
import { FLASH_MS } from './ReaderContext'
import { HlText, TranslationError } from './translationBits'

/**
 * 原版 PDF「中文」模式：译文原位覆盖原段落框（版面不动），PLAN-pdf-inline-translation §5.2。
 *
 * 叠在 PdfPage 的 canvas + 文字层之上（`.paper-zhlayer`，z-index 2，层本身不接指针）。每个「段落片」
 * （一个块在本页某栏的一段，见 pdfLayout.PortionRect）一个元素，三态：
 * - 已译且版面像正文 → 不透明译文块，底色从同一张 canvas 取样（callout 色块里也对）；
 * - 未译且可译 → 只描边的脉冲骨架，不盖原文；
 * - 失败 → 不覆盖（原文照常可读），段落框右下角一枚紧凑失败签；
 * - 非正文版面（公式行 / 表格行 / 作者块）、图内孤立短标签（pdfLayout.isLabelLike）、不可译块、空文本
 *   → 不出元素，永远显示原文（标签盖上译文框会把示意图糊掉）。
 *
 * 字号拟合在页级 useLayoutEffect 里「全写→全读」批处理（避免逐块读写交错的强制重排抖动），
 * 最多 3 轮；结果直接写 style，不进 React 状态——React 的 style 对象里不含 fontSize/lineHeight，
 * 重渲染时不会把拟合结果冲掉。
 *
 * DOM 契约（selectionOffsets / SelectionActions / anchorFromElement 依赖）：
 * 译文块带 `data-block-index` + `data-translated="zh"`；**只有单片块**带 `data-hl-host="zh"`——
 * 跨栏 / 跨页块的译文按行数比例拆到各片，单片的 textContent 不等于整段译文，偏移口径不成立。
 * 「中」签是译文块的兄弟而不是子元素，同样为了宿主 textContent 恰好等于译文。
 */

/** 跳转闪烁的跨组件通道：viewer 持有一份（稳定引用），覆盖层挂载时登记、卸载时注销 */
export interface ZhFlashRegistry {
  /** 跳转目标页尚未渲染时挂起的块：该页覆盖层挂载后命中即闪（at 用来丢弃过期请求） */
  pending: { index: number; at: number } | null
  /** 已挂载的覆盖层：页码 → 闪烁某块（本页没有该块返回 false） */
  handlers: Map<number, (blockIndex: number) => boolean>
}

/** 一页的译文切片（覆盖层与对照流共用）：viewer 按页切、签名不变复用同一对象，memo 照常生效 */
export interface ZhSlice {
  texts: ReadonlyMap<number, string>
  failed: ReadonlySet<number>
  highlights: ReadonlyMap<number, readonly PaperHighlight[]>
  authIssue: LlmAuthCode | null | undefined
  onRetry: ((blockIndex: number) => void) | undefined
}

/** PdfPage 的就地译文数据 */
export interface ZhPageData extends ZhSlice {
  /** 在本页有 seg 的块（文档序）；跨页块的其它 seg 也在 layout 里，拆分译文要用全部 seg 的行数 */
  blocks: readonly PaperBlock[]
  flash: ZhFlashRegistry
}

interface Props extends ZhPageData {
  page: number
  /** 渲染该页所用 viewport 的 scale 与 rawDims（PdfPage 渲染 effect 里存下的那一个） */
  scale: number
  geom: PageGeom
  /** 同页 canvas：背景取样 */
  canvasRef: RefObject<HTMLCanvasElement | null>
}

/** 挂起的跳转闪烁超过这个时长就不再兑现（用户早已滚去别处） */
const PENDING_FLASH_TTL_MS = 4000
const FIT_ROUNDS = 3
/** 取样点亮度低于它 = 打到了字形 / 图形，回退白底 */
const MIN_BG_LUMA = 0.5

/**
 * 从已渲染的页 canvas 取样底色：多点取最亮者（字形 / 抗锯齿灰点更暗），过深 → 白底。
 * 覆盖片的几何（`buildPieces`）在 pdfLayout；导出内核离屏渲染后也用这一函数取底色。
 */
export function sampleBackgrounds(canvas: HTMLCanvasElement | null, pieces: readonly Piece[], cssWidth: number): Map<string, string> {
  const out = new Map<string, string>()
  if (!canvas || !canvas.width || !pieces.length) return out
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return out
  const dpr = cssWidth > 0 ? canvas.width / cssWidth : 1
  for (const p of pieces) {
    let best: [number, number, number] | null = null
    let bestLuma = -1
    for (const s of p.samples) {
      const x = Math.round(s.x * dpr)
      const y = Math.round(s.y * dpr)
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue
      try {
        const d = ctx.getImageData(x, y, 1, 1).data
        const luma = (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255
        if (luma > bestLuma) {
          bestLuma = luma
          best = [d[0], d[1], d[2]]
        }
      } catch {
        /* 取样失败按白底 */
      }
    }
    out.set(p.key, best && bestLuma >= MIN_BG_LUMA ? `rgb(${best[0]}, ${best[1]}, ${best[2]})` : '#fff')
  }
  return out
}

/**
 * 字号拟合（纯 DOM，全写→全读）：先给所有块写起始字号，统一读 scrollHeight；溢出者按 planFontFit 缩，
 * 最多 FIT_ROUNDS 轮；收尾再统一读一次，仍溢出的标 `data-overflow="1"`（底部渐隐）。
 */
function fitFonts(els: readonly HTMLElement[], params: ReadonlyMap<string, Piece>): void {
  const items: { el: HTMLElement; p: Piece; f: number }[] = []
  for (const el of els) {
    const p = params.get(el.dataset.zhKey ?? '')
    if (p) items.push({ el, p, f: p.f0 })
  }
  for (const it of items) {
    it.el.style.fontSize = `${it.f}px`
    it.el.style.lineHeight = `${it.p.lh0}px`
    it.el.removeAttribute('data-overflow')
  }
  let active = items
  for (let round = 0; round < FIT_ROUNDS && active.length; round += 1) {
    // 全读
    const reads = active.map((it) => ({ it, boxH: it.el.clientHeight, scrollH: it.el.scrollHeight }))
    // 全写（+1px 容差：scrollHeight 是整数，行高取整会多出零点几像素）
    const next: typeof items = []
    for (const { it, boxH, scrollH } of reads) {
      const f = planFontFit(boxH + 1, scrollH, it.f, it.p.fMin)
      if (f === null) continue
      it.f = f
      it.el.style.fontSize = `${f}px`
      it.el.style.lineHeight = `${(it.p.lh0 * f) / it.p.f0}px`
      next.push(it)
    }
    active = next
  }
  const overflow = items.filter((it) => it.el.scrollHeight > it.el.clientHeight + 1)
  for (const it of overflow) it.el.setAttribute('data-overflow', '1')
}

export default function PdfZhOverlay({
  page,
  scale,
  geom,
  canvasRef,
  blocks,
  texts,
  failed,
  highlights,
  authIssue,
  onRetry,
  flash,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
  /** 点按看原文的块（整块一起切，跨栏两片同进同出）；页离开渲染窗口即卸载重置——「临时」语义 */
  const [showOrig, setShowOrig] = useState<ReadonlySet<number>>(() => new Set())
  /** 跳转闪烁：tick 让连续两次闪同一块也能重播动画 */
  const [flashing, setFlashing] = useState<{ index: number; tick: number } | null>(null)

  const blockOf = useMemo(() => {
    const m = new Map<number, PaperBlock>()
    for (const b of blocks) m.set(b.index, b)
    return (i: number) => m.get(i)
  }, [blocks])
  const portions = useMemo(() => segmentsOnPage(blocks as PaperBlock[], page, geom), [blocks, page, geom])
  const pieces = useMemo(() => buildPieces(portions, blockOf, scale), [portions, blockOf, scale])
  const params = useMemo(() => new Map(pieces.map((p) => [p.key, p])), [pieces])
  // 覆盖层只在 PdfPage 位图落地后挂载（rendered），此刻 canvas 已有像素；scale 变化会先卸载再挂载
  const backgrounds = useMemo(
    () => sampleBackgrounds(canvasRef.current, pieces, geom.pageWidth * scale),
    [canvasRef, pieces, geom.pageWidth, scale],
  )

  /** 每片实际显示的译文（跨栏 / 跨页块按各 seg 行数比例拆分，pdfLayout.pieceText），缺席 = 未译 */
  const shown = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of pieces) {
      const text = texts.get(p.block.index)
      if (text === undefined) continue
      m.set(p.key, pieceText(p, text))
    }
    return m
  }, [pieces, texts])
  /** 拟合只看「哪些片显示了什么字」：高亮 / 看原文切换都不改排版，不重拟合 */
  const fitSig = useMemo(() => pieces.map((p) => `${p.key}=${shown.get(p.key) ?? ''}`).join('\u0001'), [pieces, shown])

  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const run = () => fitFonts(Array.from(layer.querySelectorAll<HTMLElement>('.paper-zh-block')), params)
    run()
    // 中文字体可能晚于首帧就绪（系统字体通常同步可用）：就绪后补拟合一次
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts || fonts.status === 'loaded') return
    let alive = true
    void fonts.ready.then(() => {
      if (alive) run()
    })
    return () => {
      alive = false
    }
  }, [fitSig, params])

  const flashBlock = useCallback(
    (blockIndex: number): boolean => {
      if (!portions.some((p) => p.blockIndex === blockIndex)) return false
      setFlashing((prev) => ({ index: blockIndex, tick: (prev?.tick ?? 0) + 1 }))
      return true
    },
    [portions],
  )

  // 登记闪烁处理器；挂起的跳转闪烁（目标页刚进渲染窗口）在这里兑现
  useEffect(() => {
    flash.handlers.set(page, flashBlock)
    const pending = flash.pending
    if (pending && performance.now() - pending.at < PENDING_FLASH_TTL_MS && flashBlock(pending.index)) flash.pending = null
    return () => {
      if (flash.handlers.get(page) === flashBlock) flash.handlers.delete(page)
    }
  }, [flash, page, flashBlock])

  useEffect(() => {
    if (!flashing) return
    const timer = setTimeout(() => setFlashing(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flashing])

  const toOrig = (blockIndex: number) => (e: MouseEvent) => {
    // 划选译文时的 click 不算「点段落」；点高亮 mark 交给 HighlightActions（删除浮层），不切原文
    const sel = (e.currentTarget as HTMLElement).ownerDocument.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return
    if ((e.target as Element).closest?.('mark[data-highlight-id]')) return
    setShowOrig((prev) => new Set(prev).add(blockIndex))
  }
  const toZh = (blockIndex: number) => () =>
    setShowOrig((prev) => {
      const next = new Set(prev)
      next.delete(blockIndex)
      return next
    })

  const boxStyle = (b: Rect): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h })

  return (
    <div ref={layerRef} className="paper-zhlayer">
      {pieces.map((p) => {
        const i = p.block.index
        const text = shown.get(p.key)
        if (text !== undefined) {
          const orig = showOrig.has(i)
          const single = p.portion.segCount === 1
          return (
            <Fragment key={p.key}>
              <div
                data-block-index={i}
                data-translated="zh"
                data-hl-host={single ? 'zh' : undefined}
                data-zh-key={p.key}
                data-state={orig ? 'orig' : undefined}
                className="paper-zh-block"
                title={orig ? undefined : '点按看原文'}
                onClick={toOrig(i)}
                style={{
                  ...boxStyle(p.box),
                  background: backgrounds.get(p.key) ?? '#fff',
                  textAlign: p.center ? 'center' : 'justify',
                  textIndent: p.indent ? p.indent : undefined,
                  fontWeight: p.block.kind === 'heading' ? 600 : undefined,
                }}
              >
                <span className="paper-zh-text">
                  {single ? <HlText text={text} rows={highlights.get(i)} host="zh" /> : text}
                </span>
              </div>
              {orig && (
                <button
                  type="button"
                  className="paper-zh-chip"
                  title="切回中文"
                  onClick={toZh(i)}
                  style={{ left: p.box.x + p.box.w, top: p.box.y, transform: 'translateX(-100%)' }}
                >
                  中
                </button>
              )}
            </Fragment>
          )
        }
        if (failed.has(i)) {
          // 失败签只挂在块的最后一片（跨栏块不出两枚）
          if (p.portion.segIndex !== p.portion.segCount - 1) return null
          return (
            <div
              key={p.key}
              className="paper-zh-fail"
              style={{ left: p.box.x + p.box.w, top: p.box.y + p.box.h, transform: 'translate(-100%, -100%)' }}
            >
              <TranslationError compact onRetry={onRetry ? () => onRetry(i) : undefined} authIssue={authIssue} />
            </div>
          )
        }
        return <div key={p.key} className="paper-zh-skel" style={boxStyle(p.box)} />
      })}
      {flashing &&
        portions
          .filter((p) => p.blockIndex === flashing.index)
          .map((p) => {
            const r = scaleRect(p.rect, scale)
            return (
              <div
                key={`flash:${p.segIndex}:${flashing.tick}`}
                className="paper-zh-flash paper-flash"
                style={{ left: r.x - 3, top: r.y - 3, width: r.w + 6, height: r.h + 6 }}
              />
            )
          })}
    </div>
  )
}
