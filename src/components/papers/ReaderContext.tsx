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
 *    页面容器需要提供 `--total-scale-factor`（见 PdfViewer）。
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
`}</style>
  )
}
