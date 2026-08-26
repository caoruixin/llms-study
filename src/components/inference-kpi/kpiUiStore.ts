import { create } from 'zustand'
import { importAiperfFiles, type ImportBatch } from '../../lib/aiperfImport'
import { groupSweepPoints } from './metricUi'

export interface ImportedRunMetadataDraft {
  model: string
  quantization: string
  inputTokens: string
  outputTokens: string
  engine: string
  engineVersion: string
  gpuModel: string
  gpuCount: string
  topology: string
  loadMode: string
  workload: string
  slo: string
}

/** KPI 工作台二级视图；提升到 store 后往返显存墙等 tab 不再丢当前视图。 */
export type KpiWorkbenchView = 'overview' | 'benchmark' | 'sizing' | 'dictionary'

interface KpiUiState {
  batch: ImportBatch | null
  selectedRunKey: string | null
  selectedSweepKey: string | null
  importing: boolean
  importFailure: string | null
  metadataDrafts: Record<string, ImportedRunMetadataDraft>
  view: KpiWorkbenchView
  // Sizing 门禁的人工确认（run.key + 场景口径的组合键）；组件卸载不能作废用户勾选
  confirmedMeasurementKey: string | null
  importFiles: (files: File[]) => Promise<void>
  selectRun: (key: string) => void
  selectSweep: (key: string) => void
  updateMetadata: (key: string, patch: Partial<ImportedRunMetadataDraft>) => void
  setView: (view: KpiWorkbenchView) => void
  setConfirmedMeasurementKey: (key: string | null) => void
  clearImport: () => void
}

const emptyMetadata = (): ImportedRunMetadataDraft => ({
  model: '',
  quantization: '',
  inputTokens: '',
  outputTokens: '',
  engine: '',
  engineVersion: '',
  gpuModel: '',
  gpuCount: '',
  topology: '',
  loadMode: '',
  workload: '',
  slo: '',
})

/**
 * AIPerf 导入只放在 Zustand 内存态，不使用 persist。切 KPI 二级视图仍保留，刷新即清除。
 */
export const useKpiUiStore = create<KpiUiState>()((set) => ({
  batch: null,
  selectedRunKey: null,
  selectedSweepKey: null,
  importing: false,
  importFailure: null,
  metadataDrafts: {},
  view: 'overview',
  confirmedMeasurementKey: null,
  importFiles: async (files) => {
    if (files.length === 0) return
    set({ importing: true, importFailure: null })
    try {
      const batch = await importAiperfFiles(files)
      const firstSweep = groupSweepPoints(batch.sweepPoints)[0] ?? null
      const firstSweepRun = firstSweep === null
        ? undefined
        : batch.runs.find((run) =>
            run.valid &&
            !run.cancelled &&
            (firstSweep.sweepId !== null
              ? run.sweepId === firstSweep.sweepId
              : firstSweep.sourceName !== null && run.sourceNames.includes(firstSweep.sourceName)),
          )
      const firstRunKey = firstSweepRun?.key
        ?? batch.runs.find((run) => run.valid && !run.cancelled)?.key
        ?? batch.runs[0]?.key
        ?? null
      set({
        batch,
        selectedRunKey: firstRunKey,
        selectedSweepKey: firstSweep?.key ?? null,
        importing: false,
        // 新批次是新证据：旧的可比性人工确认一律作废，必须重新核对
        confirmedMeasurementKey: null,
        metadataDrafts: Object.fromEntries(
          // JSON input_config is often nested and may still omit deployment topology/version.
          // Keep an in-memory override draft for every run; the UI only opens it when effective fields are incomplete.
          batch.runs.map((run) => [run.key, emptyMetadata()]),
        ),
      })
    } catch (error) {
      set({
        importing: false,
        importFailure: error instanceof Error ? error.message : '无法读取所选文件。',
      })
    }
  },
  selectRun: (selectedRunKey) => set({ selectedRunKey }),
  selectSweep: (selectedSweepKey) => set({ selectedSweepKey }),
  updateMetadata: (key, patch) =>
    set((state) => ({
      metadataDrafts: {
        ...state.metadataDrafts,
        [key]: { ...(state.metadataDrafts[key] ?? emptyMetadata()), ...patch },
      },
    })),
  setView: (view) => set({ view }),
  setConfirmedMeasurementKey: (confirmedMeasurementKey) => set({ confirmedMeasurementKey }),
  // view 是导航状态不随导入清除；确认键绑定 run.key，批次清空后必须一并作废
  clearImport: () =>
    set({ batch: null, selectedRunKey: null, selectedSweepKey: null, importFailure: null, metadataDrafts: {}, confirmedMeasurementKey: null }),
}))
