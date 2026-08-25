import { beforeEach, describe, expect, it } from 'vitest'
import { useInferenceParams, useInferenceScenario } from './store'

const BASE = {
  inputTokens: 16_000,
  outputTokens: 512,
  peakRps: 20,
  concurrency: 32,
  slo: { ttftMs: null, tpotMs: null, e2eMs: null, attainment: 0.95 },
  headroom: 0.2,
  spareUnits: 1,
  gpusPerCapacityUnit: 8,
  gpusPerServer: null,
  serversPerRack: null,
  gpuCount: 8,
  systemTps: 5000,
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

  it('does not invent server or rack topology', () => {
    expect(useInferenceParams.getState().gpusPerServer).toBeNull()
    expect(useInferenceParams.getState().serversPerRack).toBeNull()
  })
})
