import { cx } from '../lib/cx'

type Tone = 'success' | 'warning' | 'danger'

/** One interactive slider styled by the shared `range-bar` utility: the
 * track fill is an inline horizontal gradient that ends at the filled
 * share, so the bar never needs a second element to read as "full vs not". */
export function RangeBar({
  min,
  max,
  step,
  value,
  onChange,
  fillVar,
  disabled,
  ariaLabel,
}: {
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  /** CSS variable name (without `var()`) that colors the filled portion. */
  fillVar: string
  disabled?: boolean
  ariaLabel: string
}) {
  const pct = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
  return (
    <input
      type="range"
      className="range-bar"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        background: `linear-gradient(to right, var(--color-${fillVar}) 0%, var(--color-${fillVar}) ${pct * 100}%, var(--color-line) ${pct * 100}%, var(--color-line) 100%)`,
      }}
    />
  )
}

/** Risk tiers drive the bar's color and its plain-language label, so an
 * operator reads severity without parsing the number. The engine sizes
 * every entry as equity × risk% — 35% of the book per fill is a lever, not
 * a nitpick — so the bands rise to: conservative 1–15, balanced 16–40,
 * aggressive 41–70, maximum 71–100. */
export function riskTier(pct: number): { label: string; tone: Tone; fillVar: string } {
  if (pct <= 15) return { label: 'conservative', tone: 'success', fillVar: 'success' }
  if (pct <= 40) return { label: 'balanced', tone: 'warning', fillVar: 'accent' }
  if (pct <= 70) return { label: 'aggressive', tone: 'warning', fillVar: 'warning' }
  return { label: 'maximum', tone: 'danger', fillVar: 'danger' }
}

const toneClass: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

/** A precision entry rendered beside the bar: clamped typed value keeps the
 * bar and the number honest against the same 1–100 range. */
export function PercentEntry({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <input
      type="number"
      min={1}
      max={100}
      step={1}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = Number(e.target.value)
        if (Number.isFinite(next)) onChange(Math.min(100, Math.max(1, Math.round(next))))
      }}
      className="h-8 w-16 rounded-control border border-control bg-surface px-2 text-right text-[13px] t-num text-fg outline-none focus:border-accent disabled:opacity-60"
    />
  )
}

/** The interactive risk bar: drag or type a 1–100% per-entry risk, with the
 * tier label carrying the color. Controlled — parents own the number so
 * launch previews and PATCH flows stay in sync while dragging. */
export function RiskBar({
  value,
  onChange,
  disabled,
  hint,
  className,
}: {
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  /** One-line explanation rendered under the bar. */
  hint?: string
  className?: string
}) {
  const tier = riskTier(value)
  return (
    <div className={cx('grid gap-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] font-medium text-muted">Risk per entry</span>
        <span className="flex items-center gap-2">
          <span className={cx('t-num text-[12.5px] font-medium capitalize', toneClass[tier.tone])}>{tier.label}</span>
          <PercentEntry value={value} onChange={onChange} disabled={disabled} ariaLabel="Risk per entry (%)" />
          <span className="t-num text-[12.5px] text-faint">% of equity</span>
        </span>
      </div>
      <RangeBar
        min={1}
        max={100}
        step={1}
        value={value}
        onChange={onChange}
        fillVar={tier.fillVar}
        disabled={disabled}
        ariaLabel="Risk per entry"
      />
      {hint && <p className="text-[11.5px] leading-relaxed text-faint">{hint}</p>}
    </div>
  )
}
