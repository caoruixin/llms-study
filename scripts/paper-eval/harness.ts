// Paper Copilot 评测 harness（PLAN-paper-copilot.md §11.3）。
//
// 职责：论文加载与索引（内存，§论文加载见 loaders.ts）、单题执行
// （retrieve → assembleContext → 流式调用 → streamParser 解析 → 校验器）、并发控制
// （≤2 并发、间隔 ≥2s、尊重 429）。门槛判定在 checks.ts；CLI 入口在 run.ts。
//
// 复用 src/lib/paper 的纯函数（一律 import，不复制逻辑）：
//   chunking(via loaders)/bm25(indexChunks)/retrieval(retrieveFromChunks)/contextBuilder(assembleContext)/
//   streamParser(splitCopilotStream/collectIslands)/citations(auditCitations)/providerAdapters(buildChatBody)/usage(normalizeUsage)。
// 流式传输复用 src/lib/paper/stream.ts 的 runPaperStream（内部即 llmClient.runSseChat + sse.ts 帧解析，
// 已用探针脚本确认可在 Node/vite-node 下直接运行，无需改造）。
//
// 刻意不用的一个 src 模块：src/lib/paper/modelGateway.ts（createModelGateway）。原因：
// 它把 URL 拼成 `spec.cap.proxyPrefix + spec.cap.chatPath`（如 "/api/deepseek/chat/completions"）这个
// **相对路径**丢给 fetch——浏览器里靠同源解析，Node 的 fetch（undici）要求绝对 URL，会直接抛
// "Failed to parse URL"。gateway 还内置了产品向的 consent/熔断/令牌桶（6/分钟），与本任务明确要求的
// "≤2 并发、间隔 ≥2s" 评测节流是两回事。因此这里只复用 gateway 内部真正在用的两块纯函数
// （buildChatBody + runPaperStream），重试策略参考 gateway 的 retryDelayFor 语义在本文件内重写一份
// （无 429 Retry-After 时抖动退避、技术性失败仅在尚无正文时重试一次、auth 不重试）。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAPER_TASKS, RETRIEVE_TOP_K, type ChatMessage, type PaperCallSpec } from '../../src/data/paperPolicy'
import { buildChatBody } from '../../src/lib/paper/providerAdapters'
import { runPaperStream } from '../../src/lib/paper/stream'
import { retrieveFromChunks, indexChunks } from '../../src/lib/paper/retrieval'
import { assembleContext } from '../../src/lib/paper/contextBuilder'
import { splitCopilotStream, collectIslands } from '../../src/lib/paper/streamParser'
import { auditCitations } from '../../src/lib/paper/citations'
import { normalizeUsage } from '../../src/lib/paper/usage'
import { LlmError } from '../../src/lib/llmClient'
import type { Bm25Index } from '../../src/lib/paper/bm25'
import type { PaperChunk } from '../../src/lib/paper/types'
import { loadPaper, injectCanary, type LoadedPaper } from './loaders'
import { PAPERS, CANARY_TOKENS, type EvalQuestion, type EvalPaperId } from './questions'
import type { IslandOutcome, RetrieveDebug, TurnError, TurnResult } from './types'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 语料保存位置：默认仓库内 fixtures/（本次已从 scratchpad 拷贝一份，避免依赖会话级临时目录）。
 *  可用 PAPER_EVAL_FIXTURES_DIR 覆盖（例如日后换一批评测论文时）。 */
export const FIXTURES_DIR = process.env.PAPER_EVAL_FIXTURES_DIR ?? path.join(HERE, 'fixtures')

/** dev server 地址：所有调用都走本地代理，脚本本身绝不读取 .env.local、绝不出现 key。 */
export const BASE_URL = process.env.PAPER_EVAL_BASE_URL ?? 'http://localhost:5173'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 语料：加载 + 预建索引，供多题复用
// ---------------------------------------------------------------------------

export interface PreparedPaper extends LoadedPaper {
  baseIndex: Bm25Index
}

export interface Corpus {
  papers: Map<EvalPaperId, PreparedPaper>
}

export async function prepareCorpus(paperIds: readonly EvalPaperId[], fixturesDir: string = FIXTURES_DIR): Promise<Corpus> {
  const papers = new Map<EvalPaperId, PreparedPaper>()
  // 串行加载：pdfjs 解析较重，串行更省内存、日志也更好读；只在启动时跑一次，耗时可忽略。
  for (const id of paperIds) {
    const spec = PAPERS[id]
    const sourcePath = path.join(fixturesDir, spec.fileName)
    const loaded = await loadPaper(id, sourcePath, spec.format)
    papers.set(id, { ...loaded, baseIndex: indexChunks(loaded.chunks) })
  }
  return { papers }
}

/** 本题实际使用的 chunk 池：注入题在指定 chunk 末尾追加金丝雀段落，索引随之重建；其余题目复用预建索引。 */
function chunksForQuestion(
  paper: PreparedPaper,
  question: EvalQuestion,
): { chunks: readonly PaperChunk[]; index: Bm25Index; injectedChunkId: string | null } {
  if (question.kind === 'challenge' && question.challengeType === 'injection' && question.injection) {
    const { chunks, injectedChunkId } = injectCanary(paper.chunks, question.injection.matchText, question.injection.canaryLine)
    if (injectedChunkId === null) {
      // matchText 没命中任何 chunk：注入题形同虚设，必须显式暴露而不是悄悄退化成普通问答。
      console.warn(`[harness] 注入题 ${question.id} 的 matchText 未在 ${question.paperId} 的任何 chunk 中命中，金丝雀未被注入`)
    }
    return { chunks, index: indexChunks(chunks), injectedChunkId }
  }
  return { chunks: paper.chunks, index: paper.baseIndex, injectedChunkId: null }
}

// ---------------------------------------------------------------------------
// 重试策略（modelGateway.retryDelayFor 的评测版精简重写，语义一致，见文件头说明）
// ---------------------------------------------------------------------------

function retryDelayMs(e: unknown, receivedAnyText: boolean): number | null {
  if (!(e instanceof LlmError)) return null
  if (e.kind === 'auth') return null // 配置问题，不重试
  if (e.kind === 'rate-limit') return e.retryAfterMs ?? Math.round(1500 + Math.random() * 1500) // 尊重 429 Retry-After
  if (e.kind === 'server' || e.kind === 'network' || e.kind === 'timeout' || e.kind === 'bad-response') {
    return receivedAnyText ? null : Math.round(500 + Math.random() * 800) // 已有正文 token 就不重试，保留半截
  }
  return null
}

function classifyError(e: unknown): TurnError {
  if (e instanceof LlmError) return { kind: e.kind, message: e.message }
  return { kind: 'other', message: e instanceof Error ? e.message : String(e) }
}

/**
 * commit 41d0bb3（modelGateway.ts 第 257-263 行）新增：`thinking:'on-high'` 轮命中
 * "bad-response 流式返回为空" 且尚无正文时，同参重试必然复现（推理独占了整个 max_tokens 预算），
 * 因此**不**走下面的同参 retryDelayMs 路径，改为立即（不延迟）用 `{...spec, thinking:'off'}`
 * 重试一次。字面复刻该判定条件，一字不差。
 */
function emptyStreamNeedsDowngrade(e: unknown, spec: PaperCallSpec, textSoFar: string): boolean {
  return (
    e instanceof LlmError &&
    e.kind === 'bad-response' &&
    e.message.includes('流式返回为空') &&
    spec.thinking === 'on-high' &&
    textSoFar === ''
  )
}

/**
 * commit 725b6cf（modelGateway.ts）新增：深度轮"预算烧尽残句"——推理烧掉≈全部 max_tokens 预算，
 * 只漏出百余字符截断正文，不抛空流错（result.text 非空，属于成功返回）但答案不可用。
 * 判定 = 真实 usage 显示输出触顶（阈值 maxOutputTokens-64）+ 正文 trim 后 <200 字符。
 * 命中同样走关思考降级重试（成功路径触发，与 emptyStreamNeedsDowngrade 的失败路径互补）。
 * 本评测就是这条规则的实证来源（attn-c-cross run2：outputTokens=5999/6000，正文 113 字符、0 引用）。
 */
function budgetBurnedSliver(result: { text: string; aborted: boolean; usage: CallOutcome['usageRaw'] }, spec: PaperCallSpec): boolean {
  const out = result.usage?.outputTokens
  return (
    !result.aborted &&
    spec.thinking === 'on-high' &&
    typeof out === 'number' &&
    out >= spec.maxOutputTokens - 64 &&
    result.text.trim().length < 200
  )
}

/**
 * §6.1/§8.1 唯一自动二次调用之一：`copilot:evidence status=insufficient` → 扩检索（固定 top-12）
 * 同模型重试一次。字面复刻 src/lib/paper/turnEngine.ts 的 createTurnRunner（第 326-363 行）：
 * - 重试时 topK 固定为 `RETRIEVE_TOP_K.deep`（=12），与本轮原 taskId 是 chat 还是 deep 无关；
 * - 指令原文取自 turnEngine.ts 的 EVIDENCE_RETRY_DIRECTIVE 常量，一字不改；
 * - 判定用"最后一个闭合 evidence 岛"（turnEngine.findIsland 语义），不是"任意一个"；
 * - 命中即完全替换 citeMap/chunks/segs/最终文本（不与首次结果合并），退出后返回值即最终态。
 * 2026-08-13 补齐：此前 harness 只发一次，导致检索为空/模型误判"不足"时评测把它算作"误拒"，
 * 而产品实际会在这里再抢救一次——评测因此系统性高估了误拒率，见 checks.ts 门槛表复核记录。
 */
const EVIDENCE_RETRY_DIRECTIVE =
  '上一次检索片段不足，本次已扩大检索范围。若白名单仍不足以回答，直接输出 evidence 岛并只说明缺少什么，不要编造。'

interface CallOutcome {
  finalText: string
  usageRaw: Awaited<ReturnType<typeof runPaperStream>>['usage']
  aborted: boolean
  error: TurnError | null
  retryCount: number
  firstDeltaAt: number | null
  /** commit 41d0bb3：本次调用是否触发了"深度轮空流→关思考降级重试"且降级重试成功 */
  thinkingDowngraded: boolean
}

/**
 * 单次逻辑调用，抽出来是因为 evidence 扩检索需要完整地再跑一遍。字面复刻
 * modelGateway.streamPaperChat（41d0bb3 后）的分支结构：先判断是否命中"深度轮空流降级"条件
 * （命中则立即用 thinking:'off' 重试一次，不占用同参重试名额），否则走原有 retryDelayMs 同参重试。
 * 两条路径互斥——命中降级就不再尝试同参重试，与 src 完全一致。
 */
async function callWithTechnicalRetry(url: string, spec: PaperCallSpec, messages: ChatMessage[]): Promise<CallOutcome> {
  let acc = ''
  let firstDeltaAt: number | null = null
  const onDelta = (d: string) => {
    if (firstDeltaAt === null) firstDeltaAt = Date.now()
    acc += d
  }
  const attempt = (s: PaperCallSpec) => {
    acc = ''
    firstDeltaAt = null
    return runPaperStream({ url, body: buildChatBody(s, messages, true), onDelta })
  }

  let finalText = ''
  let usageRaw: CallOutcome['usageRaw'] = null
  let aborted = false
  let error: TurnError | null = null
  let retryCount = 0
  let thinkingDowngraded = false

  try {
    const result = await attempt(spec)
    if (budgetBurnedSliver(result, spec)) {
      // 成功路径命中（不是异常）：预算被推理烧尽、只漏出截断残句，同样降级重试一次；
      // attempt() 内部会在发起降级调用前重置 acc，天然避免残句拼进新答案（与 src 的显式 text='' 等价）。
      retryCount += 1
      try {
        const retryResult = await attempt({ ...spec, thinking: 'off' })
        finalText = retryResult.text
        usageRaw = retryResult.usage
        aborted = retryResult.aborted
        thinkingDowngraded = true
      } catch (e2) {
        error = classifyError(e2)
        finalText = acc // 保留半截，语义同产品侧「响应中断」
      }
    } else {
      finalText = result.text
      usageRaw = result.usage
      aborted = result.aborted
    }
  } catch (e) {
    if (emptyStreamNeedsDowngrade(e, spec, acc)) {
      retryCount += 1
      try {
        const result = await attempt({ ...spec, thinking: 'off' })
        finalText = result.text
        usageRaw = result.usage
        aborted = result.aborted
        thinkingDowngraded = true
      } catch (e2) {
        error = classifyError(e2)
        finalText = acc // 保留半截，语义同产品侧「响应中断」
      }
    } else {
      const delay = retryDelayMs(e, acc.length > 0)
      if (delay === null) {
        error = classifyError(e)
        finalText = acc
      } else {
        retryCount += 1
        await sleep(delay)
        try {
          const result = await attempt(spec)
          finalText = result.text
          usageRaw = result.usage
          aborted = result.aborted
        } catch (e2) {
          error = classifyError(e2)
          finalText = acc
        }
      }
    }
  }

  return { finalText, usageRaw, aborted, error, retryCount, firstDeltaAt, thinkingDowngraded }
}

// ---------------------------------------------------------------------------
// 单题执行：retrieve → assembleContext → 流式调用 → streamParser 解析 → （evidence 不足则扩检索重试一次）→ 校验器
// ---------------------------------------------------------------------------

export async function runOneQuestion(corpus: Corpus, question: EvalQuestion, runIndex: number): Promise<TurnResult> {
  const paper = corpus.papers.get(question.paperId)
  if (!paper) throw new Error(`语料未加载：${question.paperId}（先调用 prepareCorpus）`)

  const { chunks, index, injectedChunkId } = chunksForQuestion(paper, question)
  const spec = PAPER_TASKS[question.taskId]
  const topK = question.taskId === 'deep' ? RETRIEVE_TOP_K.deep : RETRIEVE_TOP_K.normal
  const url = `${BASE_URL}${spec.cap.proxyPrefix}${spec.cap.chatPath}`

  const startedAt = Date.now()

  // --- 第一轮：常规检索 + 生成 ---
  let retrieveResult = await retrieveFromChunks(chunks, question.question, { topK }, index)
  let assembled = assembleContext({
    history: [],
    chunks: retrieveResult.chunks,
    question: question.question,
    directives: [],
    inputBudgetTokens: spec.inputBudgetTokens,
  })
  let call = await callWithTechnicalRetry(url, spec, assembled.messages)

  let retryCount = call.retryCount
  let usedEvidenceRetry = false
  // 两阶段任一命中"深度轮空流降级"都算：与 turnEngine 的 reducer 语义一致（state.thinkingDowngraded || ev.thinkingDowngraded）
  let thinkingDowngraded = call.thinkingDowngraded
  // usage：与 turnEngine 的 reducer 语义一致（`stream-end` 的 `ev.usage ?? state.usage`——整段覆盖，
  // 不跨调用相加）。命中 evidence 重试时，首次调用的真实花费因此不进本地 usage 明细（provider 侧仍会
  // 计费，只是产品自己的用量统计看不到）——这是产品既有取舍，评测如实复刻，不自作主张改成"求和更准确"。
  let usageSnapshot: { usageRaw: CallOutcome['usageRaw']; messages: ChatMessage[]; outputText: string } | null = null
  if (!call.error) usageSnapshot = { usageRaw: call.usageRaw, messages: assembled.messages, outputText: call.finalText }

  // --- evidence 不足 → 扩检索同模型重试一次（见上方函数注释） ---
  if (!call.error && !call.aborted) {
    const segs1 = splitCopilotStream(call.finalText, { open: false })
    const lastEvidence = collectIslands(segs1, 'evidence').at(-1)
    if (lastEvidence?.status === 'insufficient') {
      usedEvidenceRetry = true
      const wider = await retrieveFromChunks(chunks, question.question, { topK: RETRIEVE_TOP_K.deep }, index)
      const widerAssembled = assembleContext({
        history: [],
        chunks: wider.chunks,
        question: question.question,
        directives: [EVIDENCE_RETRY_DIRECTIVE],
        inputBudgetTokens: spec.inputBudgetTokens,
      })
      const retryCall = await callWithTechnicalRetry(url, spec, widerAssembled.messages)
      retryCount += retryCall.retryCount
      thinkingDowngraded = thinkingDowngraded || retryCall.thinkingDowngraded
      if (!retryCall.error) usageSnapshot = { usageRaw: retryCall.usageRaw, messages: widerAssembled.messages, outputText: retryCall.finalText }
      // 完全替换：citeMap/chunks/segs/最终文本全部来自重试结果（与 turnEngine 一致，不与首次合并）；
      // firstDeltaAt 例外——保留首轮的（首轮通常已经把 evidence 岛本身流出来了，那才是用户真正看到第一个字符的时刻）。
      retrieveResult = wider
      assembled = widerAssembled
      call = { ...retryCall, firstDeltaAt: call.firstDeltaAt ?? retryCall.firstDeltaAt }
    }
  }

  const endedAt = Date.now()
  const injectedChunkRetrieved = injectedChunkId !== null && retrieveResult.chunks.some((c) => c.chunk.id === injectedChunkId)

  const segs = splitCopilotStream(call.finalText, { open: false })

  const chunkTextByAlias: Record<string, string> = {}
  for (const c of retrieveResult.chunks) chunkTextByAlias[c.alias] = c.chunk.text
  const citeAudit = call.error ? null : auditCitations(segs, retrieveResult.citeMapEntries, chunkTextByAlias)

  const islands: IslandOutcome[] = segs
    .filter((s): s is Extract<typeof s, { type: 'island' }> => s.type === 'island' && s.closed)
    .map((s) => (s.block ? { islandType: s.islandType, ok: true } : { islandType: s.islandType, ok: false, failure: s.failure }))

  // 与 turnEngine.findIsland 一致：取最后一个闭合 evidence 岛，不是"任意一个"
  const evidenceInsufficient = collectIslands(segs, 'evidence').at(-1)?.status === 'insufficient'
  const canaryHits = Object.values(CANARY_TOKENS).filter((token) => call.finalText.includes(token))

  // usage 取最后一次成功调用的快照（见上方 usageSnapshot 注释：与 turnEngine 一致，不跨调用相加）
  const usage = usageSnapshot ? normalizeUsage(spec.cap, usageSnapshot.usageRaw, { messages: usageSnapshot.messages, outputText: usageSnapshot.outputText }) : null

  const retrieve: RetrieveDebug = {
    expandedQuery: retrieveResult.expandedQuery,
    chunkIds: retrieveResult.chunks.map((c) => c.chunk.id),
    usedRerank: retrieveResult.usedRerank,
    injectedChunkId,
    injectedChunkRetrieved,
  }

  return {
    questionId: question.id,
    paperId: question.paperId,
    taskId: question.taskId,
    runIndex,
    startedAt,
    firstDeltaAt: call.firstDeltaAt,
    endedAt,
    ttftMs: call.firstDeltaAt !== null ? call.firstDeltaAt - startedAt : null,
    totalMs: endedAt - startedAt,
    aborted: call.aborted,
    retryCount,
    error: call.error,
    rawText: call.finalText,
    segs,
    citeMapEntries: retrieveResult.citeMapEntries,
    retrieve,
    citeAudit,
    islands,
    evidenceInsufficient,
    usedEvidenceRetry,
    thinkingDowngraded,
    canaryHits,
    budget: assembled.report,
    usage,
  }
}

// ---------------------------------------------------------------------------
// 并发控制：≤2 并发、全局发起间隔 ≥2s（modelGateway.takeToken 的排队思路：单一 Promise 链
// 串行化"检查间隔 + 记录发起时刻"，避免两个 worker 同时读到旧的 lastLaunch 而抢跑）。
// ---------------------------------------------------------------------------

export interface RunEvalOptions {
  concurrency?: number
  minIntervalMs?: number
  onProgress?: (done: number, total: number, last: TurnResult) => void
}

interface Job {
  question: EvalQuestion
  runIndex: number
}

function createLaunchGate(minIntervalMs: number) {
  let lastLaunch = 0
  let queueTail: Promise<void> = Promise.resolve()
  return (): Promise<void> => {
    const turn = queueTail.then(async () => {
      const wait = Math.max(0, lastLaunch + minIntervalMs - Date.now())
      if (wait > 0) await sleep(wait)
      lastLaunch = Date.now()
    })
    queueTail = turn.catch(() => undefined)
    return turn
  }
}

/** questions × repeats 展开为任务队列后统一调度；--smoke 传 repeats=1，--full 传 repeats=3。 */
export async function runEval(
  corpus: Corpus,
  questions: readonly EvalQuestion[],
  repeats: number,
  opts: RunEvalOptions = {},
): Promise<TurnResult[]> {
  const jobs: Job[] = []
  for (const question of questions) {
    for (let runIndex = 0; runIndex < repeats; runIndex++) jobs.push({ question, runIndex })
  }

  const concurrency = Math.max(1, opts.concurrency ?? 2)
  const minIntervalMs = opts.minIntervalMs ?? 2000
  const reserveSlot = createLaunchGate(minIntervalMs)

  const results: TurnResult[] = new Array(jobs.length)
  let nextIndex = 0
  let done = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= jobs.length) return
      await reserveSlot()
      const { question, runIndex } = jobs[i]
      const result = await runOneQuestion(corpus, question, runIndex)
      results[i] = result
      done += 1
      opts.onProgress?.(done, jobs.length, result)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
  await Promise.all(workers)
  return results
}
