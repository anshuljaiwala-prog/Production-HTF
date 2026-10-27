import { ArrowLeft, ChevronRight, Pause, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { AreaChart, BarChart, DrawdownChart } from '../components/charts'
import { Badge, Button, Card, ConfirmDialog, EmptyState, Live, PageHeader, Skeleton, useToast } from '../components/ui'
import { controlBot, deleteBot, patchBot, useApiMutation, useBot } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime, shortDate } from '../lib/format'
import { BOT_STAGES, activityOf, type BotStage } from '../../shared/types'

export function BotDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { data, isLoading } = useBot(id)
  const [deleting, setDeleting] = useState(false)

  const control = useApiMutation(
    (action: 'start' | 'pause' | 'stop') => controlBot(id!, action),
    ['bot', 'bots', 'dashboard'],
    { onSuccess: (result) => toast(`Bot is now ${activityOf(result.bot)}`) },
  )
  const remove = useApiMutation(() => deleteBot(id!), ['bots', 'bot', 'dashboard'], {
    onSuccess: () => {
      toast('Bot deleted')
      navigate('/bots')
    },
  })
  const setStage = useApiMutation((stage: BotStage) => patchBot(id!, { stage }), ['bot', 'bots', 'dashboard'])

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
        <Skeleton className="h-16 w-full" />
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <Skeleton className="h-[240px] rounded-card lg:col-span-2" />
          <Skeleton className="h-[240px] rounded-card" />
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-[720px] p-8">
        <EmptyState
          icon={<ArrowLeft />}
          title="Bot not found"
          description="It may have been deleted."
          action={<Button onClick={() => navigate('/bots')}>Back to bots</Button>}
        />
      </div>
    )
  }

  const { bot, positions, trades, events, equity } = data
  const pnl = bot.equity - bot.initialEquity
  const pnlPct = bot.initialEquity > 0 ? (pnl / bot.initialEquity) * 100 : 0
  const winRate = bot.roundTrips > 0 ? (bot.wins / bot.roundTrips) * 100 : null
  const curve = sample(equity).map((point) => ({
    label: new Date(point.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' }),
    value: point.value,
  }))
  // Closed round trips in chronological (oldest → newest) order for the P&L bars.
  const closedTrades = [...trades].filter((trade) => trade.pnl !== null).reverse()
  const realizedGross = closedTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0)

  const kpis = [
    { label: 'Equity', value: money(bot.equity), hint: `of ${money(bot.initialEquity)} seeded` },
    { label: 'Total P&L', value: `${pnl >= 0 ? '+' : ''}${money(pnl)}`, hint: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`, tone: pnl >= 0 ? 'text-success' : 'text-danger' },
    { label: 'Cash', value: money(bot.cash), hint: 'uninvested' },
    { label: 'Win rate', value: winRate === null ? '—' : `${winRate.toFixed(0)}%`, hint: `${bot.wins}/${bot.roundTrips} trades` },
    { label: 'Open positions', value: String(positions.length), hint: bot.symbols.join(', ') },
    { label: 'Timeframe', value: bot.timeframe, hint: bot.mode === 'live' ? 'live mode' : 'paper mode' },
  ]

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <Link to="/bots" className="inline-flex items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-3.5" />
        Bots
      </Link>

      <div className="mt-3">
        <PageHeader
          title={bot.name}
          subtitle={bot.lastEvent ?? `${bot.strategyName} · ${bot.symbols.join(', ')}`}
          actions={
            <>
              {bot.status === 'running' ? (
                <Button onClick={() => control.mutate('pause')} loading={control.isPending}>
                  <Pause />
                  Pause
                </Button>
              ) : (
                <Button variant="primary" onClick={() => control.mutate('start')} loading={control.isPending}>
                  <Play />
                  Start
                </Button>
              )}
              {bot.status !== 'stopped' && (
                <Button onClick={() => control.mutate('stop')} loading={control.isPending}>
                  <Square />
                  Stop
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="Delete bot" onClick={() => setDeleting(true)}>
                <Trash2 />
              </Button>
            </>
          }
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge
            tone={bot.status === 'running' ? 'success' : bot.status === 'paused' ? 'warning' : 'neutral'}
            dot
            title="Active: trading · Inactive: holding only · Grounded: no trades, no positions"
          >
            {activityOf(bot)}
          </Badge>
          <Badge tone={bot.mode === 'live' ? 'success' : 'info'}>{bot.mode} mode</Badge>
          <Badge tone="accent">{bot.strategyName}</Badge>
          {bot.connectionName && <Badge tone="neutral">{bot.connectionName}</Badge>}
          <span className="text-[12.5px] text-faint">
            {bot.startedAt ? `first started ${relativeTime(bot.startedAt)}` : `created ${shortDate(bot.createdAt)}`}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
          {kpis.map((kpi) => (
            <Card key={kpi.label} className="flex h-[92px] flex-col justify-between p-4">
              <p className="text-[12.5px] text-muted">{kpi.label}</p>
              <div>
                <p className={cx('text-[19px] font-semibold tracking-[-0.02em] tabular-nums', kpi.tone)}>{kpi.value}</p>
                <p className="truncate text-[11.5px] text-faint">{kpi.hint}</p>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Equity curve</h2>
            <Live
              active={bot.status === 'running'}
              label={bot.status === 'running' ? 'live · 2s updates' : `${equity.length} points`}
            />
          </div>
          <div className="mt-4">
            {curve.length > 1 ? (
              <AreaChart data={curve} />
            ) : (
              <EmptyState icon={<Play />} title="Nothing yet" description="Equity is recorded as closed bars come in." />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Run events</h2>
            <span className="text-[12.5px] text-faint">latest first</span>
          </div>
          <ul className="scrollbar-thin mt-3 max-h-[260px] divide-y divide-line overflow-y-auto">
            {events.map((event) => (
              <li key={event.id} className="flex items-start gap-2.5 py-2.5">
                <span
                  className={cx(
                    'mt-1 round size-1.5 shrink-0',
                    event.level === 'fill' ? 'bg-success' : event.level === 'error' ? 'bg-danger' : event.level === 'warn' ? 'bg-warning' : 'bg-line-strong',
                  )}
                />
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted">{event.message}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{relativeTime(event.at)}</span>
              </li>
            ))}
            {events.length === 0 && <li className="py-6 text-center text-[13px] text-muted">No events yet</li>}
          </ul>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Drawdown under running peak</h2>
            <span className="text-[12.5px] text-faint">% below highest equity</span>
          </div>
          <div className="mt-4">
            {curve.length > 1 ? (
              <DrawdownChart data={curve} height={150} />
            ) : (
              <p className="py-6 text-center text-[13px] text-muted">Not enough history yet</p>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Realised P&amp;L per closed trade</h2>
            <span className={cx('text-[12.5px] tabular-nums', realizedGross >= 0 ? 'text-success' : 'text-danger')}>
              {realizedGross >= 0 ? '+' : ''}${realizedGross.toFixed(2)} across {closedTrades.length}
            </span>
          </div>
          <div className="mt-4">
            {closedTrades.length > 0 ? (
              <BarChart
                data={closedTrades.map((trade) => ({
                  label: shortDate(trade.at),
                  value: trade.pnl ?? 0,
                  note: trade.symbol,
                }))}
                height={150}
              />
            ) : (
              <p className="py-6 text-center text-[13px] text-muted">No closed round trips yet</p>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-3 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-[14px] font-semibold">Open positions</h2>
          <span className="text-[12.5px] text-faint">{positions.length} held</span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full table-fixed text-left text-[13.5px]">
            <thead>
              <tr className="h-10 border-y border-line bg-bg/60 text-[12.5px] text-muted">
                <th className="w-[22%] px-5 font-medium">Symbol</th>
                <th className="w-[18%] px-4 text-right font-medium">Qty</th>
                <th className="w-[20%] px-4 text-right font-medium">Avg price</th>
                <th className="w-[20%] px-4 text-right font-medium">Mark</th>
                <th className="w-[20%] px-5 text-right font-medium">Unrealised</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {positions.map((position) => (
                <tr key={position.symbol} className="h-12">
                  <td className="truncate px-5 font-medium">{position.symbol}</td>
                  <td className="px-4 text-right tabular-nums text-muted">{position.qty}</td>
                  <td className="px-4 text-right tabular-nums text-muted">{position.avgPrice.toFixed(2)}</td>
                  <td className="px-4 text-right tabular-nums text-muted">{position.markPrice.toFixed(2)}</td>
                  <td className={cx('px-5 text-right tabular-nums', position.unrealizedPnl >= 0 ? 'text-success' : 'text-danger')}>
                    {position.unrealizedPnl >= 0 ? '+' : ''}
                    {money(position.unrealizedPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {positions.length === 0 && (
            <EmptyState icon={<Plus />} title="Flat" description="The bot holds no positions right now." />
          )}
        </div>
      </Card>

      <Card className="mt-3 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-[14px] font-semibold">Trade log</h2>
          <span className="text-[12.5px] text-faint">{trades.length} fills</span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full table-fixed text-left text-[13.5px]">
            <thead>
              <tr className="h-10 border-y border-line bg-bg/60 text-[12.5px] text-muted">
                <th className="w-[22%] px-5 font-medium">Time</th>
                <th className="w-[20%] px-4 font-medium">Symbol</th>
                <th className="w-[12%] px-4 font-medium">Side</th>
                <th className="w-[16%] px-4 text-right font-medium">Qty</th>
                <th className="w-[16%] px-4 text-right font-medium">Price</th>
                <th className="w-[14%] px-5 text-right font-medium">P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {trades.map((trade) => (
                <tr key={trade.id} className="h-12">
                  <td className="truncate px-5 text-muted">{shortDate(trade.at)} · {new Date(trade.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="truncate px-4 font-medium">{trade.symbol}</td>
                  <td className="px-4">
                    <Badge tone={trade.side === 'buy' ? 'info' : 'warning'}>{trade.side}</Badge>
                  </td>
                  <td className="px-4 text-right tabular-nums text-muted">{trade.qty}</td>
                  <td className="px-4 text-right tabular-nums text-muted">{trade.price.toFixed(2)}</td>
                  <td className={cx('px-5 text-right tabular-nums', trade.pnl === null ? 'text-faint' : trade.pnl >= 0 ? 'text-success' : 'text-danger')}>
                    {trade.pnl === null ? '—' : `${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {trades.length === 0 && <EmptyState icon={<ChevronRight />} title="No fills yet" description="Trades appear as the strategy fires." />}
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">Lifecycle stage</span>
        <div className="grid grid-cols-4 gap-1 rounded-control bg-bg p-1">
          {BOT_STAGES.map((stage) => (
            <button
              key={stage.key}
              type="button"
              onClick={() => setStage.mutate(stage.key)}
              className={cx(
                'h-8 rounded-[9px] px-3 text-[12px] font-medium transition-colors',
                bot.stage === stage.key ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
              )}
            >
              {stage.label}
            </button>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate(undefined)}
        loading={remove.isPending}
        title="Delete this bot?"
        description="Its positions, trades, events and equity history are removed too."
      />
    </div>
  )
}

/** Cap the number of points handed to the chart so labels stay readable. */
function sample<T extends { t: number }>(points: T[]): T[] {
  if (points.length <= 90) return points
  const step = Math.ceil(points.length / 90)
  return points.filter((_, i) => i % step === 0 || i === points.length - 1)
}
