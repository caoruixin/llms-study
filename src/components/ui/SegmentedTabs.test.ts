// @vitest-environment happy-dom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SegmentedTabs from './SegmentedTabs'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABS = [
  { id: 'overview', label: '全景图' },
  { id: 'benchmark', label: 'Benchmark' },
  { id: 'sizing', label: 'Sizing' },
] as const

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function renderTabs(onChange = vi.fn()) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)

  function Harness() {
    const [value, setValue] = useState<(typeof TABS)[number]['id']>('overview')
    return createElement(SegmentedTabs, {
      tabs: TABS,
      value,
      ariaLabel: 'KPI 工作台视图',
      onChange: (next) => {
        onChange(next)
        setValue(next as (typeof TABS)[number]['id'])
      },
    })
  }

  act(() => root?.render(createElement(Harness)))
  return { onChange, tabs: Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')) }
}

describe('SegmentedTabs accessibility', () => {
  it('exposes tablist/tab state with a single tab stop', () => {
    const { tabs } = renderTabs()
    const tablist = container?.querySelector('[role="tablist"]')

    expect(tablist?.getAttribute('aria-label')).toBe('KPI 工作台视图')
    expect(tabs).toHaveLength(3)
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
  })

  it.each([
    ['ArrowRight', 0, 'benchmark'],
    ['ArrowLeft', 0, 'sizing'],
    ['End', 0, 'sizing'],
    ['Home', 2, 'overview'],
  ] as const)('switches and focuses with %s', (key, startIndex, expected) => {
    const { onChange, tabs } = renderTabs()
    tabs[startIndex].focus()

    act(() => tabs[startIndex].dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

    expect(onChange).toHaveBeenLastCalledWith(expected)
    expect(document.activeElement?.textContent).toBe(TABS.find((tab) => tab.id === expected)?.label)
    const selected = container?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    expect(selected?.textContent).toBe(TABS.find((tab) => tab.id === expected)?.label)
    expect(selected?.tabIndex).toBe(0)
  })
})
