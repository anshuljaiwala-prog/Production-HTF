import { ArrowDownRight, ArrowUpRight, FileSearch, Wallet, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { AreaChart } from '../components/charts'
import { Badge, Card, EmptyState, Live, PageHeader, Skeleton } from '../components/ui'
import { useBot, usePortfolio } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime, shortDate } from '../lib/format'
import type { EquityPoint, Portfolio, PortfolioBotAudit, PortfolioPosition, PortfolioTransaction } from '../../shared/types'

const pnlText = (value: number) => `${value >= 0 ? '+' : ''}${money(value)}`
const mark = (value: number) => (value >= 0 ? 'text-success' : 'text-danger')
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

/** Money with cents for audit rows where small numbers matter. */
const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const exactMoney = (value: number) => exact.format(value)

const statusDot: Record<PortfolioBotAudit['status'], string> = {
  running: 'bg-success',
  paused: 'bg-warning',
  stopped: 'bg-line-strong',
}

export function Portfolio() {
  const { data, isLoading } = usePortfolio()
  const [selected, setSelected] = useState<string>('fleet')

  const isLive = (data?.summary.activeBots ?? 0) > 0
  const bots = data?.bots ?? []
  const selectedBot = bots.find((bot) => bot.id === selected) ?? null

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader title="Portfolio" subtitle="Financial audit of the fleet: every dollar in, every dollar out, per bot." />

      <div className="mt-6 flex flex-wrap items-center gap-1.5">
        <TabButton active={selected === 'fleet'} onMouseDown={() => setSelected('fleet')}>
          Fleet overview
          {isLive && <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-success" />}
        </TabButton>
        {bots.map((bot) => (
          <TabButton
            key={bot.id}
            active={selected === bot.id}
            onMouseDown={() => setSelected(bot.id)}
          >
            <span className={cx('mr-1 inline-block size-1.5 rounded-full', statusDot[bot.status])} />
            {bot.name}
          </TabButton>
        ))}
      </div>

      {isLoading && <Skeleton className="mt-3 h-8" />}

      {data && !selectedBot && <FleetAudit data={data} live={isLive} />}
      {data && selectedBot && (
        <BotPerformance
          audit={data.bots.find((bot) => bot.id === selectedBot.id)!}
          onBack={() => setSelected('fleet')}
        />
      )}
    </div>
  )
}

function TabButton({
  active,
  children,
  onMouseDown,
}: {
  active: boolean
  children: React.ReactNode
  onMouseDown: () => void
}) {
  return (
    <button
      type="button"
      onMouseDown={onMouseDown}
      className={cx(
        'flex h-8 items-center gap-1 rounded-[9px] px-3 text-[12.5px] font-medium transition-colors',
        active ? 'bg-fg text-white' : 'border border-line bg-surface text-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

/** Fleet-wide audit: KPI surge, equity curve, trade quality, per-bot table, positions, ledger. */
function FleetAudit({ data, live }: { data: Portfolio; live: boolean }) {
  const kpis = [
    { label: 'Starting capital', value: money(data.summary.startingCapital), hint: `${data.summary.bots} bots seeded` },
    { label: 'Current equity', value: money(data.summary.currentEquity), hint: 'cash + open marks' },
    {
      label: 'Net P&L',
      value: `${data.summary.netPnl >= 0 ? '+' : ''}${money(data.summary.netPnl)}`,
      hint: `${pct(data.summary.netPnlPct)} on capital, fees paid`,
      tone: mark(data.summary.netPnl),
    },
    { label: 'Realized P&L', value: pnlText(data.summary.realizedPnl), hint: `${data.summary.roundTrips} closed round trips`, tone: mark(data.summary.realizedPnl) },
    { label: 'Unrealized P&L', value: pnlText(data.summary.unrealizedPnl), hint: `${data.summary.openPositions} open positions`, tone: mark(data.summary.unrealizedPnl) },
    { label: 'Fees paid', value: exactMoney(data.summary.fees), hint: `${data.summary.fills} fills`, tone: 'text-muted' },
  ]

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-6">
        {kpis.map((kpi) => (
          <Card key={kpi.label} className="flex h-[104px] flex-col justify-between p-4">
            <p className="text-[13px] text-muted">{kpi.label}</p>
            <div>
              <p className={cx('text-[19px] font-semibold tracking-[-0.02em] tabular-nums', kpi.tone)}>{kpi.value}</p>
              <p className="mt-0.5 text-[12px] text-faint">{kpi.hint}</p>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Fleet equity</h2>
            {live ? <Live active label="live · 4s updates" /> : <span className="text-[12.5px] text-faint">Last 30 days</span>}
          </div>
          <div className="mt-4">
            {data.equity.length > 0 ? (
              <AreaChart data={data.equity} />
            ) : (
              <EmptyState icon={<Wallet />} title="No curve yet" description="Launch a bot to build the fleet curve." />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Trade quality</h2>
            {live && <Live active label="live" />}
          </div>
          <dl className="mt-4 divide-y divide-line">
            {[
              {
                label: 'Win rate',
                value: data.summary.expectedWinRate !== null ? `${data.summary.expectedWinRate.toFixed(0)}%` : '—',
                detail: `${data.summary.wins}/${data.summary.roundTrips} round trips`,
              },
              { label: 'Profit factor', value: data.summary.profitFactor !== null ? data.summary.profitFactor.toFixed(2) : '—', detail: 'gross profit ÷ gross loss' },
              { label: 'Gross profit', value: exactMoney(data.summary.grossProfit), detail: '', tone: 'text-success' },
              { label: 'Gross loss', value: exactMoney(data.summary.grossLoss), detail: '', tone: 'text-danger' },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-2.5">
                <dt>
                  <span className="block text-[13px] text-muted">{row.label}</span>
                  {row.detail && <span className="block text-[11.5px] text-faint">{row.detail}</span>}
                </dt>
                <dd className={cx('text-[14px] font-semibold tabular-nums', 'tone' in row ? row.tone : undefined)}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card className="mt-3 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-[14px] font-semibold">Per-bot audit</h2>
          {live ? <Live active label="live · 4s" /> : <span className="text-[12.5px] text-faint">{data.summary.bots} bots</span>}
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full table-fixed text-left text-[13.5px]">
            <thead>
              <tr className="h-10 border-y border-line bg-bg/60 text-[12.5px] text-muted">
                <th className="w-[17%] px-5 font-medium">Bot</th>
                <th className="w-[9%] px-2 text-right font-medium">Capital</th>
                <th className="w-[10%] px-2 text-right font-medium">Equity</th>
                <th className="w-[11%] px-2 text-right font-medium">Net P&L</th>
                <th className="w-[11%] px-2 text-right font-medium">Realized</th>
                <th className="w-[10%] px-2 text-right font-medium">Unrealized</th>
                <th className="w-[8%] px-2 text-right font-medium">Fees</th>
                <th className="w-[7%] px-2 text-right font-medium">Fills</th>
                <th className="w-[9%] px-2 text-right font-medium">Win rate</th>
                <th className="w-[10%] px-5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.bots.map((bot) => (
                <BotAuditRow key={bot.id} bot={bot} />
              ))}
            </tbody>
            <tfoot>
              <tr className="h-11 border-t border-line bg-bg/40 text-[13px] font-semibold">
                <td className="px-5">Total</td>
                <td className="px-2 text-right tabular-nums">{exactMoney(data.summary.startingCapital)}</td>
                <td className="px-2 text-right tabular-nums">{exactMoney(data.summary.currentEquity)}</td>
                <td className={cx('px-2 text-right tabular-nums', mark(data.summary.netPnl))}>{exactMoney(data.summary.netPnl).replace('$', '')}</td>
                <td className={cx('px-2 text-right tabular-nums', mark(data.summary.realizedPnl))}>{exactMoney(data.summary.realizedPnl).replace('$', '')}</td>
                <td className={cx('px-2 text-right tabular-nums', mark(data.summary.unrealizedPnl))}>{exactMoney(data.summary.unrealizedPnl).replace('$', '')}</td>
                <td className="px-2 text-right tabular-nums">{exactMoney(data.summary.fees).replace('$', '')}</td>
                <td className="px-2 text-right tabular-nums">{data.summary.fills}</td>
                <td className="px-2 text-right tabular-nums">{data.summary.expectedWinRate === null ? '—' : `${data.summary.expectedWinRate.toFixed(0)}%`}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {data.bots.length === 0 && (
            <EmptyState icon={<FileSearch />} title="Nothing to audit yet" description="Launch a bot and the ledger starts filling here." />
          )}
        </div>
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <PositionsCard positions={data.positions} title="Open positions" countLabel={data.positions.length} />
        <LedgerCard transactions={data.transactions} countLabel={`${data.transactions.length} most recent`} />
      </div>
    </>
  )
}

function BotAuditRow({ bot }: { bot: PortfolioBotAudit }) {
  const net = bot.equity - bot.capital
  return (
    <tr className="h-12 cursor-pointer transition-colors hover:bg-surface-2/50">
      <td className="px-5">
        <Link to={`/bots/${bot.id}`} className="flex items-center gap-1.5 font-medium transition-colors hover:text-accent">
          <span className={cx('inline-block size-1.5 shrink-0 rounded-full', statusDot[bot.status])} />
          {bot.name}
        </Link>
        <span className="block truncate text-[12px] text-faint">
          {bot.strategyName} · {bot.mode} · {relativeTime(bot.lastActivityAt)}
        </span>
      </td>
      <td className="px-2 text-right tabular-nums text-muted">{exactMoney(bot.capital)}</td>
      <td className="px-2 text-right tabular-nums">{exactMoney(bot.equity)}</td>
      <td className={cx('px-2 text-right tabular-nums font-medium', mark(net))}>
        {net >= 0 ? <ArrowUpRight className="mr-0.5 inline size-3.5" /> : <ArrowDownRight className="mr-0.5 inline size-3.5" />}
        {exactMoney(net).replace('$', '')}
      </td>
      <td className={cx('px-2 text-right tabular-nums text-muted', mark(bot.realizedPnl))}>{exactMoney(bot.realizedPnl).replace('$', '')}</td>
      <td className={cx('px-2 text-right tabular-nums text-muted', mark(bot.unrealizedPnl))}>{exactMoney(bot.unrealizedPnl).replace('$', '')}</td>
      <td className="px-2 text-right tabular-nums text-faint">{exactMoney(bot.fees).replace('$', '')}</td>
      <td className="px-2 text-right tabular-nums text-muted">{bot.fills}</td>
      <td className="px-2 text-right tabular-nums text-muted">{bot.winRate === null ? '—' : `${bot.winRate.toFixed(0)}%`}</td>
      <td className="px-5 text-right">
        <Badge tone={bot.status === 'running' ? 'success' : bot.status === 'paused' ? 'warning' : 'neutral'} dot>
          {bot.status}
        </Badge>
      </td>
    </tr>
  )
}

/** Per-bot performance: live curve, accounting KPIs, its positions and its fills. */
function BotPerformance({ audit, onBack }: { audit: PortfolioBotAudit; onBack: () => void }) {
  const { data, isLoading } = useBot(audit.id)
  const detail = data

  const curve = detail ? sample(detail.equity).map((point) => ({ label: curveLabel(point), value: point.value })) : []
  const positions: PortfolioPosition[] = (detail?.positions ?? []).map((position) => ({
    botId: audit.id,
    botName: audit.name,
    symbol: position.symbol,
    qty: position.qty,
    avgPrice: position.avgPrice,
    markPrice: position.markPrice,
    costBasis: position.qty * position.avgPrice,
    unrealizedPnl: position.unrealizedPnl,
  }))
  const transactions = (detail?.trades ?? []).map((trade) => ({ ...trade, botName: audit.name }))
  const net = audit.equity - audit.capital

  const kpis = [
    { label: 'Capital', value: exactMoney(audit.capital), hint: `deployed on ${audit.timeframe} bars` },
    { label: 'Current equity', value: exactMoney(audit.equity), hint: `${audit.roundTrips} round trips`, tone: undefined },
    { label: 'Net P&L', value: exactMoney(net).replace('$', ''), hint: pct(net / (audit.capital || 1) * 100), tone: mark(net) },
    { label: 'Realized', value: exactMoney(audit.realizedPnl).replace('$', ''), hint: `${audit.wins} wins`, tone: mark(audit.realizedPnl) },
    { label: 'Unrealized', value: exactMoney(audit.unrealizedPnl).replace('$', ''), hint: `${positions.length} open`, tone: mark(audit.unrealizedPnl) },
    { label: 'Fees / Fills', value: exactMoney(audit.fees).replace('$', ''), hint: `${audit.fills} fills at the venue`, tone: 'text-muted' },
  ]

  return (
    <div className="mt-3">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex h-7 items-center gap-1 rounded-[8px] border border-line px-2 text-[12.5px] text-muted transition-colors hover:text-fg"
            aria-label="Back to fleet overview"
          >
            <X className="size-3.5" />
            Close tab
          </button>
          <h2 className="text-[16px] font-semibold">{audit.name}</h2>
          <Badge tone={audit.status === 'running' ? 'success' : audit.status === 'paused' ? 'warning' : 'neutral'} dot>
            {audit.status}
          </Badge>
          <Badge tone="accent">{audit.strategyName}</Badge>
          <Badge tone={audit.mode === 'live' ? 'success' : 'info'}>{audit.mode}</Badge>
          {audit.status === 'running' && <Live active label="live · 2s" />}
          <Link to={`/bots/${audit.id}`} className="ml-auto text-[12.5px] text-muted transition-colors hover:text-fg">
            Open run monitor
          </Link>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="rounded-card border border-line p-3">
              <p className="text-[12px] text-muted">{kpi.label}</p>
              <p className={cx('mt-0.5 text-[17px] font-semibold tabular-nums', kpi.tone)}>{kpi.value}</p>
              <p className="mt-0.5 truncate text-[11.5px] text-faint">{kpi.hint}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-semibold">Equity curve</h3>
            {audit.status === 'running' ? <Live active label="2s updates" /> : <span className="text-[12.5px] text-faint">{detail?.equity.length ?? 0} points</span>}
          </div>
          <div className="mt-4">
            {isLoading && <Skeleton className="h-[180px]" />}
            {!isLoading && curve.length > 1 ? (
              <AreaChart data={curve} />
            ) : (
              !isLoading && <EmptyState icon={<ArrowUpRight />} title="Nothing yet" description="Equity is recorded as closed bars come in." />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-semibold">Trade quality</h3>
            {audit.status === 'running' && <Live active label="live" />}
          </div>
          <dl className="mt-4 divide-y divide-line">
            {[
              { label: 'Win rate', value: audit.winRate !== null ? `${audit.winRate.toFixed(0)}%` : '—', detail: `${audit.wins}/${audit.roundTrips} round trips` as string | null },
              { label: 'Last activity', value: relativeTime(audit.lastActivityAt), detail: null },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-2.5">
                <dt className="text-[13px] text-muted">{row.label}</dt>
                <div className="text-right">
                  <dd className="text-[14px] font-semibold tabular-nums">{row.value}</dd>
                  {row.detail && <p className="text-[11.5px] text-faint">{row.detail}</p>}
                </div>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <PositionsCard positions={positions} title="Open positions" countLabel={positions.length} />
        <LedgerCard transactions={transactions} countLabel={`${transactions.length} fills`} />
      </div>
    </div>
  )
}

/** Shared: live positions table for the fleet tab or one bot's tab. */
function PositionsCard({ positions, title, countLabel }: { positions: PortfolioPosition[]; title: string; countLabel: number }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <span className="text-[12.5px] text-faint">{countLabel}</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full table-fixed text-left text-[13px]">
          <thead>
            <tr className="h-9 border-y border-line bg-bg/60 text-[12px] text-muted">
              <th className="w-[24%] px-5 font-medium">Symbol</th>
              <th className="w-[18%] px-2 font-medium">Bot</th>
              <th className="w-[13%] px-2 text-right font-medium">Qty</th>
              <th className="w-[15%] px-2 text-right font-medium">Avg</th>
              <th className="w-[14%] px-2 text-right font-medium">Mark</th>
              <th className="w-[16%] px-5 text-right font-medium">Unrealised</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {positions.map((position, i) => (
              <tr key={`${position.botId}-${position.symbol}-${i}`} className="h-10">
                <td className="truncate px-5 font-medium">{position.symbol}</td>
                <td className="truncate px-2 text-muted">{position.botName}</td>
                <td className="px-2 text-right tabular-nums text-muted">{position.qty.toFixed(4)}</td>
                <td className="px-2 text-right tabular-nums text-muted">{position.avgPrice.toFixed(2)}</td>
                <td className="px-2 text-right tabular-nums text-muted">{position.markPrice.toFixed(2)}</td>
                <td className={cx('px-5 text-right tabular-nums', mark(position.unrealizedPnl))}>{exactMoney(position.unrealizedPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {positions.length === 0 && <EmptyState title="Flat" description="No held positions here right now." />}
      </div>
    </Card>
  )
}

/** Shared: transaction ledger for the fleet tab or one bot's tab. */
function LedgerCard({ transactions, countLabel }: { transactions: PortfolioTransaction[]; countLabel: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 className="text-[14px] font-semibold">Transaction ledger</h2>
        <span className="text-[12.5px] text-faint">{countLabel}</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full table-fixed text-left text-[13px]">
          <thead>
            <tr className="h-9 border-y border-line bg-bg/60 text-[12px] text-muted">
              <th className="w-[17%] px-5 font-medium">Time</th>
              <th className="w-[18%] px-2 font-medium">Bot</th>
              <th className="w-[14%] px-2 font-medium">Symbol</th>
              <th className="w-[9%] px-2 text-right font-medium">Side</th>
              <th className="w-[12%] px-2 text-right font-medium">Price</th>
              <th className="w-[10%] px-2 text-right font-medium">Fee</th>
              <th className="w-[14%] px-5 text-right font-medium">P&L</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {transactions.map((tx) => (
              <tr key={tx.id} className="h-10">
                <td className="truncate px-5 text-muted">{relativeTime(tx.at)}</td>
                <td className="truncate px-2 text-muted">{tx.botName ?? '—'}</td>
                <td className="truncate px-2 font-medium">{tx.symbol}</td>
                <td className="px-2 text-right">
                  <Badge tone={tx.side === 'buy' ? 'info' : 'warning'}>{tx.side}</Badge>
                </td>
                <td className="px-2 text-right tabular-nums text-muted">{tx.price.toFixed(2)}</td>
                <td className="px-2 text-right tabular-nums text-faint">{tx.fee.toFixed(2)}</td>
                <td className={cx('px-5 text-right tabular-nums', tx.pnl === null ? 'text-faint' : mark(tx.pnl))}>
                  {tx.pnl === null ? 'opens position' : `${tx.pnl >= 0 ? '+' : ''}${tx.pnl.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {transactions.length === 0 && <EmptyState title="Ledger empty" description="Fills land here the moment a bot trades." />}
      </div>
    </Card>
  )
}

/** Same 90-point cap the run monitor uses so chart labels stay readable. */
function sample(points: EquityPoint[]): EquityPoint[] {
  if (points.length <= 90) return points
  const step = Math.ceil(points.length / 90)
  return points.filter((_, i) => i % step === 0 || i === points.length - 1)
}

function curveLabel(point: EquityPoint): string {
  const date = new Date(point.t)
  return `${shortDate(point.t)}, ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
}
