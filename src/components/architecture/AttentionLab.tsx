import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { MECHANISMS, TERMS, isMechanism } from '../../data/architectureTerms'
import type { MechanismId } from '../../data/architectureTypes'
import { DIM, HEADS, INPUTS, PROMPT_TOKENS, RECURRENT_STAGES, STAGES, TOKENS, absorbedScore, buildAttentionTrace, isLatent, isRecurrent, latentOf, memoryLedger, ropeKey, upMatrix, type AttentionStep, type AttentionTrace, type MemoryLedger } from '../../lib/attention/engine'
import { Term } from './Term'
import './architecture.css'
const TraceScene = lazy(() => import('./TraceScene'))
const fmt = (v: number) => Number(v.toFixed(4)).toString()
export function formatBytes(bytes: number) { if (bytes === 0) return '0 B'; const i = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))); return `${Number((bytes / 1024 ** i).toFixed(2))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}` }
export function safeFrame(value: string | null) { if (value === null) return 27; const n = Number(value); return Number.isInteger(n) && n >= 0 && n < TOKENS.length * 5 ? n : 27 }
function Matrix({ values, label }: { values: readonly (readonly number[])[]; label: string }) {
  return <div className="arch-matrix-wrap"><span>{label} <small>{values.length} × {values[0]?.length ?? 0}</small></span><div className="arch-matrix" style={{ gridTemplateColumns: `repeat(${values[0]?.length ?? 1}, minmax(42px, 1fr))` }}>{values.flatMap((row, r) => row.map((v, c) => <span key={`${r}-${c}`} title={`[${r}, ${c}] = ${v}`} style={{ background: v < 0 ? `rgba(20,125,128,${Math.min(.4, .06 + Math.abs(v) * .18)})` : `rgba(158,43,58,${Math.min(.4, .04 + Math.abs(v) * .18)})` }}>{fmt(v)}</span>))}</div></div>
}
function Fallback({ id, step, stage, head, selection, select }: { id: MechanismId; step: AttentionStep; stage: number; head: number; selection: string; select: (id: string) => void }) {
  const h = step.heads[head], r = h.recurrent
  return <div className="arch-fallback" data-testid={`fallback-${id}`}>
    <div className="arch-fallback-heading"><strong>2D step view</strong><span>同一数值轨迹 · {r ? RECURRENT_STAGES[stage] : STAGES[stage]}</span></div>
    <div className="arch-head-row">{step.heads.map(h => <button key={h.head} aria-pressed={head === h.head} onClick={() => select(`head-${h.head}`)}>Q{h.head} → {r ? `S${h.head}` : `KV${h.kvHead}`}</button>)}</div>
    {r ? <Matrix label={stage === 0 ? 'State before' : stage < 3 ? 'Decayed State' : 'Updated State'} values={stage === 0 ? r.before : stage < 3 ? r.decayed : r.after} /> : <div className="arch-cache-grid">{h.entries.map(e => <button key={e.id} className={`${e.selected ? 'is-read' : ''} ${selection === `entry-${e.id}` ? 'is-selected' : ''}`} onClick={() => select(`entry-${e.id}`)}><strong>{e.kind === 'summary' ? e.label : `t${e.tokens[0] + 1}`}</strong><span>{e.kind === 'summary' ? `Summary ${e.tokens.map(t => t + 1).join('–')}` : e.label}</span><small>{e.selected ? `w = ${fmt(e.weight)}` : 'Not selected'}</small></button>)}</div>}
    <div className="arch-fallback-arrow">{r ? 'Decay → Prediction Error → Delta Write → Query Readout' : 'Q · Kᵀ → Scale → Causal Mask → Softmax → Σ wᵢVᵢ'}</div><Matrix values={[h.output]} label="Output" />
  </div>
}
const STAGE_HELP = [
  '新 token 从 Embedding 投影出自己的 Q、K、V；历史 K/V 可以复用，当前 token 的 K/V 仍然需要计算。',
  '确定本 Query 可以读取的因果位置。共享 Heads 改变缓存份数；Sparse Indexer 选择主 Attention 的读取集合。',
  '对选中的历史与当前 K 计算 q·k / √d，再执行 Softmax。未选中位置不进入主 Attention 的归一化。',
  '用同一组 Attention Weights 加权读取 V，形成当前 Head 的输出；多个 Head 再进入 Output Projection。',
  '提交本 token 的 K/V、latent 或压缩摘要。SWA 淘汰窗口外位置；稀疏读取本身不会删除历史缓存。',
]
const REC_HELP = [
  '新 token 产生 q、k、v 以及 gates；本教学 k 做 L2 normalization，固定 α、β，便于手算。',
  '先衰减历史 State。GDN 对所有 key channels 使用同一 α；KDA 为每个 channel 使用不同 α。',
  '以当前 k 从衰减后的 State 读出预测值，再用真实 v 减去预测值，得到需要纠正的残差。',
  '以 β · residual ⊗ k 增量写入 State。维度不随历史长度增长，已有关联会受到本次纠正影响。',
  '用当前 q 读取更新后的 State，得到输出。这里没有逐 token Softmax Weights；不是离散历史检索。',
]
function Memory({ ledger, label }: { ledger: MemoryLedger; label: string }) {
  return <div className="arch-memory"><div className="arch-memory-heading"><span>{label}</span><strong>{formatBytes(ledger.bytes)}</strong></div><div className="arch-memory-bar">{ledger.parts.filter(p => p.bytes).map((p, i) => <span key={p.id} title={`${p.label}: ${formatBytes(p.bytes)}`} style={{ width: `${p.bytes / ledger.bytes * 100}%`, background: ['#9e2b3a', '#6d28d9', '#147d80', '#b06d14'][i] }} />)}</div><dl>{ledger.parts.map(p => <div key={p.id}><dt title={p.note}>{p.label}</dt><dd>{p.elements.toLocaleString()} elements · {formatBytes(p.bytes)}</dd></div>)}</dl></div>
}
function Inspector({ step, head, selection, stage }: { trace: AttentionTrace; step: AttentionStep; head: number; selection: string; stage: number }) {
  const h = step.heads[head], r = h.recurrent, selectedEntry = h.entries.find(e => `entry-${e.id}` === selection)
  const selectedToken = selection.startsWith('token-') ? Number(selection.slice(6)) : undefined
  return <details className="arch-inspector" open><summary>Tensor inspector <span>{selectedEntry ? selectedEntry.label : selectedToken !== undefined ? `Embedding t${selectedToken + 1}` : selection.startsWith('state-') ? selection : `Head ${head}`}</span></summary>
    {selectedToken !== undefined ? <><Matrix values={[INPUTS[selectedToken]]} label={`x${selectedToken + 1} · ${TOKENS[selectedToken]}`} /><p className="arch-muted">固定教学输入，4 dimensions；不是实际 tokenizer / embedding 权重。</p></> : selectedEntry ? <><div className="arch-inline"><span className="arch-tag">{selectedEntry.kind}</span><span>Positions {selectedEntry.tokens.map(t => t + 1).join(', ')}</span><span>{selectedEntry.selected ? 'Read selected' : 'Masked by selection'}</span></div>{selectedEntry.latent && <Matrix values={[selectedEntry.latent]} label="Cached latent c" />}<Matrix values={[selectedEntry.key]} label="K · reconstructed when latent" /><Matrix values={[selectedEntry.value]} label="V · reconstructed when latent" /><p>Score {selectedEntry.score === null ? '—' : fmt(selectedEntry.score)} · Weight {fmt(selectedEntry.weight)}{selectedEntry.indexScore !== undefined && ` · Index score ${fmt(selectedEntry.indexScore)}`}</p></> : <>
      <Matrix values={[h.q]} label="q" /><div className="arch-grid-2"><Matrix values={[h.k]} label="New k" /><Matrix values={[h.v]} label="New v" /></div>
      {r && <><p className="arch-muted">α = [{r.alpha.join(', ')}] · β = {r.beta} · State rows = value channels / columns = key channels</p><div className="arch-grid-2"><Matrix values={[r.prediction]} label="Prediction = S̄ k" /><Matrix values={[r.residual]} label="Residual = v − prediction" /></div>{selection.startsWith('state-') && <p className="arch-note">{(() => { const [, row, col] = selection.split('-').map(Number); return `S[${row},${col}]：${fmt(r.before[row][col])} → decay ${fmt(r.decayed[row][col])} + write ${fmt(r.write[row][col])} = ${fmt(r.after[row][col])}` })()}</p>}</>}
      <Matrix values={[h.output]} label="Output after aggregation / readout" />
    </>}
    <p className="arch-muted">当前高亮：{r ? RECURRENT_STAGES[stage] : STAGES[stage]}。Inspector 保留本 token 的完整计算结果，便于前后步骤复核。</p>
  </details>
}
function Formula({ trace, step, head }: { trace: AttentionTrace; step: AttentionStep; head: number }) {
  const h = step.heads[head], r = h.recurrent
  return <details className="arch-formula"><summary>Equations & full matrices · 展开公式与完整数值</summary>
    <pre>{r ? 'S̄ = Sₜ₋₁ diag(αₜ)\nprediction = S̄ kₜ\nr = vₜ − prediction\nΔS = βₜ r kₜᵀ\nSₜ = S̄ + ΔS\noₜ = Sₜ qₜ' : isLatent(trace.mechanism) ? 'cₜ = Wᴰ xₜ  (2 dimensions)\nkⱼ = [Uₖ cⱼ ; kᴿⱼ]   vⱼ = Uᵥ cⱼ\nscoreⱼ = ((Uₖᵀ q)ᵀ cⱼ + qᴿᵀ kᴿⱼ) / √6\nw = softmax(score over selected causal positions)\no = Uᵥ (Σⱼ wⱼ cⱼ)' : 'head_to_KV(h) = floor(h × Hkv / Hq)\nscoreⱼ = q · kⱼ / √d\nmaskⱼ = −∞ for j > t or unselected j\nw = softmax(score + mask)\no = Σⱼ wⱼ vⱼ'}</pre>
    {r ? <div className="arch-grid-2"><Matrix values={r.before} label="S before" /><Matrix values={r.decayed} label="S̄ · decayed" /><Matrix values={r.write} label="ΔS · write" /><Matrix values={r.after} label="S after" /></div> : <>
      {isLatent(trace.mechanism) && <><Matrix values={upMatrix(head)} label="Uₖ · 4×2" /><Matrix values={upMatrix((head + 1) % HEADS)} label="Uᵥ · 4×2" /><p>当前 token 的 absorbed score = {fmt(absorbedScore(h.q.slice(0, 4), latentOf(step.t), upMatrix(head), ropeKey(step.t), ropeKey(step.t)))}。与显式重建 K 的 q·k/√6 相同。</p></>}
      <div className="arch-table-scroll"><table><thead><tr><th>Entry / Positions</th><th>Indexer</th><th>Score</th><th>Weight</th><th>V</th></tr></thead><tbody>{h.entries.map(e => <tr key={e.id}><td>{e.label} · {e.tokens.map(t => t + 1).join(',')}</td><td>{e.indexScore === undefined ? '—' : fmt(e.indexScore)}</td><td>{e.score === null ? 'masked' : fmt(e.score)}</td><td>{fmt(e.weight)}</td><td>[{e.value.map(fmt).join(', ')}]</td></tr>)}</tbody></table></div>
      <p className="arch-muted">教学 projection：q=L2Norm(rotate(x,h))；非 latent 的 k=L2Norm(rotate(x,KV head))，v=rotate(x,KV head)⊙[1,.5,1,.5]。MLA：c=[(x₀+x₂)/2,(x₁+x₃)/2]，RoPE=[cos(t/2),sin(t/2)]；t 从 0 开始。压缩机制使用块均值；完整选择逻辑见扩展文档。</p>
    </>}
  </details>
}
function Weights({ trace, head, t, selectStep }: { trace: AttentionTrace; head: number; t: number; selectStep: (t: number) => void }) {
  if (isRecurrent(trace.mechanism)) return <div className="arch-weight-note"><strong>No token Softmax</strong><p>State 通过 decay 与 delta write 保留关联，不能把 State 中的数值解释为历史 token 的概率。</p></div>
  const compressed = trace.mechanism === 'csa' || trace.mechanism === 'hca'
  return <div className="arch-weights"><div className="arch-section-heading"><strong>{compressed ? 'Summary contribution map' : 'Attention Weights'}</strong><small>Q{head} · causal positions</small></div><div className="arch-heatmap"><span />{TOKENS.map((_, i) => <small key={i}>{i + 1}</small>)}{trace.steps.map((s, row) => <div className="arch-heatmap-row" key={row}><button aria-label={`Inspect query token ${row + 1}`} onClick={() => selectStep(row)} className={t === row ? 'is-current' : ''}>{row + 1}</button>{s.heads[head].tokenWeights.map((w, col) => <span key={col} title={row > t ? 'Future step' : `Q token ${row + 1} → ${col + 1}: ${fmt(w)}`} style={{ background: row > t || col > row ? '#eee9df' : `rgba(158,43,58,${.05 + w * .9})`, color: w > .55 ? 'white' : '#6e6a60' }}>{row <= t && col <= row ? w.toFixed(2) : '·'}</span>)}</div>)}</div><p className="arch-muted">{compressed ? '摘要权重平均摊回所含 token，仅用于覆盖可视化；不是原始 token-level Attention Weights。' : '行 = Query token，列 = Key token。灰色未来位置被 Causal Mask 屏蔽；稀疏未选中位置为 0。'}</p></div>
}
function Panel({ id, frame, fallback, reset, playing, onUnavailable, onFrame }: { id: MechanismId; frame: number; fallback: boolean; reset: number; playing: boolean; onUnavailable: () => void; onFrame: (frame: number) => void }) {
  const trace = useMemo(() => buildAttentionTrace(id), [id]), t = Math.floor(frame / 5), stage = frame % 5, step = trace.steps[t]
  const [head, setHead] = useState(0), [selection, setSelection] = useState('head-0')
  const select = (key: string) => { if (key.startsWith('head-')) setHead(Number(key.slice(5))); setSelection(key) }
  useEffect(() => { setSelection(`head-${head}`) }, [id, t, head])
  return <article className="arch-lab-panel">
    <header><div><h3><Term id={id} full /></h3><span className="arch-muted">{TERMS[id].chinese}</span></div><span className={`arch-fidelity ${trace.fidelity}`}>{trace.fidelity === 'numeric' ? 'Reproducible math' : 'Teaching implementation'}</span></header>
    <p className="arch-intuition">{TERMS[id].explanation}</p>
    {fallback ? <Fallback id={id} step={step} stage={stage} head={head} selection={selection} select={select} /> : <Suspense fallback={<div className="arch-three-scene arch-loading">Loading 3D scene…</div>}><TraceScene playing={playing} mechanism={id} step={step} stage={stage} head={head} selection={selection} onSelect={select} cameraReset={reset} onUnavailable={onUnavailable} /></Suspense>}
    <div className="arch-token-strip" aria-label="Embedding tokens">{TOKENS.map((token, i) => <button key={i} onClick={() => select(`token-${i}`)} className={i === t ? 'is-current' : i > t ? 'is-future' : ''} title={`Inspect embedding t${i + 1}`}><small>t{i + 1}</small>{token}</button>)}</div>
    <div className="arch-scene-tools"><label>Inspect Q Head<select aria-label={`Inspect ${TERMS[id].short} Q Head`} value={head} onChange={e => select(`head-${e.target.value}`)}>{step.heads.map(h => <option key={h.head} value={h.head}>Q{h.head} → {isRecurrent(id) ? `State ${h.head}` : `KV${h.kvHead}`}</option>)}</select></label><label>Tensor<select aria-label={`Inspect ${TERMS[id].short} tensor`} value={selection} onChange={e => select(e.target.value)}><option value={`head-${head}`}>Q / New K,V / Output</option>{TOKENS.map((token, i) => <option key={i} value={`token-${i}`}>Embedding t{i + 1} · {token}</option>)}<option value="output">Output</option>{step.heads[head].entries.map(e => <option key={e.id} value={`entry-${e.id}`}>{e.kind === 'summary' ? 'Summary' : 'Cache'} · {e.label}</option>)}{Array.from({ length: isRecurrent(id) ? DIM * DIM : 0 }, (_, i) => <option key={i} value={`state-${Math.floor(i / DIM)}-${i % DIM}`}>S[{Math.floor(i / DIM)},{i % DIM}]</option>)}</select></label></div>
    <ol className="arch-stages">{(isRecurrent(id) ? RECURRENT_STAGES : STAGES).map((s, i) => <li key={s}><button className={stage === i ? 'is-current' : ''} onClick={() => onFrame(t * 5 + i)} aria-current={stage === i ? 'step' : undefined}><small>{i + 1}</small>{s}</button></li>)}</ol>
    <div className="arch-step-explanation"><strong>{isRecurrent(id) ? RECURRENT_STAGES[stage] : STAGES[stage]}</strong><p>{(isRecurrent(id) ? REC_HELP : STAGE_HELP)[stage]}</p></div>
    <div className="arch-read-stats"><div><span>Indexer candidates</span><strong>{step.indexCandidates || '—'}</strong></div><div><span>Main entries read / Q head</span><strong>{isRecurrent(id) ? 'State' : step.mainEntriesRead}</strong></div><div><span>Historical positions evicted</span><strong>{step.evictedTokens.length}</strong></div></div>
    {step.layerModes.length > 0 && <div className="arch-note">CED / CSA2 · L1 Full → L2 Reindex → L3 Reuse → L4 Reuse。Global KV 与 Indexer K 跨层同一份，Reuse 引用 Top-K IDs；层模式仅演示共享关系。</div>}
    <Memory ledger={step.memory} label={`After t${t + 1} · ${step.memory.elements.toLocaleString()} state elements`} />
    <div className="arch-panel-details"><Weights trace={trace} head={head} t={t} selectStep={row => onFrame(row * 5 + 2)} /><Inspector trace={trace} step={step} stage={stage} head={head} selection={selection} /></div>
    <Formula trace={trace} step={step} head={head} />
    <p className="arch-disclosure">{trace.simplification} <a href={TERMS[id].sourceUrl} target="_blank" rel="noreferrer">Official definition ↗</a></p>
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
  const frame = safeFrame(params.get('frame')), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1), [reset, setReset] = useState(0), [failed, setFailed] = useState(false)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const resumeAfterReset = useRef(false)
  const fallback = failed || reduced || params.get('view') === '2d', t = Math.floor(frame / 5)
  const update = (key: string, value: string) => setParams(p => { if (value) p.set(key, value); else p.delete(key); return p }, { replace: true })
  const setFrame = (f: number) => update('frame', String(Math.max(0, Math.min(39, f))))
  const togglePlay = () => {
    if (frame === 39) { resumeAfterReset.current = true; setFrame(0) }
    else setPlaying(p => !p)
  }
  useEffect(() => { if (resumeAfterReset.current && frame === 0) { resumeAfterReset.current = false; setPlaying(true) } }, [frame])
  useEffect(() => { const media = window.matchMedia('(prefers-reduced-motion: reduce)'); const listener = () => setReduced(media.matches); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener) }, [])
  useEffect(() => { const pause = () => { if (document.hidden) setPlaying(false) }; document.addEventListener('visibilitychange', pause); return () => document.removeEventListener('visibilitychange', pause) }, [])
  useEffect(() => { if (!playing) return; if (frame === 39) { setPlaying(false); return } const timer = window.setTimeout(() => setFrame(frame + 1), 1250 / speed); return () => clearTimeout(timer) }, [playing, frame, speed]) // timer owns exactly one trace step
  const ids = compare ? [id, compare] : [id]
  return <section className="architecture-lab" aria-label="Attention 3D laboratory">
    <header className="arch-hero"><div><span className="arch-eyebrow">ATTENTION / A COMPUTATIONAL LAB</span><h2>把一次 Attention，看清楚。</h2><p>相同输入，不同记忆方式。跟随 token，观察读取、计算、写入，再用数值复核。</p></div><Link className="arch-deep-link" to="/kda">KDA derivation <span>深入 Delta Rule →</span></Link></header>
    <div className="arch-box arch-lab-toolbar"><div className="arch-lab-selectors"><label>Mechanism<select aria-label="Primary mechanism" value={id} onChange={e => { setPlaying(false); update('mechanism', e.target.value) }}>{MECHANISMS.map(m => <option key={m} value={m}>{TERMS[m].short} · {TERMS[m].chinese}</option>)}</select></label><label>Synchronized comparison<select aria-label="Compare mechanism" value={compare ?? ''} onChange={e => update('compare', e.target.value)}><option value="">Single mechanism</option>{MECHANISMS.filter(m => m !== id).map(m => <option key={m} value={m}>{TERMS[m].short} · {TERMS[m].chinese}</option>)}</select></label><button className="arch-secondary" disabled={reduced || failed} onClick={() => update('view', fallback ? '' : '2d')}>{fallback ? '2D step view' : 'Switch to 2D'}</button><button className="arch-secondary" onClick={() => setReset(x => x + 1)}>Reset camera</button></div>
      <div className="arch-playback" onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === ' ') { e.preventDefault(); togglePlay() } if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); setFrame(frame + 1) } if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); setFrame(frame - 1) } }} tabIndex={0} role="group" aria-label="Playback · Space play/pause, left/right step">
        <button className="arch-play" aria-label={playing ? 'Pause animation' : 'Play animation'} onClick={togglePlay}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button><button aria-label="Previous step" disabled={frame === 0} onClick={() => { setPlaying(false); setFrame(frame - 1) }}>←</button><button aria-label="Next step" disabled={frame === 39} onClick={() => { setPlaying(false); setFrame(frame + 1) }}>→</button><label className="arch-progress">Trace position <input aria-label="Trace position" type="range" min="0" max="39" value={frame} onChange={e => { setPlaying(false); setFrame(Number(e.target.value)) }} /></label><output data-testid="trace-position">{frame + 1} / 40</output><label>Speed<select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[.5, 1, 2].map(v => <option key={v} value={v}>{v}×</option>)}</select></label>
      </div>
      <div className="arch-phase-row"><div><button aria-pressed={t < PROMPT_TOKENS} onClick={() => { setPlaying(false); setFrame(0) }}>Prefill · t1–t5</button><button aria-pressed={t >= PROMPT_TOKENS} onClick={() => { setPlaying(false); setFrame(25) }}>Decode · t6–t8</button></div><span aria-live="polite">{t < PROMPT_TOKENS ? 'Prefill' : 'Decode'} · t{t + 1} 「{TOKENS[t]}」 · Stage {frame % 5 + 1}/5</span></div>
      <p className="arch-muted">Prefill 的 Q/K/V 可批量生成，这里逐行观察 causal computation；Decode 每次追加一个 token。动画速度与路径运动仅用于讲解，不代表真实吞吐。{fallback && ` ${reduced ? 'Reduced motion' : failed ? 'WebGL unavailable' : '手动选择'}：已使用同一轨迹的 2D 视图。`}</p>
    </div>
    <div className={`arch-lab-panels ${compare ? 'is-comparing' : ''}`}>{ids.map((mechanism, i) => <Panel key={i} id={mechanism} frame={frame} fallback={fallback} reset={reset} playing={playing} onUnavailable={() => setFailed(true)} onFrame={f => { setPlaying(false); setFrame(f) }} />)}</div>
    <Growth ids={ids} />
  </section>
}
