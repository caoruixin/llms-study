import { useState } from 'react'
import { MODELS } from '../data/models'
import type { ModelSpec } from '../data/types'

function fmtParams(m: ModelSpec) {
  const total = m.totalParamsB >= 1000 ? `${(m.totalParamsB / 1000).toFixed(1)}T` : `${m.totalParamsB}B`
  if (m.activeParamsB === m.totalParamsB) return `${total} dense`
  return `${total} / 激活 ${m.activeParamsB}B`
}

function fmtContext(k: number) {
  return k >= 1000 ? `${Math.round(k / 1000)}M` : `${k}K`
}

export default function ModelEvolution() {
  const [openId, setOpenId] = useState<string | null>('kimi-k3')

  return (
    <div className="space-y-3">
      <p className="text-sm text-dim">
        按时间排列的开源模型演进。<span className="text-accent">红色标签</span>为该模型相对经典 Transformer 的架构
        diff，点击卡片展开亮点详解。
      </p>
      {MODELS.map((m) => {
        const open = openId === m.id
        return (
          <div
            key={m.id}
            className={`rounded-xl border shadow-sm transition-colors ${open ? 'border-accent/60 bg-panel' : 'border-line bg-panel hover:border-accent/40'}`}
          >
            <button onClick={() => setOpenId(open ? null : m.id)} className="w-full px-5 py-4 text-left">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded bg-panel-2 px-2 py-0.5 text-xs text-dim">{m.year}</span>
                <span className="text-lg font-bold">{m.name}</span>
                <span className="text-sm text-dim">{m.vendor}</span>
                <span className="rounded bg-accent-2/15 px-2 py-0.5 text-xs text-accent-2">{fmtParams(m)}</span>
                <span className="rounded bg-panel-2 px-2 py-0.5 text-xs text-dim">上下文 {fmtContext(m.contextK)}</span>
                <span className="rounded bg-panel-2 px-2 py-0.5 text-xs text-dim">{m.attentionType}</span>
                {m.multimodal && <span className="rounded bg-ok/15 px-2 py-0.5 text-xs text-ok">多模态</span>}
                <span className="ml-auto text-dim">{open ? '▾' : '▸'}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.diffVsTransformer.map((d, i) => (
                  <span key={i} className="rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs text-accent">
                    {d}
                  </span>
                ))}
              </div>
            </button>
            {open && (
              <div className="border-t border-line px-5 py-4">
                <div className="mb-3 grid gap-3 md:grid-cols-2">
                  {m.highlights.map((h, i) => (
                    <div key={i} className="rounded-lg bg-panel-2 p-3 text-sm leading-relaxed">
                      <div className="mb-1 font-semibold text-accent">{h.title}</div>
                      <p>{h.what}</p>
                      <p className="mt-1.5 border-t border-line pt-1.5 text-warn/90">
                        <span className="text-xs font-semibold">为什么重要：</span>
                        {h.why}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-dim">
                  <span>许可证：{m.license}</span>
                  {m.moe && (
                    <span>
                      MoE：{m.moe.experts} 专家
                      {m.moe.activePerToken ? `选 ${m.moe.activePerToken}` : '（激活专家数未公布）'}
                      {m.moe.shared ? ` + ${m.moe.shared} 共享` : ''}
                    </span>
                  )}
                  {m.kvSpec.kind === 'unsupported' && <span className="text-warn/70">KV 估算：{m.kvSpec.note}</span>}
                  <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    来源（{m.asOf}）↗
                  </a>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
