import { motion } from 'motion/react'
import { useId, useState } from 'react'

import { cx } from '../lib/cx'
import { moneyCompact } from '../lib/format'

// Small SVG charts: no dependency, crisp at any size, easy to restyle.

export type ChartFormatter = (value: number) => string

/** Area chart of a single series. `zeroBaseline` anchors the fill to the domain
 * minimum so negative-moving series render honestly. Callers pass `format`
 * when the series isn't money (e.g. percentages). */
export function AreaChart({
  data,
  height = 220,
  className,
  format = moneyCompact,
  stroke,
  fill,
}: {
  data: { label: string; value: number }[]
  height?: number
  className?: string
  format?: ChartFormatter
  stroke?: string
  fill?: string
}) {
  const gradientId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const w = 600
  const h = height
  const padLeft = 52
  const padRight = 12
  const padTop = 14
  const padBottom = 30
  const innerW = w - padLeft - padRight
  const lo = Math.min(...data.map((d) => d.value))
  const hi = Math.max(...data.map((d) => d.value))
  const span = hi - lo || Math.abs(hi) || 1
  const max = hi + span * 0.12
  const min = lo > 0 ? 0 : lo - span * 0.12
  const y = (v: number) => padTop + (h - padTop - padBottom) * (1 - (v - min) / (max - min))
  const step = data.length > 1 ? innerW / (data.length - 1) : 0
  const points = data.map((d, i) => ({ x: padLeft + i * step, y: y(d.value) }))
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const baseline = y(Math.max(min, 0))
  const area = `${line} L${points[points.length - 1]?.x ?? padLeft},${baseline} L${padLeft},${baseline} Z`
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * (max - min))
  // Label a handful of points instead of every one, so long series stay readable.
  const labelEvery = Math.max(1, Math.ceil(data.length / 6))
  const color = stroke ?? 'var(--color-accent)'
  return (
    <div className={cx('relative', className)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={fill ?? color} stopOpacity="0.22" />
            <stop offset="1" stopColor={fill ?? color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={padLeft}
              x2={w - padRight}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--color-line)"
              strokeDasharray="2 4"
            />
            <text x={padLeft - 8} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize="11" fill="var(--color-faint)">
              {format(t)}
            </text>
          </g>
        ))}
        <motion.path d={area} fill={`url(#${gradientId})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.3 }} />
        <motion.path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: 'easeInOut' }}
        />
        {points.map((p, i) => (
          <g key={i}>
            <rect
              x={p.x - step / 2}
              y={0}
              width={step || w}
              height={h - padBottom}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
            {hover === i && (
              <>
                <line x1={p.x} x2={p.x} y1={padTop} y2={h - padBottom} stroke="var(--color-line-strong)" />
                <circle cx={p.x} cy={p.y} r="5" fill="var(--color-surface)" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
              </>
            )}
          </g>
        ))}
        {data.map((d, i) => {
          const isEdge = i === 0 || i === data.length - 1
          if (!isEdge && i % labelEvery !== 0) return null
          return (
            <text key={`${i}-${d.label}`} x={points[i].x} y={h - 8} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fontSize="12" fill="var(--color-faint)">
              {d.label}
            </text>
          )
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 -translate-x-1/2 rounded-tile bg-fg px-2.5 py-1.5 text-[12px] font-medium text-bg shadow-pop"
          style={{ left: `${((points[hover].x) / w) * 100}%` }}
        >
          {data[hover].label} · {format(data[hover].value)}
        </div>
      )}
    </div>
  )
}

/** Equity series → drawdown below the running peak. Fills downward, red,
 * y-axis labelled in % below peak, hover shows both the dip and its date. */
export function DrawdownChart({
  data,
  height = 160,
  className,
}: {
  /** Equity series; the peak is derived, not supplied. */
  data: { label: string; value: number }[]
  height?: number
  className?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const w = 600
  const h = height
  const padLeft = 52
  const padRight = 12
  const padTop = 10
  const padBottom = 30
  const innerW = w - padLeft - padRight

  // Running maxPeak → drawdown percentage per point.
  let peak = -Infinity
  const dd = data.map((d) => {
    peak = Math.max(peak, d.value)
    return peak > 0 ? ((d.value - peak) / peak) * 100 : 0
  })
  const worst = Math.min(-1e-9, ...dd)
  const zeroY = padTop + (h - padTop - padBottom) * 0.06 // 0% line near the top
  const bottomY = h - padBottom
  const y = (pctValue: number) => zeroY + (bottomY - zeroY) * (worst === 0 ? 0 : pctValue / worst)
  const step = data.length > 1 ? innerW / (data.length - 1) : 0
  const points = dd.map((v, i) => ({ x: padLeft + i * step, y: y(v) }))
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const area = `${line} L${points[points.length - 1]?.x ?? padLeft},${zeroY} L${padLeft},${zeroY} Z`
  const labelEvery = Math.max(1, Math.ceil(data.length / 6))
  // Depth axis ticks between the worst point and zero.
  const depthTicks = [0, 0.5, 1].map((t) => worst * t)

  return (
    <div className={cx('relative', className)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        {depthTicks.map((d) => (
          <g key={d}>
            <line x1={padLeft} x2={w - padRight} y1={y(d)} y2={y(d)} stroke="var(--color-line)" strokeDasharray="2 4" />
            <text x={padLeft - 8} y={y(d)} textAnchor="end" dominantBaseline="central" fontSize="11" fill="var(--color-faint)">
              −{Math.abs(d).toFixed(1)}%
            </text>
          </g>
        ))}
        <motion.path
          d={area}
          fill="var(--color-danger)"
          fillOpacity="0.16"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.25 }}
        />
        <motion.path d={line} fill="none" stroke="var(--color-danger)" strokeWidth="2" vectorEffect="non-scaling-stroke" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: 'easeInOut' }} />
        <line x1={padLeft} x2={w - padRight} y1={zeroY} y2={zeroY} stroke="var(--color-line-strong)" strokeWidth="1" />
        <text x={w - padRight} y={zeroY - 5} textAnchor="end" fontSize="10.5" fill="var(--color-faint)">
          peak
        </text>
        {points.map((p, i) => (
          <g key={i}>
            <rect x={p.x - step / 2} y={0} width={step || w} height={h - padBottom} fill="transparent" onMouseEnter={() => setHover(i)} />
            {hover === i && (
              <>
                <line x1={p.x} x2={p.x} y1={padTop} y2={h - padBottom} stroke="var(--color-line-strong)" />
                <circle cx={p.x} cy={p.y} r="4.5" fill="var(--color-surface)" stroke="var(--color-danger)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
              </>
            )}
          </g>
        ))}
        {data.map((d, i) => {
          const isEdge = i === 0 || i === data.length - 1
          if (!isEdge && i % labelEvery !== 0) return null
          return (
            <text key={`${i}-${d.label}`} x={points[i].x} y={h - 8} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fontSize="12" fill="var(--color-faint)">
              {d.label}
            </text>
          )
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 -translate-x-1/2 rounded-tile bg-fg px-2.5 py-1.5 text-[12px] font-medium text-bg shadow-pop"
          style={{ left: `${(points[hover].x / w) * 100}%` }}
        >
          {data[hover].label} · −{Math.abs(dd[hover]).toFixed(1)}% below peak
        </div>
      )}
    </div>
  )
}

/** Diverging vertical bars (signed values around a zero baseline) — used for
 * per-trade P&L. Y-axis is labelled; hovering highlights the bar. */
export function BarChart({
  data,
  height = 150,
  className,
  format = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`,
}: {
  data: { label: string; value: number; note?: string }[]
  height?: number
  className?: string
  format?: ChartFormatter
}) {
  const [hover, setHover] = useState<number | null>(null)
  const w = 600
  const h = height
  const padLeft = 60
  const padRight = 10
  const padTop = 12
  const padBottom = 20
  const innerW = w - padLeft - padRight
  const maxAbs = Math.max(1e-9, ...data.map((d) => Math.abs(d.value)))
  const lo = Math.min(0, ...data.map((d) => d.value)) - maxAbs * 0.1
  const hi = Math.max(0, ...data.map((d) => d.value)) + maxAbs * 0.1
  const y = (v: number) => padTop + (h - padTop - padBottom) * (1 - (v - lo) / (hi - lo))
  const zeroY = y(0)
  const slot = data.length > 0 ? innerW / data.length : innerW
  const barW = Math.max(2, Math.min(30, slot * 0.66))
  const ticks = [0, (lo + hi) / 2, hi].filter((t, i, arr) => arr.findIndex((x) => Math.abs(x - t) < 1e-9) === i)

  return (
    <div className={cx('relative', className)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padLeft} x2={w - padRight} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} strokeDasharray={t === 0 ? undefined : '2 4'} />
            <text x={padLeft - 6} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize="10.5" fill="var(--color-faint)">
              {format(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const top = d.value >= 0 ? y(d.value) : zeroY
          const bottom = d.value >= 0 ? zeroY : y(d.value)
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={padLeft + i * slot} y={padTop} width={slot} height={h - padTop - padBottom} fill="transparent" />
              <motion.rect
                x={padLeft + i * slot + (slot - barW) / 2}
                y={top}
                width={barW}
                height={Math.max(1, bottom - top)}
                rx="2.5"
                fill={d.value >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}
                fillOpacity={hover === null || hover === i ? 1 : 0.45}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: Math.min(0.5, i * 0.02) }}
              />
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-tile bg-fg px-2.5 py-1.5 text-[12px] font-medium text-bg shadow-pop"
          style={{ left: `${((padLeft + hover * slot + slot / 2) / w) * 100}%` }}
        >
          trade {hover + 1}{data[hover].label ? ` · ${data[hover].label}` : ''} · {format(data[hover].value)}
          {data[hover].note ? ` · ${data[hover].note}` : ''}
        </div>
      )}
    </div>
  )
}

/** Labelled horizontal comparison bars — one row per bot, value on the right,
 * colored by sign when the series is signed. Small but fully labelled: name,
 * optional secondary caption, value and share of the max. */
export function CompareBars({
  items,
  format = moneyCompact,
  signed = false,
  className,
}: {
  items: { label: string; caption?: string; value: number }[]
  format?: ChartFormatter
  /** Color each bar by sign (green/red) instead of a single accent. */
  signed?: boolean
  className?: string
}) {
  const max = Math.max(1e-9, ...items.map((i) => Math.abs(i.value)))
  return (
    <ul className={cx('flex flex-col gap-3', className)}>
      {items.map((item, i) => (
        <li key={item.label} className="grid items-center gap-3 text-[13px]" style={{ gridTemplateColumns: 'minmax(110px, 160px) 1fr auto' }}>
          <span className="min-w-0">
            <span className="block truncate text-fg">{item.label}</span>
            {item.caption && <span className="block truncate text-[11.5px] text-faint">{item.caption}</span>}
          </span>
          <span className="relative h-2.5 overflow-hidden rounded-[5px] bg-surface-2">
            <motion.span
              className="absolute inset-y-0 left-0 rounded-[5px]"
              style={{
                background: signed
                  ? item.value >= 0
                    ? 'var(--color-success)'
                    : 'var(--color-danger)'
                  : 'var(--color-accent)',
              }}
              initial={{ width: 0 }}
              animate={{ width: `${(Math.abs(item.value) / max) * 100}%` }}
              transition={{ duration: 0.8, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            />
          </span>
          <span className={cx('w-[76px] text-right tabular-nums font-medium', signed && (item.value < 0 ? 'text-danger' : 'text-success'))} title={format(item.value)}>
            {signed && item.value < 0 ? '−' : ''}{format(Math.abs(item.value))}
          </span>
        </li>
      ))}
      {items.length === 0 && <li className="py-4 text-center text-[13px] text-muted">Nothing to chart yet</li>}
    </ul>
  )
}
