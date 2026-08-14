import type { Grade, Question } from '../../data/types'

// 等级徽章配色单一来源：题库列表 / 切换条 / 评分卡 / 历史行共用
export const GRADE_STYLE: Record<Grade, string> = {
  A: 'bg-ok text-white',
  B: 'bg-accent text-white',
  C: 'bg-warn text-white',
  D: 'bg-bad text-white',
}

interface QuestionGroup {
  category: string
  label: string
  questions: Question[]
}

interface QuestionListProps {
  groups: QuestionGroup[]
  selectedId: string
  bestGradeByQuestion: ReadonlyMap<string, Grade>
  onSelect: (id: string) => void
}

// 分组题库列表：桌面 aside 与移动 Drawer 双处渲染同一份
export default function QuestionList({ groups, selectedId, bestGradeByQuestion, onSelect }: QuestionListProps) {
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.category}>
          <div className="mb-1 px-1 text-xs font-semibold tracking-wide text-dim">{g.label}</div>
          <div className="space-y-1">
            {g.questions.map((q) => {
              const best = bestGradeByQuestion.get(q.id)
              return (
                <button
                  key={q.id}
                  onClick={() => onSelect(q.id)}
                  className={`flex min-h-10 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors lg:min-h-0 ${
                    q.id === selectedId
                      ? 'border-accent/60 bg-accent/10'
                      : 'border-line bg-panel hover:bg-panel-2'
                  }`}
                >
                  <span className="flex-1 truncate">{q.prompt}</span>
                  {q.lang === 'en' && <span className="rounded bg-accent-2/20 px-1 text-[10px] text-accent-2">EN</span>}
                  {best && <span className={`rounded px-1.5 text-xs font-bold ${GRADE_STYLE[best]}`}>{best}</span>}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
