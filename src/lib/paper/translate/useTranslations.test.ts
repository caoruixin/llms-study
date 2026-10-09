import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAPER_CIRCUIT } from '../../../data/paperPolicy'
import { LlmError } from '../../llmClient'
import { GatewayError, type CompletePaperJsonRequest, type CompletePaperJsonResult } from '../modelGateway'
import {
  CIRCUIT_RESUME_SLACK_MS,
  createTranslationScheduler,
  isPulledFor,
  type TranslateAllProgress,
  type TranslateAllResult,
  type TranslationSchedulerDeps,
  type TranslationSnapshot,
} from './useTranslations'
import { TRANSLATE_PROMPT_VERSION, srcHash } from './translateBatch'
import type { BlockTranslation, PaperBlock } from '../types'

/**
 * 调度层测试：stub gateway 验证单飞行、失败对分、consent 停机、sensitive 静默与熔断暂停自动恢复（假时钟）。
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

/** 「另一台设备译好、被同步引擎补拉落库」的一行（reload 用） */
const remoteRow = (
  index: number,
  srcText: string,
  text: string,
  patch: Partial<BlockTranslation> = {},
): BlockTranslation => ({
  id: `p1:${index}:zh`,
  paperId: 'p1',
  blockIndex: index,
  blockId: `p1:${index}`,
  targetLang: 'zh',
  promptVersion: TRANSLATE_PROMPT_VERSION,
  model: 'deepseek-v4-pro',
  srcHash: srcHash(srcText),
  text,
  createdAt: 1,
  updatedAt: 2,
  ...patch,
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

/** 响应可以是 Promise：用例需要把网关挂起、再决定何时成功/失败时用 */
type Responder = (req: CompletePaperJsonRequest, call: number) => string | Error | Promise<string | Error>

/** 从请求 user 消息反解本包的块序号（按包内顺序） */
const requestedIndices = (req: CompletePaperJsonRequest): number[] =>
  (JSON.parse(req.messages[1].content) as { items: { i: number }[] }).items.map((it) => it.i)

/** 网关在发请求之前抛出的熔断错误（checkBreaker 口径：带剩余冷却毫秒；不带则调度器按 PAPER_CIRCUIT 兜底） */
const circuitOpen = (remainingMs?: number): GatewayError => {
  const e = new GatewayError('circuit-open', 'deepseek', '熔断中')
  if (remainingMs !== undefined) e.remainingMs = remainingMs
  return e
}

/**
 * 假时钟版 settle：drain 每轮让位的 setTimeout(0) 若是在 tick 内创建的，fake-timers 记成 now+1，
 * 推 0ms 永远轮不到它，所以每步推 1ms。40 步 = 40ms 假时间，远小于任何熔断冷却，不会误触暂停定时器
 */
const settleFake = async (tries = 40) => {
  for (let i = 0; i < tries; i++) await vi.advanceTimersByTimeAsync(1)
}

function makeHarness(opts: {
  blocks: PaperBlock[]
  respond?: Responder
  cached?: BlockTranslation[]
  consent?: () => Promise<boolean>
  sensitive?: boolean
  /** 出包顺序开关（调度器每次重算时读）；缺省恒真 */
  aheadFirst?: () => boolean
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
        const r = await respond(req, calls.length - 1)
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
    aheadFirst: opts.aheadFirst,
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

  // GatewayError 分两种口径：circuit-open 是带期限的暂停（见下方「熔断暂停（假时钟）」）；
  // no-consent / sensitive-blocked 要用户动作才能解除，永久停机（同一组用例里对照）

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

  // PLAN 1.6：另一台设备的译文被同步引擎补拉落库后，页面收到 paper-sync-pulled 调 reload()
  it('reload()：远端补拉到的译文补进内存、清掉该块失败标记，且不重新出包', async () => {
    const blocks = [blk(0, 'a'), blk(1, 'b'), blk(2, 'c')]
    const cached: BlockTranslation[] = [] // 同一引用喂给 loadTranslations，推行即模拟远端落库
    const h = makeHarness({ blocks, cached, respond: () => new Error('boom') })

    await h.scheduler.activate()
    await h.settle()
    expect([...h.snapshot.failed].sort()).toEqual([0, 1, 2])
    const callsBefore = h.calls.length

    cached.push(remoteRow(1, 'b', '远端译文1'))
    await h.scheduler.reload()
    await h.settle()

    expect(h.snapshot.texts.get(1)).toBe('远端译文1')
    expect([...h.snapshot.failed].sort()).toEqual([0, 2]) // 远端已译好的块不再是失败态
    expect(h.calls).toHaveLength(callsBefore) // 已有译文的块不会再花钱翻一遍
  })

  it('reload()：版本/哈希不符的远端行视同缺失；无变化不 emit，有变化以库为准覆盖', async () => {
    const blocks = [blk(0, 'a')]
    const cached: BlockTranslation[] = []
    const h = makeHarness({ blocks, cached })

    await h.scheduler.activate()
    await h.settle()
    expect(h.snapshot.texts.get(0)).toBe('译0#-')

    // 协议版本/原文哈希不符 → 忽略；内存无变化 → 不重新 emit（不白重渲染整篇）
    const stale = h.snapshot
    cached.push(remoteRow(0, 'a', '旧协议', { promptVersion: 'tr0' }))
    cached.push(remoteRow(0, 'a', '旧原文', { srcHash: '00000000' }))
    await h.scheduler.reload()
    expect(h.snapshot).toBe(stale)
    expect(h.snapshot.texts.get(0)).toBe('译0#-')

    // 合法且内容有变（另一台设备的 LWW 结果）→ 覆盖并 emit
    cached.length = 0
    cached.push(remoteRow(0, 'a', '远端译文0'))
    await h.scheduler.reload()
    expect(h.snapshot).not.toBe(stale)
    expect(h.snapshot.texts.get(0)).toBe('远端译文0')
  })

  it('reload()：dispose 后是空操作', async () => {
    const blocks = [blk(0, 'a')]
    const cached: BlockTranslation[] = [remoteRow(0, 'a', '远端译文0')]
    const h = makeHarness({ blocks, cached })
    h.scheduler.dispose()
    const before = h.snapshot
    await h.scheduler.reload()
    expect(h.snapshot).toBe(before)
  })

  // PLAN 2.2：出包顺序按视图有无滚动锚定兜底切换——没有兜底（WebKit 的文本视图）保持文档顺序
  it('aheadFirst 为 false 按文档顺序出包（首包从回看块起）；同一调度器中途翻成 true，下一次 setWindow 后按新顺序', async () => {
    // 每块 1800 字符 ≈ 600 token → 每包 3 条；窗口 21 块 → 7 包
    const blocks = Array.from({ length: 60 }, (_, i) => blk(i, `text-${i} `.padEnd(1800, 'x')))
    let aheadFirst = false
    const h = makeHarness({ blocks, aheadFirst: () => aheadFirst })

    h.scheduler.setWindow(10)
    await h.scheduler.activate()
    await h.settle()
    expect(h.calls).toHaveLength(7)
    expect(requestedIndices(h.calls[0])).toEqual([6, 7, 8]) // 文档顺序：回看块在前
    expect(requestedIndices(h.calls[6])).toEqual([24, 25, 26])

    aheadFirst = true // 视图切到有锚定兜底的场合：同一个调度器，不重建
    h.scheduler.setWindow(40)
    await h.settle()
    expect(h.calls).toHaveLength(14)
    expect(requestedIndices(h.calls[7])).toEqual([40, 41, 42]) // 当前块起往后在前
    expect(requestedIndices(h.calls[13])).toEqual([37, 38, 39]) // 回看块排在最后
    for (let i = 36; i <= 56; i++) expect(h.snapshot.texts.get(i)).toBe(`译${i}#-`)
  })

  // PLAN 2.3：熔断（circuit-open）不再整体停机——按网关给的剩余冷却时长暂停，到点自动续上。
  // 全部走假时钟：真定时器下 5 分钟冷却跑不动，且 vi.getTimerCount() 能直接数出暂停定时器
  describe('熔断暂停（假时钟）', () => {
    type Harness = ReturnType<typeof makeHarness>
    /** 两种用户动作都应立即解除暂停 / 停机 */
    const resumeWays = [
      { name: 'retryBlock', resume: (h: Harness) => h.scheduler.retryBlock(0) },
      { name: 'activate', resume: (h: Harness) => h.scheduler.activate() },
    ]

    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('circuit-open → 不停机不标失败、骨架保留；冷却到点自动续上，按最新窗口把缺译块译完', async () => {
      const blocks = Array.from({ length: 30 }, (_, i) => blk(i, `t${i}`))
      let open = true
      const h = makeHarness({ blocks, respond: (req) => (open ? circuitOpen(60_000) : okRaw(req)) })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()

      expect(h.calls).toHaveLength(1)
      expect(h.snapshot.failed.size).toBe(0) // 骨架态，不是失败态
      expect(h.snapshot.texts.size).toBe(0)
      expect(vi.getTimerCount()).toBe(1) // 只剩暂停定时器：drain 已退出，没有让位定时器挂着

      // 暂停期间窗口变化只重算队列，不出包
      h.scheduler.setWindow(20)
      await settleFake()
      expect(h.calls).toHaveLength(1)

      // 冷却还差一截：仍不出包（settle 累计只花了几十毫秒假时间）
      await vi.advanceTimersByTimeAsync(60_000 - 1_000)
      expect(h.calls).toHaveLength(1)

      // 到点（含余量）：自动续上，按最新窗口 [16, 29] 出包，早已离屏的 0..15 不翻
      open = false
      await vi.advanceTimersByTimeAsync(1_000 + CIRCUIT_RESUME_SLACK_MS + 100)
      await settleFake()
      expect(h.calls).toHaveLength(2)
      for (let i = 16; i <= 29; i++) expect(h.snapshot.texts.get(i)).toBe(`译${i}#-`)
      expect(h.snapshot.texts.has(15)).toBe(false)
      expect(h.snapshot.failed.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0) // 定时器用完即清，没有遗留
    })

    it('circuit-open 不带 remainingMs：按 PAPER_CIRCUIT.cooldownMs 兜底暂停', async () => {
      const blocks = [blk(0, 'a')]
      let open = true
      const h = makeHarness({ blocks, respond: (req) => (open ? circuitOpen() : okRaw(req)) })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()
      expect(h.calls).toHaveLength(1)

      open = false
      await vi.advanceTimersByTimeAsync(PAPER_CIRCUIT.cooldownMs - 1_000)
      expect(h.calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000 + CIRCUIT_RESUME_SLACK_MS + 100)
      await settleFake()
      expect(h.calls).toHaveLength(2)
      expect(h.snapshot.texts.get(0)).toBe('译0#-')
    })

    it('请求在途时 dispose、网关随后才抛 circuit-open：不挂暂停定时器，到点也不出包', async () => {
      const blocks = [blk(0, 'a'), blk(1, 'b')]
      let release!: (r: string | Error) => void
      const gate = new Promise<string | Error>((resolve) => {
        release = resolve
      })
      const h = makeHarness({ blocks, respond: () => gate })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()
      expect(h.calls).toHaveLength(1) // 首包已发出，网关挂起中
      expect(vi.getTimerCount()).toBe(0)

      h.scheduler.dispose()
      release(circuitOpen(60_000)) // dispose 之后网关才以熔断拒绝
      await settleFake()
      expect(vi.getTimerCount()).toBe(0) // 没有挂上空定时器
      expect(h.snapshot.failed.size).toBe(0)

      await vi.advanceTimersByTimeAsync(60_000 + CIRCUIT_RESUME_SLACK_MS + 1_000)
      await settleFake()
      expect(h.calls).toHaveLength(1)
    })

    it('暂停期间 dispose：定时器清掉，到点后不再出包', async () => {
      const blocks = [blk(0, 'a'), blk(1, 'b')]
      const h = makeHarness({ blocks, respond: () => circuitOpen(60_000) })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()
      expect(h.calls).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)

      h.scheduler.dispose()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000 + CIRCUIT_RESUME_SLACK_MS + 1_000)
      await settleFake()
      expect(h.calls).toHaveLength(1)
    })

    it.each(resumeWays)('暂停期间 $name：清掉定时器立即恢复（网关已可用），不留重复/遗留的暂停定时器', async ({ resume }) => {
      const blocks = [blk(0, 'a'), blk(1, 'b')]
      let open = true
      const h = makeHarness({ blocks, respond: (req) => (open ? circuitOpen(60_000) : okRaw(req)) })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()
      expect(h.calls).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)

      open = false
      await resume(h)
      await settleFake()
      expect(h.calls).toHaveLength(2) // 没等冷却到点
      expect(h.snapshot.texts.size).toBe(2)
      expect(h.snapshot.failed.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0) // 暂停定时器已清，没有遗留

      // 原定到点时刻过去也不会再来一发
      await vi.advanceTimersByTimeAsync(60_000 + CIRCUIT_RESUME_SLACK_MS + 1_000)
      await settleFake()
      expect(h.calls).toHaveLength(2)
    })

    it('熔断未过时 retryBlock：网关再抛 circuit-open → 只换一个新定时器，按新的 remainingMs 到点续上', async () => {
      const blocks = [blk(0, 'a'), blk(1, 'b')]
      let remaining: number | null = 60_000
      const h = makeHarness({ blocks, respond: (req) => (remaining === null ? okRaw(req) : circuitOpen(remaining)) })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()
      expect(h.calls).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)

      remaining = 5_000 // 第二次撞上的是更短的剩余冷却
      h.scheduler.retryBlock(0)
      await settleFake()
      expect(h.calls).toHaveLength(2) // 立即试了一次，网关在发请求之前再抛
      expect(h.snapshot.failed.size).toBe(0)
      expect(vi.getTimerCount()).toBe(1) // 换了一个新定时器，不是叠成两个

      // 新定时器按 5s 到点（旧的 60s 已作废）
      remaining = null
      await vi.advanceTimersByTimeAsync(5_000 + CIRCUIT_RESUME_SLACK_MS + 100)
      await settleFake()
      expect(h.calls).toHaveLength(3)
      expect(h.snapshot.texts.size).toBe(2)
      expect(vi.getTimerCount()).toBe(0)

      // 旧定时器的到点时刻过去也不会再来一发
      await vi.advanceTimersByTimeAsync(60_000)
      await settleFake()
      expect(h.calls).toHaveLength(3)
    })

    it('对分递归里前半包撞上熔断：后半包不再碰网关，到点后整包重新规划', async () => {
      const blocks = [blk(0, 'a'), blk(1, 'b')]
      let open = true
      const h = makeHarness({
        blocks,
        // 整包对不齐 → 对分；[0] 撞熔断 → 暂停；[1] 直接跳过
        respond: (req, call) => (call === 0 ? 'not a json at all' : open ? circuitOpen(60_000) : okRaw(req)),
      })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()
      expect(h.calls).toHaveLength(2) // 不是 3：暂停中后半包没出
      expect(h.snapshot.failed.size).toBe(0)
      expect(vi.getTimerCount()).toBe(1)

      open = false
      await vi.advanceTimersByTimeAsync(60_000 + CIRCUIT_RESUME_SLACK_MS + 100)
      await settleFake()
      expect(h.calls).toHaveLength(3) // 到点后 [0,1] 作为一包重新规划
      expect(h.snapshot.texts.get(0)).toBe('译0#-')
      expect(h.snapshot.texts.get(1)).toBe('译1#-')
    })

    it.each(
      (['no-consent', 'sensitive-blocked'] as const).flatMap((kind) => resumeWays.map((w) => ({ kind, ...w }))),
    )('$kind → 永久停机保骨架：无暂停定时器，时间推多久都不出包，直到 $name 才恢复', async ({ kind, resume }) => {
      const blocks = [blk(0, 'a'), blk(1, 'b')]
      let blocked = true
      const h = makeHarness({
        blocks,
        respond: (req) => (blocked ? new GatewayError(kind, 'deepseek', '拒绝') : okRaw(req)),
      })

      await h.scheduler.activate()
      h.scheduler.setWindow(0)
      await settleFake()
      expect(h.calls).toHaveLength(1)
      expect(h.snapshot.failed.size).toBe(0) // 骨架态，不刷失败 chip
      expect(vi.getTimerCount()).toBe(0) // 不是暂停：没有定时器会来自动恢复

      h.scheduler.setWindow(1)
      await vi.advanceTimersByTimeAsync(10 * PAPER_CIRCUIT.cooldownMs)
      await settleFake()
      expect(h.calls).toHaveLength(1) // 停机后不再出包

      blocked = false
      await resume(h)
      await settleFake()
      expect(h.calls).toHaveLength(2)
      expect(h.snapshot.texts.size).toBe(2)
    })
  })
})

// PLAN A.1：导出前全篇补全——同一条 drain，规划改按文档顺序不裁窗口；结果 / 进度 / 停机原因给导出对话框
describe('translateAll（全篇补全）', () => {
  /** 每块 1800 字符 ≈ 600 token → 每包 3 条 */
  const bigBlocks = (n: number) => Array.from({ length: n }, (_, i) => blk(i, `text-${i} `.padEnd(1800, 'x')))

  /** 把第 call 包的网关响应挂起，release 后才成功；其余包直接成功 */
  const gateCall = (call: number) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const respond: Responder = (req, i) => (i === call ? gate.then(() => okRaw(req)) : okRaw(req))
    return { respond, release }
  }

  it('文档顺序把全部缺译块译完：跳过缓存命中、不看阅读位置、进度单调、结果带译文快照', async () => {
    const blocks = bigBlocks(30)
    const h = makeHarness({
      blocks,
      cached: [remoteRow(5, blocks[5].text, '缓存5'), remoteRow(6, blocks[6].text, '缓存6')],
    })
    h.scheduler.setWindow(10) // 阅读位置只影响窗口模式
    const progress: TranslateAllProgress[] = []

    const result = await h.scheduler.translateAll({ onProgress: (p) => progress.push(p) })

    expect(result).toMatchObject({ outcome: 'done', translated: 30, failed: [], total: 30 })
    expect(result.halt).toBeUndefined()
    expect(result.texts.size).toBe(30)
    expect(result.texts.get(5)).toBe('缓存5')
    expect(result.texts.get(7)).toBe('译7#-')
    // 28 条 / 3 = 10 包，文档顺序从头起，缓存命中的 5、6 不翻
    expect(h.calls).toHaveLength(10)
    expect(h.maxConcurrent).toBe(1)
    expect(h.calls.flatMap(requestedIndices)).toEqual(Array.from({ length: 30 }, (_, i) => i).filter((i) => i !== 5 && i !== 6))
    expect(h.saved.flat()).toHaveLength(28)
    // 进度：开工先报一次（缓存命中数），之后每包递增，最后 30/30
    expect(progress[0]).toEqual({ done: 2, total: 30, failed: 0, pausedUntil: null })
    for (let i = 1; i < progress.length; i++) expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done)
    expect(progress.at(-1)).toEqual({ done: 30, total: 30, failed: 0, pausedUntil: null })
    expect(progress).toHaveLength(11)
  })

  it('已全部译好（不可译块不计）：立即 done、零请求、不问授权', async () => {
    const blocks = [blk(0, 'a'), { ...blk(1, 'const x'), kind: 'code' as const }, blk(2, 'b')]
    const h = makeHarness({ blocks, cached: [remoteRow(0, 'a', '甲'), remoteRow(2, 'b', '乙')] })
    const progress: TranslateAllProgress[] = []

    const result = await h.scheduler.translateAll({ onProgress: (p) => progress.push(p) })

    expect(result).toEqual({
      outcome: 'done',
      texts: new Map([
        [0, '甲'],
        [2, '乙'],
      ]),
      translated: 2,
      failed: [],
      total: 2,
    })
    expect(h.calls).toHaveLength(0)
    expect(h.consentAsks).toBe(0)
    expect(progress).toEqual([{ done: 2, total: 2, failed: 0, pausedUntil: null }])
  })

  it('中途 abort：立即 aborted（快照是拷贝）、在飞的包仍落库，之后 setWindow 只按窗口出包', async () => {
    const blocks = bigBlocks(30)
    const { respond, release } = gateCall(0)
    const h = makeHarness({ blocks, respond })
    const ac = new AbortController()

    const promise = h.scheduler.translateAll({ signal: ac.signal })
    await h.settle()
    expect(h.calls).toHaveLength(1)
    expect(requestedIndices(h.calls[0])).toEqual([0, 1, 2]) // 全篇模式：文档顺序从头起

    ac.abort()
    const result = await promise
    expect(result).toMatchObject({ outcome: 'aborted', translated: 0, failed: [], total: 30 })
    expect(result.texts.size).toBe(0)

    // 回窗口模式：阅读位置在 20，窗口 [16, 36]，当前块起往后在前
    h.scheduler.setWindow(20)
    release()
    await h.settle()
    for (const i of [0, 1, 2]) expect(h.snapshot.texts.get(i)).toBe(`译${i}#-`) // 在飞的包照常落地
    expect(h.saved[0].map((r) => r.blockIndex)).toEqual([0, 1, 2]) // 并且落库
    expect(result.texts.size).toBe(0) // resolve 时的快照不随后续落库变化
    const later = h.calls.slice(1).map(requestedIndices)
    expect(later[0]).toEqual([20, 21, 22])
    expect(later.flat().every((i) => i >= 16 && i <= 29)).toBe(true)
    expect(h.calls).toHaveLength(1 + 5) // 窗口内 14 块 → 5 包，不再补全篇
    for (let i = 3; i <= 15; i++) expect(h.snapshot.texts.has(i)).toBe(false)
  })

  it('signal 已中止 / 已 dispose：直接 aborted，不碰网关', async () => {
    const h = makeHarness({ blocks: [blk(0, 'a')] })
    const ac = new AbortController()
    ac.abort()
    expect(await h.scheduler.translateAll({ signal: ac.signal })).toMatchObject({ outcome: 'aborted', total: 1 })
    h.scheduler.dispose()
    expect(await h.scheduler.translateAll()).toMatchObject({ outcome: 'aborted' })
    await h.settle()
    expect(h.calls).toHaveLength(0)
  })

  it('进行中 dispose → aborted；在飞的包回来后不再出包', async () => {
    const { respond, release } = gateCall(0)
    const h = makeHarness({ blocks: bigBlocks(6), respond })

    const promise = h.scheduler.translateAll()
    await h.settle()
    expect(h.calls).toHaveLength(1)

    h.scheduler.dispose()
    expect(await promise).toMatchObject({ outcome: 'aborted', translated: 0, total: 6 })
    release()
    await h.settle()
    expect(h.calls).toHaveLength(1)
  })

  it('进行中重复调用返回同一 promise；结束后再调用是新的一次（已齐备 → 零请求 done）', async () => {
    const { respond, release } = gateCall(0)
    const h = makeHarness({ blocks: [blk(0, 'a'), blk(1, 'b')], respond })

    const p1 = h.scheduler.translateAll()
    const p2 = h.scheduler.translateAll()
    expect(p2).toBe(p1)
    await h.settle()
    release()
    expect(await p1).toMatchObject({ outcome: 'done', translated: 2 })

    const p3 = h.scheduler.translateAll()
    expect(p3).not.toBe(p1)
    expect(await p3).toMatchObject({ outcome: 'done', translated: 2, total: 2 })
    expect(h.calls).toHaveLength(1)
  })

  it('拒绝授权 → halted/consent：零请求、骨架保留不标失败', async () => {
    const h = makeHarness({ blocks: [blk(0, 'a'), blk(1, 'b')], consent: () => Promise.resolve(false) })

    const result = await h.scheduler.translateAll()

    expect(result).toMatchObject({ outcome: 'halted', halt: 'consent', translated: 0, failed: [], total: 2 })
    expect(h.consentAsks).toBe(1)
    expect(h.calls).toHaveLength(0)
    expect(h.snapshot.failed.size).toBe(0)
  })

  it('账号 auth 失败 → halted/auth：failed 列出该包的块，authIssue 记码', async () => {
    const h = makeHarness({
      blocks: [blk(0, 'a'), blk(1, 'b')],
      respond: () => {
        const e = new LlmError('auth', '该账号尚未配置此服务商的 API key')
        e.code = 'no-user-key'
        return e
      },
    })
    const progress: TranslateAllProgress[] = []

    const result = await h.scheduler.translateAll({ onProgress: (p) => progress.push(p) })

    expect(result).toMatchObject({ outcome: 'halted', halt: 'auth', translated: 0, failed: [0, 1], total: 2 })
    expect(h.snapshot.authIssue).toBe('no-user-key')
    expect(h.calls).toHaveLength(1) // 停机，不刷 403
    expect(progress.at(-1)).toEqual({ done: 0, total: 2, failed: 2, pausedUntil: null })
  })

  it.each(['no-consent', 'sensitive-blocked'] as const)('网关拒绝（%s）→ halted/blocked：骨架保留不标失败', async (kind) => {
    const h = makeHarness({ blocks: [blk(0, 'a'), blk(1, 'b')], respond: () => new GatewayError(kind, 'deepseek', '拒绝') })

    const result = await h.scheduler.translateAll()

    expect(result).toMatchObject({ outcome: 'halted', halt: 'blocked', translated: 0, failed: [], total: 2 })
    expect(h.calls).toHaveLength(1)
    expect(h.snapshot.failed.size).toBe(0)
  })

  it('敏感论文 → halted/sensitive：不碰网关也不问授权', async () => {
    const h = makeHarness({ blocks: [blk(0, 'secret')], sensitive: true })

    const result = await h.scheduler.translateAll()

    expect(result).toMatchObject({ outcome: 'halted', halt: 'sensitive', translated: 0, total: 1 })
    expect(h.calls).toHaveLength(0)
    expect(h.consentAsks).toBe(0)
  })

  it('此前失败的块在全篇模式下恰好再试一次：再失败仍落回 failed，不风暴', async () => {
    const h = makeHarness({ blocks: [blk(0, 'a'), blk(1, 'b'), blk(2, 'c')], respond: () => new Error('boom') })

    await h.scheduler.activate()
    h.scheduler.setWindow(0)
    await h.settle()
    expect([...h.snapshot.failed].sort()).toEqual([0, 1, 2])
    expect(h.calls).toHaveLength(1)

    const result = await h.scheduler.translateAll()

    expect(result).toMatchObject({ outcome: 'done', translated: 0, failed: [0, 1, 2], total: 3 })
    expect(h.calls).toHaveLength(2) // 恰好再试一次
    expect([...h.snapshot.failed].sort()).toEqual([0, 1, 2])
  })

  it('窗口出包进行中调用：同一条 drain 接着按全篇文档顺序出包，不并发', async () => {
    const { respond, release } = gateCall(0)
    const h = makeHarness({ blocks: bigBlocks(30), respond })

    h.scheduler.setWindow(10)
    await h.scheduler.activate()
    await h.settle()
    expect(h.calls).toHaveLength(1)
    expect(requestedIndices(h.calls[0])).toEqual([10, 11, 12]) // 窗口模式首包

    const promise = h.scheduler.translateAll()
    release()
    const result = await promise

    expect(result).toMatchObject({ outcome: 'done', translated: 30, failed: [], total: 30 })
    expect(h.maxConcurrent).toBe(1)
    expect(requestedIndices(h.calls[1])).toEqual([0, 1, 2]) // 在飞的窗口包落地后切到全篇：从头起
    expect(h.calls.slice(1).flatMap(requestedIndices)).toEqual(
      Array.from({ length: 30 }, (_, i) => i).filter((i) => i < 10 || i > 12),
    )
  })

  describe('熔断暂停（假时钟）', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('中途熔断：进度报 pausedUntil、不标失败；冷却到点自动续跑直至 done', async () => {
      let open = true
      const h = makeHarness({
        blocks: bigBlocks(6), // 2 包
        respond: (req, call) => (call >= 1 && open ? circuitOpen(60_000) : okRaw(req)),
      })
      const progress: TranslateAllProgress[] = []
      const results: TranslateAllResult[] = []

      void h.scheduler.translateAll({ onProgress: (p) => progress.push(p) }).then((r) => results.push(r))
      await settleFake()

      expect(h.calls).toHaveLength(2) // 首包成功，次包撞熔断
      expect(results).toHaveLength(0) // 暂停不是结束
      expect(h.snapshot.failed.size).toBe(0)
      expect(progress.at(-1)).toEqual({ done: 3, total: 6, failed: 0, pausedUntil: 1_700_000_000 + 60_000 + CIRCUIT_RESUME_SLACK_MS })
      expect(vi.getTimerCount()).toBe(1) // 只剩暂停定时器

      await vi.advanceTimersByTimeAsync(60_000 - 1_000)
      expect(h.calls).toHaveLength(2)
      expect(results).toHaveLength(0)

      open = false
      await vi.advanceTimersByTimeAsync(1_000 + CIRCUIT_RESUME_SLACK_MS + 100)
      await settleFake()
      expect(h.calls).toHaveLength(3)
      expect(results[0]).toMatchObject({ outcome: 'done', translated: 6, failed: [], total: 6 })
      expect(progress.at(-1)).toEqual({ done: 6, total: 6, failed: 0, pausedUntil: null })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('暂停期间 abort：清掉定时器，立即 aborted；到点不再出包', async () => {
      const h = makeHarness({ blocks: bigBlocks(3), respond: () => circuitOpen(60_000) })
      const ac = new AbortController()
      const results: TranslateAllResult[] = []

      void h.scheduler.translateAll({ signal: ac.signal }).then((r) => results.push(r))
      await settleFake()
      expect(h.calls).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)

      ac.abort()
      await settleFake()
      expect(results[0]).toMatchObject({ outcome: 'aborted', translated: 0, total: 3 })
      // abort 只结束全篇补全：暂停定时器留给窗口模式（熔断语义不变），到点按窗口续一次、再撞熔断再暂停，
      // 不会再 resolve 第二次
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000 + CIRCUIT_RESUME_SLACK_MS + 100)
      await settleFake()
      expect(h.calls).toHaveLength(2)
      expect(results).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)
    })
  })
})

describe('isPulledFor', () => {
  const detail = { paperIds: ['p1', 'p3'], tables: ['blocks', 'translations'] }
  const cases: { name: string; detail: unknown; want: boolean }[] = [
    { name: '本篇 + 本表', detail, want: true },
    { name: '别的论文', detail: { paperIds: ['p2'], tables: ['translations'] }, want: false },
    { name: '别的表', detail: { paperIds: ['p1'], tables: ['highlights'] }, want: false },
    { name: 'detail 缺失', detail: undefined, want: false },
    { name: 'detail 为 null', detail: null, want: false },
    { name: '字段缺失', detail: {}, want: false },
    { name: '字段不是数组', detail: { paperIds: 'p1', tables: 'translations' }, want: false },
    { name: 'detail 不是对象', detail: 'p1', want: false },
  ]

  for (const c of cases) {
    it(`${c.name} → ${c.want}`, () => {
      expect(isPulledFor(c.detail, 'p1', 'translations')).toBe(c.want)
    })
  }
})
