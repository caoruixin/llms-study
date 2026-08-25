// 10 维度 + 5 项部署元信息 × 全部架构的横向对比总表。
// 桌面 lg+ 走真 <table>(唯一允许 overflow-x-auto 的位置,卡片内部);移动端转维度卡片列表,页面级不横滚。
import { ARCH_DIAGRAMS, DIMENSIONS, type ArchDiagram } from '../../data/archAtlas'

function dots(level: 1 | 2 | 3 | 4 | 5): string {
  return '●'.repeat(level) + '○'.repeat(5 - level)
}

const META_ROWS: readonly { key: string; name: string; value: (d: ArchDiagram) => string }[] = [
  { key: 'minDeploy', name: '最小部署粒度', value: (d) => d.meta.minDeploy },
  { key: 'qpsThreshold', name: '起效 QPS 门槛', value: (d) => d.meta.qpsThreshold },
  { key: 'network', name: '网络要求', value: (d) => d.meta.network },
  { key: 'opsComplexity', name: '运维复杂度', value: (d) => dots(d.meta.opsComplexity) },
  { key: 'avoidWhen', name: '何时不该用', value: (d) => d.meta.avoidWhen },
]

interface Row {
  key: string
  name: string
  values: string[]
}

export default function ArchDimensionTable() {
  const rows: Row[] = [
    ...DIMENSIONS.map((dim) => ({
      key: dim.id,
      name: dim.name,
      values: ARCH_DIAGRAMS.map((d) => d.dims[dim.id]),
    })),
    ...META_ROWS.map((m) => ({
      key: m.key,
      name: m.name,
      values: ARCH_DIAGRAMS.map((d) => m.value(d)),
    })),
  ]

  return (
    <div className="space-y-3">
      <p className="text-sm text-dim">
        上半部 {DIMENSIONS.length} 行是技术维度,下半部 5 行是落地元信息(运维复杂度 ●●●●● = 1~5 级)。
        横向读一行看同一维度上各架构的差别,纵向读一列就是这张图的完整画像。
      </p>

      {/* 桌面:真表格,首列 sticky,卡片内部横向滚动 */}
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-panel shadow-sm lg:block">
        <table className="w-full text-sm" style={{ minWidth: `${170 + ARCH_DIAGRAMS.length * 150}px` }}>
          <thead className="bg-panel-2 text-left text-xs text-dim">
            <tr>
              <th className="sticky left-0 z-10 bg-panel-2 px-3 py-3 font-semibold">维度</th>
              {ARCH_DIAGRAMS.map((d) => (
                <th key={d.id} className="px-3 py-3 font-semibold text-fg">
                  {d.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className={i % 2 ? '' : 'bg-panel-2/60'}>
                <td className="sticky left-0 z-10 bg-panel-2 px-3 py-2.5 text-xs font-semibold whitespace-nowrap text-accent">
                  {r.name}
                </td>
                {r.values.map((v, j) => (
                  <td key={ARCH_DIAGRAMS[j].id} className="px-3 py-2.5 leading-relaxed">
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动端:一维一卡 */}
      <div className="space-y-3 lg:hidden">
        {rows.map((r) => (
          <div key={r.key} className="rounded-xl border border-line bg-panel shadow-sm p-4">
            <div className="mb-2 text-sm font-semibold text-accent">{r.name}</div>
            <dl className="space-y-1.5 text-sm leading-relaxed">
              {r.values.map((v, j) => (
                <div key={ARCH_DIAGRAMS[j].id} className="flex gap-2">
                  <dt className="w-28 shrink-0 text-xs text-dim">{ARCH_DIAGRAMS[j].name}</dt>
                  <dd className="min-w-0 flex-1">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  )
}
