import { describe, expect, it } from 'vitest'
import {
  createTurnRunner,
  findOrphanTurns,
  initialTurnState,
  turnErrorDetail,
  turnReducer,
  type TurnRequest,
  type TurnRunnerDeps,
  type TurnState,
} from './turnEngine'
import { PAPER_TASKS } from '../../data/paperPolicy'
import type { RetrieveResult, RetrievedChunk } from './retrieval'
import type { StreamPaperChatResult } from './modelGateway'

const mkChunk = (alias: string, text: string): RetrievedChunk => ({
  alias,
  score: 1,
  matched: [],
  chunk: {
    id: `id-${alias}`,
    paperId: 'p1',
    order: 0,
    text,
    anchor: { kind: 'pdf', blockIndex: 0, page: 3, section: '2 Background' },
    blockStart: 0,
    blockEnd: 0,
  },
})

const mkRetrieval = (aliases: string[], text = 'KV cache 显存占用线性增长'): RetrieveResult => {
  const chunks = aliases.map((a) => mkChunk(a, text))
  return {
    chunks,
    citeMapEntries: chunks.map((c) => ({ alias: c.alias, chunkId: c.chunk.id, anchor: c.chunk.anchor, page: 3, section: '2 Background' })),
    expandedQuery: 'q',
    usedRerank: false,
  }
}

const usageOf = (text: string): StreamPaperChatResult => ({
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  inputTokens: 100,
  outputTokens: 10,
  estimated: false,
  cost: 0.001,
  text,
  aborted: false,
})

const baseReq: TurnRequest = {
  question: 'KV cache 为什么贵？',
  selection: null,
  spec: PAPER_TASKS.chat,
  planIsland: true,
  memoIsland: false,
  context: { history: [] },
}

describe('turnReducer · 状态迁移', () => {
  it('happy path：idle→retrieving→streaming→finalizing→done', () => {
    let s = initialTurnState
    s = turnReducer(s, { type: 'start' })
    expect(s.phase).toBe('retrieving')
    s = turnReducer(s, { type: 'retrieved', citeMap: [], chunks: [] })
    expect(s.phase).toBe('streaming')
    s = turnReducer(s, { type: 'delta', delta: '你' })
    s = turnReducer(s, { type: 'delta', delta: '好' })
    expect(s.text).toBe('你好')
    s = turnReducer(s, { type: 'stream-end', aborted: false, usage: null })
    expect(s.phase).toBe('finalizing')
    s = turnReducer(s, { type: 'finalized', audit: null, insufficient: false })
    expect(s.phase).toBe('done')
  })

  it('非法迁移原样返回（防御迟到事件）', () => {
    const s = initialTurnState
    expect(turnReducer(s, { type: 'delta', delta: 'x' })).toBe(s)
    expect(turnReducer(s, { type: 'stream-end', aborted: false, usage: null })).toBe(s)
    const done = turnReducer(
      turnReducer(
        turnReducer(turnReducer(initialTurnState, { type: 'start' }), { type: 'retrieved', citeMap: [], chunks: [] }),
        { type: 'stream-end', aborted: false, usage: null },
      ),
      { type: 'finalized', audit: null, insufficient: false },
    )
    expect(turnReducer(done, { type: 'delta', delta: '迟到' })).toBe(done)
  })

  it('Stop（aborted stream-end）→ interrupted 标记，半截保留', () => {
    let s = turnReducer(initialTurnState, { type: 'start' })
    s = turnReducer(s, { type: 'retrieved', citeMap: [], chunks: [] })
    s = turnReducer(s, { type: 'delta', delta: '半截' })
    s = turnReducer(s, { type: 'stream-end', aborted: true, usage: null })
    expect(s.interrupted).toBe(true)
    expect(s.text).toBe('半截')
  })

  it('reasoning / wait / retry 只在 streaming 生效；retry 清空半截', () => {
    let s = turnReducer(initialTurnState, { type: 'start' })
    expect(turnReducer(s, { type: 'reasoning' })).toBe(s)
    s = turnReducer(s, { type: 'retrieved', citeMap: [], chunks: [] })
    s = turnReducer(s, { type: 'reasoning' })
    expect(s.reasoning).toBe(true)
    s = turnReducer(s, { type: 'wait', ms: 8000 })
    expect(s.waitMs).toBe(8000)
    s = turnReducer(s, { type: 'delta', delta: 'x' })
    expect(s.reasoning).toBe(false)
    expect(s.waitMs).toBeNull()
    s = turnReducer(s, { type: 'retry' })
    expect(s.text).toBe('')
    expect(s.retrying).toBe(true)
  })

  it('evidence-retry：finalizing→streaming，text 清空、白名单替换', () => {
    let s = turnReducer(initialTurnState, { type: 'start' })
    s = turnReducer(s, { type: 'retrieved', citeMap: [], chunks: [] })
    s = turnReducer(s, { type: 'delta', delta: '第一次' })
    s = turnReducer(s, { type: 'stream-end', aborted: false, usage: null })
    const wider = mkRetrieval(['c1', 'c2'])
    s = turnReducer(s, { type: 'evidence-retry', citeMap: wider.citeMapEntries, chunks: wider.chunks })
    expect(s.phase).toBe('streaming')
    expect(s.text).toBe('')
    expect(s.evidenceRetry).toBe(true)
    expect(s.citeMap).toHaveLength(2)
  })
})

interface ScriptedStream {
  reply: string
  aborted?: boolean
}

function makeDeps(replies: ScriptedStream[], over: Partial<TurnRunnerDeps> = {}) {
  const retrieveCalls: { query: string; topK: number }[] = []
  const streamCalls: { directives: string; signal: AbortSignal }[] = []
  let call = 0
  const deps: TurnRunnerDeps = {
    retrieve: async (query, opts) => {
      retrieveCalls.push({ query, topK: opts.topK })
      return mkRetrieval(opts.topK >= 12 ? ['c1', 'c2', 'c3'] : ['c1'])
    },
    stream: async (req) => {
      const script = replies[Math.min(call, replies.length - 1)]
      call += 1
      streamCalls.push({ directives: req.messages[req.messages.length - 1].content, signal: req.signal })
      for (const piece of script.reply.split('|')) req.onDelta(piece)
      return { ...usageOf(script.reply.replaceAll('|', '')), aborted: script.aborted ?? false }
    },
    ...over,
  }
  return { deps, retrieveCalls, streamCalls }
}

describe('createTurnRunner · 编排', () => {
  it('完整一轮：状态序列 + 引用审计 + memo 提取', async () => {
    const reply = 'KV cache 显存占用线性增长 [[cite:c1]]。|\n```copilot:memo\n{"summary":"讨论了 KV cache"}\n```'
    const { deps } = makeDeps([{ reply }])
    const runner = createTurnRunner(deps)
    const phases: string[] = []
    const outcome = await runner.run({ ...baseReq, memoIsland: true }, (s) => phases.push(s.phase))
    expect(outcome).not.toBeNull()
    expect(phases[0]).toBe('retrieving')
    expect(phases).toContain('streaming')
    expect(phases[phases.length - 1]).toBe('done')
    expect(outcome!.state.audit?.badges.c1).toBe('ok')
    expect(outcome!.memo).toEqual({ kind: 'memo', summary: '讨论了 KV cache' })
    expect(outcome!.stopped).toBe(false)
    expect(runner.busy()).toBe(false)
  })

  it('plan 指令只在自由问答（planIsland=true）出现；选段快捷无 plan', async () => {
    const a = makeDeps([{ reply: 'ok' }])
    await createTurnRunner(a.deps).run({ ...baseReq, planIsland: true }, () => {})
    expect(a.streamCalls[0].directives).toContain('copilot:plan')
    const b = makeDeps([{ reply: 'ok' }])
    await createTurnRunner(b.deps).run({ ...baseReq, planIsland: false }, () => {})
    expect(b.streamCalls[0].directives).not.toContain('copilot:plan')
  })

  it('深度任务用 top-12 检索', async () => {
    const { deps, retrieveCalls } = makeDeps([{ reply: 'ok' }])
    await createTurnRunner(deps).run({ ...baseReq, spec: PAPER_TASKS.deep }, () => {})
    expect(retrieveCalls[0].topK).toBe(12)
  })

  it('evidence 岛 insufficient → 扩检索 top-12 重试一次；仍不足 → insufficient 终态', async () => {
    const insufficientReply = '```copilot:evidence\n{"status":"insufficient","note":"缺实验数据"}\n```'
    const { deps, retrieveCalls, streamCalls } = makeDeps([{ reply: insufficientReply }, { reply: insufficientReply }])
    const outcome = await createTurnRunner(deps).run(baseReq, () => {})
    expect(retrieveCalls).toHaveLength(2)
    expect(retrieveCalls[1].topK).toBe(12)
    expect(streamCalls).toHaveLength(2)
    expect(streamCalls[1].directives).toContain('扩大检索')
    expect(outcome!.state.insufficient).toBe(true)
    expect(outcome!.state.phase).toBe('done')
  })

  it('evidence 重试后成功 → insufficient=false', async () => {
    const { deps, streamCalls } = makeDeps([
      { reply: '```copilot:evidence\n{"status":"insufficient"}\n```' },
      { reply: '扩检索后答案 [[cite:c2]]。' },
    ])
    const outcome = await createTurnRunner(deps).run(baseReq, () => {})
    expect(streamCalls).toHaveLength(2)
    expect(outcome!.state.insufficient).toBe(false)
    expect(outcome!.state.text).toContain('扩检索后答案')
  })

  it('Stop（aborted 返回）：不做 evidence 重试，interrupted 保留半截', async () => {
    const { deps, streamCalls } = makeDeps([{ reply: '半截', aborted: true }])
    const runner = createTurnRunner(deps)
    const outcome = await runner.run(baseReq, () => {})
    expect(streamCalls).toHaveLength(1)
    expect(outcome!.stopped).toBe(true)
    expect(outcome!.state.interrupted).toBe(true)
    expect(outcome!.state.text).toBe('半截')
    expect(outcome!.state.phase).toBe('done')
  })

  it('discard 后：迟到写入丢弃（onState 不再触发）、run 返回 null', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { deps } = makeDeps([{ reply: 'x' }], {
      stream: async (req) => {
        req.onDelta('第一帧')
        await gate // 挂起，等 discard
        req.onDelta('迟到帧')
        return usageOf('第一帧迟到帧')
      },
    })
    const runner = createTurnRunner(deps)
    const seen: TurnState[] = []
    const p = runner.run(baseReq, (s) => seen.push(s))
    await new Promise((r) => setTimeout(r, 0))
    const before = seen.length
    expect(seen.some((s) => s.text === '第一帧')).toBe(true)
    runner.discard()
    release()
    const outcome = await p
    expect(outcome).toBeNull() // 关掉即忘
    expect(seen.length).toBe(before) // 迟到帧没有产生任何 onState
  })

  it('单飞行守卫：进行中再 run 返回 null', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { deps } = makeDeps([{ reply: 'x' }], {
      stream: async (req) => {
        await gate
        req.onDelta('x')
        return usageOf('x')
      },
    })
    const runner = createTurnRunner(deps)
    const p1 = runner.run(baseReq, () => {})
    await new Promise((r) => setTimeout(r, 0))
    expect(runner.busy()).toBe(true)
    const p2 = await runner.run(baseReq, () => {})
    expect(p2).toBeNull()
    release()
    await p1
  })

  it('成本确认拒绝 → cost-declined 错误态', async () => {
    const { deps } = makeDeps([{ reply: 'ok' }], {
      confirmCost: async () => false,
    })
    // 大输入把预估成本推过 $0.02 阈值（>46K tokens 输入）
    const outcome = await createTurnRunner(deps).run(
      { ...baseReq, spec: { ...PAPER_TASKS.chat, inputBudgetTokens: 200_000 }, context: { history: [{ role: 'user', content: 'h'.repeat(150_000) }, { role: 'assistant', content: 'a' }] } },
      () => {},
    )
    expect(outcome!.state.phase).toBe('error')
    expect(outcome!.state.error?.kind).toBe('cost-declined')
  })

  it('流失败：error 终态 + LlmError kind 透传', async () => {
    const { deps } = makeDeps([{ reply: 'x' }], {
      stream: async () => {
        const { LlmError } = await import('../llmClient')
        throw new LlmError('rate-limit', '触发限流（429），请稍后重试')
      },
    })
    const outcome = await createTurnRunner(deps).run(baseReq, () => {})
    expect(outcome!.state.phase).toBe('error')
    expect(outcome!.state.error?.kind).toBe('rate-limit')
  })
})

describe('turnErrorDetail（错误文案不叠前缀、不外露英文）', () => {
  it('「中文前缀：英文原文」只保留中文前缀', () => {
    // 修复前 UI 会拼成「网络异常：网络错误：Failed to fetch」
    expect(turnErrorDetail('网络错误：Failed to fetch', '网络异常，请检查网络后重试')).toBe('网络错误')
    expect(turnErrorDetail('网络错误: NetworkError when attempting to fetch resource.', 'fb')).toBe('网络错误')
  })

  it('纯英文 message 换成中文兜底（原文只留 console.debug）', () => {
    expect(turnErrorDetail('Failed to fetch', '网络异常，请检查网络后重试')).toBe('网络异常，请检查网络后重试')
    expect(turnErrorDetail('', 'fb')).toBe('fb')
    expect(turnErrorDetail(undefined, 'fb')).toBe('fb')
  })

  it('完整中文文案原样返回（含中文冒号后仍是中文的情况）', () => {
    expect(turnErrorDetail('本轮上下文超出预算且无法继续裁剪，请缩短选区后重试', 'fb')).toBe(
      '本轮上下文超出预算且无法继续裁剪，请缩短选区后重试',
    )
    expect(turnErrorDetail('触发限流：请稍后重试', 'fb')).toBe('触发限流：请稍后重试')
  })
})

describe('findOrphanTurns（有问无答的中断轮）', () => {
  const u = (id: string) => ({ id, role: 'user' as const })
  const a = (id: string) => ({ id, role: 'assistant' as const })

  it('末尾的用户消息没有回答 → 孤儿', () => {
    expect([...findOrphanTurns([u('1'), a('2'), u('3')])]).toEqual(['3'])
  })

  it('两条用户消息相邻 → 前一条也是孤儿', () => {
    expect([...findOrphanTurns([u('1'), u('2'), a('3')])]).toEqual(['1'])
  })

  it('liveTail：末条正在生成回答时不算孤儿', () => {
    expect([...findOrphanTurns([u('1'), a('2'), u('3')], { liveTail: true })]).toEqual([])
    // 中间的孤儿不受 liveTail 影响
    expect([...findOrphanTurns([u('1'), u('2'), a('3'), u('4')], { liveTail: true })]).toEqual(['1'])
  })

  it('成对完整的会话没有孤儿；空列表安全', () => {
    expect(findOrphanTurns([u('1'), a('2'), u('3'), a('4')]).size).toBe(0)
    expect(findOrphanTurns([]).size).toBe(0)
  })
})
