import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import SegmentedTabs from '../components/ui/SegmentedTabs'
import TransformerDiagram from '../components/TransformerDiagram'
import ModelEvolution from '../components/ModelEvolution'
import { ATTENTION_EVOLUTION, ATTENTION_SUMMARY } from '../data/attention'
import { isPromoExpired, PRICING, PRICING_NOTES } from '../data/pricing'

const TABS = [
  { id: 'transformer', label: '经典 Transformer' },
  { id: 'evolution', label: '模型演进' },
  { id: 'attention', label: '注意力演进' },
  { id: 'pricing', label: '模型 API 横评' },
] as const

type TabId = (typeof TABS)[number]['id']

// 价目表数字格式化：表格行与卡片共用，避免公式双份
function fmtPrice(currency: 'USD' | 'RMB', v: number | null) {
  const cur = currency === 'USD' ? '$' : '¥'
  return v === null ? 'N/A' : `${cur}${v}`
}
function fmtContextK(k: number | null) {
  return k === null ? 'N/A' : k >= 1000 ? `${Math.round(k / 1000)}M` : `${k}K`
}
function fmtMaxOutputK(k: number | null) {
  return k === null ? 'N/A' : `${k}K`
}

export default function ArchitecturePage() {
  // ?tab= 仅作初值（如 /kda 页返回链接落在「注意力演进」）；切 tab 不写回 URL，保持现有轻量行为
  const [params] = useSearchParams()
  const [tab, setTab] = useState<TabId>(() => {
    const q = params.get('tab')
    return TABS.some((t) => t.id === q) ? (q as TabId) : 'transformer'
  })

  return (
    <div className="space-y-5">
      <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'transformer' && <TransformerDiagram />}
      {tab === 'evolution' && <ModelEvolution />}

      {tab === 'attention' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm leading-relaxed">
            {ATTENTION_SUMMARY}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-line bg-panel shadow-sm md:block">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-panel-2 text-left text-xs text-dim">
                <tr>
                  <th className="px-4 py-3">机制</th>
                  <th className="px-4 py-3">原理一句话</th>
                  <th className="px-4 py-3">KV cache 代价</th>
                  <th className="px-4 py-3">代表模型</th>
                </tr>
              </thead>
              <tbody>
                {ATTENTION_EVOLUTION.map((a, i) => (
                  <tr key={a.id} className={i % 2 ? '' : 'bg-panel-2/60'}>
                    <td className="px-4 py-3 font-semibold whitespace-nowrap text-accent">
                      {a.id === 'kda' ? (
                        <Link to="/kda" className="hover:underline">
                          {a.name} <span className="text-xs font-normal">→ 交互式拆解</span>
                        </Link>
                      ) : (
                        a.name
                      )}
                    </td>
                    <td className="px-4 py-3 leading-relaxed">{a.mechanism}</td>
                    <td className="px-4 py-3 leading-relaxed text-dim">{a.kvCost}</td>
                    <td className="px-4 py-3 text-dim">{a.models}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 md:hidden">
            {ATTENTION_EVOLUTION.map((a) => (
              <div key={a.id} className="rounded-xl border border-line bg-panel p-4">
                <div className="font-semibold text-accent">
                  {a.id === 'kda' ? (
                    <Link to="/kda" className="hover:underline">
                      {a.name} <span className="text-xs font-normal">→ 交互式拆解</span>
                    </Link>
                  ) : (
                    a.name
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  <div>
                    <div className="text-xs text-dim">原理一句话</div>
                    <p className="leading-relaxed">{a.mechanism}</p>
                  </div>
                  <div>
                    <div className="text-xs text-dim">KV cache 代价</div>
                    <p className="leading-relaxed text-dim">{a.kvCost}</p>
                  </div>
                  <div>
                    <div className="text-xs text-dim">代表模型</div>
                    <p className="text-dim">{a.models}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'pricing' && (
        <div className="space-y-4">
          <div className="hidden overflow-x-auto rounded-xl border border-line bg-panel shadow-sm md:block">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-panel-2 text-left text-xs text-dim">
                <tr>
                  <th className="px-3 py-3">Provider / 模型 ID</th>
                  <th className="px-3 py-3 text-right">输入 /MTok</th>
                  <th className="px-3 py-3 text-right">输出 /MTok</th>
                  <th className="px-3 py-3 text-right">缓存命中</th>
                  <th className="px-3 py-3 text-right">上下文</th>
                  <th className="px-3 py-3 text-right">最大输出</th>
                  <th className="px-3 py-3">实用上下文</th>
                  <th className="px-3 py-3">开源</th>
                  <th className="px-3 py-3">备注</th>
                </tr>
              </thead>
              <tbody>
                {PRICING.map((p, i) => (
                  <tr key={`${p.provider}-${p.modelId}-${i}`} className={i % 2 ? '' : 'bg-panel-2/60'}>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="text-xs text-dim">{p.provider}</div>
                      <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="font-mono font-semibold text-accent hover:underline">
                        {p.modelId}
                      </a>
                    </td>
                    <td className="px-3 py-3 text-right font-mono">{fmtPrice(p.currency, p.inputPerMTok)}</td>
                    <td className="px-3 py-3 text-right font-mono">{fmtPrice(p.currency, p.outputPerMTok)}</td>
                    <td className="px-3 py-3 text-right font-mono text-ok">{fmtPrice(p.currency, p.cachedInputPerMTok)}</td>
                    <td className="px-3 py-3 text-right">{fmtContextK(p.contextK)}</td>
                    <td className="px-3 py-3 text-right">{fmtMaxOutputK(p.maxOutputK)}</td>
                    <td className="px-3 py-3 text-xs text-dim">{p.practicalContextNote ?? 'N/A'}</td>
                    <td className="px-3 py-3">{p.openWeights ? <span className="text-ok">✓</span> : <span className="text-dim">—</span>}</td>
                    <td className="max-w-64 px-3 py-3 text-xs leading-relaxed text-dim">
                      {p.notes}
                      {isPromoExpired(p.validUntil) && (
                        <span className="ml-1 font-semibold text-warn">限时价已过期，现价见来源 ↗</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 md:hidden">
            {PRICING.map((p, i) => (
              <div key={`${p.provider}-${p.modelId}-${i}`} className="rounded-xl border border-line bg-panel p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs text-dim">{p.provider}</div>
                    <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="font-mono font-semibold text-accent hover:underline">
                      {p.modelId}
                    </a>
                  </div>
                  {p.openWeights && (
                    <span className="shrink-0 rounded bg-ok/15 px-1.5 py-0.5 text-xs font-semibold text-ok">开源 ✓</span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <div className="text-xs text-dim">输入 /MTok</div>
                    <div className="font-mono">{fmtPrice(p.currency, p.inputPerMTok)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-dim">输出 /MTok</div>
                    <div className="font-mono">{fmtPrice(p.currency, p.outputPerMTok)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-dim">缓存命中</div>
                    <div className="font-mono text-ok">{fmtPrice(p.currency, p.cachedInputPerMTok)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-dim">上下文</div>
                    <div className="font-mono">{fmtContextK(p.contextK)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-dim">最大输出</div>
                    <div className="font-mono">{fmtMaxOutputK(p.maxOutputK)}</div>
                  </div>
                </div>
                <div className="mt-3 space-y-1 text-xs text-dim">
                  <p>实用上下文：{p.practicalContextNote ?? 'N/A'}</p>
                  <p className="leading-relaxed">
                    {p.notes}
                    {isPromoExpired(p.validUntil) && (
                      <span className="ml-1 font-semibold text-warn">限时价已过期，现价见来源 ↗</span>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
            <h3 className="mb-2 text-sm font-semibold text-warn">售前速记（长上下文 / Batch / 缓存）</h3>
            <ul className="list-inside list-disc space-y-1.5 text-sm leading-relaxed text-dim">
              {PRICING_NOTES.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-dim">
              数据时点 2026-08-22，均来自各家官方定价页（点模型 ID 跳转）；价格月月变，报价前务必再核对。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
