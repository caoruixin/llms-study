import { useState } from 'react'
import { DATA_EXAMPLES, ENGINEERING, METHODS, QUIZ, REWARD_SOURCES, RL_STAGES, ROLES } from '../../data/agentRl'
import { dataset } from '../../lib/agentRl/engine'
import { useRlStore } from './rlStore'
import { Button, Card, Note } from './primitives'

export function StageDetail() {
  const id = useRlStore((s) => s.stage)
  const stage = RL_STAGES.find((s) => s.id === id) ?? RL_STAGES[0]
  return (
    <Card title={stage.title} kicker="当前环节 · 技术 × 服务">
      <p className="mb-4 text-sm leading-relaxed text-dim">{stage.why}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-xl bg-panel-2 p-4 text-sm">
          <h4 className="font-semibold text-accent-2">工程视角</h4>
          <Detail label="输入" text={stage.input} />
          <Detail label="产出" text={stage.output} />
          <Detail label="资源" text={stage.resources} />
          <Detail label="验收" text={stage.acceptance} />
        </div>
        <div className="space-y-3 rounded-xl border border-accent/20 bg-accent/5 p-4 text-sm">
          <h4 className="font-semibold text-accent">Token Provider 视角</h4>
          <Detail label="客户负责" text={stage.customer} />
          <Detail label="可提供" text={stage.service} />
          <Detail label="交付形式" text={stage.form} />
          <Detail label="计量方式" text={stage.meter} />
        </div>
      </div>
    </Card>
  )
}
function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <span className="mb-0.5 block text-[11px] font-medium text-dim">{label}</span>
      <p className="leading-relaxed">{text}</p>
    </div>
  )
}
export default function LifecycleMap() {
  const s = useRlStore()
  const [example, setExample] = useState(0)
  const [answers, setAnswers] = useState<Record<number, number>>({})
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        {[
          ['一次 Agent 执行', '观察 → 提议动作 → 工具执行 → 新观察', '跑完一条轨迹，没有自动学习。'],
          ['一次 RL 训练迭代', '多条轨迹 → 奖励 → 优势 → 更新 → 同步', '改变下一轮选择动作的概率。'],
          ['一次产品升级', '多轮训练 → 独立评测 → 发布 → 反馈', '让新模型进入真实 Agent 系统。'],
        ].map(([title, flow, text], i) => (
          <Card key={title} title={title} kicker={`循环 0${i + 1}`}>
            <p className="text-sm font-medium leading-relaxed">{flow}</p>
            <p className="mt-2 text-xs text-dim">{text}</p>
          </Card>
        ))}
      </div>
      <Card title="从业务目标走到下一轮改进" kicker="Lifecycle / 点击任一环节">
        <div className="grid gap-4 lg:grid-cols-4">
          {['准备', '训练循环', '验收与发布', '持续改进'].map((group, i) => (
            <div key={group} className="min-w-0">
              <h4 className="mb-2 text-xs font-semibold text-dim">
                0{i + 1} / {group}
              </h4>
              <div className="space-y-2">
                {RL_STAGES.filter((st) => st.group === group).map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    aria-pressed={s.stage === st.id}
                    onClick={() => s.setStage(st.id)}
                    className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm ${s.stage === st.id ? 'border-accent bg-accent text-white' : 'border-line bg-panel-2 hover:border-accent/40'}`}
                  >
                    <span>{st.title}</span>
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
              {group === '训练循环' && <p className="mt-2 text-xs text-accent">↻ 同步后回到采样，直到训练预算结束</p>}
              {group === '持续改进' && <p className="mt-2 text-xs text-accent">↩ 新失败回到数据、环境或方法选择</p>}
            </div>
          ))}
        </div>
      </Card>
      <StageDetail />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent/10 p-4">
        <p className="text-sm">流程看过一遍，带着一个工单进入真实参数实验。</p>
        <Button
          primary
          onClick={() => {
            s.setView('train')
            s.setStage('rollout')
          }}
        >
          开始跟练 →
        </Button>
      </div>
      <Card title="先诊断，再选择干预方法" kicker="不是必经的升级阶梯">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {METHODS.map(([problem, method, purpose]) => (
            <div key={method} className="rounded-lg bg-panel-2 p-3">
              <p className="text-xs text-dim">{problem}</p>
              <h4 className="my-1 font-semibold text-accent">{method}</h4>
              <p className="text-sm leading-relaxed">{purpose}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card title="把日志整理成不同用途的数据" kicker="Data workshop">
        <p className="mb-3 text-sm text-dim">
          采集 → 去重脱敏 → 结果复核 → 按家族分区 → 版本冻结。例子都是合成数据，不涉及真实客户。
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          {DATA_EXAMPLES.map((d, i) => (
            <Button key={d.title} primary={i === example} onClick={() => setExample(i)}>
              {d.title}
            </Button>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="font-semibold">{DATA_EXAMPLES[example].title}</h4>
            <p className="my-3 text-sm leading-relaxed text-dim">{DATA_EXAMPLES[example].purpose}</p>
            <div className="flex flex-wrap gap-2">
              {(['train', 'validation', 'test'] as const).map((split, i) => (
                <span key={split} className="rounded-lg border border-line px-3 py-2 text-xs">
                  {['训练', '验证', '测试'][i]} {dataset(split).length} 条
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-dim">
              工单 ID 与家族完全隔离，但共享客服任务类型。它检验小型策略，不证明真实语言模型的泛化。
            </p>
          </div>
          <pre className="max-h-80 overflow-auto rounded-xl bg-panel-2 p-4 text-xs leading-relaxed">
            {JSON.stringify(DATA_EXAMPLES[example].example, null, 2)}
          </pre>
        </div>
      </Card>
      <Card title="哪些是模型，哪些是算法？" kicker="角色与资源">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {ROLES.map(([name, tag, body]) => (
            <div key={name} className="rounded-xl border border-line p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <h4 className="font-semibold">{name}</h4>
                <span className="rounded bg-accent-2/10 px-2 py-0.5 text-[11px] text-accent-2">{tag}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-dim">{body}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card title="奖励信号必要，独立 Reward Model 按需">
        <div className="grid gap-3 md:grid-cols-2">
          {REWARD_SOURCES.map(([name, source, cost]) => (
            <div key={name} className="rounded-xl bg-panel-2 p-4">
              <h4 className="font-semibold">{name}</h4>
              <p className="my-2 text-sm">{source}</p>
              <p className="text-xs leading-relaxed text-dim">{cost}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-dim">
          奖励来源与优化算法是两条独立选择轴。换成 Judge 或 RM
          的资源成本可在「服务与成本」中推演；本地实验始终用可检查的规则评分。
        </p>
      </Card>
      <Card title="从小型策略实验对应到真实 Agent RL">
        <div className="divide-y divide-line">
          {ENGINEERING.map((item) => (
            <details key={item.title} className="py-3">
              <summary className="cursor-pointer text-sm font-medium">{item.title}</summary>
              <p className="mt-3 text-sm leading-relaxed text-dim">{item.text}</p>
            </details>
          ))}
        </div>
      </Card>
      <Card title="用六个判断检查自己是否理解" kicker={`已掌握 ${s.completed.length} / 6`}>
        <div className="grid gap-4 md:grid-cols-2">
          {QUIZ.map((q, i) => (
            <div key={q.question} className="rounded-xl border border-line p-4">
              <p className="text-sm font-semibold">
                {i + 1}. {q.question}
              </p>
              <div className="my-3 space-y-2">
                {q.options.map((option, j) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setAnswers((a) => ({ ...a, [i]: j }))
                      if (j === q.answer) s.markCompleted(i)
                    }}
                    className={`min-h-11 w-full rounded-lg border px-3 py-2 text-left text-xs ${answers[i] === j ? 'border-accent bg-accent/5' : 'border-line'}`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              {answers[i] !== undefined && (
                <Note warn={answers[i] !== q.answer}>
                  {answers[i] === q.answer ? '正确。' : '再想一步。'}
                  {q.explanation}
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => {
                      s.setStage(q.stage)
                      window.scrollTo({ top: 300, behavior: 'smooth' })
                    }}
                  >
                    回看环节
                  </button>
                </Note>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
