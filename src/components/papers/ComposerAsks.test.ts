// @vitest-environment happy-dom

import { act, createElement, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ComposerAsks from './ComposerAsks'
import type { ComposerQuote, PendingAsk } from '../../pages/papers/paperUiStore'

/**
 * 输入框上方 chips 的交互（happy-dom + createRoot/act，UrlImportDialog.test 先例）：
 * 点引用 chip 展开预览、Delete 移除并转移焦点、忙时点排队 chip 不发起。
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

const anchor = { kind: 'pdf', blockIndex: 3, page: 7, section: '4.2 Method' } as const
const ask = (id: string, label = '解释这段'): PendingAsk => ({
  id,
  paperId: 'p1',
  action: 'explain',
  label,
  text: `queued text ${id} ${'x'.repeat(80)}`,
  anchor,
  at: 0,
})
const quote = (id: string, translated = false): ComposerQuote => ({
  id,
  paperId: 'p1',
  text: `quoted text ${id} ${'y'.repeat(200)}`,
  anchor,
  at: 0,
  ...(translated ? { translated } : {}),
})

interface RenderOpts {
  queued?: PendingAsk[]
  quotes?: ComposerQuote[]
  busy?: boolean
  paused?: boolean
}

function render(opts: RenderOpts = {}) {
  const onFire = vi.fn()
  const onRemoveQueued = vi.fn()
  const onRemoveQuote = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  const textarea = document.createElement('textarea')
  container.append(textarea)
  const focusFallbackRef: RefObject<HTMLElement | null> = { current: textarea }
  const mount = document.createElement('div')
  container.prepend(mount)
  root = createRoot(mount)
  const props = {
    queued: opts.queued ?? [],
    quotes: opts.quotes ?? [],
    busy: opts.busy ?? false,
    paused: opts.paused ?? false,
    onFire,
    onRemoveQueued,
    onRemoveQuote,
    focusFallbackRef,
  }
  act(() => root?.render(createElement(ComposerAsks, props)))
  const rerender = (patch: RenderOpts) => act(() => root?.render(createElement(ComposerAsks, { ...props, ...patch })))
  const click = (el: Element | null | undefined) => act(() => el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const key = (el: Element | null | undefined, k: string) =>
    act(() => el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
  return {
    onFire,
    onRemoveQueued,
    onRemoveQuote,
    textarea,
    rerender,
    click,
    key,
    text: () => mount.textContent ?? '',
    queuedChip: (id: string) => mount.querySelector(`[data-queued-ask="${id}"]`),
    quoteChip: (id: string) => mount.querySelector(`[data-composer-quote="${id}"]`),
    body: (chip: Element | null) => chip?.querySelector<HTMLButtonElement>('[data-chip-body]') ?? null,
    x: (chip: Element | null) => chip?.querySelector<HTMLButtonElement>('[aria-label]') ?? null,
    quoteBlocks: () => mount.querySelectorAll('[data-copilot-quote]'),
  }
}

describe('ComposerAsks', () => {
  it('两行都空时不渲染', () => {
    const v = render()
    expect(v.text()).toBe('')
  })

  it('点引用 chip 展开 QuoteBlock 预览，再点收起；× 走 onRemoveQuote', () => {
    const v = render({ quotes: [quote('q1', true), quote('q2')] })
    expect(v.text()).toContain('引用')
    expect(v.quoteBlocks()).toHaveLength(0)
    const chip = v.quoteChip('q1')
    expect(chip?.textContent).toContain('译文')
    v.click(v.body(chip))
    expect(v.quoteBlocks()).toHaveLength(1)
    expect(v.body(chip)?.getAttribute('aria-expanded')).toBe('true')
    expect(v.quoteBlocks()[0].textContent).toContain('§4.2 Method · p.7')
    v.click(v.body(chip))
    expect(v.quoteBlocks()).toHaveLength(0)
    v.click(v.x(chip))
    expect(v.onRemoveQuote).toHaveBeenCalledWith('q1')
  })

  it('Delete 移除当前 chip 并把焦点交给下一 chip；最后一个则落到 textarea', () => {
    const v = render({ quotes: [quote('q1'), quote('q2')] })
    const b1 = v.body(v.quoteChip('q1'))
    const b2 = v.body(v.quoteChip('q2'))
    b1?.focus()
    v.key(b1, 'Delete')
    expect(v.onRemoveQuote).toHaveBeenCalledWith('q1')
    expect(document.activeElement).toBe(b2)
    v.rerender({ quotes: [quote('q2')] })
    v.key(v.body(v.quoteChip('q2')), 'Backspace')
    expect(v.onRemoveQuote).toHaveBeenCalledWith('q2')
    expect(document.activeElement).toBe(v.textarea)
    // 其他按键不触发移除
    v.key(v.body(v.quoteChip('q2')), 'Enter')
    expect(v.onRemoveQuote).toHaveBeenCalledTimes(2)
  })

  it('排队 chip：不忙时点击发起；忙时 disabled、点击不发；× 取消排队', () => {
    const v = render({ queued: [ask('a1', '更简单')] })
    expect(v.text()).toContain('排队中')
    expect(v.text()).toContain('更简单 · queued text a1')
    v.click(v.body(v.queuedChip('a1')))
    expect(v.onFire).toHaveBeenCalledTimes(1)
    expect(v.onFire.mock.calls[0][0].id).toBe('a1')

    v.rerender({ busy: true })
    const body = v.body(v.queuedChip('a1'))
    expect(body?.disabled).toBe(true)
    v.click(body)
    expect(v.onFire).toHaveBeenCalledTimes(1)
    expect(v.text()).not.toContain('已暂停自动发送')

    v.click(v.x(v.queuedChip('a1')))
    expect(v.onRemoveQueued).toHaveBeenCalledWith('a1')
  })

  it('paused 且不忙时提示手动发送；忙时不提示', () => {
    const v = render({ queued: [ask('a1')], paused: true })
    expect(v.text()).toContain('已暂停自动发送，点击芯片发送')
    v.rerender({ busy: true })
    expect(v.text()).not.toContain('已暂停自动发送')
  })

  it('排队 chip 的 Delete 同样移除并转焦到引用行的下一 chip', () => {
    const v = render({ queued: [ask('a1')], quotes: [quote('q1')] })
    const a = v.body(v.queuedChip('a1'))
    a?.focus()
    v.key(a, 'Delete')
    expect(v.onRemoveQueued).toHaveBeenCalledWith('a1')
    expect(document.activeElement).toBe(v.body(v.quoteChip('q1')))
  })
})
