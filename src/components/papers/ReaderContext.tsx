import { createContext, useContext } from 'react'
import type { ReaderMode, ScrollTarget } from '../../lib/paper/anchors'
import type { SourceAnchor } from '../../lib/paper/types'

/**
 * 阅读器对外的命令式接口。
 *
 * **这是 Phase 3 CiteBadge 的消费接口**：引用点击链路 =
 * `useReader().scrollToAnchor(citeMapEntry.anchor)` → 解析锚点 → 滚动 → 短暂高亮，
 * 返回的 `ScrollTarget.precision` 告诉调用方实际定位到了段落 / 页 / 章节，
 * 以便在无法精确定位时给出「已定位到第 7 页」这类诚实提示。
 */
export interface ReaderApi {
  mode: ReaderMode
  setMode: (mode: ReaderMode) => void
  scrollToAnchor: (anchor: Partial<SourceAnchor> | null | undefined) => ScrollTarget
  /** 当前阅读位置（块序号 / 页码 / 章节），Phase 3 的检索查询扩展要用 */
  position: { blockIndex: number; page?: number; section?: string }
}

const ReaderContext = createContext<ReaderApi | null>(null)

export const ReaderProvider = ReaderContext.Provider

export function useReader(): ReaderApi {
  const api = useContext(ReaderContext)
  if (!api) throw new Error('useReader 必须在 ReaderProvider 内使用')
  return api
}

/** 引用跳转后的短暂高亮时长（与 CSS 动画时长保持一致） */
export const FLASH_MS = 1600

export function flashElement(el: Element): void {
  el.classList.remove('paper-flash')
  // 强制回流，连续点同一条引用时动画能重新播放
  void (el as HTMLElement).offsetWidth
  el.classList.add('paper-flash')
  setTimeout(() => el.classList.remove('paper-flash'), FLASH_MS)
}

/**
 * 阅读器所需的少量原生 CSS：
 * 1. `.paper-flash`：引用跳转高亮（Tailwind 无法表达自定义 keyframes）；
 * 2. `.paper-textlayer`：pdf.js 文字层的定位规则。**不 import pdfjs 自带的
 *    `web/pdf_viewer.css`**——那是 160KB 的完整查看器样式（工具栏、批注、编辑器全在内），
 *    我们只用得上 textLayer 这一段，照抄并展平（去掉 CSS 嵌套语法）即可。
 *    页面容器需要提供 `--total-scale-factor`（见 PdfViewer）；
 * 3. `.paper-zh*` / `.paper-flow*`：原版 PDF 的中文覆盖与段落对照流（PdfZhOverlay / PdfFlowPage）。
 */
export function ReaderStyles() {
  return (
    <style>{`
@keyframes paper-flash-kf {
  0% { background-color: color-mix(in srgb, var(--color-accent) 26%, transparent); }
  100% { background-color: transparent; }
}
.paper-flash { animation: paper-flash-kf ${FLASH_MS}ms ease-out; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { .paper-flash { animation-duration: 1ms; } }

/* 语音悬浮球：收音时呼吸脉冲；实际音量电平走 --voice-level 缩放内环（不进 React 状态） */
@keyframes voice-listen-kf { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.07); } }
.voice-listening { animation: voice-listen-kf 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .voice-listening { animation: none; } }

/* 文本视图的原生虚拟化：视口外的块跳过渲染，DOM 节点仍在（跳转/选区/浏览器查找照常） */
.paper-block { content-visibility: auto; contain-intrinsic-size: auto 3.5rem; }
.paper-table table { width: 100%; border-collapse: collapse; }
.paper-table th, .paper-table td { border: 1px solid var(--color-line); padding: 0.25rem 0.5rem; }
.paper-table th { background: var(--color-panel-2); }

.paper-textlayer {
  position: absolute;
  inset: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  text-align: initial;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  z-index: 0;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.paper-textlayer span, .paper-textlayer br {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  user-select: text;
}
.paper-textlayer > :not(.markedContent),
.paper-textlayer .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.paper-textlayer .markedContent { display: contents; }
.paper-textlayer ::selection { background: color-mix(in srgb, var(--color-accent) 30%, transparent); }

/* ===== 原版 PDF 就地译文（PLAN-pdf-inline-translation §5）===== */
:root { --paper-zh-font: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "Songti TC", serif; }

/* 中文覆盖：叠在 canvas + 文字层之上；层本身不接指针，只有译文块接（点按看原文 / 划选译文） */
.paper-zhlayer { position: absolute; inset: 0; z-index: 2; pointer-events: none; font-family: var(--paper-zh-font); }
/* 字号 / 行高由页级 useLayoutEffect 批量拟合后直接写 style（不进 React），这里只给版式；
   contain 让单块重排不波及整页 */
.paper-zh-block {
  position: absolute; box-sizing: border-box; overflow: hidden; pointer-events: auto; cursor: pointer;
  color: #1a1814; text-align: justify; overflow-wrap: anywhere; word-break: normal; user-select: text;
  contain: layout style;
}
.paper-zh-block ::selection { background: color-mix(in srgb, var(--color-accent) 30%, transparent); }
/* 三轮拟合仍放不下：底部 8px 渐隐，提示「还有」而不是硬切半行 */
.paper-zh-block[data-overflow="1"] {
  -webkit-mask-image: linear-gradient(#000 calc(100% - 8px), transparent);
  mask-image: linear-gradient(#000 calc(100% - 8px), transparent);
}
/* 点按看原文：底色透明、译文隐藏、指针穿透到下方文字层（原文可选可点）；「中」签切回 */
.paper-zh-block[data-state="orig"] { background: transparent !important; pointer-events: none; }
.paper-zh-block[data-state="orig"] > .paper-zh-text { visibility: hidden; }
/* 「中」签是译文块的兄弟而不是子元素：宿主 textContent 必须恰好等于整段译文（selectionOffsets 的偏移口径） */
.paper-zh-chip {
  position: absolute; z-index: 1; pointer-events: auto; cursor: pointer; user-select: none;
  font: 600 10px/1 system-ui, sans-serif; padding: 2px 4px; border-radius: 3px;
  color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 10%, #fff);
  border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
}
/* 未译骨架：只描边不覆盖（原文照常可读），脉冲提示「正在翻译」 */
.paper-zh-skel {
  position: absolute; pointer-events: none; border-radius: 3px;
  outline: 1.5px dashed color-mix(in srgb, var(--color-accent) 45%, transparent); outline-offset: 1px;
  animation: pc-pulse 1.4s ease-in-out infinite;
}
.paper-zh-fail { position: absolute; z-index: 1; pointer-events: auto; font-size: 10px; }
/* 跳转闪烁框：非正文块 / 未译块没有覆盖元素可闪，按段落框单独画一层 */
.paper-zh-flash { position: absolute; pointer-events: none; }
@keyframes pc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .paper-zh-skel { animation: none; } }

/* 段落对照流：页容器无固定高度（由条带 + 译文撑开）；条带 = 页位图的裁切 + 同尺寸裁切的文字层 */
.paper-flow-page { height: auto; box-sizing: content-box; }
.paper-flow-row { display: flex; align-items: flex-start; }
.paper-flow-col { flex: 0 0 auto; min-width: 0; }
.paper-flow-strip { position: relative; overflow: clip; }
.paper-flow-strip > canvas { display: block; }
/* 条带的 canvas 不透明（alpha:false），盖住了条带自己的背景动画：跳转闪烁改画在伪元素上 */
.paper-flow-strip.paper-flash::after {
  content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  animation: paper-flash-kf ${FLASH_MS}ms ease-out;
}
@media (prefers-reduced-motion: reduce) { .paper-flow-strip.paper-flash::after { animation-duration: 1ms; } }
/* 文字层容器是整页尺寸（pdf.js setLayerDimensions 写入），负偏移对齐本条带、由条带 overflow:clip 裁掉其余 */
.paper-flow-text { inset: auto; }
.paper-flow-zh {
  margin: 2px 8px 6px; padding-left: .75rem;
  border-left: 2px solid color-mix(in srgb, var(--color-accent) 40%, transparent);
  background: color-mix(in srgb, var(--color-accent) 5%, transparent);
  font: 0.9rem/1.75 var(--paper-zh-font); color: var(--color-fg); overflow-wrap: anywhere;
}
.paper-flow-skel, .paper-flow-fail { margin: 2px 8px 6px; }
@media (max-width: 767px) {
  .paper-flow-zh { font-size: 0.82rem; margin: 2px 4px 4px; padding-left: .5rem; }
  .paper-flow-skel, .paper-flow-fail { margin: 2px 4px 4px; }
}
`}</style>
  )
}
