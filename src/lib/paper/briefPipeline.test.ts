import { describe, expect, it } from 'vitest'
import {
  BriefAbortError,
  buildSynthesisMessages,
  estimateBriefCost,
  runBriefPipeline,
  sectionizeUnits,
  unitCacheKey,
  validateBriefDataJson,
  validateUnitDigestJson,
  type BriefPipelineDeps,
  type BriefUnit,
  type UnitDigest,
} from './briefPipeline'
import type { CompletePaperJsonResult } from './modelGateway'
import type { PaperBlock } from './types'

const mkBlock = (index: number, kind: PaperBlock['kind'], text: string, level?: number): PaperBlock => ({
  id: `b${index}`,
  paperId: 'p1',
  index,
  kind,
  level,
  text,
  anchor: { kind: 'pdf', blockIndex: index },
})

describe('sectionizeUnits', () => {
  it('按 1–2 级标题分单元，标题进单元 title', () => {
    const blocks = [
      mkBlock(0, 'heading', 'Introduction', 1),
      mkBlock(1, 'paragraph', '引言内容'),
      mkBlock(2, 'heading', 'Method', 1),
      mkBlock(3, 'paragraph', '方法内容'),
    ]
    const units = sectionizeUnits(blocks)
    expect(units.map((u) => u.title)).toEqual(['Introduction', 'Method'])
    expect(units[0].text).toContain('引言内容')
  })

  it('超 20K token 的章节切成连续部分', () => {
    const big = 'x'.repeat(30_000) // 10K token
    const blocks = [
      mkBlock(0, 'heading', 'Huge', 1),
      ...Array.from({ length: 9 }, (_, i) => mkBlock(i + 1, 'paragraph', big)),
    ]
    const units = sectionizeUnits(blocks)
    expect(units.length).toBeGreaterThan(1)
    for (const u of units) expect(u.tokenEstimate).toBeLessThanOrEqual(20_000)
    expect(units[1].title).toContain('续')
  })

  it('小节合并到 ≤10 个单元', () => {
    const blocks: PaperBlock[] = []
    for (let i = 0; i < 30; i++) {
      blocks.push(mkBlock(i * 2, 'heading', `节${i}`, 2))
      blocks.push(mkBlock(i * 2 + 1, 'paragraph', `内容${i}`))
    }
    const units = sectionizeUnits(blocks)
    expect(units.length).toBeLessThanOrEqual(10)
  })

  it('无标题 → 单一「开头」单元；确定性（同输入同输出）', () => {
    const blocks = [mkBlock(0, 'paragraph', '内容 A'), mkBlock(1, 'paragraph', '内容 B')]
    const a = sectionizeUnits(blocks)
    const b = sectionizeUnits(blocks)
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
    expect(a[0].id).toBe(b[0].id)
  })
})

describe('digest / brief 校验器', () => {
  it('unit digest：summary 必填，keyPoints 钳制', () => {
    expect(validateUnitDigestJson('{"summary":"讲了注意力","keyPoints":["a","b"]}')).toEqual({
      summary: '讲了注意力',
      keyPoints: ['a', 'b'],
    })
    expect(validateUnitDigestJson('{"keyPoints":[]}')).toBeNull()
    expect(validateUnitDigestJson('围栏杂讯 {"summary":"s"} 尾巴')).toEqual({ summary: 's', keyPoints: [] })
    expect(validateUnitDigestJson('不是 JSON')).toBeNull()
  })

  it('brief data：oneLiner 必填，缺省字段回退占位', () => {
    const r = validateBriefDataJson('{"oneLiner":"一句话","contributions":["c1"]}')
    expect(r).toMatchObject({ oneLiner: '一句话', contributions: ['c1'], problem: '（未能提取）' })
    expect(validateBriefDataJson('{"problem":"没有一句话结论"}')).toBeNull()
  })
})

const mkUnit = (id: string, title: string): BriefUnit => ({ id, title, text: `${title} 的正文`, tokenEstimate: 100 })

const jsonResult = (parsed: unknown, cost = 0.01): CompletePaperJsonResult => ({
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  inputTokens: 100,
  outputTokens: 50,
  estimated: false,
  cost,
  raw: JSON.stringify(parsed ?? {}),
  parsed,
  repaired: false,
  usedFallbackModel: false,
})

function makeDeps(overrides: Partial<BriefPipelineDeps> = {}) {
  const cache = new Map<string, UnitDigest>()
  const calls: string[] = []
  const progress: [number, number][] = []
  const deps: BriefPipelineDeps = {
    completeJson: async (req) => {
      calls.push(req.task)
      if (req.task.startsWith('brief-digest')) {
        return jsonResult({ summary: `摘要-${req.task}`, keyPoints: ['要点'] })
      }
      return jsonResult({
        oneLiner: '一句话结论',
        problem: '问题',
        contributions: ['贡献'],
        method: '方法',
        theory: '无',
        algorithm: '无',
        experiments: '实验',
        limitations: '局限',
        prerequisites: ['前置'],
        readingPath: ['先读引言'],
      })
    },
    loadUnitDigest: async (key) => cache.get(key) ?? null,
    saveUnitDigest: async (key, digest) => {
      cache.set(key, digest)
    },
    onProgress: (done, total) => progress.push([done, total]),
    ...overrides,
  }
  return { deps, cache, calls, progress }
}

const input = {
  paperTitle: '测试论文',
  fileHash: 'hash1',
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  units: [mkUnit('u1-10', 'Introduction'), mkUnit('u2-10', 'Method')],
}

describe('runBriefPipeline', () => {
  it('happy path：逐单元 + 综合，进度持续上报，digest 落缓存', async () => {
    const { deps, cache, calls, progress } = makeDeps()
    const r = await runBriefPipeline(deps, input)
    expect(calls).toEqual(['brief-digest:u1-10', 'brief-digest:u2-10', 'brief-synthesis'])
    expect(r.data.oneLiner).toBe('一句话结论')
    expect(r.data.gaps).toEqual([])
    expect(r.digests).toHaveLength(2)
    expect(r.cost).toBeCloseTo(0.03, 10)
    expect(cache.size).toBe(2)
    expect(progress[0]).toEqual([0, 3])
    expect(progress[progress.length - 1]).toEqual([3, 3])
  })

  it('断点续跑：已缓存单元不再调用', async () => {
    const { deps, cache, calls } = makeDeps()
    cache.set(unitCacheKey('hash1', 'u1-10', 'deepseek', 'deepseek-v4-pro'), {
      unitId: 'u1-10',
      title: 'Introduction',
      summary: '缓存摘要',
      keyPoints: [],
    })
    const r = await runBriefPipeline(deps, input)
    expect(calls).toEqual(['brief-digest:u2-10', 'brief-synthesis'])
    expect(r.digests[0].summary).toBe('缓存摘要')
  })

  it('单元失败（修复+兜底后仍 null）→ 标缺口继续，综合显式带缺口', async () => {
    const synthesisMessages: string[] = []
    const { deps } = makeDeps({
      completeJson: async (req) => {
        if (req.task === 'brief-digest:u1-10') return jsonResult(null) // 该单元彻底失败
        if (req.task.startsWith('brief-digest')) return jsonResult({ summary: 's', keyPoints: [] })
        synthesisMessages.push(req.messages[1].content)
        return jsonResult({ oneLiner: '结论', problem: 'p', contributions: [], method: 'm', theory: '无', algorithm: '无', experiments: 'e', limitations: 'l', prerequisites: [], readingPath: [] })
      },
    })
    const r = await runBriefPipeline(deps, input)
    expect(r.data.gaps).toEqual(['Introduction'])
    expect(synthesisMessages[0]).toContain('Introduction')
    expect(synthesisMessages[0]).toContain('摘要失败')
  })

  it('全部单元失败 → 抛错（无法综合）', async () => {
    const { deps } = makeDeps({ completeJson: async () => jsonResult(null) })
    await expect(runBriefPipeline(deps, input)).rejects.toThrow('无法综合')
  })

  it('中断：signal.aborted → BriefAbortError（已完成单元的缓存保留）', async () => {
    const ctrl = new AbortController()
    const { deps, cache } = makeDeps({
      signal: ctrl.signal,
      completeJson: async (req) => {
        ctrl.abort() // 第一个单元完成后中断
        return jsonResult(req.task.startsWith('brief-digest') ? { summary: 's', keyPoints: [] } : null)
      },
    })
    await expect(runBriefPipeline(deps, input)).rejects.toBeInstanceOf(BriefAbortError)
    expect(cache.size).toBe(1) // u1 已缓存，续跑从 u2 开始
  })

  it('综合失败 → 抛错（单元缓存在，重试便宜）', async () => {
    const { deps, cache } = makeDeps({
      completeJson: async (req) =>
        req.task.startsWith('brief-digest') ? jsonResult({ summary: 's', keyPoints: [] }) : jsonResult(null),
    })
    await expect(runBriefPipeline(deps, input)).rejects.toThrow('综合失败')
    expect(cache.size).toBe(2)
  })
})

describe('estimateBriefCost / buildSynthesisMessages', () => {
  it('预估：调用数 = 单元数 + 1，成本按价格表', () => {
    const est = estimateBriefCost(input.units, { inPerMTok: 0.435, outPerMTok: 0.87 })
    expect(est.calls).toBe(3)
    expect(est.inputTokens).toBeGreaterThan(0)
    expect(est.cost).toBeGreaterThan(0)
  })

  it('综合 prompt 含全部 digest 与注入防御 system', () => {
    const msgs = buildSynthesisMessages('论文', [{ unitId: 'u1', title: 'T', summary: 'S', keyPoints: ['K'] }], [])
    expect(msgs[0].role).toBe('system')
    expect(msgs[1].content).toContain('【T】')
    expect(msgs[1].content).toContain('oneLiner')
  })
})
