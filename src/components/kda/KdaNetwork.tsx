// Tab4 网络结构（PLAN-kda-demo.md §6.1）：TransformerDiagram 双栏模式。
//
// 数据一致性：层数只来自 K3_STRUCTURE（条带由 buildLayerBand() 生成，计数有单测互锁）；
// 其余 K3 事实字段直接引用 src/data/models.ts 的 kimi-k3 条目（getK3ModelSpec()，render 期惰性取值，
// 条目缺失时 throw 由路由级 ErrorBoundary 接住），不复制第二份。
// 文案红线：~2.5× 效率提升是架构 + 训练配方的综合收益，不单项归因给 KDA。
import { useMemo, useState } from 'react'
import { buildLayerBand, getK3ModelSpec, K3_STRUCTURE, NETWORK_NODES } from '../../data/kda'
import KdaLayerFlow from './KdaLayerFlow'

const REPEAT_UNIT: readonly { readonly nodeId: string; readonly label: string }[] = [
  { nodeId: 'kda-layer', label: 'KDA × 3' },
  { nodeId: 'gated-mla', label: 'Gated MLA × 1' },
  { nodeId: 'moe-ffn', label: 'MoE FFN' },
  { nodeId: 'attn-residual', label: 'Attention Residuals' },
]

export default function KdaNetwork() {
  const band = useMemo(() => buildLayerBand(), [])
  const [selectedId, setSelectedId] = useState('kda-layer')
  const selected = NETWORK_NODES.find((n) => n.id === selectedId) ?? NETWORK_NODES[0]
  const spec = getK3ModelSpec()
  const moe = spec.moe

  const arrow = (
    <div className="py-0.5 text-center text-dim" aria-hidden="true">
      ↓
    </div>
  )

  const facts: readonly [string, string][] = [
    ['总参 / 激活参', `${spec.totalParamsB}B / ${spec.activeParamsB}B`],
    ['注意力', `${spec.attentionType}（${K3_STRUCTURE.kdaLayers} 层 KDA + ${K3_STRUCTURE.mlaLayers} 层 Gated MLA）`],
    [
      'MoE',
      moe
        ? `${moe.experts} 专家${moe.activePerToken ? `选 ${moe.activePerToken}` : '（激活专家数未公布）'}${moe.shared ? ` + ${moe.shared} 共享` : ''}`
        : 'N/A（专家配置官方未公布）',
    ],
    ['上下文', spec.contextK >= 1000 ? `${Math.round(spec.contextK / 1000)}M tokens` : `${spec.contextK}K tokens`],
    ['KV cache', spec.kvSpec.kind === 'unsupported' ? spec.kvSpec.note : 'N/A'],
    ['许可 / 多模态', `${spec.license} / ${spec.multimodal ? '原生多模态' : '纯文本'}`],
  ]

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* 左：结构图 */}
      <div className="w-full shrink-0 lg:w-96">
        {/* 93 层全景条带 */}
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4">
          <button
            type="button"
            onClick={() => setSelectedId('hybrid-stack')}
            className={`mb-2 w-full rounded-lg border px-3 py-2 text-left text-sm transition-all ${
              selectedId === 'hybrid-stack' ? 'border-accent bg-accent/10 shadow-sm' : 'border-line bg-panel-2 hover:border-accent/50'
            }`}
          >
            <div className="font-medium">{K3_STRUCTURE.totalLayers} 层混合注意力栈</div>
            <div className="text-[11px] text-dim">{K3_STRUCTURE.ratioNote}</div>
          </button>

          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dim">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-accent/70" />
              KDA 线性注意力 × {K3_STRUCTURE.kdaLayers}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-accent-2/70" />
              Gated MLA × {K3_STRUCTURE.mlaLayers}
            </span>
          </div>

          {/* 93 个格子移出 Tab 键序（tabIndex=-1）：键盘用户不必按 93 次 Tab 才能越过条带；
              同一批信息通过上方「混合注意力栈」按钮与下方重复单元节点可达，两者保持可聚焦。 */}
          <div className="flex flex-wrap gap-[3px]">
            {band.map((kind, i) => (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                title={`第 ${i + 1} 层 · ${kind === 'kda' ? 'KDA' : 'Gated MLA'}（顺序为示意）`}
                aria-label={`第 ${i + 1} 层 ${kind === 'kda' ? 'KDA' : 'Gated MLA'}`}
                onClick={() => setSelectedId(kind === 'kda' ? 'kda-layer' : 'gated-mla')}
                className={`h-5 w-[13px] rounded-[2px] transition-opacity hover:opacity-100 ${
                  kind === 'kda' ? 'bg-accent/70' : 'bg-accent-2/70'
                } ${
                  (kind === 'kda' && selectedId === 'kda-layer') || (kind === 'mla' && selectedId === 'gated-mla')
                    ? 'opacity-100 ring-1 ring-fg/20'
                    : 'opacity-60'
                }`}
              />
            ))}
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-warn">⚠ {K3_STRUCTURE.interleaveNote}</p>
          <p className="mt-1 text-[11px] text-dim">
            来源：
            <a href={K3_STRUCTURE.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {spec.vendor} {spec.name}
            </a>
            （{K3_STRUCTURE.asOf}）
          </p>
        </div>

        {/* 重复单元 */}
        <div className="mt-4 rounded-xl border border-line bg-panel shadow-sm p-4">
          <div className="mb-2 text-xs font-semibold text-dim">重复单元（点节点看讲解）</div>
          <div className="relative rounded-xl border-2 border-dashed border-accent-2/50 p-3">
            <span className="absolute -top-3 right-3 rounded bg-accent-2/20 px-2 py-0.5 text-xs font-semibold text-accent-2">
              重复堆叠
            </span>
            {REPEAT_UNIT.map((u, i) => {
              const node = NETWORK_NODES.find((n) => n.id === u.nodeId)
              return (
                <div key={u.nodeId}>
                  {i > 0 && arrow}
                  <button
                    type="button"
                    onClick={() => setSelectedId(u.nodeId)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-all ${
                      selectedId === u.nodeId
                        ? 'border-accent bg-accent/10 shadow-sm'
                        : 'border-line bg-panel-2 hover:border-accent/50'
                    }`}
                  >
                    <div className="font-medium">
                      {u.label}
                      {u.nodeId === 'moe-ffn' && moe && (
                        <span className="ml-1 text-[11px] font-normal text-dim">
                          （{moe.experts} 选 {moe.activePerToken}
                          {moe.shared ? ` + ${moe.shared}` : ''}）
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-dim">{node?.enName}</div>
                  </button>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-dim">
            KDA 层与 Gated MLA 层按 {K3_STRUCTURE.ratioNote} 交错；上图条带是同一件事的全景视角。
          </p>
        </div>
      </div>

      {/* 右：讲解面板 */}
      <div className="min-w-0 flex-1">
        <div className="sticky top-20 rounded-xl border border-line bg-panel shadow-sm p-6">
          <h3 className="text-xl font-bold">
            {selected.name} <span className="ml-2 text-sm font-normal text-dim">{selected.enName}</span>
          </h3>
          <div className="mt-4 space-y-4 text-sm leading-relaxed">
            <div>
              <div className="mb-1 text-xs font-semibold tracking-wide text-accent">是什么</div>
              <p>{selected.what}</p>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold tracking-wide text-accent-2">为什么需要它</div>
              <p>{selected.why}</p>
            </div>
            <div className="rounded-lg border border-warn/30 bg-warn/10 p-3">
              <div className="mb-1 text-xs font-semibold tracking-wide text-warn">面试一句话</div>
              <p>{selected.interview}</p>
            </div>
          </div>

          {selectedId === 'kda-layer' && <KdaLayerFlow />}

          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-2 text-xs font-semibold tracking-wide text-dim">
              {spec.name} 事实速查（引用自模型库条目，非本页重复维护）
            </div>
            <table className="w-full text-sm">
              <tbody>
                {facts.map(([k, v], i) => (
                  <tr key={k} className={i % 2 ? '' : 'bg-panel-2/50'}>
                    <td className="w-32 px-3 py-2 align-top text-dim">{k}</td>
                    <td className="px-3 py-2 leading-relaxed">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-relaxed text-dim">
              来源{' '}
              <a href={spec.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {spec.sourceUrl}
              </a>
              （{spec.asOf}）。官方口径的 ~2.5× 缩放效率提升是 KDA + Attention Residuals + MoE 稀疏化 + 训练配方的
              <span className="font-semibold text-fg">综合收益</span>，不能单项归因给 KDA。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
