import { Link } from 'react-router-dom'
import { ALGORITHM_INFO, RL_TABS } from '../data/agentRl'
import SegmentedTabs from '../components/ui/SegmentedTabs'
import LifecycleMap from '../components/agent-rl/LifecycleMap'
import TrainingLab, { AlgorithmLab } from '../components/agent-rl/TrainingLab'
import EvaluationPanel from '../components/agent-rl/EvaluationPanel'
import ProviderPanel from '../components/agent-rl/ProviderPanel'
import { useRlStore } from '../components/agent-rl/rlStore'

export default function AgentRlPage() {
  const s = useRlStore()
  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-2xl bg-[#36232b] p-5 text-white sm:p-7">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-32 h-96 w-96 rounded-full border-[48px] border-white/[0.035]"
        />
        <div className="relative grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.22em] text-[#e8b7a9]">
              AGENT LEARNING LAB / 交互式学习实验室
            </p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Agent 如何从反馈中学会？</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/70">
              从一张客服工单出发，亲手走过采样、奖励、训练与发布。看清模型如何改变，也看清背后的资源与服务。
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-[10px]">
              <span className="rounded-full border border-white/20 px-2.5 py-1">真实策略参数更新</span>
              <span className="rounded-full border border-white/20 px-2.5 py-1">浏览器内运行 · 无需 Key</span>
              <span className="rounded-full border border-white/20 px-2.5 py-1">Token / GPU 成本为教学估算</span>
            </div>
          </div>
          <div className="flex flex-col justify-between rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-white/60">三个版本，三个不同角色</span>
              <span className="font-mono text-[#e8b7a9]">{ALGORITHM_INFO[s.config.algorithm].name}</span>
            </div>
            <div className="my-4 grid grid-cols-3 gap-3">
              {[
                ['训练中', s.learner.version],
                ['采样器', s.sampler.version],
                ['生产版', s.productionVersion],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-[11px] text-white/60">{label}</p>
                  <p className="mt-1 font-mono text-3xl">v{value}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[11px] text-white/60">
              <span>
                {s.round} / {s.config.rounds} 轮完成
              </span>
              <span>{s.completed.length} / 6 概念掌握</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-[#e8b7a9] transition-all"
                style={{ width: `${(s.round / s.config.rounds) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedTabs tabs={RL_TABS} value={s.view} onChange={s.setView} ariaLabel="Agent RL 学习视图" />
        <Link to="/agent" className="text-xs text-accent hover:underline">
          回看 Agent 架构 ↗
        </Link>
      </div>
      {s.view === 'map' && <LifecycleMap />}
      {s.view === 'train' && <TrainingLab />}
      {s.view === 'lab' && <AlgorithmLab />}
      {s.view === 'evaluate' && <EvaluationPanel />}
      {s.view === 'provider' && <ProviderPanel />}
      <p className="border-t border-line pt-4 text-[11px] leading-relaxed text-dim">
        教学边界：合成工单、离散观察、6 个固定动作和小型概率表；文本由模板呈现。这里验证 RL
        的计算与因果，不执行语言生成、真实退款或 GPU
        训练，不能把实验成功率与耗时外推为大模型表现。刷新后恢复配置与学习进度，轨迹和模型版本重新开始。
      </p>
    </div>
  )
}
