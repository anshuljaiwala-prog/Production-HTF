import { AlertTriangle, ArrowUpRight, Bot as BotIcon, Layers, Pause, PowerOff, Zap } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { AreaChart, ChartNote, Sparkline } from '../components/charts'
import { Badge, Button, Card, EmptyState, Live, PageHeader, Skeleton } from '../components/ui'
import { useDashboard } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime } from '../lib/format'
import { BOT_STAGES, activityOf, type BotStage } from '../../shared/types'

const stageTone: Record<BotStage, string> = {
  draft: '#c6c6d2',
  backtest: '#9d99f0',
  paper: '#2f77d1',
  live: '#1d9a66',
}

/** Equity windows the header's segmented control offers. */
const PERIODS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 365, label: '1y' },
]

export function Dashboard() {
  const navigate = useNavigate()
  const [days, setDays] = useState(30)
  const { data, isLoading } = useDashboard(days)

  const totalBots = data?.stageTotals.reduce((sum, stage) => sum + stage.count, 0) ?? 0
  const todayPnl = data?.kpis.todayPnl ?? 0
  const isLive = (data?.kpis.activeBots ?? 0) > 0

  // Sparkline sources derived from the fleet equity series: shape of capital
  // over the window, and the day-to-day change ("daily P&L").
  const equitySeries = data?.equity ?? []
  const capitalSpark = equitySeries.map((point) => point.value)
  const dailySpark = equitySeries.map((point, i) => (i === 0 ? 0 : point.value - equitySeries[i - 1].value))

  const kpis: { label: string; value: string; hint: string; spark?: number[]; sparkPositive?: boolean; tone?: string }[] = data
    ? [
        {
          label: 'Live capital',
          value: money(data.kpis.capitalDeployed),
          hint: `${data.kpis.liveBots} live ${data.kpis.liveBots === 1 ? 'bot' : 'bots'}`,
          spark: capitalSpark,
        },
        {
          label: 'P&L today',
          value: money(todayPnl),
          hint: 'realised + open',
          spark: dailySpark,
          sparkPositive: todayPnl >= 0,
          tone: todayPnl >= 0 ? 'text-success' : 'text-danger',
        },
        { label: 'Active bots', value: String(data.kpis.activeBots), hint: `of ${totalBots} live` },
        {
          label: 'Win rate',
          value: data.kpis.winRate === null ? '—' : `${data.kpis.winRate.toFixed(0)}%`,
          hint: data.kpis.winRate === null ? 'no closed trades yet' : 'closed round trips',
        },
        { label: 'Open positions', value: String(data.kpis.openPositions), hint: 'across the live book' },
      ]
    : []

  // Fleet strip: whole-fleet counts in the operator's vocabulary, each chip a
  // shortcut into the matching bots list filter.
  const fleet = data?.fleet
  const strip = fleet
    ? [
        { label: 'Active', count: fleet.running, to: '/bots', className: 'text-success', icon: <Zap className="size-3.5" /> },
        { label: 'Holding', count: fleet.paused, to: '/bots', className: 'text-warning', icon: <Pause className="size-3.5" /> },
        { label: 'Grounded', count: fleet.grounded, to: '/bots', className: 'text-danger', icon: <PowerOff className="size-3.5" /> },
      ]
    : []

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Dashboard"
        subtitle="High-frequency bots on the live book, routed to their exchange venues."
        actions={
          <Button variant="primary" onClick={() => navigate('/strategies')}>
            <Zap />
            Launch a bot
          </Button>
        }
      />

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-card" />)
          : kpis.map((kpi) => (
              <Card key={kpi.label} className="flex h-[118px] flex-col justify-between p-4">
                <p className="text-[13px] text-muted">{kpi.label}</p>
                <div className="flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <p className={cx('text-[22px] leading-[1.15] font-semibold tracking-[-0.02em] t-num', kpi.tone)}>{kpi.value}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[12px] text-faint">
                      {kpi.spark !== undefined && kpi.sparkPositive !== undefined && kpi.sparkPositive ? <ArrowUpRight className="size-3.5 text-success" /> : null}
                      {kpi.hint}
                    </p>
                  </div>
                  {kpi.spark !== undefined && <Sparkline className="mb-0.5 shrink-0" data={kpi.spark} positive={kpi.sparkPositive} />}
                </div>
              </Card>
            ))}
      </div>

      {/* Fleet strip */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {strip.length > 0 &&
          strip.map((chip) => (
            <Link
              key={chip.label}
              to={chip.to}
              className={cx(
                'inline-flex h-8 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-[13px] shadow-card transition-colors hover:bg-surface-2',
                chip.className,
              )}
              title={`${chip.label} bots — open the matching list`}
            >
              {chip.icon}
              {chip.label}
              <span className="font-semibold t-num">{chip.count}</span>
            </Link>
          ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[14px] font-semibold">Fleet equity</h2>
            <div className="flex items-center gap-3">
              {isLive && <Live active label="4s updates" />}
              <div className="grid grid-cols-3 gap-0.5 rounded-control bg-surface-2 p-0.5">
                {PERIODS.map((period) => (
                  <button
                    key={period.days}
                    type="button"
                    aria-pressed={days === period.days}
                    onClick={() => setDays(period.days)}
                    className={cx(
                      'h-7 rounded-tile px-2.5 text-[12px] font-medium transition-colors',
                      days === period.days ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
                    )}
                  >
                    {period.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4">
            {data ? (
              data.equity.length > 0 ? (
                <>
                  <AreaChart data={data.equity} />
                  <ChartNote
                    value={`daily closes · last ${days === 365 ? 'year' : `${days}d`}`}
                    source="venue marks per bot on open bars"
                  />
                </>
              ) : (
                <EmptyState icon={<Layers />} title="No bots yet" description="Launch a strategy to start building the curve." />
              )
            ) : (
              <Skeleton className="h-[220px]" />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Lifecycle</h2>
            <Link to="/bots?tab=board" className="text-[12.5px] text-muted hover:text-fg">
              Open board
            </Link>
          </div>
          <ul className="mt-5 flex flex-col gap-3.5">
            {(data?.stageTotals ?? []).filter((stage) => stage.stage !== 'paper').map((stage, i) => (
              <li key={stage.stage} className="grid grid-cols-[92px_1fr_auto] items-center gap-3 text-[13px]">
                <span className="text-muted">{BOT_STAGES.find((s) => s.key === stage.stage)?.label}</span>
                <span className="h-2 overflow-hidden rounded-[4px] bg-surface-2">
                  <span
                    className="block h-full rounded-[4px] transition-[width] duration-700"
                    style={{
                      background: stageTone[stage.stage],
                      width: `${totalBots ? (stage.count / totalBots) * 100 : 0}%`,
                      transitionDelay: `${i * 50}ms`,
                    }}
                  />
                </span>
                <span className="w-[40px] text-right t-num text-muted">{stage.count}</span>
              </li>
            ))}
            {data && totalBots === 0 && <li className="py-6 text-center text-[13px] text-muted">No bots on the board</li>}
          </ul>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Needs attention</h2>
            <Link to="/bots" className="text-[12.5px] text-muted hover:text-fg">
              All bots
            </Link>
          </div>
          <ul className="mt-3 divide-y divide-line">
            {data?.attention.map((bot) => {
              const pnl = bot.capital > 0 ? ((bot.equity - bot.capital) / bot.capital) * 100 : 0
              return (
                <li key={bot.id}>
                  <Link to={`/bots/${bot.id}`} className="flex items-center gap-3 py-3 transition-colors hover:bg-surface-2/60">
                    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-muted [&_svg]:size-3.5">
                      {bot.status === 'running' ? <BotIcon /> : <Pause />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{bot.name}</span>
                      <span className="block truncate text-[12.5px] text-faint">{bot.lastEvent ?? bot.strategyName}</span>
                    </span>
                    <Badge
                      tone={bot.status === 'running' ? 'warning' : pnl >= 0 ? 'success' : 'danger'}
                      title="Active: trading · Inactive: holding only · Grounded: no trades, no positions"
                    >
                      {bot.status === 'running' ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%` : activityOf(bot)}
                    </Badge>
                  </Link>
                </li>
              )
            })}
            {data && data.attention.length === 0 && (
              <li className="flex flex-col items-center py-8 text-center">
                <Zap className="size-5 text-faint" />
                <p className="mt-2 text-[13px] text-muted">Everything is running smoothly</p>
              </li>
            )}
          </ul>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Recent events</h2>
            <Link to="/bots?tab=board" className="text-[12.5px] text-muted hover:text-fg">
              Board
            </Link>
          </div>
          <ul className="mt-3 divide-y divide-line">
            {data?.events.map((event) => (
              <li key={event.id} className="flex items-start gap-3 py-3">
                <span
                  className={cx(
                    'mt-0.5 grid size-7 shrink-0 place-items-center rounded-[9px] [&_svg]:size-3.5',
                    event.level === 'fill'
                      ? 'bg-success-soft text-success'
                      : event.level === 'error'
                        ? 'bg-danger-soft text-danger'
                        : event.level === 'warn'
                          ? 'bg-warning-soft text-warning'
                          : 'bg-surface-2 text-muted',
                  )}
                >
                  {event.level === 'error' ? <AlertTriangle /> : event.level === 'warn' ? <AlertTriangle /> : <BotIcon />}
                </span>
                <span className="min-w-0 flex-1">
                  {event.botId ? (
                    <Link to={`/bots/${event.botId}`} className="block truncate text-[13.5px] font-medium hover:underline">
                      {event.botName ?? 'Bot'}
                    </Link>
                  ) : (
                    <span className="block truncate text-[13.5px] font-medium">{event.botName ?? 'Bot'}</span>
                  )}
                  <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{event.message}</span>
                </span>
                <span className="shrink-0 text-[12px] t-num text-faint">{relativeTime(event.at)}</span>
              </li>
            ))}
            {data && data.events.length === 0 && <li className="py-8 text-center text-[13px] text-muted">No events yet</li>}
          </ul>
        </Card>
      </div>
    </div>
  )
}
