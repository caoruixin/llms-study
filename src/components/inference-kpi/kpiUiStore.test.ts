import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportBatch } from '../../lib/aiperfImport'
import { useKpiUiStore } from './kpiUiStore'

const emptyBatch: ImportBatch = {
  artifacts: [],
  runs: [],
  sweepPoints: [],
  unassociatedServerMetrics: [],
  unassociatedServerArtifacts: [],
  duplicates: [],
  errors: [],
  warnings: [],
}

describe('kpi ui store (session-only)', () => {
  beforeEach(() =>
    useKpiUiStore.setState({
      batch: null,
      selectedRunKey: null,
      selectedSweepKey: null,
      importing: false,
      importFailure: null,
      metadataDrafts: {},
      view: 'overview',
      confirmedMeasurementKey: null,
    }),
  )

  it('keeps the workbench view across component unmounts (state lives in the store)', () => {
    expect(useKpiUiStore.getState().view).toBe('overview')
    useKpiUiStore.getState().setView('sizing')
    expect(useKpiUiStore.getState().view).toBe('sizing')
  })

  it('stores and clears the manual measurement confirmation key', () => {
    useKpiUiStore.getState().setConfirmedMeasurementKey('run-1|scenario-x')
    expect(useKpiUiStore.getState().confirmedMeasurementKey).toBe('run-1|scenario-x')
    useKpiUiStore.getState().setConfirmedMeasurementKey(null)
    expect(useKpiUiStore.getState().confirmedMeasurementKey).toBeNull()
  })

  it('clearImport drops batch state and the confirmation, but keeps the current view', () => {
    useKpiUiStore.setState({
      batch: emptyBatch,
      selectedRunKey: 'run-1',
      selectedSweepKey: 'sweep:s1',
      importFailure: 'boom',
      metadataDrafts: { 'run-1': { model: 'm' } as never },
      view: 'benchmark',
      confirmedMeasurementKey: 'run-1|scenario-x',
    })

    useKpiUiStore.getState().clearImport()

    const state = useKpiUiStore.getState()
    expect(state.batch).toBeNull()
    expect(state.selectedRunKey).toBeNull()
    expect(state.selectedSweepKey).toBeNull()
    expect(state.importFailure).toBeNull()
    expect(state.metadataDrafts).toEqual({})
    // 确认键绑定 run.key，批次清空必须作废；view 是导航状态不受导入影响
    expect(state.confirmedMeasurementKey).toBeNull()
    expect(state.view).toBe('benchmark')
  })
})
