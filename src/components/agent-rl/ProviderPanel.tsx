import { PARTNERSHIPS, RL_STAGES, SOURCES } from '../../data/agentRl'
import { estimateCosts, tokenQuantities, type PriceConfig } from '../../lib/agentRl/economics'
import type { Partnership } from '../../lib/agentRl/types'
import { StageDetail } from './LifecycleMap'
import { useRlStore } from './rlStore'
import { Button, Card, Metric, Note, NumberField, dollars, fieldClass } from './primitives'

export default function ProviderPanel() {
  const s = useRlStore()
  const p = s.prices
  const partner = PARTNERSHIPS[p.partnership]
  const cost = estimateCosts(s.trainingUsage, s.evaluationUsage, s.productionUsage, p)
  const quantities = tokenQuantities(s.trainingUsage, p)
  const field = (label: string, key: keyof PriceConfig, step = 1, max = 1e7) => (
    <NumberField
      label={label}
      value={p[key] as number}
      step={step}
      max={max}
      onChange={(v) => s.setPrices({ [key]: v })}
    />
  )
  return (
    <div className="space-y-5">
      <Card title="从生产 Token 到模型持续改进" kicker="Provider opportunity map">
        <p className="mb-4 text-sm leading-relaxed text-dim">
          沿生命周期识别服务机会。业务目标与最终发布决策属于客户；计算平台的交付范围随合作方式变化。下方责任划分是教学方案，不代表所有厂商都提供这些产品。
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
          {RL_STAGES.map((st) => (
            <button
              type="button"
              key={st.id}
              aria-pressed={s.stage === st.id}
              onClick={() => s.setStage(st.id)}
              className={`min-h-14 rounded-xl border p-3 text-left text-xs ${s.stage === st.id ? 'border-accent bg-accent text-white' : 'border-line bg-panel-2'}`}
            >
              {st.title}
              <span className="mt-1 block text-[10px] opacity-70">{st.group}</span>
            </button>
          ))}
        </div>
      </Card>
      <StageDetail />
      <Card title="客户与 Provider 怎样分工？" kicker="Delivery models">
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(PARTNERSHIPS).map(([id, partnership]) => (
            <Button
              primary={p.partnership === id}
              key={id}
              onClick={() => s.setPrices({ partnership: id as Partnership })}
            >
              {partnership.title}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Note>
            <strong>Provider：</strong>
            {partner.provider}
          </Note>
          <div className="rounded-xl bg-panel-2 p-3 text-sm leading-relaxed">
            <strong>客户：</strong>
            {partner.customer}
          </div>
        </div>
        <p className="mt-3 text-xs text-dim">
          收入账本只包含此合作模式下由该 Provider 承接的服务，其余仍计入客户项目总投入。
        </p>
      </Card>
      <Card title="先看工作量，再谈价格" kicker="小型环境实际次数 → 大模型用量教学估算">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="训练采样调用" value={s.trainingUsage.modelCalls.toLocaleString()} detail="真实执行次数" />
          <Metric
            label="Rollout 输入 Token"
            value={Math.round(quantities.input + quantities.cached).toLocaleString()}
            detail="估算，包含累计上下文"
          />
          <Metric
            label="Rollout 输出 Token"
            value={Math.round(quantities.output).toLocaleString()}
            detail="估算，每步输出长度假设"
          />
          <Metric
            label="训练处理 Token"
            value={Math.round(quantities.train).toLocaleString()}
            detail={`其中带损失输出 ≈ ${Math.round(quantities.learned).toLocaleString()}`}
          />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          输入 ≈ 调用数 × 初始上下文 + 历史轮数总和 ×（输出 +
          工具观察）。训练处理量按实际保留轨迹及更新遍历估算。工具文本是输入，不是被强化的动作；无损失 Token 与计费
          Token 并非同一集合。
        </p>
      </Card>
      <Card title="可编辑的教学价格与用量假设" kicker="全部为假设 · 不是真实账单">
        <div className="mb-4 flex flex-wrap gap-2">
          <Button primary={p.billing === 'token'} onClick={() => s.setPrices({ billing: 'token' })}>
            按 Token 购买
          </Button>
          <Button primary={p.billing === 'gpu'} onClick={() => s.setPrices({ billing: 'gpu' })}>
            专用 GPU 时间
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {field('输入 $ / 1M Token', 'input', 0.1)}
          {field('缓存输入 $ / 1M Token', 'cached', 0.1)}
          {field('输出 $ / 1M Token', 'output', 0.1)}
          {p.billing === 'token' && field('训练处理 $ / 1M Token', 'train', 0.1)}
          {field('输入缓存命中比例', 'cacheRate', 0.05, 1)}
          {field('初始上下文 Token / 调用', 'promptTokens')}
          {field('模型输出 Token / 动作', 'outputTokens')}
          {field('工具观察 Token / 轮', 'observationTokens')}
          {field('工具环境 $ / 调用', 'toolCall', 0.001)}
          {!p.judge && field('规则评分 $ / 次', 'ruleCall', 0.0001)}
          {field('数据与 Eval 建设 $', 'dataCost')}
          {p.partnership === 'expert' && field('专家项目服务 $', 'expertCost')}
        </div>
        {p.billing === 'gpu' && (
          <div className="mt-4 rounded-xl border border-warn/20 bg-warn/5 p-4">
            <p className="mb-3 text-xs leading-relaxed text-warn">
              下面是用户填写的容量预算，不从小型策略运行时间推断 GPU 时间。Rollout、Trainer、Serving 改按 GPU
              计费；评测另购 API，工具/评分是独立资源，不重复计入上述容量。
            </p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {field('每类集群 GPU 数', 'gpuCount')}
              {field('$ / GPU-hour', 'gpuPrice', 0.1)}
              {field('Rollout 小时', 'rolloutHours', 0.1)}
              {field('Trainer 小时', 'trainHours', 0.1)}
              {field('Serving 小时', 'servingHours', 0.1)}
            </div>
          </div>
        )}
        <div className="mt-4">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={p.judge} onChange={(e) => s.setPrices({ judge: e.target.checked })} />
            推演额外使用 LLM Judge 的费用
          </label>
          {p.judge && (
            <>
              <p className="mb-3 text-xs text-dim">
                只改变成本假设；实验奖励仍由规则计算，不会调用外部模型。Judge 使用上方输入/输出单价。
              </p>
              <div className="grid grid-cols-2 gap-3">
                {field('每次 Judge 输入 Token', 'judgeInput')}
                {field('每次 Judge 输出 Token', 'judgeOutput')}
              </div>
            </>
          )}
        </div>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer">如果使用学习得到的 Reward Model，还需准备什么？</summary>
          <p className="mt-3 leading-relaxed text-dim">
            还需要评分/偏好训练集、独立校准评测、RM 训练 GPU 与部署推理。这里没有 RM
            训练，所以不虚构其费用；真实项目应按模型与数据量另建训练预算，不能把 Judge 的 API 费用当成 RM
            全生命周期成本。
          </p>
        </details>
      </Card>
      <div className="grid gap-3 md:grid-cols-3">
        <Metric
          label="客户项目总投入 / 预算"
          value={dollars(cost.total)}
          detail="一次性研发 + 训练 + 已执行评测/生产或容量预算"
        />
        <Metric
          label="此 Provider 可获得的收入"
          value={dollars(cost.revenue)}
          detail="按所选合作模式承接的费用；不是毛利"
        />
        <Metric label="生产费用 / 预算" value={dollars(cost.productionCost)} detail="Serving + 工具 + 评分" />
      </div>
      <Card title="逐项账本：谁提供，按什么收费？">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead>
              <tr>
                {['阶段 / 服务', '计量依据', '客户费用', '承接方'].map((v) => (
                  <th className="px-2 py-3 text-dim" key={v}>
                    {v}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cost.rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-2 py-3 font-medium">{r.label}</td>
                  <td className="max-w-xs px-2 text-dim">{r.basis}</td>
                  <td className="px-2 font-mono">{dollars(r.cost)}</td>
                  <td className={`px-2 ${r.provider ? 'text-accent' : 'text-dim'}`}>
                    {r.provider ? '此 Provider' : '客户 / 其他服务商'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          本账本不包含未知的真实厂商 COGS，也不推算毛利。存储、网络、预留容量和定制 SLA
          应核对是否已包含在合同价中；未单列代表未建模，不代表免费。
        </p>
      </Card>
      <Card title="客户最终关心每成功任务成本">
        <p className="text-sm leading-relaxed">
          每成功任务成本 = 所有尝试消耗 ÷ 真正成功的任务数。失败和重试仍消耗推理与工具资源；每百万 Token
          更便宜不一定使成功任务更便宜。
        </p>
        <p className="mt-3 text-sm text-dim">
          最近一次生产对照的候选成功数：
          {s.canary ? `${s.canary.candidate.resolved}/${s.canary.candidate.count}` : '请在评估与升级中运行 A/B'}
          。每批可变成本在评估表中计算，整项目回本还需生产流量、研发摊销期和业务收益。
        </p>
        <p className="mt-2 text-xs text-dim">
          研发摊销与生产批次不能混用分母。没有成功样本时，每成功任务成本显示 N/A。
        </p>
      </Card>
      <Card title="Fireworks 实例与资料边界" kicker="来源与核验日期">
        <div className="grid gap-3 md:grid-cols-2">
          {SOURCES.map((source) => (
            <div key={source.url} className="rounded-xl border border-line p-4">
              <a
                className="text-sm font-semibold text-accent underline"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                {source.title} ↗
              </a>
              <p className="mt-2 text-xs leading-relaxed text-dim">{source.detail}</p>
              <p className="mt-2 text-[11px] text-dim">核验于 {source.asOf}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          一般服务地图、已核验厂商实例与教学价格分别呈现。能力可售不代表默认包含；可用模型、区域、阶段状态和最新报价以厂商确认为准。
        </p>
        <label className="mt-4 block text-xs text-dim">
          快速跳转到一个阶段
          <select className={fieldClass} value={s.stage} onChange={(e) => s.setStage(e.target.value)}>
            {RL_STAGES.map((st) => (
              <option key={st.id} value={st.id}>
                {st.title}
              </option>
            ))}
          </select>
        </label>
      </Card>
    </div>
  )
}
