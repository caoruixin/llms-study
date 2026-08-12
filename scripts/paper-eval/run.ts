// Paper Copilot 评测 CLI 入口（PLAN-paper-copilot.md §11.3）。
//
//   npx vite-node scripts/paper-eval/run.ts -- --smoke   # 3 题 × 1 run，仅 kv-cache-note
//   npx vite-node scripts/paper-eval/run.ts -- --full    # 36 题 × 3 runs = 108 次生成（发布前手动跑，不进 vitest 门禁）
//
// 不传参数默认 --smoke（更安全，避免误触发全量）。可选：--concurrency=2 --min-interval-ms=2000。
//
// 前置条件：dev server 已在 http://localhost:5173 运行（`npm run dev`），代理会把
// /api/deepseek、/api/moonshot 转发并注入 .env.local 里的 key——本脚本不读取 .env.local、
// 不出现任何 key，一律通过该本地代理发起请求。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ALL_QUESTIONS, findQuestion, SMOKE_QUESTION_IDS, type EvalPaperId, type EvalQuestion } from './questions'
import { BASE_URL, FIXTURES_DIR, prepareCorpus, runEval } from './harness'
import { evaluateGates, type EvalStats } from './checks'
import type { GateResult, TurnResult } from './types'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(HERE, 'results')

type Mode = 'smoke' | 'full' | 'subset'

interface CliOptions {
  mode: Mode
  concurrency: number
  minIntervalMs: number
  /** --subset=id1,id2,... ：只跑这些题（各 ×3 runs），用于 harness 修复后的定向复测 */
  subsetIds: string[]
  /** --merge-with=<path to a prior *-full.json> ：把 subset 结果替换进那份结果里的同名题，重新算门槛表 */
  mergeWith: string | null
  /** --label=<name> ：合并输出文件名后缀，默认 full-merged；如 --label=final → *-final.{json,md} */
  label: string
}

function parseArgs(argv: readonly string[]): CliOptions {
  const flag = (prefix: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(prefix))
    if (!hit) return fallback
    const n = Number(hit.slice(prefix.length))
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const subsetArg = argv.find((a) => a.startsWith('--subset='))
  const subsetIds = subsetArg
    ? subsetArg
        .slice('--subset='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
  const mergeWithArg = argv.find((a) => a.startsWith('--merge-with='))
  const labelArg = argv.find((a) => a.startsWith('--label='))
  return {
    mode: argv.includes('--full') ? 'full' : subsetIds.length > 0 ? 'subset' : 'smoke',
    concurrency: flag('--concurrency=', 2),
    minIntervalMs: flag('--min-interval-ms=', 2000),
    subsetIds,
    mergeWith: mergeWithArg ? mergeWithArg.slice('--merge-with='.length) : null,
    label: labelArg ? labelArg.slice('--label='.length) : 'full-merged',
  }
}

interface Plan {
  questions: EvalQuestion[]
  paperIds: EvalPaperId[]
  repeats: number
}

function selectPlan(opts: CliOptions): Plan {
  if (opts.mode === 'smoke') {
    return { questions: SMOKE_QUESTION_IDS.map(findQuestion), paperIds: ['kv-cache'], repeats: 1 }
  }
  if (opts.mode === 'subset') {
    const questions = opts.subsetIds.map(findQuestion)
    const paperIds = [...new Set(questions.map((q) => q.paperId))]
    return { questions, paperIds, repeats: 3 }
  }
  return { questions: [...ALL_QUESTIONS], paperIds: ['attention', 'kv-cache', 'vllm'], repeats: 3 }
}

interface PriorResultFile {
  meta: Record<string, unknown>
  turns: TurnResult[]
}

/** 用新 turns 替换掉旧结果里同 questionId 的全部旧 runs，其余题目原样保留。 */
function mergeTurns(original: readonly TurnResult[], replacement: readonly TurnResult[]): TurnResult[] {
  const replacedIds = new Set(replacement.map((t) => t.questionId))
  return [...original.filter((t) => !replacedIds.has(t.questionId)), ...replacement]
}

function statusLabel(s: GateResult['status']): string {
  switch (s) {
    case 'pass':
      return 'PASS'
    case 'fail':
      return 'FAIL'
    case 'manual-pending':
      return '待人工'
    case 'not-covered':
      return 'N/A'
  }
}

const fmtMs = (ms: number | null): string => (ms === null ? 'N/A' : `${(ms / 1000).toFixed(2)}s`)

/** Map 不是 plain object，JSON.stringify 会把它序列化成 {}；这里转成可读的 entries 数组。 */
function statsToJson(stats: EvalStats): Record<string, unknown> {
  return {
    ...stats,
    schema: { ...stats.schema, byType: Object.fromEntries(stats.schema.byType) },
    repair: { ...stats.repair, byType: Object.fromEntries(stats.repair.byType) },
  }
}

function renderMarkdown(label: string, turns: readonly TurnResult[], stats: EvalStats, gates: readonly GateResult[], meta: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push(`# Paper Copilot 评测结果 — ${label}`, '')
  lines.push(`生成时间：${new Date().toISOString()}`, '')
  lines.push(`题目数：${new Set(turns.map((t) => t.questionId)).size} · 总运行次数：${turns.length} · 失败次数：${stats.errors.length}`, '')

  lines.push('## 门槛表（PLAN-paper-copilot.md §11.3）', '')
  lines.push('| 门槛 | 判定方式 | 结果 | 详情 |', '|---|---|---|---|')
  for (const g of gates) {
    lines.push(`| ${g.label} | ${g.judgment === 'auto' ? '自动' : '人工'} | **${statusLabel(g.status)}** | ${g.detail.replace(/\|/g, '\\|')} |`)
  }

  lines.push('', '## 关键数字', '')
  lines.push(`- 引用：${stats.citation.total} 次，可定位率 ${(stats.citation.locatableRate * 100).toFixed(1)}%，弱支持 ${stats.citation.weak} 次，不在白名单 ${stats.citation.missing} 次`)
  lines.push(`- 结构岛：${stats.schema.totalIslands} 个，首次通过率 ${(stats.schema.firstPassRate * 100).toFixed(1)}%（${stats.schema.passed}/${stats.schema.totalIslands}）`)
  lines.push(
    `- repairLatexBackslashes：触发 ${stats.repair.triggered} 次，修复后可解析 ${stats.repair.repairedParseOk} 次` +
      `（成功率 ${stats.repair.triggered > 0 ? ((stats.repair.repairedParseOk / stats.repair.triggered) * 100).toFixed(1) : '0.0'}%），` +
      `按岛类型：${[...stats.repair.byType.entries()].map(([k, v]) => `${k}=${v.repairedParseOk}/${v.triggered}`).join('，') || '（无触发）'}`,
  )
  lines.push(`- TTFT（thinking off，n=${stats.latency.ttftChatOnly.n}）：P50=${fmtMs(stats.latency.ttftChatOnly.p50)}，P95=${fmtMs(stats.latency.ttftChatOnly.p95)}`)
  lines.push(`- 完整回答耗时字面口径（全部轮次不分 taskId，n=${stats.latency.totalAll.n}）：P50=${fmtMs(stats.latency.totalAll.p50)}，P95=${fmtMs(stats.latency.totalAll.p95)}`)
  lines.push(`- 完整回答耗时分拆·thinking-off（chat，n=${stats.latency.totalChatOnly.n}）：P50=${fmtMs(stats.latency.totalChatOnly.p50)}，P95=${fmtMs(stats.latency.totalChatOnly.p95)}`)
  lines.push(`- 完整回答耗时分拆·thinking-on-high（deep，n=${stats.latency.totalDeepOnly.n}）：P50=${fmtMs(stats.latency.totalDeepOnly.p50)}，P95=${fmtMs(stats.latency.totalDeepOnly.p95)}`)
  lines.push(`- deep（thinking on-high，豁免 TTFT）轮次：${stats.latency.deepCount}`)
  lines.push(`- 金丝雀：注入成功 ${stats.canary.injectionSuccess.length}/${stats.canary.injectionAttempts}，跨论文泄漏 ${stats.canary.crossPaperLeaks.length} 次`)

  if (stats.errors.length) {
    lines.push('', '## 失败的运行', '')
    for (const e of stats.errors) lines.push(`- \`${e.questionId}\`（run ${e.runIndex}，${e.paperId}）`)
  }

  lines.push('', '## 运行参数', '')
  for (const [k, v] of Object.entries(meta)) lines.push(`- ${k}: ${JSON.stringify(v)}`)

  return lines.join('\n')
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const plan = selectPlan(opts)
  const totalRuns = plan.questions.length * plan.repeats

  console.log(`[paper-eval] mode=${opts.mode} papers=[${plan.paperIds.join(', ')}] questions=${plan.questions.length} repeats=${plan.repeats} totalRuns=${totalRuns}`)
  if (opts.mode === 'subset') console.log(`[paper-eval] subset=[${opts.subsetIds.join(', ')}]${opts.mergeWith ? ` mergeWith=${opts.mergeWith}` : ''}`)
  console.log(`[paper-eval] fixturesDir=${FIXTURES_DIR}`)
  console.log(`[paper-eval] baseUrl=${BASE_URL}（一律走本地代理，本脚本不读取 .env.local、不出现任何 key）`)
  console.log(`[paper-eval] concurrency=${opts.concurrency} minIntervalMs=${opts.minIntervalMs}`)

  const corpus = await prepareCorpus(plan.paperIds)
  for (const id of plan.paperIds) {
    const p = corpus.papers.get(id)
    if (!p) continue
    console.log(`[paper-eval] loaded ${id}: title="${p.title}" format=${p.format} pages=${p.pageCount ?? 'n/a'} chars=${p.charCount} chunks=${p.chunks.length}`)
    for (const d of p.deviations) console.log(`[paper-eval]   已知偏差: ${d}`)
  }

  const startedAt = new Date()
  const turns = await runEval(corpus, plan.questions, plan.repeats, {
    concurrency: opts.concurrency,
    minIntervalMs: opts.minIntervalMs,
    onProgress: (done, total, last) => {
      const status = last.error ? `ERROR(${last.error.kind}: ${last.error.message})` : last.aborted ? 'ABORTED' : 'ok'
      console.log(
        `[paper-eval] ${done}/${total} ${last.questionId} run${last.runIndex} [${last.taskId}] ${status} ttft=${last.ttftMs ?? '-'}ms total=${last.totalMs}ms retries=${last.retryCount} evidenceRetry=${last.usedEvidenceRetry} thinkingDowngraded=${last.thinkingDowngraded}`,
      )
    },
  })
  const endedAt = new Date()

  // subset 模式下门槛表仍按"评测集完整 36 题元数据"判定分母（如 24/3），只是 turns 只有子集——
  // 用 ALL_QUESTIONS 保证 checks.ts 的分母语义不因为只跑了子集而改变含义。
  const gateQuestions = opts.mode === 'subset' ? ALL_QUESTIONS : plan.questions
  const { stats, gates } = evaluateGates(turns, gateQuestions)

  await mkdir(RESULTS_DIR, { recursive: true })
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(RESULTS_DIR, `${stamp}-${opts.mode}.json`)
  const mdPath = path.join(RESULTS_DIR, `${stamp}-${opts.mode}.md`)

  const meta = {
    mode: opts.mode,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    wallMs: endedAt.getTime() - startedAt.getTime(),
    concurrency: opts.concurrency,
    minIntervalMs: opts.minIntervalMs,
    baseUrl: BASE_URL,
    fixturesDir: FIXTURES_DIR,
    paperIds: plan.paperIds,
    questionCount: plan.questions.length,
    repeats: plan.repeats,
    totalRuns,
    ...(opts.mode === 'subset' ? { subsetIds: opts.subsetIds, note: '仅子集结果；分母按 ALL_QUESTIONS(36题) 语义计算，非子集自身占比' } : {}),
  }

  await writeFile(jsonPath, JSON.stringify({ meta, stats: statsToJson(stats), gates, turns }, null, 2), 'utf8')
  await writeFile(mdPath, renderMarkdown(opts.mode, turns, stats, gates, meta), 'utf8')

  console.log('')
  console.log(`[paper-eval] 结果已写入 ${jsonPath}`)
  console.log(`[paper-eval] 汇总已写入 ${mdPath}`)
  console.log('')
  for (const g of gates) console.log(`  [${statusLabel(g.status)}] ${g.label}\n      ${g.detail}`)

  // --merge-with：把本次子集 turns 替换进旧结果的同名题，重新计算完整门槛表，产出 *-<label>.*（默认 label=full-merged）
  if (opts.mode === 'subset' && opts.mergeWith) {
    const priorRaw = JSON.parse(await readFile(opts.mergeWith, 'utf8')) as PriorResultFile
    const mergedTurns = mergeTurns(priorRaw.turns, turns)
    const merged = evaluateGates(mergedTurns, ALL_QUESTIONS)

    const mergedStamp = new Date().toISOString().replace(/[:.]/g, '-')
    const mergedJsonPath = path.join(RESULTS_DIR, `${mergedStamp}-${opts.label}.json`)
    const mergedMdPath = path.join(RESULTS_DIR, `${mergedStamp}-${opts.label}.md`)
    const mergedMeta = {
      mode: opts.label,
      mergedFrom: opts.mergeWith,
      subsetRerunJson: jsonPath,
      subsetIds: opts.subsetIds,
      subsetRepeats: plan.repeats,
      originalTurnCount: priorRaw.turns.length,
      replacedTurnCount: turns.length,
      mergedTurnCount: mergedTurns.length,
      generatedAt: new Date().toISOString(),
    }
    await writeFile(mergedJsonPath, JSON.stringify({ meta: mergedMeta, stats: statsToJson(merged.stats), gates: merged.gates, turns: mergedTurns }, null, 2), 'utf8')
    await writeFile(mergedMdPath, renderMarkdown(opts.label, mergedTurns, merged.stats, merged.gates, mergedMeta), 'utf8')

    console.log('')
    console.log(`[paper-eval] 合并结果已写入 ${mergedJsonPath}`)
    console.log(`[paper-eval] 合并汇总已写入 ${mergedMdPath}`)
    console.log('')
    for (const g of merged.gates) console.log(`  [merged ${statusLabel(g.status)}] ${g.label}\n      ${g.detail}`)
  }

  const anyFail = gates.some((g) => g.status === 'fail')
  process.exitCode = anyFail ? 1 : 0
}

main().catch((e: unknown) => {
  console.error('[paper-eval] 运行失败：', e)
  process.exitCode = 1
})
