// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import EconomicsPanel, { capacityUnitBreakdown } from './EconomicsPanel'
import { inferenceTpsFingerprint, useInferenceParams } from '../store'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('capacityUnitBreakdown', () => {
  it('never yields fractional capacity units', () => {
    // 1 卡 ÷ 12 卡/单元：不足一个单元 → 0 单元，1 卡全是余数
    expect(capacityUnitBreakdown(1, 12)).toEqual({ wholeUnits: 0, remainderGpus: 1 })
    // 13 卡 ÷ 12 卡/单元：只算 1 个整单元，1 卡不计入产能
    expect(capacityUnitBreakdown(13, 12)).toEqual({ wholeUnits: 1, remainderGpus: 1 })
    expect(capacityUnitBreakdown(24, 12)).toEqual({ wholeUnits: 2, remainderGpus: 0 })
    expect(capacityUnitBreakdown(8, 8)).toEqual({ wholeUnits: 1, remainderGpus: 0 })
  })
})

describe('EconomicsPanel whole-unit capacity', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  const setScenario = (gpuCount: number, gpusPerCapacityUnit: number) => {
    useInferenceParams.setState({ gpuCount, gpusPerCapacityUnit, systemTps: 6000 })
    // 场景口径有效（指纹匹配当前状态），隔离出“单元不足”这一种失效原因
    useInferenceParams.setState({
      systemTpsFingerprint: inferenceTpsFingerprint(useInferenceParams.getState()),
      systemTpsSource: 'manual',
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it('refuses cost conclusions below one whole capacity unit', () => {
    setScenario(1, 12)
    act(() => root?.render(createElement(EconomicsPanel)))

    const text = container?.textContent ?? ''
    expect(text).toContain('不足一个容量单元（需 12 卡）')
    expect(text).toContain('不出成本结论')
    // 图表让位给警告块，自建单位成本显示 N/A
    expect(text).toContain('N/A')
  })

  it('counts only whole units and flags leftover GPUs', () => {
    setScenario(13, 12)
    act(() => root?.render(createElement(EconomicsPanel)))

    const text = container?.textContent ?? ''
    // 13 卡 = 1 整单元 × 6000 tok/s；余 1 卡明示不计入
    expect(text).toContain('12 GPU/单元 × 1 单元')
    expect(text).toContain('折算 6000 tok/s')
    expect(text).toContain('1 卡不成单元，不计入产能')
  })
})
