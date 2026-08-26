// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KpiOverview from './KpiOverview'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('KpiOverview metric selection', () => {
  it('announces the currently selected card with aria-pressed', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root?.render(createElement(KpiOverview, { onJumpTo: vi.fn() })))

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))
    expect(buttons.length).toBeGreaterThan(4)
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1)

    const peakRps = buttons.find((button) => button.textContent?.includes('峰值 RPS'))
    expect(peakRps).toBeDefined()
    act(() => peakRps?.click())

    expect(peakRps?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
  })
})
