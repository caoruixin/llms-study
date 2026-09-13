import { TERMS } from '../../data/architectureTerms'
import type { TermId } from '../../data/architectureTypes'

export function Term({ id, full = false }: { id: TermId; full?: boolean }) {
  const t = TERMS[id]
  return <span title={`${t.english} · ${t.chinese}\n${t.explanation}`}>{full && t.short !== t.english ? `${t.short} · ${t.english}` : t.short}</span>
}
export function Glossary() {
  return <details className="arch-box arch-glossary">
    <summary>Terminology · 统一术语表 <span className="arch-muted">English term / 中文解释 / 官方定义</span></summary>
    <div className="arch-grid-2">{Object.values(TERMS).map(t => <div key={t.id}>
      <a href={t.sourceUrl} target="_blank" rel="noreferrer"><strong><Term id={t.id} full /> ↗</strong></a>
      <p>{t.chinese} · {t.explanation}</p>
    </div>)}</div>
  </details>
}
