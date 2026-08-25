import { create } from 'zustand'
import { importAiperfFiles, type ImportBatch } from '../../lib/aiperfImport'

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

interface KpiUiState {
  batch: ImportBatch | null
  selectedRunKey: string | null
  importing: boolean
  importFailure: string | null
  metadataDrafts: Record<string, ImportedRunMetadataDraft>
  importFiles: (files: File[]) => Promise<void>
  selectRun: (key: string) => void
  updateMetadata: (key: string, patch: Partial<ImportedRunMetadataDraft>) => void
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
  importing: false,
  importFailure: null,
  metadataDrafts: {},
  importFiles: async (files) => {
    if (files.length === 0) return
    set({ importing: true, importFailure: null })
    try {
      const batch = await importAiperfFiles(files)
      const firstRunKey = batch.runs.find((run) => run.valid && !run.cancelled)?.key ?? batch.runs[0]?.key ?? null
      set({
        batch,
        selectedRunKey: firstRunKey,
        importing: false,
        metadataDrafts: Object.fromEntries(
          batch.runs
            .filter((run) => run.sourceNames.some((name) => batch.artifacts.find((a) => a.name === name)?.metadataRequired))
            .map((run) => [run.key, emptyMetadata()]),
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
  updateMetadata: (key, patch) =>
    set((state) => ({
      metadataDrafts: {
        ...state.metadataDrafts,
        [key]: { ...(state.metadataDrafts[key] ?? emptyMetadata()), ...patch },
      },
    })),
  clearImport: () => set({ batch: null, selectedRunKey: null, importFailure: null, metadataDrafts: {} }),
}))
