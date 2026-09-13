import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ARCHITECTURE_MODELS, CATALOG_VERSION, CATALOG_VERIFIED_ON, CLASSIC_BASELINE, getArchitectureModel, modelSearchText, parameterLabel } from '../data/architectureModels'
import { ARCHITECTURE_AXES, type ArchitectureModel } from '../data/architectureTypes'
import { TERMS } from '../data/architectureTerms'
import { Glossary, Term } from './architecture/Term'
import './architecture/architecture.css'

const kinds = { model: 'Whole-model result · 整模型', ablation: 'Module ablation · 模块消融', runtime: 'Runtime result · 运行时', architecture: 'Architecture measurement · 架构测量' }
function Evidence({ model }: { model: ArchitectureModel }) {
  return <section aria-label={`${model.name} official evidence`}>
    <h4>Official evidence <span>官方结果与条件</span></h4>
    <p className="arch-muted">不同测试口径分别阅读。整模型结果包含数据、训练与架构共同影响；没有消融证据时，不归因于单个模块。</p>
    {!model.evidence.length && <div className="arch-note">未录入可完整追溯的量化结果。官方评测入口见本卡片 Sources。</div>}
    <div className="arch-evidence-grid">{model.evidence.slice(0, 3).map(e => {
      const s = model.sources.find(s => s.id === e.sourceId)!
      return <article key={e.id} className="arch-evidence">
        <small>{kinds[e.kind]}</small><div className="arch-result">{e.value} <span>{e.unit}</span></div>
        <strong>{e.metric}</strong><p>Baseline · {e.baseline}{e.baselineValue !== undefined ? ` (${e.baselineValue} ${e.unit})` : ''}</p>
        <p>{e.conditions}</p><a href={s.url} target="_blank" rel="noreferrer">{s.title} ↗</a><small>{e.locator} · {s.locator} · 核验 {s.verifiedOn}</small>
      </article>
    })}</div>
  </section>
}
function ModelDetails({ model }: { model: ArchitectureModel }) {
  const previous = getArchitectureModel(model.predecessorId ?? null)
  const [baseline, setBaseline] = useState(previous ? 'previous' : 'classic')
  const baseChanges = baseline === 'previous' && previous ? previous.changes : CLASSIC_BASELINE
  const p = model.parameters
  return <div className="arch-model-details">
    <div className="arch-flow" aria-label="Overall architecture">{model.topology.map((node, i) => <div key={i} className="arch-flow-node"><span className="arch-eyebrow">{String(i + 1).padStart(2, '0')}</span><strong>{node.label}</strong><p>{node.detail}</p></div>)}</div>
    {model.releaseNote && <p className="arch-note">Release date · {model.releaseNote}</p>}
    <section><h4>Parameter accounting <span>不同参数口径独立记录</span></h4>
      <dl className="arch-parameters">{[
        ['Backbone', p.backboneB], ['Activated', p.activeB], ['Prefill activated', p.prefillActiveB], ['Decode activated', p.decodeActiveB], ['Lookup memory', p.lookupB], ['Prediction head', p.predictionHeadB],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'number' ? `${value}B` : '未披露'}</dd></div>)}</dl>
      {p.note && <p className="arch-muted">{p.note}</p>}
      {model.variants && <p className="arch-note">Variants · {model.variants.join('；')}</p>}
    </section>
    <section>
      <div className="arch-section-heading"><h4>Architecture changes <span>逐项观察</span></h4><label>Baseline <select aria-label="Architecture baseline" value={baseline} onChange={e => setBaseline(e.target.value)}>
        {previous && <option value="previous">{previous.name}</option>}<option value="classic">Classic Transformer</option>
      </select></label></div>
      <div className="arch-axis-grid">{ARCHITECTURE_AXES.map(axis => {
        const c = model.changes.find(c => c.axis === axis.id)!, b = baseChanges.find(c => c.axis === axis.id)!
        return <article className={`arch-axis ${c.disclosed ? '' : 'arch-undisclosed'}`} key={axis.id}>
          <span className="arch-eyebrow">{axis.english} · {axis.chinese}</span><small className="arch-baseline">Baseline · {b.label}</small>
          <h5>{c.label}</h5><p>{c.explanation}</p><p className="arch-impact">Inference impact · {c.implication}</p>
          <div className="arch-inline">{c.terms.map(t => <span className="arch-tag" key={t}><Term id={t} full /></span>)}</div>
          <div className="arch-source-links">{c.sourceIds.map(id => { const s = model.sources.find(s => s.id === id); return s && <a key={id} href={s.url} title={s.locator} target="_blank" rel="noreferrer">{s.title} ↗</a> })}</div>
        </article>
      })}</div>
    </section>
    <Evidence model={model} />
    <p className="arch-muted">Weights revision · <code>{model.weightsRevision?.slice(0, 12) ?? '未披露'}</code> · 官方模型卡与配置链接固定到核验版本。</p>
    <details className="arch-sources"><summary>Sources · 来源位置与最后核验</summary>{model.sources.map(s => <p key={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.title} ↗</a> · {s.locator} · {s.verifiedOn}</p>)}</details>
    <p className="arch-muted">License · {model.license}　Release · {model.released}　Verified · {model.verifiedOn}　<a href={model.weightsUrl} target="_blank" rel="noreferrer">Official weights ↗</a></p>
  </div>
}
function Comparison({ models }: { models: ArchitectureModel[] }) {
  return <section className="arch-box arch-comparison" aria-label="Model comparison"><h3>Architecture comparison <span>{models.length} models · 同一观察维度</span></h3>
    <div className="arch-table-scroll"><table><thead><tr><th>Dimension</th>{models.map(m => <th key={m.id}>{m.name}</th>)}</tr></thead>
      <tbody><tr><th>Parameters</th>{models.map(m => <td key={m.id}>{parameterLabel(m)}<p className="arch-muted">Lookup {m.parameters.lookupB ?? '未披露'}{m.parameters.lookupB !== undefined ? 'B' : ''} · Head {m.parameters.predictionHeadB ?? '未披露'}{m.parameters.predictionHeadB !== undefined ? 'B' : ''}</p></td>)}</tr>
        {ARCHITECTURE_AXES.map(a => <tr key={a.id}><th>{a.english}<small>{a.chinese}</small></th>{models.map(m => { const c = m.changes.find(c => c.axis === a.id)!; return <td key={m.id}><strong>{c.label}</strong><p>{c.explanation}</p></td> })}</tr>)}
        <tr><th>Evidence</th>{models.map(m => <td key={m.id}>{m.evidence.length ? m.evidence.slice(0, 3).map(e => <p key={e.id}><a href={m.sources.find(s => s.id === e.sourceId)!.url} target="_blank" rel="noreferrer">{e.metric} · {e.value} {e.unit} ↗</a><small>{e.conditions}</small></p>) : '未披露可比较的量化结果'}</td>)}</tr>
        <tr><th>License / Verified</th>{models.map(m => <td key={m.id}>{m.license}<small>{m.verifiedOn}</small><a href={m.weightsUrl} target="_blank" rel="noreferrer">Official weights ↗</a></td>)}</tr>
      </tbody></table></div>
  </section>
}
export default function ModelEvolution() {
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(''), [vendor, setVendor] = useState('all'), [feature, setFeature] = useState('all')
  const openId = params.get('model')
  const compareIds = [...new Set((params.get('models') ?? '').split(','))].filter(id => getArchitectureModel(id)).slice(0, 3)
  const update = (key: string, value: string) => setParams(p => { if (value) p.set(key, value); else p.delete(key); return p }, { replace: true })
  const models = useMemo(() => ARCHITECTURE_MODELS.filter(m => (!query || modelSearchText(m).includes(query.toLowerCase())) && (vendor === 'all' || m.vendor === vendor) && (feature === 'all' || m.changes.some(c => c.terms.includes(feature as never)))), [query, vendor, feature])
  const toggleCompare = (id: string) => update('models', (compareIds.includes(id) ? compareIds.filter(x => x !== id) : [...compareIds, id].slice(0, 3)).join(','))
  return <div className="architecture-catalog">
    <header className="arch-hero"><div><div className="arch-eyebrow">ARCHITECTURE ATLAS / {CATALOG_VERIFIED_ON}</div><h2>理解每一次架构变化。</h2><p>从 Embedding 到 Decode，沿八个维度观察开放权重模型。结构、推理影响与官方证据，一起阅读。</p></div><div className="arch-hero-count"><strong>{ARCHITECTURE_MODELS.length}</strong><span>Architecture profiles</span><small>Snapshot {CATALOG_VERSION}</small></div></header>
    <div className="arch-filters arch-box"><label className="arch-search">Search models<input type="search" placeholder="名称、架构、英文术语…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>Provider<select aria-label="Provider" value={vendor} onChange={e => setVendor(e.target.value)}><option value="all">All providers</option>{[...new Set(ARCHITECTURE_MODELS.map(m => m.vendor))].sort().map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Architecture feature<select aria-label="Architecture feature" value={feature} onChange={e => setFeature(e.target.value)}><option value="all">All features</option>{Object.values(TERMS).map(t => <option key={t.id} value={t.id}>{t.short} · {t.chinese}</option>)}</select></label><span className="arch-muted">{models.length} models · Newest first</span>
    </div>
    <div className="arch-compare-bar"><strong>Compare {compareIds.length}/3</strong><span>{compareIds.length ? compareIds.map(id => <button key={id} onClick={() => toggleCompare(id)} title="移出对比">{getArchitectureModel(id)!.name} ×</button>) : '勾选 2–3 个模型，逐项并排比较'}</span>{compareIds.length > 0 && <button className="arch-link-button" onClick={() => update('models', '')}>Clear</button>}</div>
    {compareIds.length >= 2 && <Comparison models={compareIds.map(id => getArchitectureModel(id)!)} />}
    {!models.length && <div className="arch-box">没有匹配的模型。<button onClick={() => { setQuery(''); setVendor('all'); setFeature('all') }}>清除筛选</button></div>}
    {models.map(m => {
      const open = openId === m.id
      const highlights = ['attention', 'residual', m.changes.find(c => c.axis === 'input')?.terms.some(t => ['ngram', 'engram'].includes(t)) ? 'input' : 'ffn'].map(a => m.changes.find(c => c.axis === a && c.disclosed)).filter(Boolean)
      const mainEvidence = m.evidence[0]
      return <article className={`arch-model ${open ? 'is-open' : ''}`} key={m.id}>
        <div className="arch-model-heading"><button className="arch-model-toggle" aria-expanded={open} aria-controls={`detail-${m.id}`} onClick={() => update('model', open ? '' : m.id)}>
          <span className="arch-model-date">{m.released}<small>{m.vendor}</small></span><span className="arch-model-title"><strong>{m.name}</strong><span>{parameterLabel(m)} <i>Context {m.context}</i></span></span><span className="arch-expand">{open ? '−' : '+'}</span>
        </button><label className="arch-checkbox"><input type="checkbox" aria-label={`Compare ${m.name}`} checked={compareIds.includes(m.id)} disabled={!compareIds.includes(m.id) && compareIds.length >= 3} onChange={() => toggleCompare(m.id)} /> Compare</label></div>
        <div className="arch-model-brief"><p>{m.summary}</p><div className="arch-inline">{highlights.map(c => c && <span className="arch-tag" key={c.axis}>{c.label}</span>)}</div>
          <div className="arch-model-meta"><div className="arch-inline">{m.mechanisms.map(id => <Link key={id} className="arch-mechanism-link" onClick={() => window.scrollTo({ top: 0, behavior: 'instant' })} to={`/architecture?tab=attention&mechanism=${id}&model=${m.id}`} title={`${TERMS[id].english} · ${TERMS[id].chinese}`}>{TERMS[id].short} <span>3D ↗</span></Link>)}</div>
          {mainEvidence && <a className="arch-key-result" href={m.sources.find(s => s.id === mainEvidence.sourceId)!.url} target="_blank" rel="noreferrer">{mainEvidence.metric} <strong>{mainEvidence.value} {mainEvidence.unit}</strong> · {kinds[mainEvidence.kind]} ↗</a>}</div>
          <div className="arch-card-footer"><span>License · {m.license}</span><span>Verified · {m.verifiedOn}</span><a href={m.weightsUrl} target="_blank" rel="noreferrer">Official weights ↗</a></div>
        </div>
        {open && <div id={`detail-${m.id}`}><ModelDetails model={m} /></div>}
      </article>
    })}
    <Glossary />
    <p className="arch-muted">目录独立于旧 ModelSpec / KVSpec。复杂模型暂不自动加入显存计算器；“未披露”不代表不存在。仅提供月份的发布记录按月排序，同月不推断先后。</p>
  </div>
}
