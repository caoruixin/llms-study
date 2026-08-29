import { describe, expect, it } from 'vitest'
import { LlmError } from '../../llmClient'
import { GatewayError, type CompletePaperJsonRequest, type CompletePaperJsonResult } from '../modelGateway'
import { createTranslationScheduler, type TranslationSchedulerDeps, type TranslationSnapshot } from './useTranslations'
import { TRANSLATE_PROMPT_VERSION, srcHash } from './translateBatch'
import type { BlockTranslation, PaperBlock } from '../types'

/**
 * 调度层测试：stub gateway 验证单飞行、失败对分、consent 停机与 sensitive 静默。
 * gateway 契约按真实实现模拟：validate(raw) 的结果就是 parsed（修复阶梯在 gateway 内部，
 * stub 一次给出终局——返回能过校验的 raw = 成功，返回垃圾 = 修复兜底全失败 parsed null）。
 */

const blk = (index: number, text: string): PaperBlock => ({
  id: `p1:${index}`,
  paperId: 'p1',
  index,
  kind: 'paragraph',
  text,
  anchor: { kind: 'pdf', blockIndex: index, page: 1 },
})

/** 从请求 user 消息反解条目，逐条回填 zh —— 恒过校验的「好」响应 */
function okRaw(req: CompletePaperJsonRequest): string {
  const { items } = JSON.parse(req.messages[1].content) as {
    items: { i: number; p?: number; k: string; t: string }[]
  }
  return JSON.stringify({
    items: items.map((it) => ({ i: it.i, ...(it.p !== undefined ? { p: it.p } : {}), zh: `译${it.i}#${it.p ?? '-'}` })),
  })
}

type Responder = (req: CompletePaperJsonRequest, call: number) => string | Error

function makeHarness(opts: {
  blocks: PaperBlock[]
  respond?: Responder
  cached?: BlockTranslation[]
  consent?: () => Promise<boolean>
  sensitive?: boolean
}) {
  const calls: CompletePaperJsonRequest[] = []
  let inFlight = 0
  let maxConcurrent = 0
  let consentAsks = 0
  const saved: BlockTranslation[][] = []
  let snapshot: TranslationSnapshot = { texts: new Map(), failed: new Set(), authIssue: null }

  const respond = opts.respond ?? ((req) => okRaw(req))

  const deps: TranslationSchedulerDeps = {
    gateway: {
      completePaperJson: async (req): Promise<CompletePaperJsonResult> => {
        calls.push(req)
        inFlight += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await Promise.resolve() // 让并发（若有）有机会暴露
        const r = respond(req, calls.length - 1)
        inFlight -= 1
        if (r instanceof Error) throw r
        const parsed = req.validate ? req.validate(r) : r
        return {
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          inputTokens: 1,
          outputTokens: 1,
          estimated: true,
          cost: 0,
          raw: r,
          parsed,
          repaired: false,
          usedFallbackModel: false,
        }
      },
    },
    loadTranslations: async () => opts.cached ?? [],
    saveTranslations: async (rows) => {
      saved.push(rows)
    },
    ensureConsent: () => {
      consentAsks += 1
      return opts.consent ? opts.consent() : Promise.resolve(true)
    },
    now: () => 1_700_000_000,
  }

  const scheduler = createTranslationScheduler({
    paper: { id: 'p1', sensitive: opts.sensitive ?? false },
    blocks: opts.blocks,
    deps,
    onChange: (s) => {
      snapshot = s
    },
  })

  /** 等调度静默：串行队列跑空（微任务驱动，几个宏任务 tick 足够） */
  const settle = async (tries = 40) => {
    for (let i = 0; i < tries; i++) await new Promise((r) => setTimeout(r, 0))
  }

  return {
    scheduler,
    calls,
    saved,
    settle,
    get snapshot() {
      return snapshot
    },
    get maxConcurrent() {
      return maxConcurrent
    },
    get consentAsks() {
      return consentAsks
    },
  }
}

describe('createTranslationScheduler', () => {
  it('激活后翻译窗口内全部缺译块：单飞行逐包串行，译文与落库行齐全', async () => {
    // 每块 1800 字符 ≈ 600 token → 每包 3 条；21 块窗口 → 7 包
    const blocks = Array.from({ length: 30 }, (_, i) => blk(i, `text-${i} `.padEnd(1800, 'x')))
    const h = makeHarness({ blocks })

    h.scheduler.setWindow(10) // 激活前记录的阅读位置也要生效
    await h.scheduler.activate()
    await h.settle()

    expect(h.calls).toHaveLength(7)
    expect(h.maxConcurrent).toBe(1) // 单飞行
    expect(h.calls.every((c) => c.task === 'translate' && c.paperId === 'p1')).toBe(true)
    // 窗口 [6, 26] 全部完成
    for (let i = 6; i <= 26; i++) expect(h.snapshot.texts.get(i)).toBe(`译${i}#-`)
    expect(h.snapshot.texts.has(5)).toBe(false)
    expect(h.snapshot.texts.has(27)).toBe(false)
    expect(h.snapshot.failed.size).toBe(0)

    // 落库行：确定性 id + 当前协议版本 + 原文哈希
    const rows = h.saved.flat()
    const row6 = rows.find((r) => r.blockIndex === 6)!
    expect(row6).toMatchObject({
      id: 'p1:6:zh',
      paperId: 'p1',
      blockId: 'p1:6',
      targetLang: 'zh',
      promptVersion: TRANSLATE_PROMPT_VERSION,
      model: 'deepseek-v4-pro',
      srcHash: srcHash(blocks[6].text),
    })
  })

  it('缓存命中不再出包；promptVersion / srcHash 不符视同缺失重译', async () => {
    const blocks = [blk(0, 'a'), blk(1, 'b'), blk(2, 'c')]
    const mkRow = (i: number, patch: Partial<BlockTranslation> = {}): BlockTranslation => ({
      id: `p1:${i}:zh`,
      paperId: 'p1',
      blockIndex: i,
      blockId: `p1:${i}`,
      targetLang: 'zh',
      promptVersion: TRANSLATE_PROMPT_VERSION,
      model: 'deepseek-v4-pro',
      srcHash: srcHash(blocks[i].text),
      text: `缓存${i}`,
      createdAt: 1,
      updatedAt: 1,
      ...patch,
    })
    const h = makeHarness({
      blocks,
      cached: [mkRow(0), mkRow(1, { promptVersion: 'tr0' }), mkRow(2, { srcHash: '00000000' })],
    })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()

    expect(h.snapshot.texts.get(0)).toBe('缓存0') // 命中：不重译
    expect(h.snapshot.texts.get(1)).toBe('译1#-') // 版本不符：重译
    expect(h.snapshot.texts.get(2)).toBe('译2#-') // 原文哈希不符：重译
    const requested = h.calls.flatMap((c) => (JSON.parse(c.messages[1].content) as { items: { i: number }[] }).items.map((it) => it.i))
    expect(requested.sort()).toEqual([1, 2])
  })

  it('对齐修复兜底全失败 → 对分重试隔离坏块 → 仅坏块标 error', async () => {
    const blocks = [blk(0, 'good'), blk(1, 'poison'), blk(2, 'good2'), blk(3, 'good3')]
    // 含 i=1 的包永远给垃圾（gateway 阶梯终局 parsed=null），不含则正常
    const respond: Responder = (req) => {
      const { items } = JSON.parse(req.messages[1].content) as { items: { i: number }[] }
      return items.some((it) => it.i === 1) ? 'not a json at all' : okRaw(req)
    }
    const h = makeHarness({ blocks, respond })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()

    expect(h.snapshot.texts.get(0)).toBe('译0#-')
    expect(h.snapshot.texts.get(2)).toBe('译2#-')
    expect(h.snapshot.texts.get(3)).toBe('译3#-')
    expect(h.snapshot.texts.has(1)).toBe(false)
    expect([...h.snapshot.failed]).toEqual([1])
    // 对分树：[0..3]失败 → [0,1]失败 → [0]成功 [1]失败 → [2,3]成功 = 5 次调用
    expect(h.calls).toHaveLength(5)
  })

  it('失败块不自动重试（防风暴）；retryBlock 清标记后恢复', async () => {
    const blocks = [blk(0, 'only')]
    let failCalls = 0
    const respond: Responder = (req, call) => {
      if (call === 0) {
        failCalls += 1
        return new Error('network down')
      }
      return okRaw(req)
    }
    const h = makeHarness({ blocks, respond })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()
    expect([...h.snapshot.failed]).toEqual([0])
    expect(failCalls).toBe(1)

    // 窗口再怎么动都不自动重试
    h.scheduler.setWindow(0)
    await h.settle()
    expect(h.calls).toHaveLength(1)

    h.scheduler.retryBlock(0)
    await h.settle()
    expect(h.snapshot.texts.get(0)).toBe('译0#-')
    expect(h.snapshot.failed.size).toBe(0)
  })

  it('consent 拒绝 → 停在骨架态（零请求零失败标记）；再激活重新询问后恢复', async () => {
    const blocks = [blk(0, 'a'), blk(1, 'b')]
    let granted = false
    const h = makeHarness({ blocks, consent: () => Promise.resolve(granted) })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()

    expect(h.consentAsks).toBe(1)
    expect(h.calls).toHaveLength(0)
    expect(h.snapshot.texts.size).toBe(0)
    expect(h.snapshot.failed.size).toBe(0) // 骨架态，不是失败态

    // 停机期间窗口变化也不再骚扰用户
    h.scheduler.setWindow(1)
    await h.settle()
    expect(h.consentAsks).toBe(1)

    granted = true
    await h.scheduler.activate() // 用户再切一次非原文 = 再问一次
    await h.settle()
    expect(h.consentAsks).toBe(2)
    expect(h.snapshot.texts.size).toBe(2)
  })

  it('敏感论文：只读缓存，绝不出包也不问 consent', async () => {
    const blocks = [blk(0, 'secret')]
    const h = makeHarness({ blocks, sensitive: true })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()

    expect(h.calls).toHaveLength(0)
    expect(h.consentAsks).toBe(0)
  })

  it('GatewayError（熔断等）→ 整体停机保骨架，不刷失败标记', async () => {
    const blocks = [blk(0, 'a'), blk(1, 'b')]
    const h = makeHarness({
      blocks,
      respond: () => new GatewayError('circuit-open', 'deepseek', '熔断中'),
    })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()

    expect(h.calls).toHaveLength(1)
    expect(h.snapshot.failed.size).toBe(0)
    h.scheduler.setWindow(1)
    await h.settle()
    expect(h.calls).toHaveLength(1) // 停机后不再出包
  })

  it('auth 失败（no-user-key）→ 停机 + 该包标失败 + authIssue 记码；retryBlock 清码后恢复', async () => {
    const blocks = [blk(0, 'a'), blk(1, 'b')]
    let first = true
    const h = makeHarness({
      blocks,
      respond: (req) => {
        if (first) {
          first = false
          const e = new LlmError('auth', '该账号尚未配置此服务商的 API key')
          e.code = 'no-user-key'
          return e
        }
        return okRaw(req)
      },
    })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()

    expect(h.calls).toHaveLength(1)
    expect(h.snapshot.authIssue).toBe('no-user-key')
    expect(h.snapshot.failed.size).toBeGreaterThan(0) // 该包的块标失败 → 失败 chip 有宿主
    h.scheduler.setWindow(1)
    await h.settle()
    expect(h.calls).toHaveLength(1) // 停机后不再出包（防 403 风暴）

    // 用户配好 key 后单块重试：authIssue 清除、恢复出包并成功
    h.scheduler.retryBlock(0)
    await h.settle()
    expect(h.snapshot.authIssue).toBeNull()
    expect(h.snapshot.texts.has(0)).toBe(true)
  })

  it('长块分片跨包收齐后按分片号拼接落库', async () => {
    // 6000 字符 → 2000 token > 1500：切成 4500+1500 两片（各自 1500/500 token，同包放不下 1800 上限外）
    const long = 'L'.repeat(6000)
    const blocks = [blk(0, long)]
    const h = makeHarness({ blocks })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()

    expect(h.snapshot.texts.get(0)).toBe('译0#0译0#1')
    const rows = h.saved.flat()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'p1:0:zh', srcHash: srcHash(long), text: '译0#0译0#1' })
  })

  it('dispose 后不再发起任何请求', async () => {
    const blocks = Array.from({ length: 5 }, (_, i) => blk(i, `t${i}`))
    const h = makeHarness({ blocks })
    await h.scheduler.activate()
    h.scheduler.dispose()
    h.scheduler.setWindow(0)
    await h.settle()
    expect(h.calls).toHaveLength(0)
  })
})
