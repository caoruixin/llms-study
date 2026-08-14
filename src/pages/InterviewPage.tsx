import { useEffect, useMemo, useRef, useState } from 'react'
import { CATEGORY_LABELS, QUESTIONS, QUESTIONS_BY_CATEGORY } from '../data/questions'
import type { Grade, ScoreResult } from '../data/types'
import { chatComplete } from '../lib/llmClient'
import type { ChatMessage } from '../lib/llmClient'
import { buildGradingMessages, parseScoreJson, toGrade, weightedScore } from '../lib/grading'
import { isSpeechSupported, startDictation } from '../lib/speech'
import type { DictationSession } from '../lib/speech'
import { newAttemptId, useHistory, useSettings } from '../store'
import MasteryDashboard from '../components/MasteryDashboard'
import Drawer from '../components/ui/Drawer'
import QuestionList, { GRADE_STYLE } from '../components/interview/QuestionList'
import { MQ, useMediaQuery } from '../lib/useMediaQuery'

const DIMENSIONS: { key: keyof Pick<ScoreResult, 'accuracy' | 'structure' | 'business' | 'depth'>; label: string }[] = [
  { key: 'accuracy', label: '技术准确性' },
  { key: 'structure', label: '结构化表达' },
  { key: 'business', label: '业务成本视角' },
  { key: 'depth', label: '深度与实战感' },
]

type Phase = 'idle' | 'grading' | 'done' | 'error'

// 三个删除动作（清空全部/清空本题/删单条）共用一个待确认目标：同一时刻只有一个按钮处于确认态
type ConfirmTarget = { kind: 'all' } | { kind: 'question' } | { kind: 'one'; id: string }

export default function InterviewPage() {
  const [selectedId, setSelectedId] = useState(QUESTIONS[0].id)
  const [answer, setAnswer] = useState('')
  const [interim, setInterim] = useState('')
  const [dictating, setDictating] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ score: ScoreResult; grade: Grade } | null>(null)
  const [showRef, setShowRef] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isDesktop = useMediaQuery(MQ.lg)
  const dictationRef = useRef<DictationSession | null>(null)
  const wantDictationRef = useRef(false)
  const restartTimesRef = useRef<number[]>([]) // 自动续录的时间戳窗口，防止立即结束的浏览器无限重启

  const settings = useSettings()
  const { attempts, addAttempt, clear, clearQuestion, removeAttempt } = useHistory()

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
    setConfirmTarget(null)
    setShowAllHistory(false)
  }

  // iOS Safari 按钮 tap 不触发 focus，onBlur 复原不生效；补 document pointerdown 外点复原（保留 onBlur 路径）
  useEffect(() => {
    if (!confirmTarget) return
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-confirm]')) setConfirmTarget(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [confirmTarget])

  // 两段式确认：首次点击进入确认态，再点同一目标执行；点其他目标则切换确认态，onBlur 复原
  function confirmThen(target: ConfirmTarget, run: () => void) {
    const same =
      confirmTarget?.kind === target.kind &&
      (target.kind !== 'one' || (confirmTarget as { id?: string }).id === target.id)
    if (same) {
      run()
      setConfirmTarget(null)
    } else {
      setConfirmTarget(target)
    }
  }

  function stopDictation() {
    wantDictationRef.current = false
    dictationRef.current?.stop()
    dictationRef.current = null
    setDictating(false)
    setInterim('')
  }

  // Chrome 静音数秒后会自动结束识别；只要用户没点停止就自动续录。
  // 退避上限：短窗口内连续 3 次自动重启（识别刚启动就结束）视为异常，停止并提示，避免无限重启。
  const MAX_RESTARTS = 3
  const RESTART_WINDOW_MS = 5000
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
          const now = Date.now()
          restartTimesRef.current = restartTimesRef.current.filter((t) => now - t < RESTART_WINDOW_MS)
          if (restartTimesRef.current.length >= MAX_RESTARTS) {
            wantDictationRef.current = false
            setDictating(false)
            setError('语音识别反复中断，已自动停止；请检查麦克风权限后重试，或改用文本输入')
          } else {
            restartTimesRef.current.push(now)
            launchDictation()
          }
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
    restartTimesRef.current = []
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
        id: newAttemptId(),
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

  const currentBest = bestGradeByQuestion.get(selectedId)

  return (
    <div>
      <MasteryDashboard />

      {/* <lg 当前题切换条：☰ 开题库抽屉 + 当前题干 + 最佳等级 */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="mb-4 flex min-h-12 w-full items-center gap-2 rounded-xl border border-line bg-panel px-4 text-left lg:hidden"
      >
        <span className="shrink-0 text-sm text-dim">☰ 题库</span>
        <span className="min-w-0 flex-1 truncate text-sm">{question.prompt}</span>
        {currentBest && (
          <span className={`shrink-0 rounded px-1.5 text-xs font-bold ${GRADE_STYLE[currentBest]}`}>{currentBest}</span>
        )}
      </button>

      <div className="flex gap-6">
        {/* 左侧题目列表（lg+ 常驻；<lg 收进 Drawer） */}
      <aside className="hidden lg:block w-80 shrink-0 space-y-4">
        <QuestionList
          groups={QUESTIONS_BY_CATEGORY}
          selectedId={selectedId}
          bestGradeByQuestion={bestGradeByQuestion}
          onSelect={selectQuestion}
        />
      </aside>

      {/* 右侧答题区 */}
      <section className="min-w-0 flex-1 space-y-4">
        <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
          <div className="mb-2 flex items-center gap-2 text-xs text-dim">
            <span className="rounded bg-panel-2 px-2 py-0.5">{CATEGORY_LABELS[question.category]}</span>
            {question.lang === 'en' && <span className="rounded bg-accent-2/20 px-2 py-0.5 text-accent-2">英文题</span>}
          </div>
          <p className="text-lg leading-relaxed font-medium">{question.prompt}</p>
          {question.followUp && <p className="mt-2 text-sm text-dim">追问：{question.followUp}</p>}
        </div>

        <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={question.lang === 'en' ? 'Answer in English (or Chinese)…' : '口述或输入你的回答…'}
            rows={8}
            className="w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm leading-relaxed"
          />
          {/* 语音识别的临时结果只读预览：确定后由 onText 追加进 answer，不直接进 textarea（避免编辑时把临时文本写死） */}
          {interim && (
            <p aria-live="polite" className="mt-1 rounded-lg border border-dashed border-line bg-panel-2 px-3 py-1.5 text-sm italic leading-relaxed text-dim">
              识别中…{interim}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={toggleDictation}
              disabled={!isSpeechSupported()}
              title={isSpeechSupported() ? '' : '当前浏览器不支持语音识别（请用 Chrome）'}
              className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 md:min-h-0 ${
                dictating ? 'bg-bad text-white' : 'border border-line bg-panel text-fg hover:bg-panel-2'
              }`}
            >
              {dictating ? '■ 停止录音' : `🎙 语音回答（${question.lang === 'en' ? 'en-US' : 'zh-CN'}）`}
            </button>
            <button
              onClick={grade}
              disabled={phase === 'grading' || !answer.trim()}
              className="min-h-11 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40 md:min-h-0"
            >
              {phase === 'grading' ? '评分中…' : '提交评分'}
            </button>
            <button onClick={() => setShowRef((v) => !v)} className="min-h-11 text-sm text-dim hover:text-fg md:min-h-0">
              {showRef ? '隐藏参考要点' : '查看参考要点'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-bad">{error}</p>}
        </div>

        {showRef && (
          <div className="rounded-xl border border-line bg-panel shadow-sm p-5 text-sm leading-relaxed">
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
            <div className="mb-3">
              <div className="mb-1 text-xs text-bad">红线（提及即扣分）</div>
              <ul className="list-inside list-disc space-y-1 text-bad/90">
                {question.redFlags.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <p className="whitespace-pre-line border-t border-line pt-3 text-dim">{question.referenceNotes}</p>
          </div>
        )}

        {result && (
          <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
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
            {result.score.highlights.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs text-ok">回答亮点</div>
                <ul className="list-inside list-disc space-y-1 text-sm leading-relaxed text-ok/90">
                  {result.score.highlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
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

        {attempts.length > 0 && (
          <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-dim">本题历史（{pastAttempts.length} 次）</h3>
              <div className="flex items-center gap-2">
                {pastAttempts.length > 0 && (
                  <button
                    data-confirm
                    onClick={() => confirmThen({ kind: 'question' }, () => clearQuestion(selectedId))}
                    onBlur={() => setConfirmTarget(null)}
                    className={`min-h-11 rounded-lg border px-3 text-xs transition-colors md:min-h-0 md:py-1 ${
                      confirmTarget?.kind === 'question'
                        ? 'border-bad/60 bg-bad/10 font-semibold text-bad'
                        : 'border-line bg-panel text-dim hover:text-bad'
                    }`}
                  >
                    {confirmTarget?.kind === 'question' ? '确认清空本题？' : '清空本题'}
                  </button>
                )}
                <button
                  data-confirm
                  onClick={() => confirmThen({ kind: 'all' }, clear)}
                  onBlur={() => setConfirmTarget(null)}
                  className={`min-h-11 rounded-lg border px-3 text-xs transition-colors md:min-h-0 md:py-1 ${
                    confirmTarget?.kind === 'all'
                      ? 'border-bad/60 bg-bad/10 font-semibold text-bad'
                      : 'border-line bg-panel text-dim hover:text-bad'
                  }`}
                >
                  {confirmTarget?.kind === 'all' ? '确认清空？（全部题目）' : '清空全部题目'}
                </button>
              </div>
            </div>
            {pastAttempts.length === 0 ? (
              <p className="rounded-lg bg-panel-2 px-3 py-2 text-sm text-dim">
                本题暂无历史记录（其他题目共 {attempts.length} 条）
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  {(showAllHistory ? pastAttempts : pastAttempts.slice(0, 5)).map((a) => (
                    <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-panel-2 px-3 py-2 text-sm">
                      {a.grade && <span className={`rounded px-1.5 font-bold ${GRADE_STYLE[a.grade]}`}>{a.grade}</span>}
                      <span className="flex-1 truncate text-dim">{a.answer}</span>
                      <span className="text-xs text-dim">{new Date(a.createdAt).toLocaleString('zh-CN')}</span>
                      <button
                        data-confirm
                        onClick={() => confirmThen({ kind: 'one', id: a.id }, () => removeAttempt(a.id))}
                        onBlur={() => setConfirmTarget(null)}
                        aria-label="删除本条记录"
                        className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center transition-colors md:min-h-0 md:min-w-0 ${
                          confirmTarget?.kind === 'one' && confirmTarget.id === a.id
                            ? 'rounded-full border border-bad/60 bg-bad/10 px-2 py-0.5 text-xs font-semibold text-bad'
                            : 'px-1 text-dim hover:text-bad'
                        }`}
                      >
                        {confirmTarget?.kind === 'one' && confirmTarget.id === a.id ? '确认删除？' : '✕'}
                      </button>
                    </div>
                  ))}
                </div>
                {pastAttempts.length > 5 && (
                  <button
                    onClick={() => setShowAllHistory((v) => !v)}
                    className="mt-2 min-h-11 text-xs text-dim transition-colors hover:text-fg md:min-h-0"
                  >
                    {showAllHistory ? '收起' : `展开全部 ${pastAttempts.length} 条`}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </section>
      </div>

      {!isDesktop && (
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="题库">
          <div className="h-full overflow-y-auto">
            <QuestionList
              groups={QUESTIONS_BY_CATEGORY}
              selectedId={selectedId}
              bestGradeByQuestion={bestGradeByQuestion}
              onSelect={(id) => {
                selectQuestion(id)
                setDrawerOpen(false)
              }}
            />
          </div>
        </Drawer>
      )}
    </div>
  )
}
