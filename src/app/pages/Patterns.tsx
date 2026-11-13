import { Radar } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import { Sparkline } from '../components/charts'
import { Badge, Card, EmptyState, Skeleton } from '../components/ui'
import { useFleetPatterns } from '../lib/api'
import { cx } from '../lib/cx'
import { relativeTime } from '../lib/format'
import {
  FLEET_REGIMES,
  type BotStatus,
  type FleetPatternEntry,
  type FleetRegime,
} from '../../shared/types'

const REGIME_TONE: Record<FleetRegime, 'danger' | 'warning' | 'info'> = {
  crash: 'danger',
  hype: 'warning',
  squeeze: 'info',
}

const STATUS_TONE: Record<BotStatus, 'success' | 'warning' | 'neutral'> = {
  running: 'success',
  paused: 'warning',
  stopped: 'neutral',
}

const signed = (value: number, decimals = 1) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(decimals)}%`

const ordinal = (value: number) => {
  const n = Math.round(value)
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

type Filter = FleetRegime | 'all'

/**
 * Fleet-wide pattern ranking: every bot scored on the strongest crash, hype or
 * squeeze read among the markets it trades, strongest tape first. Answers the
 * fleet question — "who is trading a market that is falling apart, melting up
 * or coiling right now?" — with the measurements behind each call.
 */
export function FleetPatternPanel() {
  const { data, isLoading, isError } = useFleetPatterns()
  const [filter, setFilter] = useState<Filter>('all')

  const items = data?.items ?? []
  const filtered = filter === 'all' ? items : items.filter((entry) => entry.regime === filter)
  const counts = data?.counts ?? { crash: 0, hype: 0, squeeze: 0 }

  if (isLoading && !data) {
    return (
      <div className="mt-4 grid gap-3">
        <Card className="grid gap-3 p-5">
          <Skeleton className="h-5 w-1/3 rounded" />
          <Skeleton className="h-4 w-2/3 rounded" />
          <Skeleton className="h-7 w-56 rounded-control" />
        </Card>
        <Card className="grid gap-3 p-5">
          <Skeleton className="h-14 rounded-tile" />
          <Skeleton className="h-14 rounded-tile" />
          <p className="text-[13px] text-muted">Reading every bot&rsquo;s markets for crash, hype and squeeze regimes…</p>
        </Card>
      </div>
    )
  }

  if (isError && !data) {
    return (
      <Card className="mt-4 p-5">
        <p className="text-[13px] text-danger">Could not read the fleet pattern ranking. It retries on the next poll.</p>
      </Card>
    )
  }

  return (
    <div className="mt-4 grid gap-3">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold">
              <Radar className="size-4 text-accent" />
              Fleet pattern ranking
            </h2>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-muted">
              {data && data.matched > 0 ? (
                <>
                  <span className="font-medium text-fg">{data.matched}</span> of {data.scanned} bots track a market that
                  reads crash, hype or squeeze right now — <span className="font-medium text-fg">{data.active}</span>{' '}
                  running, <span className="font-medium text-fg">{data.positions}</span> holding a position in one of
                  those markets.
                </>
              ) : (
                'No bot is tracking a market that reads crash, hype or squeeze right now — the fleet is in calmer regimes.'
              )}
            </p>
          </div>
          {data && (
            <span className="text-[11.5px] text-faint">
              read {relativeTime(data.generatedAt)} · {data.bars}-bar window · scans every 60s
            </span>
          )}
        </div>

        {items.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1 rounded-control bg-bg p-1" role="group" aria-label="Filter the ranking by regime">
            <FilterChip active={filter === 'all'} count={items.length} onClick={() => setFilter('all')}>
              All regimes
            </FilterChip>
            {FLEET_REGIMES.map((regime) => (
              <FilterChip
                key={regime.key}
                active={filter === regime.key}
                count={counts[regime.key]}
                disabled={counts[regime.key] === 0}
                onClick={() => setFilter(regime.key)}
                title={regime.hint}
              >
                {regime.label}
              </FilterChip>
            ))}
          </div>
        )}
      </Card>

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Radar />}
            title="No crash, hype or squeeze reads"
            description="The ranking fills in when a bot's tracked market draws down 10%+ on a fast leg, runs up 12%+, or compresses into the calmest quintile of its own window."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden" aria-labelledby="fleet-pattern-list-heading">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5">
            <h3 id="fleet-pattern-list-heading" className="text-[13px] font-semibold">
              Ranked by regime score
            </h3>
            <span className="text-[11.5px] text-faint">
              strongest tape first · a position in the market lifts the score
            </span>
          </div>
          <ol className="divide-y divide-line border-t border-line">
            {filtered.map((entry) => (
              <li key={entry.botId}>
                <RankedBot entry={entry} />
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-5 py-10 text-center text-[13px] text-muted">No bot leads with that regime right now.</li>
            )}
          </ol>
          <p className="border-t border-line px-5 py-3 text-[11.5px] leading-relaxed text-faint">
            Score = 65% regime confidence + 35% intensity (how far past the threshold the tape sits), ×1.1 when the bot
            holds that market. A crash needs a 10%+ drawdown with a fast recent leg, a hype a 12%+ run-up, a squeeze the
            calmest quintile of its own window. Each bot is scored on its strongest read, on the bars the engine replays
            — a description of the tape, not a forecast.
          </p>
        </Card>
      )}
    </div>
  )
}

function FilterChip({
  active,
  count,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean
  count: number
  disabled?: boolean
  onClick: () => void
  title?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12.5px] font-medium transition-colors',
        active ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
        disabled && 'cursor-not-allowed opacity-40 hover:text-muted',
      )}
    >
      {children}
      <span className="t-num text-[11.5px] text-faint">{count}</span>
    </button>
  )
}

function RankedBot({ entry }: { entry: FleetPatternEntry }) {
  const regime = FLEET_REGIMES.find((option) => option.key === entry.regime)
  const holding = entry.positionQty !== 0

  return (
    <Link
      to={`/bots/${entry.botId}`}
      className="block px-4 py-3.5 transition-colors hover:bg-surface-2/50 focus-visible:bg-surface-2/50 focus-visible:outline-none"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={cx(
            'mt-0.5 grid h-7 min-w-7 place-items-center rounded-[8px] px-1 text-[12px] font-semibold t-num',
            entry.rank === 1 ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted',
          )}
        >
          #{entry.rank}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-semibold">{entry.name}</span>
            <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>
            <span className="truncate text-[12px] text-faint">{entry.strategyName}</span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium t-num">{entry.symbol}</span>
            <span className="text-[11.5px] text-faint">
              {entry.timeframe} · {entry.stage === entry.mode ? entry.stage : `${entry.stage} · ${entry.mode}`}
            </span>
            <Badge tone={REGIME_TONE[entry.regime]} title={regime?.hint}>
              {regime?.label ?? entry.regime}
            </Badge>
            <span className="text-[11.5px] text-muted">{entry.confidence}% confidence</span>
            {entry.liquidityVacuum && (
              <Badge
                tone="warning"
                title={`Volume ${entry.volZ?.toFixed(2) ?? '—'}σ against a violent price move — not confirmed by participation.`}
              >
                thin volume
              </Badge>
            )}
            {holding && (
              <Badge tone="accent">
                holding {entry.positionQty} {entry.symbol}
              </Badge>
            )}
          </div>

          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{entry.evidence[0]}</p>
          {entry.others.length > 0 && (
            <p className="mt-0.5 text-[11.5px] text-faint">
              also in regime: <span className="text-muted">{entry.others.join(', ')}</span>
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
          <div className="text-right">
            <p className="text-[19px] font-semibold leading-none t-num">{entry.score}</p>
            <p className="mt-1 text-[10.5px] uppercase tracking-wide text-faint">score</p>
          </div>
          <Sparkline data={entry.spark} width={88} height={26} positive={entry.changePct >= 0} />
        </div>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-tile bg-surface-2/50 px-3 py-2 sm:grid-cols-4">
        <Metric
          label="Window"
          value={signed(entry.changePct)}
          tone={entry.changePct >= 0 ? 'text-success' : 'text-danger'}
        />
        <Metric label="Drawdown" value={`−${entry.drawdownPct.toFixed(1)}%`} />
        <Metric label="Run-up" value={`+${entry.runupPct.toFixed(1)}%`} />
        <Metric label="Vol rank" value={ordinal(entry.volPercentile)} />
      </dl>
    </Link>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:block">
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd className={cx('text-[12.5px] t-num', tone ?? 'text-muted')}>{value}</dd>
    </div>
  )
}
