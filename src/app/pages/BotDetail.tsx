import { ArrowDownRight, ArrowLeft, ArrowUpRight, Pause, Play, PowerOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'

import { AreaChart, BarChart, CandleChart, ChartNote, DrawdownChart, Sparkline } from '../components/charts'
import { Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Live, Skeleton, useToast, type DataColumn } from '../components/ui'
import { controlBot, deleteBot, fetchMarketHistory, patchBot, useApiMutation, useBot, useBotAccuracy } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime, shortDate } from '../lib/format'
import { BOT_STAGES, TIMEFRAMES, activityOf, type AccuracyStat, type Bot, type BotStage, type BotEvent, type Position, type Timeframe, type Trade } from '../../shared/types'

/* Increment labels for the timeframe scroller (TIMEFRAMES labels read in words). */
const TF_SHORT: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' }
/** Bars-per-chart budget: shorter candles sweep fewer days, longer ones sweep
 * years — the server clamps to its MAX_BARS either way. */
const TF_DAYS: Record<Timeframe, number> = { '1m': 3, '5m': 5, '15m': 10, '1h': 45, '4h': 120, '1d': 365 }

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
    { label: 'Equity', value: money(bot.equity), hint: `of ${money(bot.initialEquity)} seeded`, spark: curve.map((p) => p.value), sparkPositive: pnl >= 0 },
    { label: 'Total P&L', value: `${pnl >= 0 ? '+' : ''}${money(pnl)}`, hint: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`, tone: pnl >= 0 ? 'text-success' : 'text-danger' },
    { label: 'Cash', value: money(bot.cash), hint: 'uninvested' },
    { label: 'Win rate', value: winRate === null ? '—' : `${winRate.toFixed(0)}%`, hint: `${bot.wins}/${bot.roundTrips} trades` },
    { label: 'Open positions', value: String(positions.length), hint: bot.symbols.join(', ') },
    { label: 'Timeframe', value: bot.timeframe, hint: bot.mode === 'live' ? 'live mode' : 'paper mode' },
  ]

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      {/* Sticky operator bar: identity + mode badge up top, controls to hand */}
      <div className="sticky top-0 z-20 -mx-5 -mt-5 mb-4 border-b border-line bg-surface/95 px-5 pb-3 pt-2.5 backdrop-blur-md sm:-mx-8 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link to="/bots" className="inline-flex items-center gap-1 text-[12px] text-muted transition-colors hover:text-fg">
              <ArrowLeft className="size-3" />
              Bots
            </Link>
            <h1 className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 truncate text-[18px] font-semibold tracking-[-0.02em]">
              <span className="truncate">{bot.name}</span>
              {/* Mode badge front and center: paper vs live is the first thing an operator reads. */}
              <Badge tone={bot.mode === 'live' ? 'success' : 'info'}>{bot.mode} mode</Badge>
            </h1>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-faint">
          <Badge
            tone={bot.status === 'running' ? 'success' : bot.status === 'paused' ? 'warning' : 'neutral'}
            dot
            title="Active: trading · Inactive: holding only · Grounded: no trades, no positions"
          >
            {activityOf(bot)}
          </Badge>
          <span>{bot.strategyName}</span>
          <span aria-hidden>·</span>
          <span>{bot.symbols.join(' · ')}</span>
          <span aria-hidden>·</span>
          <span>{bot.startedAt ? `first started ${relativeTime(bot.startedAt)}` : `created ${shortDate(bot.createdAt)}`}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {kpis.map((kpi) => (
          <Card key={kpi.label} className="flex h-[104px] flex-col justify-between p-4">
            <p className="text-[12.5px] text-muted">{kpi.label}</p>
            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p className={cx('text-[19px] font-semibold tracking-[-0.02em] t-num', kpi.tone)}>{kpi.value}</p>
                <p className="truncate text-[11.5px] text-faint">{kpi.hint}</p>
              </div>
              {kpi.spark !== undefined && <Sparkline className="mb-0.5 shrink-0" width={72} height={24} data={kpi.spark} positive={kpi.sparkPositive} />}
            </div>
          </Card>
        ))}
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
              <>
                <AreaChart data={curve} />
                <ChartNote value="closed-bar equity, marks on open bars" source={`${bot.strategyName} · ${bot.symbols.join(' · ')}`}
                />
              </>
            ) : (
              <EmptyState icon={<Play />} title="Nothing yet" description="Equity is recorded as closed bars come in." />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <EventStream events={events} />
        </Card>
      </div>

      <MarketPanel bot={bot} trades={trades} running={bot.status === 'running'} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Drawdown under running peak</h2>
            <span className="text-[12.5px] text-faint">% below highest equity</span>
          </div>
          <div className="mt-4">
            {curve.length > 1 ? (
              <>
                <DrawdownChart data={curve} height={150} />
                <ChartNote value="running-peak drawdown" source="peak derived from the same curve above" />
              </>
            ) : (
              <p className="py-6 text-center text-[13px] text-muted">Not enough history yet</p>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Realised P&amp;L per closed trade</h2>
            <span className={cx('text-[12.5px] t-num', realizedGross >= 0 ? 'text-success' : 'text-danger')}>
              {closedTrades.length === 0 ? 'no round trips yet' : `${realizedGross >= 0 ? '+' : ''}$${realizedGross.toFixed(2)} across ${closedTrades.length}`}
            </span>
          </div>
          <div className="mt-4">
            {closedTrades.length > 0 ? (
              <>
                <BarChart
                  data={closedTrades.map((trade) => ({
                    label: shortDate(trade.at),
                    value: trade.pnl ?? 0,
                    note: trade.symbol,
                  }))}
                  height={150}
                />
                <ChartNote value="one bar per closed round trip" source="green wins, red losses; hover for the symbol" />
              </>
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
          <span className="text-[12.5px] t-num text-faint">{positions.length} held</span>
        </div>
        <div className="mt-3 px-5 pb-5">
          <PositionTable positions={positions} />
        </div>
      </Card>

      <Card className="mt-3 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-[14px] font-semibold">Trade log</h2>
          <span className="text-[12.5px] t-num text-faint">{trades.length} fills</span>
        </div>
        <div className="mt-3 px-5 pb-5">
          <TradeTable trades={trades} />
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

/** Run-event feed with a level filter (all · signals · fills · info ·
 * warnings · errors) so operators can pull one thread out of the stream. */
function EventStream({ events }: { events: BotEvent[] }) {
  const [level, setLevel] = useState<'all' | BotEvent['level']>('all')
  const levels: { key: 'all' | BotEvent['level']; label: string; hint?: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'signal', label: 'Signals' },
    { key: 'fill', label: 'Fills' },
    { key: 'info', label: 'Info' },
    { key: 'warn', label: 'Warns', hint: 'risk guard rails' },
    { key: 'error', label: 'Errors' },
  ]
  const filtered = level === 'all' ? events : events.filter((event) => event.level === level)
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">Run events</h2>
        <span className="text-[12.5px] t-num text-faint">{filtered.length}/{events.length}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1" role="group" aria-label="Filter events by level">
        {levels.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={level === option.key}
            title={option.hint}
            onClick={() => setLevel(option.key)}
            className={cx(
              'h-7 rounded-tile px-2 text-[11.5px] font-medium transition-colors',
              level === option.key ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <ul className="scrollbar-thin mt-2 max-h-[300px] divide-y divide-line overflow-y-auto">
        {filtered.map((event) => (
          <li key={event.id} className="flex items-start gap-2.5 py-2.5">
            <span
              className={cx(
                'mt-1 round size-1.5 shrink-0',
                event.level === 'fill' ? 'bg-success' : event.level === 'error' ? 'bg-danger' : event.level === 'warn' ? 'bg-warning' : 'bg-line-strong',
              )}
            />
            <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted">{event.message}</span>
            <span className="shrink-0 text-[11.5px] t-num text-faint">{relativeTime(event.at)}</span>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="py-6 text-center text-[13px] text-muted">{level === 'all' ? 'No events yet' : `No ${level} events in this window`}</li>
        )}
      </ul>
    </>
  )
}

/** Candlestick panel of the data this bot trades on: the market history API
 * serves the same deterministic feed the engine replays, so what you see is
 * exactly what the strategy saw. Timeframe scroller + symbol selector + fill
 * markers from the bot's own trade log. */
function MarketPanel({ bot, trades, running }: { bot: Bot; trades: Trade[]; running: boolean }) {
  const [symbol, setSymbol] = useState(bot.symbols[0] ?? 'BTC-USD')
  const [tf, setTf] = useState<Timeframe>(bot.timeframe)
  const market = useQuery({
    queryKey: ['bot-market', bot.id, symbol, tf],
    queryFn: () => fetchMarketHistory(symbol, tf, TF_DAYS[tf] ?? 45),
    refetchInterval: running ? 6_000 : false,
    placeholderData: (p) => p,
    retry: 1,
  })
  const candles = market.data?.candles ?? []
  const windowStart = candles[0]?.t ?? 0
  const windowEnd = candles.length > 0 ? candles[candles.length - 1].t : Infinity
  // Fills from the bot's own log, clipped to the charted window (newest last).
  const markers = trades
    .filter((trade) => trade.symbol === symbol && trade.at >= windowStart && trade.at <= windowEnd)
    .slice(-160)
    .map((trade) => ({ t: trade.at, side: trade.side, price: trade.price }))

  return (
    <Card className="mt-3 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-semibold">Market &amp; fills</h2>
          <Live active={running && Boolean(market.data)} label={running ? '6s updates' : 'stationary while grounded'} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {bot.symbols.length > 1 && (
            <div className="flex gap-0.5 rounded-control bg-surface-2 p-0.5" role="group" aria-label="Choose symbol">
              {bot.symbols.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={symbol === option}
                  onClick={() => setSymbol(option)}
                  className={cx(
                    'h-7 rounded-tile px-2 text-[12px] font-medium transition-colors',
                    symbol === option ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-0.5 rounded-control bg-surface-2 p-0.5" role="group" aria-label="Choose timeframe">
            {TIMEFRAMES.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={tf === option.key}
                title={option.label}
                onClick={() => setTf(option.key)}
                className={cx(
                  'h-7 rounded-tile px-2 text-[12px] font-medium transition-colors',
                  tf === option.key ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
                )}
              >
                {TF_SHORT[option.key]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="px-5 pb-5 pt-4">
        {market.isLoading && <Skeleton className="h-[220px] rounded-tile" />}
        {!market.isLoading && candles.length > 1 && (
          <>
            <CandleChart candles={candles} markers={markers} />
            <ChartNote
              value={`${candles.length} candles · ${symbol} @ ${tf}`}
              source="stored 5-year feed · the same bars the engine replays · ▲ buy ▼ sell fills"
            />
          </>
        )}
        {!market.isLoading && candles.length <= 1 && (
          <EmptyState
            icon={<ArrowUpRight />}
            title={market.data ? 'Not enough bars in this window' : market.isError ? 'Could not load market history' : 'Loading'}
            description={market.data ? 'Switch to a longer timeframe for more bars.' : undefined}
          />
        )}
      </div>
    </Card>
  )
}

const positionColumns: DataColumn<Position>[] = [
  { key: 'symbol', header: 'Symbol', width: 'w-[22%]', cell: (p) => <span className="truncate font-medium">{p.symbol}</span> },
  { key: 'qty', header: 'Qty', width: 'w-[18%]', align: 'right', numeric: true, cell: (p) => <span className="text-muted">{p.qty}</span> },
  { key: 'avg', header: 'Avg price', width: 'w-[20%]', align: 'right', numeric: true, cell: (p) => <span className="text-muted">{p.avgPrice.toFixed(2)}</span> },
  { key: 'mark', header: 'Mark', width: 'w-[20%]', align: 'right', numeric: true, cell: (p) => <span className="text-muted">{p.markPrice.toFixed(2)}</span> },
  {
    key: 'pnl',
    header: 'Unrealised',
    width: 'w-[20%]',
    align: 'right',
    numeric: true,
    headerTitle: 'Mark − average price × quantity',
    cell: (p) => <span className={p.unrealizedPnl >= 0 ? 'text-success' : 'text-danger'}>{p.unrealizedPnl >= 0 ? '+' : ''}{money(p.unrealizedPnl)}</span>,
  },
]

function PositionTable({ positions }: { positions: Position[] }) {
  return (
    <DataTable
      columns={positionColumns}
      rows={positions}
      rowKey={(p) => p.symbol}
      empty={
        <tr>
          <td colSpan={positionColumns.length}>
            <EmptyState icon={<ArrowDownRight />} title="Flat" description="The bot holds no positions right now." />
          </td>
        </tr>
      }
    />
  )
}

const tradeColumns: DataColumn<Trade>[] = [
  {
    key: 'at',
    header: 'Time',
    width: 'w-[24%]',
    cell: (t) => (
      <span className="truncate text-muted">
        {shortDate(t.at)} · {new Date(t.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
      </span>
    ),
  },
  { key: 'symbol', header: 'Symbol', width: 'w-[22%]', cell: (t) => <span className="truncate font-medium">{t.symbol}</span> },
  { key: 'side', header: 'Side', width: 'w-[12%]', cell: (t) => <Badge tone={t.side === 'buy' ? 'info' : 'warning'}>{t.side}</Badge> },
  { key: 'qty', header: 'Qty', width: 'w-[16%]', align: 'right', numeric: true, cell: (t) => <span className="text-muted">{t.qty}</span> },
  { key: 'price', header: 'Price', width: 'w-[16%]', align: 'right', numeric: true, cell: (t) => <span className="text-muted">{t.price.toFixed(2)}</span> },
  {
    key: 'pnl',
    header: 'P&L',
    width: 'w-[10%]',
    align: 'right',
    numeric: true,
    headerTitle: "Realised P&L on closed round trips",
    cell: (t) =>
      t.pnl === null ? (
        <span className="text-faint">—</span>
      ) : (
        <span className={t.pnl >= 0 ? 'text-success' : 'text-danger'}>{t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}</span>
      ),
  },
]

function TradeTable({ trades }: { trades: Trade[] }) {
  return (
    <DataTable
      columns={tradeColumns}
      rows={trades}
      dense
      rowKey={(t) => t.id}
      empty={
        <tr>
          <td colSpan={tradeColumns.length}>
            <EmptyState icon={<ArrowUpRight />} title="No fills yet" description="Trades appear as the strategy fires." />
          </td>
        </tr>
      }
    />
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
              <span className="text-[30px] font-semibold tracking-[-0.02em] t-num">
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
            <div className="relative h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Directional accuracy ${accuracy.directionalAccuracy ?? 0} percent`}>
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${Math.max(2, Math.min(100, accuracy.directionalAccuracy ?? 0))}%` }}
              />
              <span className="absolute inset-y-0 left-1/2 w-px bg-fg/60" title="coin-flip baseline (50%)" />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] t-num text-faint">
              <span>0%</span>
              <span>50% coin-flip</span>
              <span>100%</span>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
              <div>
                <dt className="text-faint">Edge / signal bar</dt>
                <dd className="t-num">{accuracy.edgePct === null ? '—' : `${accuracy.edgePct >= 0 ? '+' : ''}${accuracy.edgePct.toFixed(3)}%`}</dd>
              </div>
              <div>
                <dt className="text-faint">Mean signal return</dt>
                <dd className="t-num">{accuracy.signalReturnPct === null ? '—' : `${accuracy.signalReturnPct >= 0 ? '+' : ''}${accuracy.signalReturnPct.toFixed(3)}%`}</dd>
              </div>
              <div>
                <dt className="text-faint">Samples</dt>
                <dd className="t-num">{accuracy.sample} bar{accuracy.sample === 1 ? '' : 's'}</dd>
              </div>
              <div>
                <dt className="text-faint">Realised hit rate</dt>
                <dd className="t-num">{hitRate === null ? 'no trades yet' : `${hitRate.toFixed(0)}% (${liveWins}/${roundTrips})`}</dd>
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
