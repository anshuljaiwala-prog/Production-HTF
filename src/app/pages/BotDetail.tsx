import { ArrowLeft, ChevronRight, Pause, Play, Plus, PowerOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { AreaChart, BarChart, DrawdownChart } from '../components/charts'
import { Badge, Button, Card, ConfirmDialog, EmptyState, Live, PageHeader, Skeleton, useToast } from '../components/ui'
import { controlBot, deleteBot, patchBot, useApiMutation, useBot, useBotAccuracy } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime, shortDate } from '../lib/format'
import { BOT_STAGES, activityOf, type AccuracyStat, type BotStage } from '../../shared/types'

export function BotDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { data, isLoading } = useBot(id)
  const [deleting, setDeleting] = useState(false)

  const control = useApiMutation(
    (action: 'pause' | 'ground' | 'resume') => controlBot(id!, action),
    ['bot', 'bots', 'dashboard'],
    {
      onSuccess: (result) =>
        toast(
          result.bot.status === 'running'
            ? 'Bot resumed — trading again'
            : result.bot.status === 'paused'
              ? 'Bot paused — holds its book'
              : 'Bot grounded — no new trades until resumed',
        ),
    },
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
              {/* Ground/Resume: the blunt operator control. Grounding stops
                  the bot — it holds its book and opens nothing new; Resume
                  starts it again from paused or grounded. */}
              {bot.status === 'running' ? (
                <Button onClick={() => control.mutate('pause')} loading={control.isPending}>
                  <Pause />
                  Pause
                </Button>
              ) : (
                <Button variant="primary" onClick={() => control.mutate('resume')} loading={control.isPending}>
                  <Play />
                  Resume
                </Button>
              )}
              {bot.status !== 'stopped' && (
                <Button
                  onClick={() => control.mutate('ground')}
                  loading={control.isPending}
                  title="Ground: stop opening trades. The bot keeps its positions until they close."
                >
                  <PowerOff />
                  Ground
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

      <AccuracyCard botId={id} liveWins={bot.wins} roundTrips={bot.roundTrips} />

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

const RATING_TONE: Record<NonNullable<AccuracyStat['rating']>, 'success' | 'warning' | 'danger' | 'neutral'> = {
  edge: 'success',
  'coin-flip': 'warning',
  anti: 'danger',
  'thin-sample': 'neutral',
}

/** How well this bot's rules predict the next bar, measured over a bounded
 * recent window of the same feed the bot trades. The gauge line marks the
 * coin-flip baseline (50%) so "60%" reads as a real edge, not noise. */
function AccuracyCard({ botId, liveWins, roundTrips }: { botId: string | undefined; liveWins: number; roundTrips: number }) {
  const { data, isLoading } = useBotAccuracy(botId)
  const accuracy = data?.accuracy
  const hitRate = roundTrips > 0 ? (liveWins / roundTrips) * 100 : null

  return (
    <Card className="mt-3 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Market-edge accuracy</h2>
        <span className="text-[12.5px] text-faint">
          {accuracy
            ? `${data.window.bars} bars · ${data.window.symbol ?? '—'} @ ${data.window.timeframe}`
            : 'measured on every read'}
        </span>
      </div>

      {isLoading && <Skeleton className="mt-4 h-24 rounded-tile" />}

      {!isLoading && accuracy && (
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-center">
          <div>
            <div className="flex items-baseline gap-3">
              <span className="text-[30px] font-semibold tracking-[-0.02em] tabular-nums">
                {accuracy.directionalAccuracy === null ? '—' : `${accuracy.directionalAccuracy.toFixed(1)}%`}
              </span>
              {accuracy.rating && <Badge tone={RATING_TONE[accuracy.rating]}>{accuracy.rating}</Badge>}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              Of {accuracy.entryBars} entry-signal bars in the window, {accuracy.correct} closed in the direction the
              strategy bet on.
            </p>
          </div>

          <div>
            {/* Gauge: 0–100% of next-bar direction, with a marker at the
                50% coin-flip baseline. Evidence beats decoration. */}
            <div className="relative h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Directional accuracy ${accuracy.directionalAccuracy ?? 0} percent`}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${Math.max(2, Math.min(100, accuracy.directionalAccuracy ?? 0))}%` }}
              />
              <span className="absolute inset-y-0 left-1/2 w-px bg-fg/60" title="coin-flip baseline (50%)" />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-faint">
              <span>0%</span>
              <span>50% coin-flip</span>
              <span>100%</span>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
              <div>
                <dt className="text-faint">Edge / signal bar</dt>
                <dd className="tabular-nums">{accuracy.edgePct === null ? '—' : `${accuracy.edgePct >= 0 ? '+' : ''}${accuracy.edgePct.toFixed(3)}%`}</dd>
              </div>
              <div>
                <dt className="text-faint">Mean signal return</dt>
                <dd className="tabular-nums">{accuracy.signalReturnPct === null ? '—' : `${accuracy.signalReturnPct >= 0 ? '+' : ''}${accuracy.signalReturnPct.toFixed(3)}%`}</dd>
              </div>
              <div>
                <dt className="text-faint">Samples</dt>
                <dd className="tabular-nums">{accuracy.sample} bar{accuracy.sample === 1 ? '' : 's'}</dd>
              </div>
              <div>
                <dt className="text-faint">Realised hit rate</dt>
                <dd className="tabular-nums">{hitRate === null ? 'no trades yet' : `${hitRate.toFixed(0)}% (${liveWins}/${roundTrips})`}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {!isLoading && !accuracy && (
        <p className="mt-2 text-[13px] text-muted">Not enough bar history in this window to score prediction quality yet.</p>
      )}
    </Card>
  )
}
