import { CandlestickChart, Play, Trash2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { AreaChart, BarChart, CandleChart, DrawdownChart } from '../components/charts'
import { BacktestDialog } from '../components/forms'
import { Badge, Button, Card, ConfirmDialog, Drawer, EmptyState, Live, PageHeader, Skeleton, useToast } from '../components/ui'
import { deleteBacktest, useApiMutation, useBacktestDetail, useBacktestMarket, useBacktests } from '../lib/api'
import { cx } from '../lib/cx'
import { money, shortDate } from '../lib/format'
import { SIM_BUDGET } from '../../shared/types'
import type { Backtest } from '../../shared/types'

/** Period label that keeps the year when the window crosses one. */
function periodSpan(from: number, to: number): string {
  const stamp = (ts: number) =>
    new Date(ts).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(new Date(ts).getFullYear() !== new Date(to).getFullYear() ? { year: 'numeric' } : {}),
    })
  return `${stamp(from)} – ${stamp(to)}`
}

export function Backtests({ embedded = false }: { embedded?: boolean }) {
  const { data, isLoading } = useBacktests()
  const [params, setParams] = useSearchParams()
  const [composing, setComposing] = useState(false)
  const toast = useToast()
  const selected = params.get('id')

  // The list auto-polls while a run is pending; when we see a run flip from
  // running to a terminal state, announce it and open its results if the user
  // isn't already reading one. The flip id also drives a pulse on the drawer
  // badge for a few seconds.
  const seenStatuses = useRef<Map<string, Backtest['status']>>(new Map())
  const [flipped, setFlipped] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    let finished: Backtest | undefined
    for (const item of data.items) {
      const before = seenStatuses.current.get(item.id)
      seenStatuses.current.set(item.id, item.status)
      if (before === 'running' && item.status !== 'running') finished = item
    }
    if (!finished) return
    if (finished.status === 'done' && finished.metrics) {
      toast(`${finished.name} finished · ${finished.metrics.totalReturn >= 0 ? '+' : ''}${finished.metrics.totalReturn.toFixed(1)}%`)
    } else if (finished.status === 'failed') {
      toast(`${finished.name} failed: ${finished.error ?? 'unknown error'}`, 'danger')
    } else {
      toast(`${finished.name} finished`)
    }
    setFlipped(finished.id)
    if (!selected) setParams({ tab: 'backtests', id: finished.id })
    // selected/params intentionally read but not re-run on: a flip announces
    // once, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    if (!flipped) return
    const timer = window.setTimeout(() => setFlipped(null), 2_800)
    return () => window.clearTimeout(timer)
  }, [flipped])

  const sim = data?.sim

  return (
    <div className={!embedded ? 'mx-auto max-w-[1200px] p-5 sm:p-8' : undefined}>
      {!embedded && (
        <PageHeader
          title="Backtests"
          subtitle="Deterministic replays over the simulated feed — same inputs, same result, every time."
          actions={
            <Button variant="primary" onClick={() => setComposing(true)}>
              <Play />
              New backtest
            </Button>
          }
        />
      )}

      {/* Simulated pot: backtests draw from on this fixed budget, never from
          workspace funding — deleting a run frees its allocation. */}
      {sim && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line bg-bg/60 px-4 py-3 text-[12.5px]">
          <span className="font-medium">Simulation pot</span>
          <span className="inline-flex items-center gap-2">
            <span className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-2">
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${Math.min(100, (sim.used / SIM_BUDGET) * 100)}%` }}
              />
            </span>
            <span className="text-faint">{((sim.used / SIM_BUDGET) * 100).toFixed(1)}% allocated</span>
          </span>
          <span className="text-muted">
            allocated <span className="font-medium tabular-nums">{money(sim.used)}</span> of {money(SIM_BUDGET)} · free <span className="font-medium tabular-nums">{money(sim.available)}</span>
          </span>
          <span className="ml-auto text-[11.5px] text-faint">
            made-up money — backtests never touch workspace funding · delete a run to free its allocation
          </span>
        </div>
      )}

      <div className={!embedded ? 'mt-6 overflow-hidden rounded-card border border-line' : 'mt-3 overflow-hidden rounded-card border border-line'}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] table-fixed text-left text-[13.5px]">
            <thead>
              <tr className="h-10 border-b border-line bg-bg/60 text-[12.5px] text-muted">
                <th className="w-[26%] px-4 font-medium">Run</th>
                <th className="w-[16%] px-4 font-medium">Market</th>
                <th className="w-[14%] px-4 font-medium">Period</th>
                <th className="w-[11%] px-4 text-right font-medium">Return</th>
                <th className="w-[11%] px-4 text-right font-medium">Max DD</th>
                <th className="w-[9%] px-4 text-right font-medium">Sharpe</th>
                <th className="w-[9%] px-4 text-right font-medium">Win rate</th>
                <th className="w-[8%] px-4 text-right font-medium">Fills</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(data?.items ?? []).map((backtest) => {
                const metrics = backtest.metrics
                return (
                  <tr
                    key={backtest.id}
                    onClick={() => setParams({ tab: 'backtests', id: backtest.id })}
                    className={cx('h-13 cursor-pointer transition-colors hover:bg-surface-2/60', selected === backtest.id && 'bg-surface-2/80')}
                  >
                    <td className="truncate px-4">
                      <span className="block truncate font-medium">{backtest.name}</span>
                      <span className="block truncate text-[12px] text-faint">{backtest.strategyName}</span>
                    </td>
                    <td className="truncate px-4 text-muted">
                      {backtest.symbol} · {backtest.timeframe}
                    </td>
                    <td className="px-4 text-muted">
                      {periodSpan(backtest.from, backtest.to)}
                    </td>
                    <td className="px-4 text-right tabular-nums">
                      {backtest.status !== 'done' || !metrics ? (
                        <Badge tone={backtest.status === 'failed' ? 'danger' : 'neutral'}>{backtest.status}</Badge>
                      ) : (
                        <span className={metrics.totalReturn >= 0 ? 'text-success' : 'text-danger'}>
                          {metrics.totalReturn >= 0 ? '+' : ''}
                          {metrics.totalReturn.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-4 text-right tabular-nums text-muted">{metrics ? `-${metrics.maxDrawdown.toFixed(1)}%` : '—'}</td>
                    <td className="px-4 text-right tabular-nums text-muted">{metrics ? metrics.sharpe.toFixed(2) : '—'}</td>
                    <td className="px-4 text-right tabular-nums text-muted">{metrics ? `${metrics.winRate.toFixed(0)}%` : '—'}</td>
                    <td className="px-4 text-right tabular-nums text-muted">{metrics?.trades ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {isLoading && (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 rounded-tile" />
            ))}
          </div>
        )}
        {!isLoading && (data?.items.length ?? 0) === 0 && (
          <EmptyState
            icon={<CandlestickChart />}
            title="No backtests yet"
            description="Replay a strategy over historical bars before risking paper money on it."
            action={
              <Button variant="primary" onClick={() => setComposing(true)}>
                <Play />
                Run a backtest
              </Button>
            }
          />
        )}
      </div>

      <BacktestDialog open={composing} onClose={() => setComposing(false)} strategyKey={null} />
      <BacktestDrawer id={selected} flashId={flipped} onClose={() => setParams({ tab: 'backtests' })} />
    </div>
  )
}

function BacktestDrawer({
  id,
  flashId,
  onClose,
}: {
  id: string | null
  flashId: string | null
  onClose: () => void
}) {
  const { data, isLoading } = useBacktests()
  // The list endpoint strips the trade payload, so the drawer reads the
  // detail query — which also resolves a pending run on read.
  const detail = useBacktestDetail(id ?? undefined)
  const market = useBacktestMarket(id ?? undefined)
  const toast = useToast()
  const [deleting, setDeleting] = useState(false)
  // Detail first (it carries trades); fall back to the list row while it
  // loads so the drawer opens instantly.
  const backtest: Backtest | undefined =
    detail.data?.backtest ?? (data?.items.find((item) => item.id === id) as Backtest | undefined)

  const remove = useApiMutation(() => deleteBacktest(id!), ['backtests'], {
    onSuccess: () => {
      setDeleting(false)
      toast('Backtest deleted')
      onClose()
    },
  })

  const metrics = backtest?.metrics
  const cards = metrics
    ? [
        { label: 'Total return', value: `${metrics.totalReturn >= 0 ? '+' : ''}${metrics.totalReturn.toFixed(2)}%`, tone: metrics.totalReturn >= 0 ? 'text-success' : 'text-danger' },
        { label: 'Final equity', value: money(metrics.finalEquity), tone: undefined },
        { label: 'Max drawdown', value: `-${metrics.maxDrawdown.toFixed(2)}%`, tone: 'text-danger' },
        { label: 'Sharpe', value: metrics.sharpe.toFixed(2), tone: undefined },
        { label: 'Win rate', value: `${metrics.winRate.toFixed(0)}%`, tone: undefined },
        { label: 'Fills', value: String(metrics.trades), tone: undefined },
      ]
    : []

  return (
    <>
      <Drawer
        open={Boolean(id)}
        onClose={onClose}
        title={backtest?.name ?? 'Backtest'}
        header={
          backtest && (
            <div className="flex items-center gap-2">
              <motion.span
                key={flashId === id ? `flash-${backtest.status}` : 'idle'}
                animate={flashId === id ? { scale: [1, 1.22, 1] } : { scale: 1 }}
                transition={{ duration: 0.55, ease: 'easeOut' }}
                className="inline-flex origin-left"
              >
                <Badge tone={backtest.status === 'done' ? 'success' : backtest.status === 'failed' ? 'danger' : 'neutral'} dot>
                  {backtest.status}
                </Badge>
              </motion.span>
              {backtest.status === 'running' && <Live active label="1s poll" />}
              <span className="truncate text-[13px] text-muted">
                {backtest.strategyName} · {backtest.symbol} · {backtest.timeframe}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" aria-label="Delete backtest" onClick={() => setDeleting(true)}>
                  <Trash2 />
                </Button>
              </div>
            </div>
          )
        }
      >
        {isLoading && <Skeleton className="m-5 h-40" />}
        {!isLoading && !backtest && (
          <EmptyState icon={<CandlestickChart />} title="Not found" description="This backtest no longer exists." />
        )}
        {backtest && backtest.status === 'failed' && (
          <div className="m-5 rounded-card border border-danger/30 bg-danger-soft p-4">
            <p className="text-[13.5px] font-medium text-danger">Run failed</p>
            <p className="mt-1 text-[13px] text-muted">{backtest.error ?? 'Unknown error.'}</p>
          </div>
        )}
        {backtest && metrics && (
          <div className="flex flex-col gap-5 p-5">
            <div className="grid grid-cols-3 gap-2">
              {cards.map((card) => (
                <div key={card.label} className="rounded-card border border-line p-3">
                  <p className="text-[12px] text-muted">{card.label}</p>
                  <p className={cx('mt-1 text-[17px] font-semibold tabular-nums', card.tone)}>{card.value}</p>
                </div>
              ))}
            </div>

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold">Market data</h3>
                {backtest.status === 'running' ? <Live active label="1s poll" /> : null}
              </div>
              {(() => {
                const candles = market.data?.candles ?? []
                const bars = market.data?.bars ?? 0
                const bucketed = market.data && candles.length < bars
                return (
                  <>
                    <p className="mt-1 text-[12.5px] text-muted">
                      The simulated feed this run replayed — {backtest.symbol} · {backtest.timeframe} · {bars} bars
                      {bucketed ? `, bucketed into ${candles.length} candles for display` : ''}. Markers are the run's fills.
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[11.5px] text-faint">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rotate-45 bg-success" /> buy fills
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rotate-45 bg-warning" /> sell fills
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-[2px] bg-success/80" /> up candle
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-[2px] bg-danger/80" /> down candle
                      </span>
                    </div>
                    <div className="mt-3">
                      {market.isLoading ? (
                        <Skeleton className="h-[220px]" />
                      ) : candles.length > 1 ? (
                        <CandleChart
                          candles={candles}
                          markers={backtest.trades.map((trade) => ({ t: trade.at, side: trade.side, price: trade.price }))}
                          height={230}
                        />
                      ) : (
                        <p className="py-6 text-center text-[13px] text-muted">
                          {market.isError ? (market.error instanceof Error ? market.error.message : 'Could not load market data') : 'No bars recorded for this run'}
                        </p>
                      )}
                    </div>
                  </>
                )
              })()}
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold">Equity curve</h3>
                <span className="text-[12px] text-faint">
                  {periodSpan(backtest.from, backtest.to)}
                </span>
              </div>
              <div className="mt-3">
                {backtest.curve.length > 1 ? (
                  <AreaChart data={backtest.curve.map((point) => ({ label: shortDate(point.t), value: point.value }))} height={180} />
                ) : (
                  <p className="py-6 text-center text-[13px] text-muted">No curve recorded</p>
                )}
              </div>
            </Card>

            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13.5px] font-semibold">Drawdown under peak</h3>
                  <span className="text-[12px] text-faint">max −{metrics ? metrics.maxDrawdown.toFixed(1) : '—'}%</span>
                </div>
                <div className="mt-3">
                  {backtest.curve.length > 1 ? (
                    <DrawdownChart data={backtest.curve.map((point) => ({ label: shortDate(point.t), value: point.value }))} height={130} />
                  ) : (
                    <p className="py-6 text-center text-[13px] text-muted">No curve recorded</p>
                  )}
                </div>
              </Card>

              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13.5px] font-semibold">P&amp;L per closed trade</h3>
                  <span className="text-[12px] text-faint">
                    {metrics ? `${metrics.winRate.toFixed(0)}% won` : '—'}
                  </span>
                </div>
                <div className="mt-3">
                  {(() => {
                    const closed = [...backtest.trades].filter((trade) => trade.pnl !== null).reverse()
                    return closed.length > 0 ? (
                      <BarChart
                        data={closed.map((trade) => ({
                          label: shortDate(trade.at),
                          value: trade.pnl ?? 0,
                          note: trade.side,
                        }))}
                        height={130}
                      />
                    ) : (
                      <p className="py-6 text-center text-[13px] text-muted">The strategy never closed a trade</p>
                    )
                  })()}
                </div>
              </Card>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold">Trades</h3>
                <span className="text-[12px] text-faint">{backtest.trades.length} fills</span>
              </div>
              <div className="mt-2 max-h-[320px] overflow-y-auto rounded-card border border-line">
                <table className="w-full table-fixed text-left text-[13px]">
                  <tbody className="divide-y divide-line">
                    {backtest.trades.map((trade) => (
                      <tr key={trade.id} className="h-10">
                        <td className="px-3 text-muted">{shortDate(trade.at)}</td>
                        <td className="px-3">
                          <Badge tone={trade.side === 'buy' ? 'info' : 'warning'}>{trade.side}</Badge>
                        </td>
                        <td className="px-3 text-right tabular-nums text-muted">{trade.qty}</td>
                        <td className="px-3 text-right tabular-nums text-muted">{trade.price.toFixed(2)}</td>
                        <td className={cx('px-3 text-right tabular-nums', trade.pnl === null ? 'text-faint' : trade.pnl >= 0 ? 'text-success' : 'text-danger')}>
                          {trade.pnl === null ? '—' : `${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {backtest.trades.length === 0 && <p className="py-6 text-center text-[13px] text-muted">The strategy never traded</p>}
              </div>
            </div>
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate(undefined)}
        loading={remove.isPending}
        title="Delete this backtest?"
        description="Its metrics, curve and trade list are removed."
      />
    </>
  )
}
