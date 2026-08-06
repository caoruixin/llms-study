import { useState } from 'react'
import SegmentedTabs from '../components/ui/SegmentedTabs'
import KdaDerivation from '../components/kda/KdaDerivation'
import KdaLab from '../components/kda/KdaLab'
import KdaChunkwise from '../components/kda/KdaChunkwise'
import KdaNetwork from '../components/kda/KdaNetwork'
import { KDA_SUMMARY } from '../data/kda'

const TABS = [
  { id: 'derivation', label: '原理推导' },
  { id: 'lab', label: '数值实验室' },
  { id: 'chunk', label: '分块并行' },
  { id: 'network', label: '网络结构' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function KdaPage() {
  const [tab, setTab] = useState<TabId>('derivation')

  return (
    <div className="space-y-5">
      <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />

      {/* 一句话主线（四 tab 常驻） */}
      <div className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm leading-relaxed">{KDA_SUMMARY}</div>

      {/* 各 tab 条件渲染：切走即卸载，播放用的定时器随之清理 */}
      {tab === 'derivation' && <KdaDerivation />}
      {tab === 'lab' && <KdaLab />}
      {tab === 'chunk' && <KdaChunkwise />}
      {tab === 'network' && <KdaNetwork />}
    </div>
  )
}
