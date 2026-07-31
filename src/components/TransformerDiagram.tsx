import { useState } from 'react'
import { ENCDEC_COMPONENTS, TF_COMPONENTS } from '../data/transformer'
import QKVFlow from './QKVFlow'

const blockOrder = ['norm', 'attention', 'residual', 'ffn'] as const
const ALL = [...TF_COMPONENTS, ...ENCDEC_COMPONENTS]

export default function TransformerDiagram() {
  const [selectedId, setSelectedId] = useState('attention')
  const [view, setView] = useState<'decoder' | 'encdec'>('decoder')
  const selected = ALL.find((c) => c.id === selectedId)!

  const node = (id: string, labelOverride?: string) => {
    const c = ALL.find((x) => x.id === id)!
    return (
      <button
        onClick={() => setSelectedId(id)}
        className={`w-full rounded-lg border px-3 py-2 text-sm transition-all ${
          selectedId === id
            ? 'border-accent bg-accent/20 shadow-[0_0_12px_rgba(91,141,239,0.35)]'
            : 'border-line bg-panel-2 hover:border-accent/50'
        }`}
      >
        <div className="font-medium">{labelOverride ?? c.name}</div>
        <div className="text-[11px] text-dim">{c.enName}</div>
      </button>
    )
  }

  const arrow = <div className="py-0.5 text-center text-dim">↓</div>

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* 左：结构图 */}
      <div className={`w-full shrink-0 ${view === 'encdec' ? 'lg:w-[560px]' : 'lg:w-80'}`}>
        <div className="mb-2 flex gap-2">
          <button
            onClick={() => setView('decoder')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === 'decoder' ? 'bg-accent text-white' : 'bg-panel text-dim hover:bg-panel-2'}`}
          >
            Decoder-only（现代 LLM）
          </button>
          <button
            onClick={() => setView('encdec')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === 'encdec' ? 'bg-accent text-white' : 'bg-panel text-dim hover:bg-panel-2'}`}
          >
            Encoder-Decoder（2017 原始）
          </button>
        </div>

        {view === 'decoder' ? (
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 rounded-lg bg-panel-2 px-4 py-2 text-center text-sm text-dim">
              输入文本 “解释 KV cache”
            </div>
            {arrow}
            {node('tokenizer')}
            {arrow}
            {node('pos')}
            {arrow}
            <div className="relative my-1 rounded-xl border-2 border-dashed border-accent-2/50 p-3">
              <span className="absolute -top-3 right-3 rounded bg-accent-2/20 px-2 py-0.5 text-xs font-semibold text-accent-2">
                × N 层（如 61~94 层）
              </span>
              {blockOrder.map((id, i) => (
                <div key={id}>
                  {i > 0 && arrow}
                  {node(id)}
                </div>
              ))}
            </div>
            {arrow}
            {node('lmhead')}
            <div className="mt-2 rounded-lg border border-ok/40 bg-ok/10 px-4 py-2 text-center text-sm text-ok">
              采样出下一个 token → 拼回输入，循环生成（自回归）
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="grid grid-cols-2 gap-4">
              {/* 编码器 */}
              <div>
                <div className="mb-2 rounded-lg bg-panel-2 px-2 py-1.5 text-center text-xs text-dim">
                  源序列（如英文原句）
                </div>
                {arrow}
                {node('tokenizer', '嵌入 + 位置编码')}
                {arrow}
                <div className="relative rounded-xl border-2 border-dashed border-ok/50 p-2">
                  <span className="absolute -top-3 left-2 rounded bg-ok/20 px-2 py-0.5 text-[10px] font-semibold text-ok">
                    Encoder × N
                  </span>
                  {node('enc-attn')}
                  {arrow}
                  {node('ffn', '前馈网络')}
                </div>
                <div className="mt-1 rounded bg-ok/10 px-2 py-1 text-center text-[11px] text-ok">上下文表示 →</div>
              </div>
              {/* 解码器 */}
              <div>
                <div className="mb-2 rounded-lg bg-panel-2 px-2 py-1.5 text-center text-xs text-dim">
                  目标序列（已生成部分）
                </div>
                {arrow}
                {node('tokenizer', '嵌入 + 位置编码')}
                {arrow}
                <div className="relative rounded-xl border-2 border-dashed border-accent-2/50 p-2">
                  <span className="absolute -top-3 left-2 rounded bg-accent-2/20 px-2 py-0.5 text-[10px] font-semibold text-accent-2">
                    Decoder × N
                  </span>
                  {node('attention', '掩码自注意力')}
                  {arrow}
                  {node('cross-attn')}
                  {arrow}
                  {node('ffn', '前馈网络')}
                </div>
                {arrow}
                {node('lmhead', '输出层 + 采样')}
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-dim">
              绿框顶部的上下文表示作为 K/V 供右侧交叉注意力查询（Q 来自目标序列）。现代 LLM 砍掉整个编码器与交叉注意力
              —— 源信息直接拼进同一条序列，换来 KV cache 复用与训练格式统一。
            </p>
          </div>
        )}
      </div>

      {/* 右：讲解面板 */}
      <div className="min-w-0 flex-1">
        <div className="sticky top-20 rounded-xl border border-line bg-panel p-6">
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
          {selectedId === 'attention' && <QKVFlow />}
        </div>
      </div>
    </div>
  )
}
