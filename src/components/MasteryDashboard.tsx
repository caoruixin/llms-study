import { useMemo } from 'react'
import { CATEGORY_LABELS, QUESTIONS } from '../data/questions'
import type { Grade, QCategory } from '../data/types'
import { useHistory } from '../store'

const GRADE_SCORE: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1 }
const GRADE_COLOR: Record<Grade, string> = { A: 'bg-ok', B: 'bg-accent', C: 'bg-warn', D: 'bg-bad' }

export default function MasteryDashboard() {
  const { attempts } = useHistory()

  const stats = useMemo(() => {
    const bestByQuestion = new Map<string, Grade>()
    for (const a of attempts) {
      if (!a.grade) continue
      const prev = bestByQuestion.get(a.questionId)
      if (!prev || GRADE_SCORE[a.grade] > GRADE_SCORE[prev]) bestByQuestion.set(a.questionId, a.grade)
    }
    const gradeDist: Record<Grade, number> = { A: 0, B: 0, C: 0, D: 0 }
    bestByQuestion.forEach((g) => gradeDist[g]++)

    const byCategory = (Object.keys(CATEGORY_LABELS) as QCategory[]).map((c) => {
      const qs = QUESTIONS.filter((q) => q.category === c)
      const practiced = qs.filter((q) => bestByQuestion.has(q.id))
      const mastery =
        practiced.length === 0
          ? 0
          : practiced.reduce((s, q) => s + GRADE_SCORE[bestByQuestion.get(q.id)!], 0) / (qs.length * 4)
      return { category: c, label: CATEGORY_LABELS[c], total: qs.length, practiced: practiced.length, mastery }
    })

    return { practiced: bestByQuestion.size, total: QUESTIONS.length, attempts: attempts.length, gradeDist, byCategory }
  }, [attempts])

  if (stats.attempts === 0) return null

  return (
    <div className="mb-5 rounded-xl border border-line bg-panel p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-8 gap-y-2">
        <h3 className="text-sm font-semibold text-accent">掌握度仪表盘</h3>
        <span className="text-sm text-dim">
          已练 <b className="font-mono text-white">{stats.practiced}</b>/{stats.total} 题 · 共{' '}
          <b className="font-mono text-white">{stats.attempts}</b> 次作答
        </span>
        <div className="flex items-center gap-3 text-sm">
          {(Object.keys(stats.gradeDist) as Grade[]).map((g) => (
            <span key={g} className="flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${GRADE_COLOR[g]}`} />
              <span className="text-dim">
                {g} <span className="font-mono text-white">{stats.gradeDist[g]}</span>
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="grid gap-x-8 gap-y-2 md:grid-cols-2 lg:grid-cols-3">
        {stats.byCategory.map((c) => (
          <div key={c.category} className="text-xs">
            <div className="mb-1 flex justify-between text-dim">
              <span>{c.label}</span>
              <span className="font-mono">
                {c.practiced}/{c.total} 题 · 掌握 {Math.round(c.mastery * 100)}%
              </span>
            </div>
            <div className="h-1.5 rounded bg-panel-2">
              <div className="h-1.5 rounded bg-accent transition-all" style={{ width: `${c.mastery * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-dim">掌握度 = 各题最佳等级得分（A=4 … D=1）÷ 板块满分；低分题会显示在左侧列表供重练。</p>
    </div>
  )
}
