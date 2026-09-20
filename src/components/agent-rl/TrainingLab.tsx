import { useEffect, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ALGORITHM_INFO, PRESETS } from '../../data/agentRl'
import {
  ACTIONS,
  ACTION_LABELS,
  DEFAULT_CONFIG,
  KIND_LABELS,
  describeObservation,
  probabilities,
} from '../../lib/agentRl/engine'
import type { Algorithm, ExperimentConfig, RewardMode } from '../../lib/agentRl/types'
import { StageDetail } from './LifecycleMap'
import { useRlStore } from './rlStore'
import { Button, Card, Formula, Metric, Note, NumberField, decimal, fieldClass, percent } from './primitives'

const PHASES = ['采样轨迹', '计算奖励', '估计优势', '更新参数', '保存快照', '同步并验证']
export function TrainingControls() {
  const s = useRlStore()
  const done = s.round >= s.config.rounds
  const stale = s.phase === 0 && s.sampler.version !== s.learner.version
  useEffect(() => {
    if (!s.playing) return
    const timer = setTimeout(s.advance, 90)
    return () => clearTimeout(timer)
  }, [s.playing, s.phase, s.round, s.advance])
  useEffect(() => () => useRlStore.getState().setPlaying(false), [])
  return (
    <Card title="每一轮都经过六个真实计算步骤" kicker={`实验进度 ${s.round} / ${s.config.rounds}`}>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {PHASES.map((label, i) => (
          <div
            key={label}
            className={`rounded-lg border px-3 py-3 text-xs ${!done && i === s.phase ? 'border-accent bg-accent/10 font-bold text-accent' : 'border-line bg-panel-2 text-dim'}`}
          >
            <span className="mb-1 block font-mono text-[10px]">0{i + 1}</span>
            {label}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button primary disabled={done || stale || s.playing} onClick={s.advance}>
          {done ? '训练已完成' : `下一步：${PHASES[s.phase]}`}
        </Button>
        <Button disabled={done || stale} onClick={() => s.setPlaying(!s.playing)}>
          {s.playing ? '暂停训练' : '自动运行'}
        </Button>
        <Button onClick={s.reset}>重置实验</Button>
        <span aria-live="polite" className="text-xs text-dim">
          {s.playing ? '计算中 · 可随时暂停' : done ? '可以进入独立评测与发布' : '暂停态 · 可检查当前轨迹'}
        </span>
      </div>
      {stale && (
        <div className="mt-3">
          <Note warn>
            Trainer 已是 v{s.learner.version}，采样器仍是 v{s.sampler.version}。保存快照不会自动更新采样服务。
            <div className="mt-2">
              <Button onClick={s.syncSampler}>同步采样器到 v{s.learner.version}</Button>
            </div>
          </Note>
        </div>
      )}
      {s.error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {s.error}
        </p>
      )}
    </Card>
  )
}
export function LearningCharts() {
  const s = useRlStore()
  const latest = s.history.at(-1)
  const rows = [
    { round: 0, validation: (s.baseline.resolved / s.baseline.count) * 100, success: undefined, reward: undefined },
    ...s.history.map((r) => ({ ...r, success: r.success * 100, validation: r.validation * 100 })),
  ]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="本轮训练奖励"
          value={latest ? decimal(latest.reward, 2) : '—'}
          detail="实际评分 · 可被错误目标误导"
        />
        <Metric
          label="验证集真实解决率"
          value={percent(latest?.validation ?? s.baseline.resolved / s.baseline.count)}
          detail={`固定 ${s.baseline.count} 条 · 每轮同一口径`}
        />
        <Metric
          label="采样模型调用"
          value={s.trainingUsage.modelCalls.toLocaleString()}
          detail="小型环境内的真实动作决策次数"
        />
        <Metric
          label="裁剪生效比例"
          value={latest ? percent(latest.clipped) : '—'}
          detail={s.config.algorithm === 'reinforce' ? 'REINFORCE 不使用裁剪' : '所有更新遍历中的动作比例'}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="独立验证：任务是否真的解决？">
          <div className="h-60 min-w-0" role="img" aria-label="训练和验证真实解决率曲线">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e3ded1" />
                <XAxis dataKey="round" tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  name="验证成功率 %"
                  dataKey="validation"
                  stroke="#9e2b3a"
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  name="本轮训练成功率 %"
                  dataKey="success"
                  stroke="#6d28d9"
                  strokeDasharray="4 4"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-dim">横轴：已完成训练轮数。验证集参与选版，最终测试集另外保留。</p>
        </Card>
        <Card title="训练目标：Reward 如何变化？">
          <div className="h-60 min-w-0" role="img" aria-label="实际训练奖励曲线">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e3ded1" />
                <XAxis dataKey="round" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  name="训练奖励均值"
                  dataKey="reward"
                  stroke="#166534"
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-dim">奖励分与成功率不共用纵轴。曲线来自实际采样和梯度计算，不保证逐轮上升。</p>
        </Card>
      </div>
      {s.history.length > 0 && (
        <details className="rounded-xl border border-line bg-panel p-4">
          <summary className="cursor-pointer text-sm">查看可访问的数据表 · 每轮指标</summary>
          <div className="mt-3 max-h-64 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  {['轮数', '奖励', '训练成功', '验证成功', 'KL', '裁剪'].map((x) => (
                    <th className="p-2" key={x}>
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.history.map((r) => (
                  <tr className="border-t border-line" key={r.round}>
                    <td className="p-2">{r.round}</td>
                    <td>{decimal(r.reward)}</td>
                    <td>{percent(r.success)}</td>
                    <td>{percent(r.validation)}</td>
                    <td>{decimal(r.kl)}</td>
                    <td>{percent(r.clipped)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
function TrajectoryInspector() {
  const s = useRlStore()
  const t = s.batch[s.selectedTrajectory]
  const [replaying, setReplaying] = useState(false)
  const step = t?.steps[s.selectedStep]
  useEffect(() => {
    if (!replaying || !t) return
    if (s.selectedStep >= t.steps.length - 1) {
      setReplaying(false)
      return
    }
    const timer = setTimeout(() => s.selectStep(s.selectedStep + 1), 650)
    return () => clearTimeout(timer)
  }, [replaying, s.selectedStep, s.selectStep, t])
  useEffect(() => {
    setReplaying(false)
  }, [s.selectedTrajectory, s.round, s.phase])
  if (!t || !step)
    return (
      <Card title="从一条真实采样轨迹开始">
        <div className="rounded-xl border border-dashed border-accent/30 p-8 text-center">
          <p className="text-3xl" aria-hidden="true">
            ↳
          </p>
          <p className="mt-2 text-sm font-medium">点击「下一步：采样轨迹」</p>
          <p className="mt-2 text-xs text-dim">观察模型如何在 6 个动作之间选择。此时不会更新参数。</p>
        </div>
      </Card>
    )
  const scored = t.parts.length > 0
  const advantageReady = s.phase >= 3 || s.pending !== null
  const after = s.pending ? probabilities(s.pending.policy, step.state) : null
  const actionIndex = ACTIONS.indexOf(step.action)
  return (
    <Card title="打开一条轨迹，看清一次决策" kicker={`Trajectory / 来自采样策略 v${t.policyVersion}`}>
      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="space-y-3">
          <label className="block text-xs text-dim">
            选择工单轨迹
            <select
              className={fieldClass}
              value={s.selectedTrajectory}
              onChange={(e) => s.selectTrajectory(+e.target.value)}
            >
              {s.batch.map((tr, i) => (
                <option key={tr.id} value={i}>
                  {i + 1}. {tr.ticket.id} · {KIND_LABELS[tr.ticket.kind]} · {tr.outcome.resolved ? '成功' : '未解决'}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-xl bg-panel-2 p-3 text-xs leading-relaxed">
            <p className="font-semibold">客户请求：请帮我处理订单退款。</p>
            <p className="mt-2">
              任务 {t.ticket.id} · {t.steps.length} 步
            </p>
            <p>
              结束状态：
              {t.outcome.resolved
                ? '正确解决'
                : t.outcome.closed
                  ? '虚假结单'
                  : t.outcome.escalated
                    ? '转人工'
                    : '达到步数上限'}
            </p>
            <p className="mt-2 text-dim">案例类别与真值供学习者复盘，Policy 只读取右侧观察。</p>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {t.steps.map((st, i) => (
              <button
                key={i}
                type="button"
                aria-pressed={i === s.selectedStep}
                onClick={() => {
                  setReplaying(false)
                  s.selectStep(i)
                }}
                className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-xs ${i === s.selectedStep ? 'bg-accent text-white' : 'bg-panel-2'}`}
              >
                <span className="font-mono opacity-60">{String(i + 1).padStart(2, '0')}</span>
                {ACTION_LABELS[st.action]}
              </button>
            ))}
          </div>
          <Button
            onClick={() => {
              if (s.selectedStep === t.steps.length - 1) s.selectStep(0)
              setReplaying(!replaying)
            }}
          >
            {replaying ? '暂停回放' : '回放这条轨迹'}
          </Button>
        </div>
        <div className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-accent-2/20 bg-accent-2/5 p-4">
              <p className="mb-2 text-xs font-semibold text-accent-2">01 / 模型可见的观察</p>
              <p className="text-sm leading-relaxed">{describeObservation(step.observation)}</p>
            </div>
            <div className="rounded-xl border border-accent/20 bg-accent/5 p-4">
              <p className="mb-2 text-xs font-semibold text-accent">02 / 提议动作 → Harness 执行</p>
              <p className="text-sm font-semibold">{ACTION_LABELS[step.action]}</p>
              <p className="mt-2 text-sm leading-relaxed">{step.result}</p>
            </div>
          </div>
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">03 / 动作概率如何改变？</h4>
              <p className="text-xs text-dim">紫色：采样时 · 酒红：更新后</p>
            </div>
            <div className="space-y-2">
              {ACTIONS.map((action, i) => (
                <div key={action} className="grid grid-cols-[72px_minmax(0,1fr)_100px] items-center gap-2 text-xs">
                  <span className={action === step.action ? 'font-bold text-accent' : ''}>
                    {ACTION_LABELS[action]}
                    {action === step.action ? ' •' : ''}
                  </span>
                  <div className="space-y-1">
                    <div className="h-2 overflow-hidden rounded bg-panel-2">
                      <div
                        className="h-full rounded bg-accent-2/70"
                        style={{ width: percent(step.probabilities[i]) }}
                      />
                    </div>
                    <div className="h-2 overflow-hidden rounded bg-panel-2">
                      <div className="h-full rounded bg-accent" style={{ width: after ? percent(after[i]) : '0%' }} />
                    </div>
                  </div>
                  <span className="text-right font-mono text-[10px]">
                    {percent(step.probabilities[i])} → {after ? percent(after[i]) : '待更新'}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="采样 logprob" value={decimal(step.logprob)} />
            <Metric label="整条轨迹 Reward" value={scored ? decimal(t.reward, 2) : '待评分'} />
            <Metric label="当前动作 Advantage" value={advantageReady ? decimal(step.advantage) : '待估计'} />
            <Metric label="当前 Critic 预测" value={s.config.algorithm === 'ppo' ? decimal(step.value) : '不使用'} />
          </div>
          {after && (
            <Note>
              本步选中「{ACTION_LABELS[step.action]}」，概率由 {percent(step.probabilities[actionIndex])} 变为{' '}
              {percent(after[actionIndex])}。这次更新聚合了本批所有轨迹；单条轨迹的优势不能独自解释最终变化。
            </Note>
          )}
          {scored && (
            <div className="rounded-xl bg-panel-2 p-4">
              <h4 className="mb-2 text-sm font-semibold">04 / 奖励分解</h4>
              {t.parts.map((p) => (
                <div key={p.label} className="flex justify-between gap-2 py-1 text-xs">
                  <span>{p.label}</span>
                  <span className="font-mono">{decimal(p.value, 2)}</span>
                </div>
              ))}
              <p className="mt-2 text-xs text-dim">
                本实验使用终局奖励：总分在最后一步给出，算法将信用传回前面的动作。
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
export default function TrainingLab() {
  const s = useRlStore()
  const preset = PRESETS.find((p) => p.id === s.preset)
  return (
    <div className="space-y-5">
      <Note>
        {preset ? (
          <>
            <strong>{preset.title}：</strong>
            {preset.lesson}
          </>
        ) : (
          '自定义实验：修改配置会开始新的实验，曲线不会混入旧配置。'
        )}
      </Note>
      <TrainingControls />
      <LearningCharts />
      <TrajectoryInspector />
      <StageDetail />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => s.setView('lab')}>调整算法与奖励 →</Button>
        <Button primary onClick={() => s.setView('evaluate')}>
          检查独立评测与发布 →
        </Button>
      </div>
    </div>
  )
}
export function AlgorithmLab() {
  const s = useRlStore()
  const c = s.config
  const info = ALGORITHM_INFO[c.algorithm]
  const input = (label: string, key: keyof ExperimentConfig, min: number, max: number, step = 1) => (
    <NumberField
      label={label}
      value={c[key] as number}
      min={min}
      max={max}
      step={step}
      onChange={(v) => s.configure({ [key]: v })}
    />
  )
  return (
    <div className="space-y-5">
      <Card title="六个实验，把容易混淆的地方亲手试一次" kicker="Experiment recipes">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => s.applyPreset(p.id)}
              className={`rounded-xl border p-4 text-left ${s.preset === p.id ? 'border-accent bg-accent/5' : 'border-line hover:bg-panel-2'}`}
            >
              <h4 className="text-sm font-semibold">
                {p.title} <span aria-hidden="true">↗</span>
              </h4>
              <p className="mt-2 text-xs leading-relaxed text-dim">{p.lesson}</p>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-dim">选择配方会建立新实验。可先保存当前结果到下方对照表，再试另一种配置。</p>
      </Card>
      <Card title="选择如何更新策略" kicker="Algorithm">
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(ALGORITHM_INFO).map(([id, meta]) => (
            <Button key={id} primary={c.algorithm === id} onClick={() => s.configure({ algorithm: id as Algorithm })}>
              {meta.name}
            </Button>
          ))}
        </div>
        <p className="mb-4 text-sm leading-relaxed">{info.plain}</p>
        <Formula formula={info.formula} />
        <div className="my-4 grid gap-3 md:grid-cols-2">
          <Note>{info.resources}</Note>
          <p className="text-xs leading-relaxed text-dim">
            {info.limits}
            <a href={info.url} target="_blank" rel="noreferrer" className="ml-1 text-accent underline">
              算法资料 ↗
            </a>
          </p>
        </div>
        <p className="text-xs leading-relaxed text-dim">
          η 是学习率；G 是未来回报；b 是历史基线；A 是优势；r 是当前/采样策略的动作概率比；ε 是裁剪宽度。GRPO 的 β
          控制偏离 Reference 的惩罚。这里的小动作空间直接求导，不训练真实 LLM。
        </p>
      </Card>
      <Card title="奖励要奖励真正的任务成功" kicker="Reward engineering">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-dim">
            奖励目标
            <select
              className={fieldClass}
              value={c.rewardMode}
              onChange={(e) => s.configure({ rewardMode: e.target.value as RewardMode })}
            >
              <option value="verified">真实解决 + 违规/步骤惩罚</option>
              <option value="closed">只奖励结单（错误示例）</option>
              <option value="flat">所有轨迹同分</option>
            </select>
          </label>
          {input('成功 / 结单奖励', 'successWeight', 0, 10, 0.5)}
          {c.rewardMode === 'verified' && input('每次违规惩罚', 'violationPenalty', 0, 10, 0.1)}
          {c.rewardMode !== 'flat' && input('每步成本惩罚', 'stepPenalty', 0, 1, 0.01)}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          这些参数只影响训练目标。独立验收始终要求合法核验和正确结果，绝不随奖励权重改变。Harness
          仍会拒绝不合法退款，即使你关闭违规惩罚。
        </p>
      </Card>
      <Card title="控制实验规模与更新方式" kicker="配置变化会重开实验">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {input('随机种子', 'seed', 1, 2147483647)}
          {input('训练轮数', 'rounds', 1, 100)}
          {input('每轮任务数', 'batchSize', 1, 16)}
          {input('每个任务的 Rollout 数', 'groupSize', 2, 16)}
          {input('每条轨迹最多步骤', 'maxSteps', 2, 16)}
          {input('学习率 η', 'learningRate', 0.01, 2, 0.01)}
          {input('训练工具故障率', 'failureRate', 0, 1, 0.05)}
          {c.algorithm !== 'grpo' && input('折扣 γ', 'gamma', 0, 1, 0.01)}
          {c.algorithm === 'ppo' && input('GAE λ', 'lambda', 0, 1, 0.01)}
          {c.algorithm !== 'reinforce' && input('每批更新次数', 'epochs', 1, 8)}
          {c.algorithm !== 'reinforce' && input('裁剪 ε', 'clip', 0.01, 0.5, 0.01)}
          {c.algorithm === 'grpo' && input('Reference KL β', 'kl', 0, 1, 0.01)}
        </div>
        <label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={c.autoSync} onChange={(e) => s.configure({ autoSync: e.target.checked })} />
          每轮完成后同步采样权重
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button primary onClick={() => s.setView('train')}>
            用当前配置开始跟练 →
          </Button>
          <Button onClick={() => s.configure(DEFAULT_CONFIG)}>恢复默认配置</Button>
        </div>
      </Card>
      <LearningCharts />
      <ExperimentComparisons />
    </div>
  )
}
function ExperimentComparisons() {
  const s = useRlStore()
  return (
    <Card title="保留结果，比较另一种配置">
      <Button disabled={!s.history.length} onClick={s.rememberRun}>
        保留本次结果到对照表
      </Button>
      <p className="my-3 text-xs text-dim">
        最多保存 3 次结果，仅在当前浏览器会话内保留。不同超参数、预算和种子不能用于宣称算法普遍优劣。
      </p>
      {s.comparisons.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {['算法 / 奖励', '种子 / 组大小', '轮数', '奖励', '验证成功', '采样调用'].map((x) => (
                  <th className="p-2" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.comparisons.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="p-2">
                    {ALGORITHM_INFO[r.config.algorithm].name} / {r.config.rewardMode}
                  </td>
                  <td>
                    {r.config.seed} / {r.config.groupSize}
                  </td>
                  <td>{r.round.round}</td>
                  <td>{decimal(r.round.reward, 2)}</td>
                  <td>{percent(r.round.validation)}</td>
                  <td>{r.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
