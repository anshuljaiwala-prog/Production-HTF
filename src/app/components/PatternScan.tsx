import { Radar } from 'lucide-react'

import { PATTERN_REGIMES, type EpisodeKind, type MarketEvent, type PatternRegime, type SymbolPattern } from '../../shared/types'
import { useBotPatterns } from '../lib/api'
import { cx } from '../lib/cx'
import { relativeTime } from '../lib/format'
import { Sparkline } from './charts'
import { Badge, Card, EmptyState, Skeleton } from './ui'

const REGIME_TONE: Record<PatternRegime, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  crash: 'danger',
  selloff: 'warning',
  hype: 'warning',
  breakout: 'success',
  squeeze: 'info',
  uptrend: 'success',
  downtrend: 'danger',
  range: 'neutral',
}

const REGIME_LABEL = Object.fromEntries(PATTERN_REGIMES.map((r) => [r.key, r.label])) as Record<PatternRegime, string>

const EVENT_TONE: Record<MarketEvent['severity'], 'danger' | 'warning' | 'info'> = {
  alert: 'danger',
  warn: 'warning',
  info: 'info',
}

const signed = (value: number, decimals = 2) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(decimals)}%`

const ordinal = (value: number) => {
  const n = Math.round(value)
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/** Multi-symbol pattern scan for one bot: every tracked symbol's regime with
 * the measurements behind it, the historic crash/hype tape it most resembles,
 * and the events the same feed is producing right now. This is where a bot
 * answers "what am I seeing across my book, and what does it look like it
 * belongs to?". */
export function PatternScan({ botId, running }: { botId: string | undefined; running: boolean }) {
  const { data, isLoading, isError } = useBotPatterns(botId)

  const symbols = data?.symbols ?? []
  const riskOff = symbols.filter((s) => s.regime === 'crash' || s.regime === 'selloff' || s.regime === 'downtrend').length

  return (
    <Card className="mt-3 overflow-hidden" aria-labelledby="pattern-scan-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id="pattern-scan-heading" className="text-[14px] font-semibold">
            Pattern scan · {symbols.length} tracked {symbols.length === 1 ? 'market' : 'markets'}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted">
            {data
              ? `${data.timeframe} bars · ${data.window.bars}-bar window · regime read ${relativeTime(data.generatedAt)}`
              : 'Reading each tracked symbol’s tape'}
            {symbols.length > 0 && ` · ${riskOff} of ${symbols.length} risk-off`}
          </p>
        </div>
        {running && <span className="text-[11.5px] text-faint">scans every 60s</span>}
      </div>

      {isLoading && (
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-[168px] rounded-tile" />
          <Skeleton className="h-[168px] rounded-tile" />
          <Skeleton className="h-[168px] rounded-tile" />
        </div>
      )}

      {!isLoading && isError && (
        <p className="px-5 py-4 text-[13px] text-danger">Could not read the pattern scan. It retries on the next poll.</p>
      )}

      {!isLoading && !isError && symbols.length === 0 && (
        <EmptyState icon={<Radar />} title="No symbols to scan" description="Give the bot at least one market and its regimes appear here." />
      )}

      {symbols.length > 0 && (
        <>
          <ul className="grid gap-3 px-5 py-4 sm:grid-cols-2 xl:grid-cols-3">
            {symbols.map((pattern) => (
              <li key={pattern.symbol}>
                <SymbolPatternTile pattern={pattern} />
              </li>
            ))}
          </ul>

          <div className="grid gap-5 border-t border-line px-5 py-4 lg:grid-cols-2">
            <section aria-labelledby="episode-heading">
              <h3 id="episode-heading" className="text-[13px] font-semibold">
                Historic crash &amp; hype analogs
              </h3>
              <p className="mt-0.5 text-[11.5px] text-faint">Shape similarity: magnitude, speed and volatility expansion. Not a forecast.</p>
              {(data?.episodes.length ?? 0) === 0 ? (
                <p className="mt-3 text-[13px] text-muted">No tracked market has moved far enough to resemble a historic episode.</p>
              ) : (
                <ol className="mt-3 grid gap-2.5">
                  {data?.episodes.map((match) => (
                    <li key={`${match.symbol}-${match.episode.id}`} className="rounded-tile bg-surface-2/70 p-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <EpisodeBadge kind={match.episode.kind} />
                        <span className="text-[13px] font-medium">{match.episode.name}</span>
                        <span className="text-[11.5px] text-faint">{match.episode.period}</span>
                        <span className="ml-auto text-[12.5px] t-num font-medium">{match.similarity}%</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`${match.similarity} percent shape similarity to ${match.episode.name}`}>
                        <div className="h-full rounded-full bg-accent" style={{ width: `${match.similarity}%` }} />
                      </div>
                      <p className="mt-1.5 text-[12px] text-muted">
                        <span className="font-medium text-fg">{match.symbol}</span> — {match.why}
                      </p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-faint">
                        {match.episode.period}: {match.episode.magnitudePct >= 0 ? '+' : '−'}
                        {Math.abs(match.episode.magnitudePct)}% over {match.episode.days} days, volatility ×{match.episode.volMultiple}.{' '}
                        {match.episode.what}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section aria-labelledby="events-heading">
              <h3 id="events-heading" className="text-[13px] font-semibold">
                What the market is doing now
              </h3>
              <p className="mt-0.5 text-[11.5px] text-faint">Derived from the same stored feed these bots trade — the events a regime read is linked to.</p>
              {(data?.events.length ?? 0) === 0 ? (
                <p className="mt-3 text-[13px] text-muted">Nothing unusual: no draws of 8%+, run-ups of 10%+ or volatility spikes among the tracked markets.</p>
              ) : (
                <ul className="mt-3 grid gap-2">
                  {data?.events.map((event) => (
                    <li key={event.id} className="flex items-start gap-2.5 rounded-tile bg-surface-2/70 p-2.5">
                      <Badge tone={EVENT_TONE[event.severity]}>{event.severity}</Badge>
                      <div className="min-w-0">
                        <p className="text-[12.5px] font-medium leading-snug">{event.headline}</p>
                        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{event.detail}</p>
                        <p className="mt-1 flex flex-wrap gap-1">
                          {event.symbols.slice(0, 6).map((symbol) => (
                            <span key={symbol} className="rounded-[6px] bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                              {symbol}
                            </span>
                          ))}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </Card>
  )
}

function EpisodeBadge({ kind }: { kind: EpisodeKind }) {
  return <Badge tone={kind === 'crash' ? 'danger' : 'warning'}>{kind}</Badge>
}

function SymbolPatternTile({ pattern }: { pattern: SymbolPattern }) {
  const positive = pattern.recentPct >= 0
  return (
    <article className="flex h-full flex-col rounded-tile border border-line bg-surface-2/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{pattern.symbol}</p>
          <p className="text-[11px] uppercase tracking-wide text-faint">{pattern.kind}</p>
        </div>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={REGIME_TONE[pattern.regime]} title={PATTERN_REGIMES.find((r) => r.key === pattern.regime)?.hint}>
            {REGIME_LABEL[pattern.regime]} · {pattern.confidence}%
          </Badge>
          {pattern.liquidityVacuum && (
            <Badge
              tone="warning"
              title={`Price ${pattern.priceZ?.toFixed(2) ?? '—'}σ moved on thin volume (${pattern.volZ?.toFixed(2) ?? '—'}σ) — the move is not confirmed by participation.`}
            >
              thin volume
            </Badge>
          )}
        </span>
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <p className="text-[16px] font-semibold t-num">{pattern.price.toLocaleString('en-US', { maximumFractionDigits: 6 })}</p>
        <Sparkline className="shrink-0" width={80} height={24} data={pattern.spark} positive={positive} />
      </div>

      <dl className="mt-2 grid grid-cols-3 gap-x-2 text-[11px]">
        <div>
          <dt className="text-faint">Window</dt>
          <dd className={cx('t-num', pattern.changePct >= 0 ? 'text-success' : 'text-danger')}>{signed(pattern.changePct, 1)}</dd>
        </div>
        <div>
          <dt className="text-faint">Drawdown</dt>
          <dd className="t-num text-muted">−{pattern.drawdownPct.toFixed(1)}%</dd>
        </div>
        <div>
          <dt className="text-faint">Vol rank</dt>
          <dd className="t-num text-muted">{ordinal(pattern.volPercentile)}</dd>
        </div>
      </dl>

      <ul className="mt-2 grid gap-1 text-[11.5px] leading-snug text-muted">
        {pattern.evidence.slice(0, 2).map((line) => (
          <li key={line} className="flex gap-1.5">
            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-line-strong" />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {pattern.positionQty !== 0 && (
        <p className="mt-2 text-[11px] text-muted">
          holding <span className="t-num font-medium text-fg">{pattern.positionQty}</span> units
        </p>
      )}
    </article>
  )
}
