import type { ButtonHTMLAttributes, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

export const fieldClass =
  'mt-1 min-h-11 w-full min-w-0 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-fg focus:border-accent'
export function Button({
  children,
  primary = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${primary ? 'border-accent bg-accent text-white hover:bg-accent/90' : 'border-line bg-panel text-fg hover:bg-panel-2'} ${props.className ?? ''}`}
    >
      {children}
    </button>
  )
}
export function Card({
  title,
  kicker,
  children,
  className = '',
}: {
  title?: string
  kicker?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-panel p-4 shadow-sm sm:p-5 ${className}`}>
      {kicker && <p className="mb-1 text-[11px] font-bold tracking-[0.16em] text-accent">{kicker}</p>}
      {title && <h3 className="mb-3 text-base font-bold">{title}</h3>}
      {children}
    </section>
  )
}
export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-panel p-3">
      <p className="text-xs text-dim">{label}</p>
      <p className="my-1 break-words font-mono text-xl font-semibold sm:text-2xl">{value}</p>
      {detail && <p className="text-[11px] text-dim">{detail}</p>}
    </div>
  )
}
export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 1000000,
  step = 1,
  hint,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  step?: number
  hint?: string
}) {
  return (
    <label className="block min-w-0 text-xs text-dim">
      {label}
      <input
        className={fieldClass}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = e.currentTarget.valueAsNumber
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)))
        }}
      />
      {hint && <span className="mt-1 block text-[11px]">{hint}</span>}
    </label>
  )
}
export function Note({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return (
    <div
      className={`rounded-xl border p-3 text-sm leading-relaxed ${warn ? 'border-warn/20 bg-warn/5 text-warn' : 'border-accent/15 bg-accent/5 text-fg'}`}
    >
      {children}
    </div>
  )
}
export function Formula({ formula }: { formula: string }) {
  return (
    <div className="overflow-x-auto rounded-lg bg-panel-2 px-3 py-2 text-sm">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{`$$\n${formula}\n$$`}</ReactMarkdown>
    </div>
  )
}
export const percent = (n: number) => `${(n * 100).toFixed(1)}%`
export const decimal = (n: number, digits = 3) => n.toFixed(digits)
export const dollars = (n: number | null) =>
  n === null ? 'N/A' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
