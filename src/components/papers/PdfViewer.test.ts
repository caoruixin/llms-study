import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 原文模式逐像素不变的护栏（源码级，沿 WebSnapshotView.test.ts / captureAgent.test.ts 断言字面量的先例）：
 *
 * PdfPage 的渲染 effect（canvas 位图 + 文字层）一旦把译文相关的东西（zh 切片、translations、failed、highlights…）
 * 放进依赖数组，每批译文落地都会让可见页整页重绘——位图闪白、文字层重建、选区丢失，而且原文模式下
 * 也多了一条重绘路径。中文覆盖必须挂在 effect **之外**（PdfZhOverlay 自己的 layout effect 拟合字号）。
 * 对照流的 PdfFlowPage 同理：rows 由 viewer 按 (blocks, 页尺寸) 记忆化，译文切片（zh）不得进位图 effect。
 * node 环境没有布局、effect 不跑，真实行为由 E2E 在浏览器里验；这里只防依赖数组被改。
 */

const viewerSrc = readFileSync(new URL('./PdfViewer.tsx', import.meta.url), 'utf8')
const flowSrc = readFileSync(new URL('./PdfFlowPage.tsx', import.meta.url), 'utf8')

/** 取「包含 marker 的那个 useEffect」的依赖数组字面量（marker 之后第一个 `}, [ … ])`） */
function depsOfEffectContaining(src: string, scopeStart: string, marker: string): string[] {
  const scope = src.indexOf(scopeStart)
  expect(scope).toBeGreaterThanOrEqual(0)
  const at = src.indexOf(marker, scope)
  expect(at).toBeGreaterThan(scope)
  const m = /\n {2}\}, \[([^\]]*)\]\)/.exec(src.slice(at))
  expect(m).not.toBeNull()
  return m![1].split(',').map((s) => s.trim()).filter(Boolean)
}

const TRANSLATION_IDENTS = /zh|transl|failed|highlight|langMode|blocks|authIssue|onRetry/i

describe('PdfViewer 原文模式护栏', () => {
  it('旋转页（/Rotate ≠ 0）一律按原文渲染：对照流不换 PdfFlowPage、几何换算不出片（PLAN §9.8）', () => {
    expect(viewerSrc).toMatch(/rotated: vp\.rotation % 360 !== 0/)
    expect(viewerSrc).toMatch(/if \(flow && !rotated\)/)
    expect(viewerSrc).toMatch(/if \(\(geom as Partial<PageSize>\)\.rotated\) return \[\]/)
  })


  it('PdfPage 渲染 effect 的依赖数组与改动前逐项相同，不含任何译文相关项', () => {
    const deps = depsOfEffectContaining(viewerSrc, 'const PdfPage = memo(', 'page.render(')
    expect(deps).toEqual(['active', 'doc', 'lib', 'pageNumber', 'scale', 'layoutTick', 'retryTick', 'onRenderError'])
    for (const d of deps) expect(d).not.toMatch(TRANSLATION_IDENTS)
  })

  it('PdfPage 的覆盖层只在「已渲染 + 有 zh 切片」时挂载（原文模式 zh 缺省 → 不出任何元素）', () => {
    expect(viewerSrc).toMatch(/\{rendered && zh && viewportRef\.current && \(\s*<PdfZhOverlay/)
    // 原文模式不给 PdfPage 传切片（旋转页在就地译文模式下也不传：PLAN §9.8）
    expect(viewerSrc).toMatch(/zh=\{inPlace && !rotated \? zhByPage\?\.get\(p\) : undefined\}/)
  })

  it('PdfFlowPage 位图 effect 的依赖数组不含译文切片', () => {
    const deps = depsOfEffectContaining(flowSrc, 'const PdfFlowPage = memo(', 'page.render(')
    expect(deps).toContain('rows')
    for (const d of deps) expect(d).not.toMatch(TRANSLATION_IDENTS)
  })
})
