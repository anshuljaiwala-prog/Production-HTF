import { ArrowDownRight, ArrowUpRight, Bot as BotIcon, Layers, Pause, Zap } from 'lucide-react'
import { Link, useNavigate } from 'react-router'

import { AreaChart } from '../components/charts'
import { Badge, Button, Card, EmptyState, Live, PageHeader, Skeleton } from '../components/ui'
import { useDashboard } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime } from '../lib/format'
import { BOT_STAGES, type BotStage } from '../../shared/types'

const stageTone: Record<BotStage, string> = {
  draft: '#c6c6d2',
  backtest: '#9d99f0',
  paper: '#2f77d1',
  live: '#1d9a66',
}

export function Dashboard() {
  const { data, isLoading } = useDashboard()
  const navigate = useNavigate()

  const totalBots = data?.stageTotals.reduce((sum, stage) => sum + stage.count, 0) ?? 0
  const todayPnl = data?.kpis.todayPnl ?? 0
  const isLive = (data?.kpis.activeBots ?? 0) > 0

  const kpis: { label: string; value: string; hint: string; delta?: number | null; tone?: string }[] = data
    ? [
        { label: 'Capital deployed', value: money(data.kpis.capitalDeployed), hint: `${data.kpis.openPositions} open positions` },
        {
          label: 'P&L today',
          value: money(todayPnl),
          delta: todayPnl === 0 ? null : todayPnl > 0 ? 1 : -1,
          hint: 'realised + open',
          tone: todayPnl >= 0 ? 'text-success' : 'text-danger',
        },
        { label: 'Active bots', value: String(data.kpis.activeBots), hint: `of ${totalBots} launched` },
        {
          label: 'Win rate',
          value: data.kpis.winRate === null ? '—' : `${data.kpis.winRate.toFixed(0)}%`,
          hint: data.kpis.winRate === null ? 'no closed trades yet' : 'closed trades',
        },
        { label: 'Open positions', value: String(data.kpis.openPositions), hint: 'across the fleet' },
      ]
    : []

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Dashboard"
        subtitle="High-frequency bots, paper-filled against the simulated venue."
        actions={
          <Button variant="primary" onClick={() => navigate('/strategies')}>
            <Zap />
            Launch a bot
          </Button>
        }
      />

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-card" />)
          : kpis.map((kpi) => (
              <Card key={kpi.label} className="flex h-[104px] flex-col justify-between p-4">
                <p className="text-[13px] text-muted">{kpi.label}</p>
                <div>
                  <p className={cx('text-[24px] font-semibold tracking-[-0.02em] tabular-nums', kpi.tone)}>{kpi.value}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-faint">
                    {kpi.delta !== undefined && kpi.delta !== null && (
                      <span className={cx('inline-flex items-center font-medium', kpi.delta >= 0 ? 'text-success' : 'text-danger')}>
                        {kpi.delta >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
                      </span>
                    )}
                    {kpi.hint}
                  </p>
                </div>
              </Card>
            ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Fleet equity</h2>
            {isLive ? (
              <Live active label="live · 4s updates" />
            ) : (
              <span className="text-[12.5px] text-faint">Last 30 days, all bots</span>
            )}
          </div>
          <div className="mt-4">
            {data ? (
              data.equity.length > 0 ? (
                <AreaChart data={data.equity} />
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
            {(data?.stageTotals ?? []).map((stage, i) => (
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
                <span className="w-[40px] text-right tabular-nums text-muted">{stage.count}</span>
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
              const pnl = bot.initialEquity > 0 ? ((bot.equity - bot.initialEquity) / bot.initialEquity) * 100 : 0
              return (
                <li key={bot.id}>
                  <Link to={`/bots/${bot.id}`} className="flex items-center gap-3 py-3 transition-colors hover:bg-surface-2/60">
                    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-muted [&_svg]:size-3.5">
                      {bot.status === 'paused' ? <Pause /> : <BotIcon />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{bot.name}</span>
                      <span className="block truncate text-[12.5px] text-faint">{bot.lastEvent ?? bot.strategyName}</span>
                    </span>
                    <Badge tone={bot.status === 'paused' ? 'warning' : pnl >= 0 ? 'success' : 'danger'}>
                      {bot.status === 'paused' ? 'Paused' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`}
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
                    event.level === 'fill' ? 'bg-success-soft text-success' : event.level === 'error' ? 'bg-danger-soft text-danger' : event.level === 'warn' ? 'bg-warning-soft text-warning' : 'bg-surface-2 text-muted',
                  )}
                >
                  <BotIcon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{event.botName ?? 'Bot'}</span>
                  <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{event.message}</span>
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-faint">{relativeTime(event.at)}</span>
              </li>
            ))}
            {data && data.events.length === 0 && (
              <li className="py-8 text-center text-[13px] text-muted">No events yet</li>
            )}
          </ul>
        </Card>
      </div>
    </div>
  )
}
