import { useState } from 'react'
import { STACK_LAYERS } from '../data/stack'
import { INTERCONNECT_NOTES } from '../data/hardware'

export default function StackExplorer() {
  const [sel, setSel] = useState<{ layer: string; comp: string }>({ layer: 'serving', comp: 'gateway' })
  const layer = STACK_LAYERS.find((l) => l.id === sel.layer)!
  const comp = layer.components.find((c) => c.id === sel.comp)!

  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-3">
        <p className="text-sm text-dim">
          自顶向下：一个请求穿过的四层。点击任意组件查看讲解与面试考点（顺序即请求流向，硬件层承载全部上层）。
        </p>
        {STACK_LAYERS.map((l) => (
          <div key={l.id} className="rounded-xl border border-line bg-panel shadow-sm p-4">
            <div className="mb-2 flex items-baseline gap-3">
              <span className={`font-bold ${l.color}`}>{l.name}</span>
              <span className="text-xs text-dim">{l.summary}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {l.components.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSel({ layer: l.id, comp: c.id })}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    sel.layer === l.id && sel.comp === c.id
                      ? 'border-accent bg-accent/10'
                      : 'border-line bg-panel-2 hover:border-accent/50'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="rounded-xl border border-line bg-panel shadow-sm p-4 text-xs leading-relaxed text-dim">
          {INTERCONNECT_NOTES.map((n, i) => (
            <p key={i} className="mb-1">
              · {n}
            </p>
          ))}
        </div>
      </div>

      <div className="w-full shrink-0 lg:w-96">
        <div className="sticky top-20 rounded-xl border border-line bg-panel shadow-sm p-5">
          <div className={`mb-1 text-xs font-semibold ${layer.color}`}>{layer.name}</div>
          <h3 className="text-lg font-bold">{comp.name}</h3>
          <p className="mt-3 text-sm leading-relaxed">{comp.what}</p>
          <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm leading-relaxed">
            <div className="mb-1 text-xs font-semibold text-warn">面试考点</div>
            {comp.interview}
          </div>
        </div>
      </div>
    </div>
  )
}
