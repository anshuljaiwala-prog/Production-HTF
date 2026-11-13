import { Target, Trophy } from 'lucide-react'
import { useNavigate } from 'react-router'

import { BarChart } from '../components/charts'
import { Badge, Card, EmptyState, Skeleton } from '../components/ui'
import { useBotEdge } from '../lib/api'
import { cx } from '../lib/cx'
import { shortDate } from '../lib/format'
import type { AccuracyStat } from '../../shared/types'

const RATING_TONE: Record<NonNullable<AccuracyStat['rating']>, 'success' | 'warning' | 'danger' | 'neutral'> = {
  edge: 'success',
  'coin-flip': 'warning',
  anti: 'danger',
  'thin-sample': 'neutral',
}

/**
 * Market-edge comparison across the fleet: every bot ranked by directional
 * accuracy — how often its entry signals predicted the next bar — best first,
 * with the edge-vs-market that says whether the accuracy actually pays.
 */
export function EdgePanel() {
  const { data, isLoading } = useBotEdge()
  const navigate = useNavigate()
  const items = data?.items ?? []

  if (isLoading && !data) {
    return (
      <Card className="mt-4 grid gap-3 p-5">
        <Skeleton className="h-5 w-1/3 rounded" />
        <Skeleton className="h-40 rounded-tile" />
        <p className="text-[13px] text-muted">Scoring every bot&rsquo;s entry signals against the stored window…</p>
      </Card>
    )
  }

  if (items.length === 0) {
    return (
      <Card className="mt-4">
        <EmptyState
          icon={<Target />}
          title="No bots to rank"
          description="Launch a bot and its strategy joins the edge ranking — every entry signal scored against what the next bar actually did."
        />
      </Card>
    )
  }

  const best = items[0]
  const chart = items.map((entry) => ({
    label: entry.name,
    caption: entry.accuracy.rating ?? 'no signals',
    value: Math.round((entry.accuracy.directionalAccuracy ?? 0) * 10) / 10,
    note: entry.accuracy.rating ?? undefined,
  }))

  return (
    <div className="mt-4 grid gap-3">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold">
            <Trophy className="size-4 text-warning" />
            Best edge: {best.name}
          </h2>
          <span className="text-[12.5px] text-faint">
            {data?.window.bars ?? 0}-bar window · scored {shortDate(data?.window.to ?? Date.now())}
          </span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          {best.strategyName}
          {best.symbol ? ` on ${best.symbol}` : ''} · {best.timeframe} —{' '}
          {best.accuracy.directionalAccuracy === null
            ? 'its rules never fired an entry in this window'
            : `${best.accuracy.correct} of ${best.accuracy.entryBars} entry bars closed in the direction it predicted`}
          {best.accuracy.edgePct !== null &&
            `, a ${best.accuracy.edgePct >= 0 ? '+' : ''}${best.accuracy.edgePct.toFixed(3)}% edge per signal against the market average`}
          . Exploits the feed better than {items.length - 1} other bot{items.length === 2 ? '' : 's'}.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone="accent">#{1} of {items.length}</Badge>
          {best.accuracy.rating && <Badge tone={RATING_TONE[best.accuracy.rating]}>{best.accuracy.rating}</Badge>}
          <Badge tone="neutral">
            {best.accuracy.directionalAccuracy === null ? '—' : `${best.accuracy.directionalAccuracy.toFixed(1)}%`} directional
          </Badge>
          {best.live.hitRate !== null && (
            <Badge tone={best.live.hitRate >= 50 ? 'success' : 'warning'}>
              {best.live.hitRate.toFixed(0)}% live hit rate
            </Badge>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Directional accuracy by bot</h2>
          <span className="text-[12.5px] text-faint">share of entry signals that predicted the next bar · 50% = coin flip</span>
        </div>
        <div className="mt-3">
          <BarChart data={chart} height={170} format={(v) => `${v.toFixed(1)}%`} />
        </div>
      </Card>

      <div className="overflow-hidden rounded-card border border-line">
        <table className="w-full min-w-[860px] table-fixed text-left text-[13px]">
          <thead>
            <tr className="h-10 border-b border-line bg-bg/60 text-[12.5px] text-muted">
              <th scope="col" className="w-[6%] px-4 font-medium">#</th>
              <th scope="col" className="w-[24%] px-4 font-medium">Bot</th>
              <th scope="col" className="w-[16%] px-4 font-medium">Market</th>
              <th scope="col" className="w-[13%] px-4 text-right font-medium">Accuracy</th>
              <th scope="col" className="w-[13%] px-4 text-right font-medium">Edge vs market</th>
              <th scope="col" className="w-[13%] px-4 text-right font-medium">Signal return</th>
              <th scope="col" className="w-[8%] px-4 text-right font-medium">Signals</th>
              <th scope="col" className="w-[13%] px-4 font-medium">Rating</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((entry, index) => (
              <tr
                key={entry.botId}
                onClick={() => navigate(`/bots/${entry.botId}`)}
                className={cx(
                  'h-13 cursor-pointer transition-colors hover:bg-surface-2/60',
                  index === 0 && 'bg-accent-soft/40',
                )}
              >
                <td className="px-4 tabular-nums text-muted">
                  {entry.rank}
                  {index === 0 && <Badge tone="accent" className="ml-1.5 h-5">best</Badge>}
                </td>
                <td className="truncate px-4">
                  <span className="block truncate font-medium">{entry.name}</span>
                  <span className="block truncate text-[12px] text-faint">{entry.strategyName}</span>
                </td>
                <td className="truncate px-4 text-muted">
                  {entry.symbol ?? '—'} · {entry.timeframe}
                </td>
                <td className="px-4 text-right tabular-nums">
                  {entry.accuracy.directionalAccuracy === null ? '—' : `${entry.accuracy.directionalAccuracy.toFixed(1)}%`}
                </td>
                <td
                  className={cx(
                    'px-4 text-right tabular-nums',
                    entry.accuracy.edgePct === null ? 'text-faint' : entry.accuracy.edgePct >= 0 ? 'text-success' : 'text-danger',
                  )}
                >
                  {entry.accuracy.edgePct === null ? '—' : `${entry.accuracy.edgePct >= 0 ? '+' : ''}${entry.accuracy.edgePct.toFixed(3)}%`}
                </td>
                <td
                  className={cx(
                    'px-4 text-right tabular-nums',
                    entry.accuracy.signalReturnPct === null ? 'text-faint' : entry.accuracy.signalReturnPct >= 0 ? 'text-success' : 'text-danger',
                  )}
                >
                  {entry.accuracy.signalReturnPct === null ? '—' : `${entry.accuracy.signalReturnPct >= 0 ? '+' : ''}${entry.accuracy.signalReturnPct.toFixed(3)}%`}
                </td>
                <td className="px-4 text-right tabular-nums text-muted">
                  {entry.accuracy.entryBars}/{entry.accuracy.sample}
                </td>
                <td className="px-4">
                  {entry.accuracy.rating ? (
                    <Badge tone={RATING_TONE[entry.accuracy.rating]}>{entry.accuracy.rating}</Badge>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-faint">
        Accuracy = entry signals whose next bar closed in the predicted direction. Edge vs market = mean next-bar return on
        signal bars minus the unconditional mean — positive means the signals land on above-average moves, not merely
        correct ones. Click a row to open the run monitor.
      </p>
    </div>
  )
}
