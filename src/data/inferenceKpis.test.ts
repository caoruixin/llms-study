import { describe, expect, it } from 'vitest'
import { ARCH_COMPONENTS } from './archAtlas'
import {
  INFERENCE_KPIS,
  KPI_BY_ID,
  KPI_CATEGORIES,
  KPI_IDS,
  type KpiCategory,
  type MetricObservation,
} from './inferenceKpis'

describe('inferenceKpis registry', () => {
  it('covers the four KPI categories with unique IDs', () => {
    expect(KPI_CATEGORIES.map((category) => category.id)).toEqual(['experience', 'capacity', 'resource', 'cost'])
    expect(new Set(INFERENCE_KPIS.map((metric) => metric.id)).size).toBe(INFERENCE_KPIS.length)
    expect(INFERENCE_KPIS.map((metric) => metric.id)).toEqual(KPI_IDS)

    const counts = INFERENCE_KPIS.reduce<Record<KpiCategory, number>>(
      (result, metric) => ({ ...result, [metric.category]: result[metric.category] + 1 }),
      { experience: 0, capacity: 0, resource: 0, cost: 0 },
    )
    expect(counts).toEqual({ experience: 4, capacity: 5, resource: 8, cost: 5 })
  })

  it('defines presentation, measurement, diagnosis, and source metadata for every KPI', () => {
    for (const metric of INFERENCE_KPIS) {
      expect(metric.label.length, `${metric.id}.label`).toBeGreaterThan(0)
      expect(metric.shortName.length, `${metric.id}.shortName`).toBeGreaterThan(0)
      expect(metric.definition.length, `${metric.id}.definition`).toBeGreaterThan(15)
      expect(metric.unit.length, `${metric.id}.unit`).toBeGreaterThan(0)
      expect(metric.statistics.length, `${metric.id}.statistics`).toBeGreaterThan(0)
      expect(metric.relatedArchComponents.length, `${metric.id}.relatedArchComponents`).toBeGreaterThan(0)
      expect(metric.diagnosticMeaning.length, `${metric.id}.diagnosticMeaning`).toBeGreaterThan(10)
      expect(metric.sourceUrl, `${metric.id}.sourceUrl`).toMatch(/^https:\/\//)
      expect(metric.asOf, `${metric.id}.asOf`).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
    }
  })

  it('references only registered KPI dependencies and arch-atlas components', () => {
    const kpiIds = new Set<string>(KPI_IDS)
    const componentIds = new Set<string>(Object.keys(ARCH_COMPONENTS))

    for (const metric of INFERENCE_KPIS) {
      for (const dependency of metric.formulaDependencies) {
        expect(kpiIds.has(dependency), `${metric.id} -> ${dependency}`).toBe(true)
        expect(dependency, `${metric.id} has a self dependency`).not.toBe(metric.id)
      }
      for (const component of metric.relatedArchComponents) {
        expect(componentIds.has(component), `${metric.id} -> ${component}`).toBe(true)
      }
    }
  })

  it('locks the easily-confused NIM and AIPerf semantics', () => {
    expect(KPI_BY_ID['system-output-tps']).toMatchObject({ scope: 'system', measurementPoint: 'engine' })
    expect(KPI_BY_ID['single-user-output-tps'].formula).toContain('E2E')
    expect(KPI_BY_ID['single-user-output-tps'].formula).not.toContain('TPOT')
    expect(KPI_BY_ID.tpot.definition).toContain('不把 TTFT 计入')
    expect(KPI_BY_ID.goodput.formula).toBeNull()
    expect(KPI_BY_ID['slo-attainment-rate'].formula).toContain('error_request_count')
  })

  it('keeps target, estimated, and measured observations discriminated by kind', () => {
    const observations: MetricObservation[] = [
      {
        id: 'target-1',
        kind: 'target',
        kpiId: 'ttft',
        value: 500,
        unit: 'ms/request',
        statistic: 'p95',
        measurementPoint: 'client',
        runId: 'scenario-1',
        constraint: 'at-most',
        source: 'customer-slo',
      },
      {
        id: 'estimate-1',
        kind: 'estimated',
        kpiId: 'e2e-latency',
        value: 1000,
        unit: 'ms/request',
        statistic: 'mean',
        measurementPoint: 'client',
        runId: 'scenario-1',
        formula: 'TTFT + (OSL - 1) × TPOT',
        inputs: { ttft: 100, osl: 46, tpot: 20 },
        assumptions: ['mean values'],
      },
      {
        id: 'measured-1',
        kind: 'measured',
        kpiId: 'goodput',
        value: 8,
        unit: 'good-request/s/system',
        statistic: 'value',
        measurementPoint: 'client',
        runId: 'benchmark-1',
        artifactId: 'artifact-1',
        sampleCount: 100,
        confidenceLevel: 0.95,
      },
    ]

    expect(observations.map((observation) => observation.kind)).toEqual(['target', 'estimated', 'measured'])
  })
})
