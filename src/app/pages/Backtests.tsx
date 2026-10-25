import { CandlestickChart, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { AreaChart } from '../components/charts'
import { BacktestDialog } from '../components/forms'
import { Badge, Button, Card, ConfirmDialog, Drawer, EmptyState, Live, PageHeader, Skeleton, useToast } from '../components/ui'
import { deleteBacktest, useApiMutation, useBacktests } from '../lib/api'
import { cx } from '../lib/cx'
import { money, shortDate } from '../lib/format'
import type { Backtest } from '../../shared/types'

export function Backtests() {
  const { data, isLoading } = useBacktests()
  const [params, setParams] = useSearchParams()
  const [composing, setComposing] = useState(false)
  const selected = params.get('id')

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
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

      <div className="mt-6 overflow-hidden rounded-card border border-line">
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
                    onClick={() => setParams({ id: backtest.id })}
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
                      {shortDate(backtest.from)} – {shortDate(backtest.to)}
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
      <BacktestDrawer id={selected} onClose={() => setParams({})} />
    </div>
  )
}

function BacktestDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading } = useBacktests()
  const toast = useToast()
  const [deleting, setDeleting] = useState(false)
  const backtest: Backtest | undefined = data?.items.find((item) => item.id === id)

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
              <Badge tone={backtest.status === 'done' ? 'success' : backtest.status === 'failed' ? 'danger' : 'neutral'}>{backtest.status}</Badge>
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
                <h3 className="text-[13.5px] font-semibold">Equity curve</h3>
                <span className="text-[12px] text-faint">
                  {shortDate(backtest.from)} – {shortDate(backtest.to)}
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
