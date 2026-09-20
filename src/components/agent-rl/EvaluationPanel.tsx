import { ALGORITHM_INFO } from '../../data/agentRl'
import { emptyUsage } from '../../lib/agentRl/engine'
import { estimateCosts, perSuccess } from '../../lib/agentRl/economics'
import type { EvaluationResult } from '../../lib/agentRl/types'
import { StageDetail } from './LifecycleMap'
import { useRlStore } from './rlStore'
import { Button, Card, Note, NumberField, dollars, fieldClass, percent } from './primitives'

function EvaluationTable({ results }: { results: { label: string; result: EvaluationResult }[] }) {
  const prices = useRlStore((s) => s.prices)
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[650px] text-left text-xs">
        <thead>
          <tr>
            {[
              '版本 / 数据',
              '样本',
              '真实解决',
              '标记关闭',
              '违规任务',
              '转人工',
              '平均步骤',
              '工具调用',
              '每成功任务*',
            ].map((label) => (
              <th key={label} className="whitespace-nowrap px-2 py-3 font-medium text-dim">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map(({ label, result: r }) => {
            const cost = estimateCosts(emptyUsage(), emptyUsage(), r.usage, {
              ...prices,
              billing: 'token',
              dataCost: 0,
              expertCost: 0,
            }).productionCost
            return (
              <tr key={label} className="border-t border-line">
                <td className="px-2 py-3 font-semibold">
                  {label}
                  <span className="block font-normal text-dim">v{r.version}</span>
                </td>
                <td>{r.count}</td>
                <td className="font-semibold text-accent">{percent(r.resolved / r.count)}</td>
                <td>{percent(r.closed / r.count)}</td>
                <td>{percent(r.violations / r.count)}</td>
                <td>{percent(r.escalated / r.count)}</td>
                <td>{(r.steps / r.count).toFixed(2)}</td>
                <td>{r.usage.toolCalls}</td>
                <td>{dollars(perSuccess(cost, r.resolved))}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-relaxed text-dim">
        * 教学 API 单价下本批推理、工具和评分开销 ÷ 成功数，失败消耗也计入；未摊销研发与训练。零成功显示 N/A。
      </p>
    </div>
  )
}
export default function EvaluationPanel() {
  const s = useRlStore()
  const validation = s.validations[s.selectedVersion]
  const test = s.tests[s.selectedVersion]
  const baseTest = s.tests[0]
  const best = Object.values(s.validations).reduce((a, b) =>
    b.resolved > a.resolved || (b.resolved === a.resolved && b.violations < a.violations) ? b : a,
  )
  const canPromote = !!(
    s.canary &&
    test &&
    baseTest &&
    test.resolved >= baseTest.resolved &&
    test.violations <= baseTest.violations &&
    s.canary.candidate.resolved >= s.canary.control.resolved &&
    s.canary.candidate.violations <= s.canary.control.violations &&
    s.selectedVersion !== s.productionVersion
  )
  const feedback = s.canary?.candidate ?? test ?? validation
  return (
    <div className="space-y-5">
      <Note>
        先用验证集选版本，再运行冻结测试集；最后把模型放回同一个 Harness 做生产对照。训练奖励不参与独立验收评分。
      </Note>
      <Card title="01 / 选择一个可追踪的 Checkpoint" kicker="Offline evaluation">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="block min-w-48 text-xs text-dim">
            候选模型版本
            <select className={fieldClass} value={s.selectedVersion} onChange={(e) => s.selectVersion(+e.target.value)}>
              {s.checkpoints.map((cp) => (
                <option key={cp.version} value={cp.version}>
                  v{cp.version} · {cp.version === 0 ? '初始基线' : ALGORITHM_INFO[cp.config.algorithm].name}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={() => s.selectVersion(best.version)}>选择验证集最佳 v{best.version}</Button>
          <Button primary onClick={s.runTest}>
            运行冻结测试集
          </Button>
        </div>
        <EvaluationTable
          results={[
            { label: '基线 · 验证集', result: s.baseline },
            ...(validation && s.selectedVersion !== 0 ? [{ label: '候选 · 验证集', result: validation }] : []),
            ...(baseTest ? [{ label: '基线 · 测试集', result: baseTest }] : []),
            ...(test && s.selectedVersion !== 0 ? [{ label: '候选 · 测试集', result: test }] : []),
          ]}
        />
        {!validation && (
          <p className="mt-3 text-sm text-warn">
            此快照已保存，但本轮尚未完成「同步并验证」。请完成该步骤后查看验证结果。
          </p>
        )}
        <p className="mt-3 text-xs leading-relaxed text-dim">
          初始与候选策略使用同一分区、相同任务种子与随机采样口径。查看测试集之后再调参，会使它逐渐成为验证集；真实项目应补充新的最终留出集。
        </p>
      </Card>
      <Card title="02 / 把模型放回生产 Agent" kicker="Model + Harness + Tools">
        <div className="grid gap-3 md:grid-cols-4">
          {[
            ['候选 Policy', `v${s.selectedVersion}`],
            ['Harness', '客服编排 v1'],
            ['工具与权限', '模拟工具 v1'],
            ['验收器', '独立业务验收 v1'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-panel-2 p-4">
              <p className="text-xs text-dim">{label}</p>
              <p className="mt-2 font-semibold">{value}</p>
            </div>
          ))}
        </div>
        <p className="my-3 text-sm leading-relaxed text-dim">
          真实 LLM 还应锁定 Tokenizer、Chat Template、System Prompt、工具 Schema、精度/量化、推理引擎和采样参数，再跑
          Golden Tasks。本实验保持 Harness 不变，用独立故障率模拟生产工具变化。
        </p>
        <NumberField
          label="生产订单 API 故障率（0–1）"
          value={s.productionFailure}
          min={0}
          max={1}
          step={0.05}
          onChange={s.setProductionFailure}
        />
      </Card>
      <Card title="03 / 配对 A/B → 发布 → 回滚" kicker={`当前生产版本 v${s.productionVersion}`}>
        <p className="mb-4 text-sm leading-relaxed text-dim">
          同一批 40 个新生产工单，分别用当前版与候选版执行，共 80
          次任务。这里是本地配对实验；没有真实用户流量，也不据小样本宣称统计显著性。
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          <Button primary onClick={s.runCanary}>
            运行模拟灰度 / A/B
          </Button>
          <Button disabled={!canPromote} onClick={s.promote}>
            发布候选版本
          </Button>
          <Button disabled={s.previousProduction === null} onClick={s.rollback}>
            回滚到上一生产版本{s.previousProduction !== null ? ` v${s.previousProduction}` : ''}
          </Button>
        </div>
        {s.canary && (
          <EvaluationTable
            results={[
              { label: '当前版 · 生产', result: s.canary.control },
              { label: '候选版 · 生产', result: s.canary.candidate },
            ]}
          />
        )}
        <div className="mt-4">
          <Note warn={!canPromote}>
            教学发布门槛：完成测试，候选测试成功数不低于 v0、违规任务数不高于 v0；生产 A/B
            成功数不低于当前版、违规任务数不高于当前版。
            {!test
              ? ' 当前候选尚未运行测试。'
              : !s.canary
                ? ' 还需运行生产对照。'
                : s.selectedVersion === s.productionVersion
                  ? ' 候选与当前生产版本相同。'
                  : canPromote
                    ? ' 当前满足门槛，可模拟发布。'
                    : ' 当前未满足门槛，先诊断失败。'}
          </Note>
        </div>
        {s.releases.length > 0 && (
          <div className="mt-4 max-h-64 space-y-2 overflow-auto">
            {s.releases
              .slice()
              .reverse()
              .map((r, i) => (
                <div key={i} className="rounded-lg border border-line p-3 text-xs">
                  <strong>
                    {{ canary: '模拟灰度', promote: '发布', rollback: '回滚' }[r.kind]} → v{r.version}
                  </strong>
                  <p className="mt-1 text-dim">
                    {r.harness} · {r.tools} · Reward {r.reward} · {r.evaluation}
                  </p>
                  <p className="mt-1">
                    生产成功 {r.result.resolved}/{r.result.count} · 工具故障率 {percent(r.result.failureRate)}
                  </p>
                </div>
              ))}
          </div>
        )}
      </Card>
      <Card title="04 / 失败反馈到底改哪里？" kicker="Close the loop">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-3 text-sm font-semibold">
              {feedback?.split === 'production' ? '候选生产对照中的失败' : '当前候选的独立评测失败'}
            </h4>
            {feedback &&
              Object.entries(feedback.failures).map(([reason, count]) => (
                <div key={reason} className="flex justify-between gap-2 border-b border-line py-2 text-xs">
                  <span>{reason}</span>
                  <strong>{count} 条</strong>
                </div>
              ))}
            {feedback && Object.keys(feedback.failures).length === 0 && (
              <p className="text-sm text-ok">本批没有未解决任务；仍需检查未覆盖场景。</p>
            )}
          </div>
          <div className="space-y-3 text-sm">
            {[
              ['缺少关键事实', '更新知识和 Context', 'data'],
              ['工具超时、权限或幂等问题', '修复 Harness / 工具，再重跑 Eval', 'environment'],
              ['刷分、目标与真实结果不一致', '修 Reward 并补反例', 'reward'],
              ['正确观察下策略仍不好', '补任务分布、示范或再训练', 'recipe'],
            ].map(([reason, next, stage]) => (
              <button
                type="button"
                key={reason}
                onClick={() => s.setStage(stage)}
                className="block w-full rounded-xl bg-panel-2 p-3 text-left"
              >
                <span className="block text-xs text-dim">{reason}</span>
                <span className="mt-1 block font-medium">{next} ↗</span>
              </button>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-dim">
          分类只是诊断线索，不能仅凭一个聚合指标确定根因。生产反馈应先复核与去重，不能直接把测试集或噪声反馈送入训练。
        </p>
      </Card>
      <StageDetail />
    </div>
  )
}
