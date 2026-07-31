import { useMemo, useRef, useState } from 'react'
import { CATEGORY_LABELS, QUESTIONS, QUESTIONS_BY_CATEGORY } from '../data/questions'
import type { Grade, ScoreResult } from '../data/types'
import { chatComplete } from '../lib/llmClient'
import type { ChatMessage } from '../lib/llmClient'
import { buildGradingMessages, parseScoreJson, toGrade, weightedScore } from '../lib/grading'
import { isSpeechSupported, startDictation } from '../lib/speech'
import type { DictationSession } from '../lib/speech'
import { useHistory, useSettings } from '../store'
import MasteryDashboard from '../components/MasteryDashboard'

const GRADE_STYLE: Record<Grade, string> = {
  A: 'bg-ok/20 text-ok',
  B: 'bg-accent/20 text-accent',
  C: 'bg-warn/20 text-warn',
  D: 'bg-bad/20 text-bad',
}

const DIMENSIONS: { key: keyof Pick<ScoreResult, 'accuracy' | 'structure' | 'business' | 'depth'>; label: string }[] = [
  { key: 'accuracy', label: '技术准确性' },
  { key: 'structure', label: '结构化表达' },
  { key: 'business', label: '业务成本视角' },
  { key: 'depth', label: '深度与实战感' },
]

type Phase = 'idle' | 'grading' | 'done' | 'error'

export default function InterviewPage() {
  const [selectedId, setSelectedId] = useState(QUESTIONS[0].id)
  const [answer, setAnswer] = useState('')
  const [interim, setInterim] = useState('')
  const [dictating, setDictating] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ score: ScoreResult; grade: Grade } | null>(null)
  const [showRef, setShowRef] = useState(false)
  const dictationRef = useRef<DictationSession | null>(null)
  const wantDictationRef = useRef(false)

  const settings = useSettings()
  const { attempts, addAttempt } = useHistory()

  const question = useMemo(() => QUESTIONS.find((q) => q.id === selectedId)!, [selectedId])
  const pastAttempts = attempts.filter((a) => a.questionId === selectedId)
  const bestGradeByQuestion = useMemo(() => {
    const map = new Map<string, Grade>()
    const rank: Grade[] = ['A', 'B', 'C', 'D']
    for (const a of attempts) {
      if (!a.grade) continue
      const prev = map.get(a.questionId)
      if (!prev || rank.indexOf(a.grade) < rank.indexOf(prev)) map.set(a.questionId, a.grade)
    }
    return map
  }, [attempts])

  function selectQuestion(id: string) {
    stopDictation()
    setSelectedId(id)
    setAnswer('')
    setInterim('')
    setPhase('idle')
    setResult(null)
    setError('')
    setShowRef(false)
  }

  function stopDictation() {
    wantDictationRef.current = false
    dictationRef.current?.stop()
    dictationRef.current = null
    setDictating(false)
    setInterim('')
  }

  // Chrome 静音数秒后会自动结束识别；只要用户没点停止就自动续录
  function launchDictation() {
    const session = startDictation(
      question.lang,
      (finalText, interimText) => {
        if (finalText) setAnswer((a) => a + finalText)
        setInterim(interimText)
      },
      (err) => {
        setInterim('')
        if (err) {
          wantDictationRef.current = false
          setDictating(false)
          setError(err)
        } else if (wantDictationRef.current) {
          launchDictation()
        } else {
          setDictating(false)
        }
      },
    )
    if (session) dictationRef.current = session
  }

  function toggleDictation() {
    if (dictating) {
      stopDictation()
      return
    }
    wantDictationRef.current = true
    setDictating(true)
    setError('')
    launchDictation()
  }

  async function grade() {
    stopDictation()
    if (!answer.trim()) return
    setPhase('grading')
    setError('')
    setResult(null)
    try {
      const messages = buildGradingMessages(question, answer)
      const score = await gradeWithRetry(messages)
      const grade = toGrade(weightedScore(score))
      setResult({ score, grade })
      setPhase('done')
      addAttempt({
        id: `${Date.now()}`,
        questionId: question.id,
        answer,
        score,
        grade,
        createdAt: Date.now(),
      })
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function gradeWithRetry(messages: ChatMessage[]): Promise<ScoreResult> {
    const call = () =>
      chatComplete({
        provider: settings.provider,
        model: settings.model,
        userKey: settings.userKey || undefined,
        messages,
        wantJson: true,
      })
    const first = await call()
    try {
      return parseScoreJson(first)
    } catch {
      // JSON 解析失败重试一次：把上次输出与纠正指令追加进上下文
      const retry = await chatComplete({
        provider: settings.provider,
        model: settings.model,
        userKey: settings.userKey || undefined,
        messages: [
          ...messages,
          { role: 'assistant', content: first },
          { role: 'user', content: '你的输出不是合法 JSON。请只输出一个合法 JSON 对象，字段与格式要求同前，不要任何其他文字。' },
        ],
        wantJson: true,
      })
      return parseScoreJson(retry)
    }
  }

  return (
    <div>
      <MasteryDashboard />
      <div className="flex gap-6">
        {/* 左侧题目列表 */}
      <aside className="w-80 shrink-0 space-y-4">
        {QUESTIONS_BY_CATEGORY.map((g) => (
          <div key={g.category}>
            <div className="mb-1 px-1 text-xs font-semibold tracking-wide text-dim">{g.label}</div>
            <div className="space-y-1">
              {g.questions.map((q) => {
                const best = bestGradeByQuestion.get(q.id)
                return (
                  <button
                    key={q.id}
                    onClick={() => selectQuestion(q.id)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
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
      </aside>

      {/* 右侧答题区 */}
      <section className="min-w-0 flex-1 space-y-4">
        <div className="rounded-xl border border-line bg-panel p-5">
          <div className="mb-2 flex items-center gap-2 text-xs text-dim">
            <span className="rounded bg-panel-2 px-2 py-0.5">{CATEGORY_LABELS[question.category]}</span>
            {question.lang === 'en' && <span className="rounded bg-accent-2/20 px-2 py-0.5 text-accent-2">英文题</span>}
          </div>
          <p className="text-lg leading-relaxed font-medium">{question.prompt}</p>
          {question.followUp && <p className="mt-2 text-sm text-dim">追问：{question.followUp}</p>}
        </div>

        <div className="rounded-xl border border-line bg-panel p-5">
          <textarea
            value={answer + (interim ? ` ${interim}` : '')}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={question.lang === 'en' ? 'Answer in English (or Chinese)…' : '口述或输入你的回答…'}
            rows={8}
            className="w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm leading-relaxed"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={toggleDictation}
              disabled={!isSpeechSupported()}
              title={isSpeechSupported() ? '' : '当前浏览器不支持语音识别（请用 Chrome）'}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 ${
                dictating ? 'bg-bad/20 text-bad' : 'bg-panel-2 text-white hover:bg-line'
              }`}
            >
              {dictating ? '■ 停止录音' : `🎙 语音回答（${question.lang === 'en' ? 'en-US' : 'zh-CN'}）`}
            </button>
            <button
              onClick={grade}
              disabled={phase === 'grading' || !answer.trim()}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-40"
            >
              {phase === 'grading' ? '评分中…' : '提交评分'}
            </button>
            <button onClick={() => setShowRef((v) => !v)} className="text-sm text-dim hover:text-white">
              {showRef ? '隐藏参考要点' : '查看参考要点'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-bad">{error}</p>}
        </div>

        {showRef && (
          <div className="rounded-xl border border-line bg-panel p-5 text-sm leading-relaxed">
            <h3 className="mb-2 font-semibold text-warn">参考要点（先自己答，再看）</h3>
            <div className="mb-3">
              <div className="mb-1 text-xs text-dim">必须覆盖</div>
              <ul className="list-inside list-disc space-y-1">
                {question.mustCover.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <div className="mb-3">
              <div className="mb-1 text-xs text-dim">加分项</div>
              <ul className="list-inside list-disc space-y-1 text-dim">
                {question.niceToHave.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <p className="border-t border-line pt-3 text-dim">{question.referenceNotes}</p>
          </div>
        )}

        {result && (
          <div className="rounded-xl border border-line bg-panel p-5">
            <div className="mb-4 flex items-center gap-4">
              <span className={`rounded-lg px-4 py-2 text-2xl font-bold ${GRADE_STYLE[result.grade]}`}>
                {result.grade}
              </span>
              <span className="text-sm text-dim">
                加权总分 {weightedScore(result.score).toFixed(1)} / 10（A≥8.0，B≥6.5，C≥5.0）
              </span>
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {DIMENSIONS.map((d) => (
                <div key={d.key} className="rounded-lg bg-panel-2 p-3">
                  <div className="text-xs text-dim">{d.label}</div>
                  <div className="text-xl font-bold">{result.score[d.key]}</div>
                  <div className="mt-1 h-1.5 rounded bg-line">
                    <div
                      className="h-1.5 rounded bg-accent"
                      style={{ width: `${result.score[d.key] * 10}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {result.score.comments.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs text-dim">面试官点评</div>
                <ul className="list-inside list-disc space-y-1 text-sm leading-relaxed">
                  {result.score.comments.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.score.missed.length > 0 && (
              <div>
                <div className="mb-1 text-xs text-warn">遗漏要点</div>
                <ul className="list-inside list-disc space-y-1 text-sm text-warn/90">
                  {result.score.missed.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {pastAttempts.length > 0 && (
          <div className="rounded-xl border border-line bg-panel p-5">
            <h3 className="mb-2 text-sm font-semibold text-dim">本题历史（{pastAttempts.length} 次）</h3>
            <div className="space-y-2">
              {pastAttempts.slice(0, 5).map((a) => (
                <div key={a.id} className="flex items-center gap-3 rounded-lg bg-panel-2 px-3 py-2 text-sm">
                  {a.grade && <span className={`rounded px-1.5 font-bold ${GRADE_STYLE[a.grade]}`}>{a.grade}</span>}
                  <span className="flex-1 truncate text-dim">{a.answer}</span>
                  <span className="text-xs text-dim">{new Date(a.createdAt).toLocaleString('zh-CN')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      </div>
    </div>
  )
}
