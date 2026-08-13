// Paper Copilot 人工评审物料生成器（PLAN-paper-copilot.md §11.3 人工三项）。
//
//   npx vite-node scripts/paper-eval/humanReview.ts [path-to-full-or-merged.json]
//
// 不传路径时自动挑 results/ 下最新的 *-full.json 或 *-full-merged.json。
// 产出单个 results/human-review-<timestamp>.md，包含：
//   1. 引用支持性抽查样本（20 条，weak 优先，跨题分散取样，附问题/回答句/别名/chunk 原文摘录/页码）
//   2. 正确性 rubric 打分表（36 题 × 每题「代表 run」的回答摘要 + 空白 1-5 分栏）
//   3. 三层级讲解差异抽查的 3 题建议
//
// 只读脚本：不发起任何模型调用，只重新加载语料（用于回填 chunk 原文）+ 读取已有结果 JSON。

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_QUESTIONS, type EvalPaperId, type EvalQuestion } from './questions'
import { prepareCorpus, type Corpus } from './harness'
import type { TurnResult } from './types'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(HERE, 'results')

interface PriorResultFile {
  meta: Record<string, unknown>
  turns: TurnResult[]
}

async function resolveInputPath(argPath: string | undefined): Promise<string> {
  if (argPath) return path.isAbsolute(argPath) ? argPath : path.join(process.cwd(), argPath)
  const files = (await readdir(RESULTS_DIR)).filter((f) => /-(full|full-merged)\.json$/.test(f)).sort()
  const latest = files.at(-1)
  if (!latest) throw new Error(`results/ 下找不到 *-full.json 或 *-full-merged.json，请显式传路径`)
  return path.join(RESULTS_DIR, latest)
}

// ---------------------------------------------------------------------------
// 1) 引用支持性抽查样本
// ---------------------------------------------------------------------------

interface CitationSampleRow {
  questionId: string
  runIndex: number
  alias: string
  level: string
  score: number
  sentence: string
  chunkExcerpt: string
  page: string
  section: string
}

function chunkText(corpus: Corpus, paperId: EvalPaperId, chunkId: string): string | null {
  return corpus.papers.get(paperId)?.chunks.find((c) => c.id === chunkId)?.text ?? null
}

/** 按 questionId 分组、轮询取样：保证跨题覆盖而不是集中在少数几题（其它条件相同时抽查更有代表性）。 */
function spreadSample<T extends { questionId: string }>(rows: readonly T[], n: number): T[] {
  if (rows.length <= n) return [...rows]
  const byQ = new Map<string, T[]>()
  for (const r of rows) {
    const arr = byQ.get(r.questionId) ?? []
    arr.push(r)
    byQ.set(r.questionId, arr)
  }
  const groups = [...byQ.values()]
  const out: T[] = []
  for (let round = 0; out.length < n && round < 50; round++) {
    for (const g of groups) {
      if (out.length >= n) break
      if (round < g.length) out.push(g[round])
    }
  }
  return out
}

function buildCitationSample(turns: readonly TurnResult[], corpus: Corpus, n: number): CitationSampleRow[] {
  const rows: CitationSampleRow[] = []
  for (const t of turns) {
    if (!t.citeAudit) continue
    const citeMapByAlias = new Map(t.citeMapEntries.map((e) => [e.alias, e]))
    for (const occ of t.citeAudit.occurrences) {
      if (occ.level === 'missing') continue // 白名单外的已由机器判定，不需要人工核对支持性
      if (!occ.sentence) continue // 结构岛内的 cites 没有句子文本，人工核对聚焦 prose 引用
      const entry = citeMapByAlias.get(occ.alias)
      if (!entry) continue
      const text = chunkText(corpus, t.paperId, entry.chunkId)
      rows.push({
        questionId: t.questionId,
        runIndex: t.runIndex,
        alias: occ.alias,
        level: occ.level,
        score: Math.round(occ.score * 100) / 100,
        sentence: occ.sentence,
        chunkExcerpt: text ? text.slice(0, 320).replace(/\n+/g, ' ') : '（未找到 chunk 原文——语料版本可能与生成结果时不一致）',
        page: entry.page !== undefined ? String(entry.page) : '-',
        section: entry.section ?? '-',
      })
    }
  }
  const weak = rows.filter((r) => r.level === 'weak')
  const ok = rows.filter((r) => r.level === 'ok')
  const sample = spreadSample(weak, n)
  if (sample.length < n) sample.push(...spreadSample(ok, n - sample.length))
  return sample.slice(0, n)
}

// ---------------------------------------------------------------------------
// 2) 正确性 rubric 打分表：36 题 × 代表 run 摘要
// ---------------------------------------------------------------------------

interface RubricRow {
  questionId: string
  paperId: string
  kind: string
  categoryOrChallenge: string
  answerable: boolean
  goldHint: string
  representativeRunIndex: number | null
  answerExcerpt: string
  divergenceNote: string
}

function buildRubricTable(turns: readonly TurnResult[], questions: readonly EvalQuestion[]): RubricRow[] {
  const byQuestion = new Map<string, TurnResult[]>()
  for (const t of turns) {
    const arr = byQuestion.get(t.questionId) ?? []
    arr.push(t)
    byQuestion.set(t.questionId, arr)
  }

  return questions.map((q): RubricRow => {
    const all = byQuestion.get(q.id) ?? []
    const ok = all.filter((t) => !t.error)
    const base = {
      questionId: q.id,
      paperId: q.paperId,
      kind: q.kind,
      categoryOrChallenge: q.kind === 'main' ? q.category : q.challengeType,
      answerable: q.answerable,
      goldHint: q.goldAnchor.hint,
    }
    if (ok.length === 0) {
      return { ...base, representativeRunIndex: null, answerExcerpt: '（全部 run 失败，无可评分回答——见失败明细）', divergenceNote: 'ALL_FAILED' }
    }
    // free text 没有精确的"多数投票"，用文本长度中位数所在的 run 作为代表（避免挑到异常偏短/偏长的极端样本）
    const sorted = [...ok].sort((a, b) => a.rawText.length - b.rawText.length)
    const rep = sorted[Math.floor(sorted.length / 2)]
    const insufficientCount = ok.filter((t) => t.evidenceInsufficient).length
    const divergenceNote =
      insufficientCount > 0 && insufficientCount < ok.length
        ? `⚠ ${insufficientCount}/${ok.length} 次进入证据不足态、其余未进入——run 间不一致，建议都看一眼`
        : insufficientCount === ok.length && ok.length > 0
          ? '全部成功 run 均为证据不足态'
          : ''
    return {
      ...base,
      representativeRunIndex: rep.runIndex,
      answerExcerpt: rep.rawText.slice(0, 550).replace(/\n+/g, ' '),
      divergenceNote,
    }
  })
}

// ---------------------------------------------------------------------------
// 3) 三层级讲解差异抽查建议（人工挑 3 题分别用入门/进阶/研究层级提示重新提问对比）
// ---------------------------------------------------------------------------

interface TierSuggestion {
  questionId: string
  reason: string
}

function buildTierSuggestions(): TierSuggestion[] {
  return [
    {
      questionId: 'attn-m5',
      reason:
        'Scaled Dot-Product Attention 公式题：入门可只给直觉类比、进阶给出完整公式与缩放原因、研究层可以展开 softmax 梯度消失的数学论证——三层级的信息增量天然存在，是最容易辨出差异的一类题。',
    },
    {
      questionId: 'vllm-m2',
      reason:
        'PagedAttention 核心思想题：入门讲"借鉴操作系统分页"的类比即可、进阶需要 block/block table 机制细节、研究层可讨论与其他内存管理方案的权衡——概念题的层级差异通常体现在"要不要展开机制细节"，适合做对比样本。',
    },
    {
      questionId: 'kv-m5',
      reason:
        'KV cache 字节数计算题：入门/进阶/研究三层的"标准答案"数字相同（131072 字节），差异只能体现在讲解方式（是否展示推导步骤、是否讨论量纲/精度选择的权衡）——挑这题是为了检验层级提示是否只改变"废话多少"而不是真正改变讲解深度，是更严格的判别样本。',
    },
  ]
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderMarkdown(sourcePath: string, citationSample: CitationSampleRow[], rubric: RubricRow[], tiers: TierSuggestion[]): string {
  const lines: string[] = []
  lines.push('# Paper Copilot 人工评审物料', '')
  lines.push(`来源结果文件：\`${sourcePath}\``, '')
  lines.push(`生成时间：${new Date().toISOString()}`, '')

  lines.push('## 1. 引用支持性抽查（目标 ≥18/20 通过）', '')
  lines.push(`共 ${citationSample.length} 条（weak 档优先，跨题分散取样）。核对方法：读"回答句"是否真的被"chunk 原文摘录"支持；` + '支持记 ✓，不支持或过度引申记 ✗。', '')
  lines.push('| # | 题目 | run | 别名 | 徽章档位 | 词面分 | 回答句 | chunk 原文摘录（page/section） | 人工判定 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  citationSample.forEach((r, i) => {
    const loc = `p.${r.page} §${r.section}`.replace(/\|/g, '\\|')
    lines.push(
      `| ${i + 1} | \`${r.questionId}\` | ${r.runIndex} | ${r.alias} | ${r.level} | ${r.score} | ${r.sentence.replace(/\|/g, '\\|')} | ${r.chunkExcerpt.replace(/\|/g, '\\|')}（${loc}） | ☐ 支持 ☐ 不支持 |`,
    )
  })

  lines.push('', '## 2. 正确性 rubric 打分表（1-5 分，均分 <3.5 才阻断发布）', '')
  lines.push('代表 run 按回答长度取中位数（free text 无精确多数投票概念）；⚠ 标记表示该题 3 次 run 之间行为不一致，建议展开看全部 run。', '')
  lines.push('| 题号 | 论文 | 类型 | answerable | gold hint | 代表 run | 回答摘要 | 备注 | 打分(1-5) |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of rubric) {
    lines.push(
      `| \`${r.questionId}\` | ${r.paperId} | ${r.kind}/${r.categoryOrChallenge} | ${r.answerable} | ${r.goldHint.replace(/\|/g, '\\|')} | ${r.representativeRunIndex ?? '-'} | ${r.answerExcerpt.replace(/\|/g, '\\|')} | ${r.divergenceNote.replace(/\|/g, '\\|')} | ☐☐☐☐☐ |`,
    )
  }

  lines.push('', '## 3. 三层级讲解差异抽查建议（3 题，目标 3/3 可辨）', '')
  lines.push('操作方法：对每题分别以入门/进阶/研究层级提示重新提问（临时改 `contextBuilder` 的 profileHint 入参），对比三份回答的讲解深度是否可辨。', '')
  for (const t of tiers) {
    lines.push(`- **\`${t.questionId}\`**：${t.reason}`)
  }

  return lines.join('\n')
}

async function main(): Promise<void> {
  const inputPath = await resolveInputPath(process.argv[2])
  console.log(`[human-review] 读取结果文件: ${inputPath}`)
  const prior = JSON.parse(await readFile(inputPath, 'utf8')) as PriorResultFile
  const turns = prior.turns

  const paperIds = [...new Set(turns.map((t) => t.paperId))] as EvalPaperId[]
  console.log(`[human-review] 重建语料以回填 chunk 原文: [${paperIds.join(', ')}]`)
  const corpus = await prepareCorpus(paperIds)

  const citationSample = buildCitationSample(turns, corpus, 20)
  const rubric = buildRubricTable(turns, ALL_QUESTIONS)
  const tiers = buildTierSuggestions()

  const md = renderMarkdown(inputPath, citationSample, rubric, tiers)
  const outPath = path.join(RESULTS_DIR, `human-review-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  await writeFile(outPath, md, 'utf8')
  console.log(`[human-review] 已写入 ${outPath}`)
  console.log(`[human-review] 引用抽查样本 ${citationSample.length} 条；rubric 表 ${rubric.length} 题；三层级建议 ${tiers.length} 题`)
}

main().catch((e: unknown) => {
  console.error('[human-review] 运行失败：', e)
  process.exitCode = 1
})
