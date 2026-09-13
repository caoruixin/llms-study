import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { MECHANISMS, TERMS, isMechanism } from '../../data/architectureTerms'
import { ATTENTION_THEORY, THEORY_VERIFIED } from '../../data/attentionTheory'
import type { MechanismId } from '../../data/architectureTypes'
import { PHASES, LAST_FRAME, TRACE_VERSION, PROMPT_TOKENS, RECURRENT_STAGES, STAGES, TOKENS, buildAttentionTrace, isLatent, isRecurrent, isCompressed, memoryLedger, frameFromUrl, type AttentionTrace, type MemoryLedger } from '../../lib/attention/engine'
import { buildSceneFrame, type SceneFrame } from '../../lib/attention/sceneGraph'
import { Term } from './Term'
import './architecture.css'
const TraceScene = lazy(() => import('./TraceScene'))
const COLORS = ['#a32b42', '#7651bb', '#168a88', '#b27519']
const fmt = (v: number) => Number(v.toFixed(4)).toString()
export function formatBytes(bytes: number) { if (bytes === 0) return '0 B'; const i = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))); return `${Number((bytes / 1024 ** i).toFixed(2))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}` }
export function safeFrame(value: string | null) { return frameFromUrl(value, TRACE_VERSION, 'gqa') }
function Matrix({ values, label }: { values: readonly (readonly number[])[]; label: string }) {
  if (!values.length || !values[0]?.length) return <p className="arch-muted">{label} · Empty</p>
  return <div className="arch-matrix-wrap"><span>{label} <small>{values.length} × {values[0].length}</small></span><div className="arch-matrix" style={{ gridTemplateColumns: `repeat(${values[0].length}, minmax(42px, 1fr))` }}>{values.flatMap((row, r) => row.map((v, c) => <span key={`${r}-${c}`} title={`[${r}, ${c}] = ${v}`} style={{ background: v < 0 ? `rgba(20,125,128,${Math.min(.4, .06 + Math.abs(v) * .18)})` : `rgba(158,43,58,${Math.min(.4, .04 + Math.abs(v) * .18)})` }}>{fmt(v)}</span>))}</div></div>
}
function Memory({ ledger, label }: { ledger: MemoryLedger; label: string }) {
  return <div className="arch-memory"><div className="arch-memory-heading"><span>{label}</span><strong>{formatBytes(ledger.bytes)}</strong></div><div className="arch-memory-bar">{ledger.parts.map((p, i) => <span key={p.id} title={`${p.label}: ${formatBytes(p.bytes)}`} style={{ width: `${p.bytes / ledger.bytes * 100}%`, background: COLORS[i % 4] }} />)}</div><dl>{ledger.parts.map(p => <div key={p.id}><dt title={p.note}>{p.label}</dt><dd>{p.elements.toLocaleString()} elements · {formatBytes(p.bytes)}</dd></div>)}</dl></div>
}
function Fallback({ graph, select, selection }: { graph: SceneFrame; select: (id: string) => void; selection: string }) {
  return <div className="arch-fallback" data-testid="fallback-scene"><div className="arch-fallback-heading"><strong>2D step view · All Heads</strong><span>{graph.title}</span></div><div className="arch-node-grid">{graph.nodes.map(n => <button key={n.id} onClick={() => select(n.id)} data-node-id={n.id} className={`${n.active ? 'is-active' : ''} ${selection === n.id ? 'is-selected' : ''} ${n.available ? '' : 'is-pending'}`}><strong>{n.label}</strong><small>{n.available ? n.values ? n.values.flat().slice(0, 4).map(fmt).join(', ') : n.storage ? `${n.storage.elements} elements` : 'Structure' : 'Pending'}</small></button>)}</div><p className="arch-muted">下方 Operation paths 与 3D 使用同一节点、连线和执行阶段。</p></div>
}
const HELP = [
  '同一个 token 通过独立的 WQ 投影产生所有 Q Heads。K/V 按机制的共享关系生成；历史 K/V 复用，当前 token 仍需自己的新投影。',
  '当前 K/V 接入缓存后才能参与后续 Attention。Indexer 与 Compression 工作状态独立更新。SWA 仅保留当前窗口；已完成但不满足读取因果边界的摘要仍可存储。',
  '确定本 token 的可读取集合。DSA / QSA 的选择跨 Main Heads 共享；MSA 按 GQA Group 共享。稀疏未选中数据仍保留在缓存。',
  '所有 Q Heads 独立计算 Q·K、缩放、Mask 和 Softmax。连线表示 Key 打分；MLA 使用吸收后的内容 Query 与独立 RoPE 分量。',
  '每个 Head 用自己的权重读取 Value，得到 Head Output。MLA 聚合 latent 后做 Uᵥ 投影；CSA/HCA 使用 Shared KV 并进行 inverse output RoPE。',
  '所有 Head Outputs 合并后经 Wᴼ 得到 Attention Output。CSA/HCA 先做 Grouped Output Projection。这里还没有 Residual、FFN 或 next-token LM Head。',
]
const REC_HELP = [
  '所有 Heads 从当前输入产生独立的 q、k、v；教学 q/k 做 L2 normalization。q 与 k 不是同一向量。',
  '取出各 Head 上一步的固定形状 State；当前还没有衰减或写入。',
  'GDN 用每 Head 一个 scalar α；KDA 对每个 key channel 使用不同 α，得到衰减后的 State。',
  '用当前 k 从衰减后的 State 得到 prediction，再计算 residual = v − prediction。此时不进行 Query Readout。',
  '计算 ΔS = β residual kᵀ，并加入衰减后的 State。4 个 Heads 都更新自己的矩阵。',
  '使用当前 q 读取更新后的 State，得到每个 Head Output，再合并并投影。递归 State 中不存在逐 token Softmax。',
]
function Details({ trace, graph, selection, head }: { trace: AttentionTrace; graph: SceneFrame; selection: string; head: number }) {
  const step = trace.steps[graph.t], h = step.heads[head], n = graph.nodes.find(n => n.id === selection), theory = ATTENTION_THEORY[trace.mechanism]
  const objects = step.stageStorage[graph.stage]
  const object = objects.find(o => o.id === selection)
  return <div className="arch-trace-details">
    <details className="arch-inspector" open><summary>Tensor inspector <span>{n?.label ?? object?.label ?? 'Select a node'}</span></summary>
      {n ? <><p>{n.detail}</p>{!n.available ? <p className="arch-note">Pending · 此阶段尚未计算该结果。</p> : n.values ? <Matrix values={n.values} label={n.label} /> : <p className="arch-muted">{graph.structural ? 'Structure only · 不提供虚构的计算向量。' : '选择对象查看存储值与维度。'}</p>}</> : object?.values ? <Matrix values={object.values} label={object.label} /> : <p className="arch-muted">点击场景中的 Query、缓存、算子或输出。</p>}
      {object && <p className="arch-muted">Object ID: {object.id} · {object.elements} elements · {formatBytes(object.elements * object.bytesPerElement)} · References: {object.refs.join(', ') || 'Indexer / working state'}</p>}
      <p className="arch-muted">当前阶段 {graph.title} · h = Query Head，g = KV Head，t/j = Token Position。</p>
    </details>
    <details className="arch-operation-details"><summary>Operation paths · {graph.edges.length} 条当前操作路径</summary><ul>{graph.edges.map(e => <li key={e.id} data-edge-from={e.from} data-edge-to={e.to} data-edge-head={e.head}><code>{e.from} → {e.to}</code><span>{e.operation}{e.weight === undefined || graph.stage < 3 ? '' : ` · weight ${fmt(e.weight)}`}</span></li>)}</ul></details>
    {step.indexes.length > 0 && <details><summary>Sparse Indexer · selection ownership</summary>{graph.stage < 2 ? <p>Pending · Route 阶段开始索引。</p> : step.indexes.map(ix => <div key={ix.id} className="arch-index-detail"><strong>{ix.scope === 'all-heads' ? 'Shared by all Main Heads' : `Shared by KV Group ${ix.group}`}</strong><p>{ix.rule}</p><Matrix values={ix.queries} label="Indexer Q Heads" /><Matrix values={ix.keys} label="Indexer K (MSA: token keys; others: candidates)" /><p>Indexer Head weights: [{ix.queryWeights.join(', ')}]</p><div className="arch-table-scroll"><table><thead><tr><th>Candidate</th><th>Score</th><th>Selected</th></tr></thead><tbody>{ix.candidates.map((ts, i) => <tr key={i}><td>{trace.mechanism === 'csa' ? `Summary C${ts[0]}` : ts.map(j => `t${j + 1}`).join(', ')}</td><td>{fmt(ix.scores[i])}</td><td>{ix.selectedCandidates.includes(i) ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div><p>Forced local / tail: {ix.forcedTokens.length ? ix.forcedTokens.map(j => `t${j + 1}`).join(', ') : '—'}</p></div>)}</details>}
    {h && <details><summary>Head {head} · intermediate tensors</summary><Matrix values={[h.q]} label="Q" />{graph.stage >= 1 && <div className="arch-grid-2"><Matrix values={[h.k]} label="Current K" /><Matrix values={[h.v]} label="Current V" /></div>}
      {h.recurrent ? <><Matrix values={graph.stage < 2 ? h.recurrent.before : graph.stage < 4 ? h.recurrent.decayed : h.recurrent.after} label={graph.stage < 2 ? 'State before' : graph.stage < 4 ? 'Decayed State' : 'Updated State'} /><p>α = [{h.recurrent.alpha.join(', ')}] · β = {h.recurrent.beta}</p>{graph.stage >= 3 && <><Matrix values={[h.recurrent.prediction]} label="Prediction = S̄ k" /><Matrix values={[h.recurrent.residual]} label="Residual = v − prediction" /></>}{graph.stage >= 4 && <Matrix values={h.recurrent.write} label="ΔS" />}</> : graph.stage >= 3 ? <>
        {h.absorbedQuery && <Matrix values={[h.absorbedQuery]} label="Absorbed content Query Uₖᵀ q" />}
        <div className="arch-table-scroll"><table><thead><tr><th>Entry</th><th>Positions</th><th>Score</th><th>Weight</th></tr></thead><tbody>{h.entries.map(e => <tr key={e.id}><td>{e.label}</td><td>{e.tokens.map(j => j + 1).join(', ')}</td><td>{e.score === null ? 'Masked' : fmt(e.score)}</td><td>{fmt(e.weight)}</td></tr>)}{h.sinkLogit !== undefined && <tr><td>Attention Sink</td><td>No token / zero Value</td><td>{fmt(h.sinkLogit)}</td><td>{fmt(h.sinkWeight)}</td></tr>}</tbody></table></div>
        {isLatent(trace.mechanism) && <details><summary>Explicit K/V reconstruction · 数学等价检查</summary>{h.entries.filter(e => e.selected).map(e => <div key={e.id}><strong>{e.label}</strong><Matrix values={[e.key]} label="Reconstructed K · not cached" /><Matrix values={[e.value]} label="Reconstructed V · not cached" /></div>)}</details>}
        {isCompressed(trace.mechanism) && <details><summary>Compression lineage · 重叠与逐 channel 权重</summary>{h.entries.filter(e => e.compression).map(e => <div key={e.id}><strong>{e.label}</strong><p>Sources: {e.compression!.sourceTokens.map((j, i) => `t${j + 1}/${e.compression!.sourceBranches[i]}`).join(', ')}</p><Matrix values={e.compression!.sourceValues} label="Source values" /><Matrix values={e.compression!.weights} label="Per-channel compression weights" /><Matrix values={[e.compression!.pooled]} label="Weighted summary before RMSNorm / RoPE" /></div>)}</details>}
      </> : <p className="arch-muted">Score 阶段后显示权重。</p>}
      {graph.stage >= (h.recurrent ? 5 : 4) && <>{h.latentOutput && <Matrix values={[h.latentOutput]} label="Weighted latent" />}<Matrix values={[h.rawOutput]} label="Core Head Output" />{isCompressed(trace.mechanism) && <Matrix values={[h.output]} label="Head Output after inverse RoPE" />}</>}
    </details>}
    {step.merge && <details><summary>All Head Outputs → Attention Output</summary>{graph.stage < 5 ? <p>Pending · Output 阶段才进行合并。</p> : <>{step.heads.map(h => <Matrix key={h.head} values={[h.output]} label={`O[${h.head}]`} />)}<Matrix values={[step.merge.concat]} label="Concat O[0…3]" />{step.merge.groups && <>{step.merge.groups.map((v, i) => <Matrix key={i} values={[v]} label={`Group ${i} intermediate`} />)}</>}<Matrix values={step.merge.matrix} label="Wᴼ · column-vector convention" /><Matrix values={[step.merge.output]} label="Attention Output" /></>}</details>}
    <details><summary>Storage objects · 按对象去重</summary><p className="arch-muted">{graph.stage === 0 ? 'Before Prepare Memory' : 'Current memory'} · References 不重复计数。</p><div className="arch-table-scroll"><table><thead><tr><th>ID</th><th>Elements</th><th>References</th></tr></thead><tbody>{objects.map(o => <tr key={o.id}><td>{o.id}</td><td>{o.elements} × {o.bytesPerElement} B</td><td>{o.refs.join(', ') || '—'}</td></tr>)}</tbody></table></div></details>
    <details className="arch-formula"><summary>Equations & fixed projection matrices</summary><pre>{theory.equation}</pre>{h && <><p className="arch-muted">Column vectors：matrix shape = [output, input]。下方为本轨迹实际使用的固定系数，包含当前 Head 与共享参数。</p>{trace.parameters.filter(p => p.head === undefined || p.head === head).map(p => <Matrix key={p.label} values={p.matrix} label={p.label} />)}</>}</details>
  </div>
}
function Weights({ trace, graph, select }: { trace: AttentionTrace; graph: SceneFrame; select: (h: number) => void }) {
  if (graph.structural) return <p className="arch-note">Structure only · 不生成虚构的 Attention Weights。</p>
  if (isRecurrent(trace.mechanism)) return <p className="arch-note">No token Softmax · State 数值不是历史 token 概率。</p>
  const step = trace.steps[graph.t], compressed = isCompressed(trace.mechanism)
  return <div className="arch-all-weights"><strong>{compressed ? 'Summary coverage attribution · not token probabilities' : 'Attention Weights · all Heads'}</strong><div className="arch-table-scroll"><table><thead><tr><th>Head / KV</th>{TOKENS.map((_, j) => <th key={j}>t{j + 1}</th>)}{compressed && <th>Sink</th>}</tr></thead><tbody>{step.heads.map(h => <tr key={h.head}><th><button onClick={() => select(h.head)} style={{ color: COLORS[h.head] }}>H{h.head} / g{h.kvHead}</button></th>{h.tokenWeights.map((w, j) => <td key={j} style={{ background: graph.stage >= 3 && j <= graph.t ? `rgba(158,43,58,${.03 + w * .65})` : undefined }}>{graph.stage < 3 || j > graph.t ? '—' : w.toFixed(3)}</td>)}{compressed && <td>{graph.stage >= 3 ? h.sinkWeight.toFixed(3) : '—'}</td>}</tr>)}</tbody></table></div>{compressed && <p className="arch-muted">按平均 compression channel weights 展示来源覆盖；窗口与重叠摘要可包含同一 token，不是原始 token-level Attention Weights。</p>}</div>
}
function Panel({ id, frame, progress, fallback, reset, focus, onFocus, onUnavailable, onFrame }: { id: MechanismId; frame: number; progress: number; fallback: boolean; reset: number; focus: number | null; onFocus: (h: number | null) => void; onUnavailable: () => void; onFrame: (f: number) => void }) {
  const trace = useMemo(() => buildAttentionTrace(id), [id]), graph = useMemo(() => buildSceneFrame(trace, frame), [trace, frame]), step = trace.steps[graph.t]
  const [selection, setSelection] = useState('input'), head = focus ?? 0
  const select = (key: string) => { setSelection(key); const node = graph.nodes.find(n => n.id === key); if (node?.head !== undefined && !graph.structural) onFocus(node.head) }
  useEffect(() => { setSelection('input') }, [id])
  const theory = ATTENTION_THEORY[id], stages = isRecurrent(id) ? RECURRENT_STAGES : STAGES
  const readHeads = step.heads.map(h => h.entries.filter(e => e.selected).length), groupReads = [...new Set(step.heads.map(h => h.kvHead))].map(g => ({ g, count: new Set(step.heads.filter(h => h.kvHead === g).flatMap(h => h.entries.filter(e => e.selected).map(e => e.storageId))).size }))
  return <article className="arch-lab-panel" data-mechanism={id}>
    <header><div><h3><Term id={id} full /></h3><span className="arch-muted">{TERMS[id].chinese}</span></div><span className={`arch-fidelity ${trace.fidelity}`}>{trace.fidelity === 'structure' ? 'Structure only' : trace.fidelity === 'numeric' ? 'Reproducible math' : 'Scaled teaching math'}</span></header>
    <p className="arch-intuition">{TERMS[id].explanation}</p>
    <div className="arch-focus-bar"><strong>All Heads participate</strong>{!step.structural && <label>Focus<select aria-label={`Inspect ${TERMS[id].short} Q Head`} value={focus ?? 'all'} onChange={e => { const h = e.target.value === 'all' ? null : Number(e.target.value); onFocus(h); setSelection(h === null ? 'input' : `head-${h}`) }}><option value="all">All Heads · 同步总览</option>{step.heads.map(h => <option key={h.head} value={h.head}>H{h.head} → {h.recurrent ? `State ${h.head}` : `KV g${h.kvHead}`}</option>)}</select></label>}<span>焦点只改变强调，不跳过计算</span></div>
    {fallback ? <Fallback graph={graph} selection={selection} select={select} /> : <Suspense fallback={<div className="arch-three-scene arch-loading">Loading 3D scene…</div>}><TraceScene graph={graph} progress={progress} selection={selection} focus={focus} onSelect={select} cameraReset={reset} onUnavailable={onUnavailable} mechanism={id} /></Suspense>}
    <p className="arch-scene-note">{graph.note}</p>
    {!step.structural && !isRecurrent(id) && <p className="arch-scene-note">Dashed · Key score（打分读取）　Solid · Weighted Value / latent read（加权聚合）；连线颜色标识 Query Head。</p>}
    <div className="arch-token-strip" aria-label="Embedding tokens">{TOKENS.map((token, i) => <button key={i} onClick={() => onFrame(i * PHASES)} className={i === graph.t ? 'is-current' : i > graph.t ? 'is-future' : ''}><small>t{i + 1}</small>{token}</button>)}</div>
    <ol className="arch-stages">{stages.map((s, i) => <li key={s}><button className={graph.stage === i ? 'is-current' : ''} onClick={() => onFrame(graph.t * PHASES + i)} aria-current={graph.stage === i ? 'step' : undefined}><small>{i + 1}</small>{s}</button></li>)}</ol>
    <div className="arch-step-explanation"><strong>{graph.title}</strong><p>{step.structural ? theory.implemented : (isRecurrent(id) ? REC_HELP : HELP)[graph.stage]}</p></div>
    {!step.structural && <div className="arch-head-outputs">{step.heads.map(h => <button key={h.head} onClick={() => { onFocus(h.head); setSelection(`head-output:${h.head}`) }} style={{ borderColor: COLORS[h.head] }}><strong style={{ color: COLORS[h.head] }}>Head Output O[{h.head}]</strong><span>{graph.stage >= (h.recurrent ? 5 : 4) ? h.output.map(fmt).join(', ') : 'Pending'}</span></button>)}</div>}
    <div className="arch-read-stats"><div><span>Indexer candidates / selection owner</span><strong>{graph.stage >= 2 ? step.indexes.map(ix => `${ix.group === null ? 'All' : `g${ix.group}`}: ${ix.candidates.length}`).join(' · ') || (step.structural ? 'See layer modes' : '—') : 'Pending'}</strong></div><div><span>Main reads / Head · total</span><strong>{graph.stage >= 3 ? step.structural ? 'Structure only' : isRecurrent(id) ? '4 independent States' : `${readHeads.join(' / ')} · Σ ${readHeads.reduce((a, b) => a + b, 0)}` : 'Pending'}</strong></div><div><span>{isRecurrent(id) ? 'Independent State objects' : 'Unique entries / KV Group'}</span><strong>{isRecurrent(id) ? step.heads.length : graph.stage >= 3 ? groupReads.map(g => `g${g.g}: ${g.count}`).join(' · ') || '—' : 'Pending'}</strong></div></div>
    <div className="arch-scene-tools"><label>Tensor / storage object<select aria-label={`Inspect ${TERMS[id].short} tensor`} value={[...graph.nodes.map(n => n.id), ...step.stageStorage[graph.stage].map(o => o.id)].includes(selection) ? selection : ''} onChange={e => select(e.target.value)}><option value="">Select…</option>{graph.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}{(step.stageStorage[graph.stage]).filter(o => !graph.nodes.some(n => n.id === o.id)).map(o => <option key={o.id} value={o.id}>{o.id}</option>)}</select></label></div>
    <Memory ledger={step.stageMemory[graph.stage]} label={`${step.structural ? '4 structural layers' : '1 computed layer'} · ${graph.stage === 0 ? `Before t${graph.t + 1}` : `t${graph.t + 1} · ${graph.title}`}`} />
    <Weights trace={trace} graph={graph} select={h => { onFocus(h); setSelection(`head-${h}`) }} />
    <Details trace={trace} graph={graph} selection={selection} head={head} />
    <div className="arch-theory-boundary"><strong>Theory alignment · verified {THEORY_VERIFIED}</strong><p><b>Implemented：</b>{theory.implemented}</p><p><b>Not simulated：</b>{theory.omitted}</p><a href={theory.source} target="_blank" rel="noreferrer">Official source · {theory.locator} ↗</a></div>
  </article>
}
function Growth({ ids }: { ids: MechanismId[] }) {
  const [length, setLength] = useState(8192), [batch, setBatch] = useState(1), [lookup, setLookup] = useState(0), [bits, setBits] = useState(16)
  const ledgers = ids.map(id => memoryLedger(id, length, batch)), points = [1, Math.round(length / 4), Math.round(length / 2), length].map(n => Math.max(1, n))
  const ymax = Math.max(...ledgers.map(l => l.bytes), 1)
  return <section className="arch-box arch-growth"><div className="arch-section-heading"><h3>State growth <span>上下文 × 并发</span></h3><span className="arch-tag">Theoretical estimate · 教学配置</span></div>
    <p className="arch-muted">保持 4 layers、4 Q heads、d=4。这里放大长度观察增长规律，场景中的 8 个 token 与真实模型规格均不改变。</p>
    <div className="arch-growth-controls"><label>Context length <strong>{length.toLocaleString()}</strong><input aria-label="Context length" type="range" min="3" max="20" value={Math.log2(length)} step="1" onChange={e => setLength(2 ** Number(e.target.value))} /></label><label>Concurrent requests<select value={batch} onChange={e => setBatch(Number(e.target.value))}>{[1, 4, 16, 64, 256].map(b => <option key={b} value={b}>{b}</option>)}</select></label></div>
    <div className="arch-growth-grid"><div><svg viewBox="0 0 580 200" className="arch-growth-chart" role="img" aria-label="Request state versus context length"><path d="M55 14V163H565" fill="none" stroke="#cfc6b6" />{[0, .5, 1].map(f => <g key={f}><path d={`M55 ${163 - f * 140} H565`} stroke="#e6dfd2" strokeDasharray="4 5" /><text x="50" y={167 - f * 140} textAnchor="end">{formatBytes(ymax * f)}</text></g>)}{ids.map((id, i) => <g key={id}><polyline points={points.map(n => `${55 + n / length * 500},${163 - memoryLedger(id, n, batch).bytes / ymax * 140}`).join(' ')} fill="none" stroke={i ? '#6d28d9' : '#9e2b3a'} strokeWidth="3" />{points.map((n, j) => <circle key={j} cx={55 + n / length * 500} cy={163 - memoryLedger(id, n, batch).bytes / ymax * 140} r="4" fill={i ? '#6d28d9' : '#9e2b3a'}><title>{TERMS[id].short} · L={n} · {formatBytes(memoryLedger(id, n, batch).bytes)}</title></circle>)}</g>)}<text x="55" y="184">0</text><text x="550" y="184" textAnchor="end">{length.toLocaleString()} tokens</text></svg><div className="arch-chart-legend">{ids.map((id, i) => <span key={id} style={{ color: i ? '#6d28d9' : '#9e2b3a' }}>● {TERMS[id].short}</span>)}</div></div><div>{ids.map((id, i) => <Memory key={id} ledger={ledgers[i]} label={`${TERMS[id].short} · Request state × ${batch}`} />)}</div></div>
    <details><summary>Accounting assumptions · 展开各项公式与精度</summary><p>{ledgers[0].assumptions}</p>{ledgers.map((l, i) => <div key={ids[i]}><strong>{TERMS[ids[i]].short}</strong>{l.parts.map(p => <p key={p.id}>{p.label} · {p.note} · {p.elements.toLocaleString()} elements</p>)}</div>)}<p>此图只计所选单一机制的层栈。真实 GDN/KDA Hybrid 还含全 Attention KV；完整工作集不能按纯固定状态估计。</p></details>
    <div className="arch-lookup"><div><h4>Lookup memory <span>模型查表参数，与请求状态分开</span></h4><p className="arch-muted">权重存储估算；不乘 context 或并发。不包含 scale、索引与预取工作区。</p></div><label>Lookup table<select value={lookup} onChange={e => setLookup(Number(e.target.value))}><option value="0">None</option><option value="51">Qwen3.8 · N-gram 51B</option><option value="196">DeepSeek-V4.1 · Engram 196B</option></select></label><label>Assumed precision<select value={bits} onChange={e => setBits(Number(e.target.value))}>{[4, 8, 16].map(b => <option key={b} value={b}>{b} bit</option>)}</select></label><strong>{formatBytes(lookup * 1e9 * bits / 8)}</strong></div>
  </section>
}
export default function AttentionLab() {
  const [params, setParams] = useSearchParams(), raw = params.get('mechanism'), rawCompare = params.get('compare')
  const id = isMechanism(raw) ? raw : 'gqa', compare = isMechanism(rawCompare) && rawCompare !== id ? rawCompare : undefined
  const routeFrame = frameFromUrl(params.get('frame'), params.get('trace'), id)
  const [frame, setPlayhead] = useState(routeFrame), urlFrameKey = `${params.get('trace') ?? '1'}:${routeFrame}`
  const observedFrameKey = useRef(urlFrameKey)
  const [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1), [reset, setReset] = useState(0), [failed, setFailed] = useState(false), [progress, setProgress] = useState(0)
  const clock = useRef({ frame, progress: 0 }), [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const fallback = failed || reduced || params.get('view') === '2d', t = Math.floor(frame / PHASES)
  const focusOf = (key: string) => { const v = params.get(key); return v !== null && /^[0-3]$/.test(v) ? Number(v) : null }
  const update = (key: string, value: string) => setParams(p => { const next = new URLSearchParams(p); if (value) next.set(key, value); else next.delete(key); next.set('trace', TRACE_VERSION); next.set('frame', String(frame)); observedFrameKey.current = `${TRACE_VERSION}:${frame}`; return next }, { replace: true })
  const setFrame = (f: number) => setPlayhead(Math.max(0, Math.min(LAST_FRAME, f)))
  useEffect(() => {
    if (urlFrameKey !== observedFrameKey.current) { observedFrameKey.current = urlFrameKey; setPlayhead(routeFrame) }
  }, [urlFrameKey, routeFrame])
  useEffect(() => {
    if (frame === routeFrame && params.get('trace') === TRACE_VERSION) return
    // Coalesce scrubbing/rapid stepping; WebKit limits history writes per time window.
    // The scene clock stays immediate. Other navigation flushes the current playhead above.
    const timer = window.setTimeout(() => setParams(p => { const next = new URLSearchParams(p); next.set('trace', TRACE_VERSION); next.set('frame', String(frame)); observedFrameKey.current = `${TRACE_VERSION}:${frame}`; return next }, { replace: true }), 400)
    return () => window.clearTimeout(timer)
  }, [frame, routeFrame, params, setParams])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)'), listener = () => { setReduced(media.matches); if (media.matches) setPlaying(false) }
    media.addEventListener('change', listener); return () => media.removeEventListener('change', listener)
  }, [])
  useEffect(() => { const pause = () => { if (document.hidden) setPlaying(false) }; document.addEventListener('visibilitychange', pause); return () => document.removeEventListener('visibilitychange', pause) }, [])
  useEffect(() => {
    if (clock.current.frame !== frame) { clock.current = { frame, progress: 0 }; setProgress(0) }
    if (!playing) return
    let raf = 0, previous = performance.now(), lastPaint = 0
    const tick = (now: number) => {
      clock.current.progress = Math.min(1, clock.current.progress + (now - previous) * speed / 1500); previous = now
      if (now - lastPaint >= 30 || clock.current.progress === 1) { setProgress(clock.current.progress); lastPaint = now }
      if (clock.current.progress >= 1) { if (frame === LAST_FRAME) setPlaying(false); else setFrame(frame + 1); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf)
  }, [playing, frame, speed])
  const togglePlay = () => { if (!playing && (frame === LAST_FRAME || clock.current.progress >= 1)) { clock.current.progress = 0; setProgress(0); setFrame(0) } setPlaying(p => !p) }
  const seek = (f: number) => { setPlaying(false); setFrame(f) }, ids = compare ? [id, compare] : [id]
  return <section className="architecture-lab" aria-label="Attention 3D laboratory">
    <header className="arch-hero"><div><span className="arch-eyebrow">ATTENTION / A COMPUTATIONAL LAB · TRACE V2</span><h2>每一个 Head，都参与计算。</h2><p>从独立 Query 到共享记忆，再到完整 Attention Output。逐步查看真实的数据依赖。</p></div><Link className="arch-deep-link" to="/kda">KDA derivation <span>深入 Delta Rule →</span></Link></header>
    <div className="arch-box arch-lab-toolbar"><div className="arch-lab-selectors"><label>Mechanism<select aria-label="Primary mechanism" value={id} onChange={e => { setPlaying(false); update('mechanism', e.target.value) }}>{MECHANISMS.map(m => <option key={m} value={m}>{TERMS[m].short} · {TERMS[m].chinese}</option>)}</select></label><label>Synchronized comparison<select aria-label="Compare mechanism" value={compare ?? ''} onChange={e => update('compare', e.target.value)}><option value="">Single mechanism</option>{MECHANISMS.filter(m => m !== id).map(m => <option key={m} value={m}>{TERMS[m].short} · {TERMS[m].chinese}</option>)}</select></label><button className="arch-secondary" disabled={reduced || failed} onClick={() => update('view', fallback ? '' : '2d')}>{fallback ? '2D step view' : 'Switch to 2D'}</button><button className="arch-secondary" onClick={() => setReset(x => x + 1)}>Reset camera</button></div>
      <div className="arch-playback" onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === ' ') { e.preventDefault(); togglePlay() } if (e.key === 'ArrowRight') { e.preventDefault(); seek(frame + 1) } if (e.key === 'ArrowLeft') { e.preventDefault(); seek(frame - 1) } }} tabIndex={0} role="group" aria-label="Playback · Space play/pause, left/right step">
        <button className="arch-play" aria-label={playing ? 'Pause animation' : 'Play animation'} onClick={togglePlay}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button><button aria-label="Previous step" disabled={frame === 0} onClick={() => seek(frame - 1)}>←</button><button aria-label="Next step" disabled={frame === LAST_FRAME} onClick={() => seek(frame + 1)}>→</button><label className="arch-progress">Trace position<input aria-label="Trace position" type="range" min="0" max={LAST_FRAME} value={frame} onChange={e => seek(Number(e.target.value))} /></label><output data-testid="trace-position">{frame + 1} / {LAST_FRAME + 1}</output><label>Speed<select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[.5, 1, 2].map(v => <option key={v} value={v}>{v}×</option>)}</select></label>
      </div>
      <div className="arch-phase-progress" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></div>
      <div className="arch-phase-row"><div><button aria-pressed={t < PROMPT_TOKENS} onClick={() => seek(0)}>Prefill · t1–t5</button><button aria-pressed={t >= PROMPT_TOKENS} onClick={() => seek(PROMPT_TOKENS * PHASES)}>Decode · t6–t8</button></div><span aria-live="polite">{t < PROMPT_TOKENS ? 'Prefill' : 'Decode'} · t{t + 1} 「{TOKENS[t]}」 · Stage {frame % PHASES + 1}/{PHASES}</span></div>
      <p className="arch-muted">Prefill 可批量计算 Q/K/V，这里逐行观察 causal computation；Decode 每次追加一个 token。所有 Heads 在每个阶段一起计算；动画顺序表达数据依赖，不代表实际 Kernel 排程或吞吐。{fallback && ` ${reduced ? 'Reduced motion' : failed ? 'WebGL unavailable' : '手动选择'}：使用同一轨迹的 2D 视图。`}</p>
    </div>
    <div className={`arch-lab-panels ${compare ? 'is-comparing' : ''}`}>{ids.map((mechanism, i) => <Panel key={i} id={mechanism} frame={frame} progress={progress} fallback={fallback} reset={reset} focus={focusOf(i ? 'head2' : 'head')} onFocus={h => update(i ? 'head2' : 'head', h === null ? '' : String(h))} onUnavailable={() => setFailed(true)} onFrame={seek} />)}</div>
    <Growth ids={ids} />
  </section>
}
