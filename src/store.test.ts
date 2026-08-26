import { beforeEach, describe, expect, it } from 'vitest'
import { useInferenceParams, useInferenceScenario } from './store'

const BASE = {
  expectedPrefixHitRate: null,
  inputTokens: 16_000,
  outputTokens: 512,
  peakRps: 20,
  concurrency: 32,
  slo: { ttftMs: null, tpotMs: null, e2eMs: null, attainment: null },
  headroom: 0.2,
  spareUnits: 1,
  gpusPerCapacityUnit: 8,
  gpusPerServer: null,
  serversPerRack: null,
  gpuCount: 8,
  systemTps: 5000,
  systemTpsFingerprint: null,
  systemTpsSource: null,
  utilization: 0.4,
  hourlyCost: 27.2,
}

describe('inference scenario store', () => {
  beforeEach(() => useInferenceParams.setState(BASE))

  it('keeps the legacy and scenario hooks on one source of truth', () => {
    useInferenceScenario.getState().setInputTokens(32_000)
    expect(useInferenceParams.getState().inputTokens).toBe(32_000)
  })

  it('clamps unsafe sizing and SLO inputs', () => {
    const state = useInferenceParams.getState()
    state.setHeadroom(2)
    state.setSpareUnits(-3)
    state.setSlo({ ttftMs: -1, attainment: 4 })
    expect(useInferenceParams.getState()).toMatchObject({
      headroom: 1,
      spareUnits: 0,
      slo: { ttftMs: 0, attainment: 1 },
    })
  })

  it('keeps attainment unset until explicitly supplied and allows clearing it', () => {
    expect(useInferenceParams.getState().slo.attainment).toBeNull()
    useInferenceParams.getState().setSlo({ attainment: 0.97 })
    expect(useInferenceParams.getState().slo.attainment).toBe(0.97)
    useInferenceParams.getState().setSlo({ attainment: null })
    expect(useInferenceParams.getState().slo.attainment).toBeNull()
  })

  it('keeps the diagnostic prefix-hit expectation unset until explicitly supplied', () => {
    // cacheRate 是估算假设；诊断预期必须独立显式设置，默认 null 抑制 cache-hit-gap 规则。
    expect(useInferenceParams.getState().expectedPrefixHitRate).toBeNull()
    useInferenceParams.getState().setExpectedPrefixHitRate(0.75)
    expect(useInferenceParams.getState().expectedPrefixHitRate).toBe(0.75)
    useInferenceParams.getState().setExpectedPrefixHitRate(1.4)
    expect(useInferenceParams.getState().expectedPrefixHitRate).toBe(1)
    useInferenceParams.getState().setExpectedPrefixHitRate(null)
    expect(useInferenceParams.getState().expectedPrefixHitRate).toBeNull()
  })

  it('does not invent server or rack topology', () => {
    expect(useInferenceParams.getState().gpusPerServer).toBeNull()
    expect(useInferenceParams.getState().serversPerRack).toBeNull()
  })

  it('invalidates a TPS estimate when its model context changes and revalidates explicit input', () => {
    const state = useInferenceParams.getState()
    state.setSystemTps(7000, 'estimated')
    expect(useInferenceParams.getState().systemTpsFingerprint).not.toBeNull()
    state.setModelId('another-model')
    expect(useInferenceParams.getState().systemTpsFingerprint).toBeNull()
    useInferenceParams.getState().setSystemTps(6500, 'manual')
    expect(useInferenceParams.getState().systemTpsSource).toBe('manual')
  })
})
