// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UrlImportDialog, { canOfferReaderRetry } from './UrlImportDialog'
import type { ImportOutcome } from '../../lib/paper/ingest'
import type { IngestFailureHint } from '../../lib/paper/types'
import type { UrlProgressEvent } from '../../lib/paper/url/urlImport'

/**
 * 两条护栏（缺陷 B / H）：
 *   1. 「改用阅读模式重试」只在阅读模式真有机会成功时出现——判据是结构化的 failure.hint，
 *      不是 message 文案；
 *   2. 「取消导入」只在任务还在跑的时候出现，且按下去走的是 onCancel 而不是 onClose
 *      （关闭弹窗刻意不取消任务，见组件头注释）。
 */

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

const failedOutcome = (hint?: IngestFailureHint): ImportOutcome => ({
  kind: 'failed',
  failure: { kind: 'empty', message: '渲染捕获只得到 0 字正文，未能生成网页原貌', at: 0, ...(hint ? { hint } : {}) },
})

/** 弹窗重开后 submitted 为 null，靠进度里的原貌专属阶段推断「上一次是原貌尝试」 */
const snapshotProgress = (): UrlProgressEvent[] => [
  { index: 0, total: 1, url: 'https://a.com/page', phase: 'rendering' },
]

function render(props: { running: boolean; progress: UrlProgressEvent[]; result: { outcome: ImportOutcome } | null }) {
  const onCancel = vi.fn()
  const onClose = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root?.render(
      createElement(UrlImportDialog, { onClose, onCancel, onSubmit: vi.fn(), ...props }),
    ),
  )
  const buttons = () => Array.from(container?.querySelectorAll('button') ?? [])
  return {
    onCancel,
    onClose,
    button: (label: string) => buttons().find((b) => b.textContent?.trim() === label),
    text: () => container?.textContent ?? '',
  }
}

describe('canOfferReaderRetry', () => {
  it.each([
    ['原貌失败且没有 hint → 提供重试', failedOutcome(), true, 1, false, true],
    ['hint=reader-wont-help → 不提供（按了也必然再失败）', failedOutcome('reader-wont-help'), true, 1, false, false],
    ['上一次走的是阅读模式 → 不提供', failedOutcome(), false, 1, false, false],
    ['重导入模式 → 不提供（呈现方式锁死原貌）', failedOutcome(), true, 1, true, false],
    ['还没有任何进度 → 不提供', failedOutcome(), true, 0, false, false],
    ['没有结果 → 不提供', undefined, true, 1, false, false],
  ] as const)('%s', (_name, outcome, wasSnapshot, progressCount, reimport, expected) => {
    expect(canOfferReaderRetry({ outcome, wasSnapshot, progressCount, reimport })).toBe(expected)
  })

  it('成功的结果不会被当成可重试', () => {
    const ready = { kind: 'duplicate' } as unknown as ImportOutcome
    expect(canOfferReaderRetry({ outcome: ready, wasSnapshot: true, progressCount: 1, reimport: false })).toBe(false)
  })
})

describe('UrlImportDialog 失败视图', () => {
  it('hint=reader-wont-help：隐藏「改用阅读模式重试」，补一行说明阅读模式同样抓不到', () => {
    const view = render({ running: false, progress: snapshotProgress(), result: { outcome: failedOutcome('reader-wont-help') } })
    expect(view.button('改用阅读模式重试')).toBeUndefined()
    expect(view.text()).toContain('阅读模式同样不执行页面脚本')
    expect(view.button('完成')).toBeDefined()
  })

  it('没有 hint：照旧提供「改用阅读模式重试」，且不出现那行说明', () => {
    const view = render({ running: false, progress: snapshotProgress(), result: { outcome: failedOutcome() } })
    expect(view.button('改用阅读模式重试')).toBeDefined()
    expect(view.text()).not.toContain('阅读模式同样不执行页面脚本')
  })
})

describe('UrlImportDialog 取消导入', () => {
  it('running 时出现「取消导入」，点击走 onCancel 而不是 onClose', () => {
    const view = render({ running: true, progress: snapshotProgress(), result: null })
    const cancel = view.button('取消导入')
    expect(cancel).toBeDefined()
    act(() => cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(view.onCancel).toHaveBeenCalledTimes(1)
    expect(view.onClose).not.toHaveBeenCalled()
  })

  it('任务已结束（只剩结果）时没有「取消导入」', () => {
    const view = render({ running: false, progress: snapshotProgress(), result: { outcome: failedOutcome() } })
    expect(view.button('取消导入')).toBeUndefined()
  })

  it('还没提交（输入表单）时没有「取消导入」', () => {
    const view = render({ running: false, progress: [], result: null })
    expect(view.button('取消导入')).toBeUndefined()
    expect(view.text()).toContain('呈现方式')
  })
})

describe('网页原貌的已知限制文案', () => {
  it('输入表单里写明脚本生成正文 / shadow DOM / iframe 可能抓不到', () => {
    const view = render({ running: false, progress: [], result: null })
    const text = view.text()
    expect(text).toContain('脚本生成')
    expect(text).toContain('shadow DOM')
    expect(text).toContain('iframe')
  })
})
