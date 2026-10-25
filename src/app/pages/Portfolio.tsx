import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight, FileSearch, Plus, Minus, Wallet, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { AreaChart, BarChart, CompareBars, DrawdownChart } from '../components/charts'
import { Badge, Button, Card, EmptyState, Input, Live, PageHeader, Skeleton, useToast } from '../components/ui'
import { adjustFunding, ApiError, useBot, usePortfolio } from '../lib/api'
import { cx } from '../lib/cx'
import { money, moneyExact, moneyExactPlain, relativeTime, shortDate } from '../lib/format'
import type { CashFlow, EquityPoint, Portfolio, PortfolioBotAudit, PortfolioPosition, PortfolioTransaction } from '../../shared/types'

const pnlText = (value: number) => `${value >= 0 ? '+' : ''}${money(value)}`
const mark = (value: number) => (value >= 0 ? 'text-success' : 'text-danger')
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
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
          flows={data.funding.filter((flow) => flow.botId === selectedBot.id)}
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
        active ? 'bg-fg text-bg' : 'border border-line bg-surface text-muted hover:text-fg',
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
    { label: 'Fees paid', value: moneyExact(data.summary.fees), hint: `${data.summary.fills} fills`, tone: 'text-muted' },
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
        <div className="grid gap-3 lg:col-span-2">
          <Card className="p-5">
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
              <h2 className="text-[14px] font-semibold">Net P&amp;L by bot</h2>
              <span className="text-[12.5px] text-faint">% of that bot's capital · green wins, red loses</span>
            </div>
            <div className="mt-4">
              <CompareBars
                signed
                format={(v) => `${v.toFixed(1)}%`}
                items={data.bots.map((bot) => ({
                  label: bot.name,
                  caption: `${bot.strategyName} · ${bot.status}`,
                  value: bot.capital > 0 ? ((bot.equity - bot.capital) / bot.capital) * 100 : 0,
                }))}
              />
            </div>
          </Card>
        </div>

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
              { label: 'Gross profit', value: moneyExact(data.summary.grossProfit), detail: '', tone: 'text-success' },
              { label: 'Gross loss', value: moneyExact(data.summary.grossLoss), detail: '', tone: 'text-danger' },
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
                <td className="px-2 text-right tabular-nums">{moneyExactPlain(data.summary.startingCapital)}</td>
                <td className="px-2 text-right tabular-nums">{moneyExactPlain(data.summary.currentEquity)}</td>
                <td className={cx('px-2 text-right tabular-nums', mark(data.summary.netPnl))}>{moneyExactPlain(data.summary.netPnl)}</td>
                <td className={cx('px-2 text-right tabular-nums', mark(data.summary.realizedPnl))}>{moneyExactPlain(data.summary.realizedPnl)}</td>
                <td className={cx('px-2 text-right tabular-nums', mark(data.summary.unrealizedPnl))}>{moneyExactPlain(data.summary.unrealizedPnl)}</td>
                <td className="px-2 text-right tabular-nums">{moneyExactPlain(data.summary.fees)}</td>
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

      <AllocationCard data={data} />

      <FundingCard data={data} flows={data.funding} />

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <PositionsCard positions={data.positions} title="Open positions" countLabel={data.positions.length} />
        <LedgerCard transactions={data.transactions} countLabel={`${data.transactions.length} most recent`} />
      </div>
    </>
  )
}

/** Cash-flow reconciliation: funding is capital movement, never P&L, so
 * launch funding + net funding + trading P&L must equal current equity. */
export function FundingCard({ data, flows, title = 'Funding & reconciliation' }: { data: Portfolio; flows: CashFlow[]; title?: string }) {
  const funding = [
    { label: 'Launch funding', value: moneyExact(data.summary.launchCapital), detail: 'capital the bots started with' },
    { label: 'Deposits in', value: moneyExact(data.summary.deposits), detail: '', tone: 'text-success' },
    { label: 'Withdrawals out', value: moneyExact(data.summary.withdrawals), detail: '', tone: 'text-danger' },
    { label: 'Net funding', value: moneyExact(data.summary.netFunding), detail: 'deposits − withdrawals', tone: undefined },
  ]
  const tradingPnl = data.summary.netPnl
  const expect = data.summary.launchCapital + data.summary.netFunding + tradingPnl
  const balanced = Math.abs(expect - data.summary.currentEquity) < 0.05

  // Net funding per calendar day, oldest → newest, signed: deposits minus
  // withdrawals. One bar per day the fleet moved money.
  const dailySeries = (() => {
    const byDay = new Map<string, number>()
    for (const flow of [...flows].sort((a, b) => a.at - b.at)) {
      const key = shortDate(flow.at)
      byDay.set(key, (byDay.get(key) ?? 0) + flow.amount)
    }
    return [...byDay.entries()].map(([label, value]) => ({ label, value }))
  })()

  return (
    <Card className="mt-3 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
        <div>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <p className="mt-0.5 text-[12px] text-faint">Deposits and withdrawals move capital, never P&L — equity reconciles against real cash flows.</p>
        </div>
        <span className={cx('text-[12.5px] font-medium', balanced ? 'text-success' : 'text-warning')}>
          {balanced ? 'Reconciled ✓' : 'Desynced — engine rebalances on next bar'}
        </span>
      </div>

      <div className="mt-4 grid gap-3 px-5 sm:grid-cols-2">
        <dl className="divide-y divide-line">
          {funding.map((row) => (
            <div key={row.label} className="flex items-center justify-between py-2">
              <dt>
                <span className="block text-[13px] text-muted">{row.label}</span>
                {row.detail && <span className="block text-[11.5px] text-faint">{row.detail}</span>}
              </dt>
              <dd className={cx('text-[14px] font-semibold tabular-nums', row.tone)}>{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="rounded-card border border-line p-4">
          <p className="text-[12.5px] font-medium text-muted">Reconciliation identity</p>
          <div className="mt-3 flex flex-col gap-1.5 text-[13px] tabular-nums">
            <Row left="Launch funding" right={moneyExactPlain(data.summary.launchCapital)} />
            <Row left="+ Net funding (deposits − withdrawals)" right={moneyExactPlain(data.summary.netFunding)} signed />
            <Row left="+ Trading P&amp;L (realized + unrealized)" right={moneyExactPlain(tradingPnl)} signed />
            <div className="mt-1 flex items-center justify-between border-t border-line pt-2 text-[13.5px] font-semibold">
              <span>= Current equity</span>
              <span>{moneyExactPlain(data.summary.currentEquity)}</span>
            </div>
          </div>
        </div>
      </div>

      {dailySeries.length > 0 && (
        <div className="mt-4 px-5">
          <div className="flex items-center justify-between">
            <p className="text-[12.5px] font-medium text-muted">Net funding per day</p>
            <span className="text-[11.5px] text-faint">
              deposits − withdrawals · {dailySeries.length} {dailySeries.length === 1 ? 'day' : 'days'} active · most recent 50 flows
            </span>
          </div>
          <div className="mt-3">
            <BarChart data={dailySeries} height={140} format={(v) => moneyExact(v)} />
          </div>
        </div>
      )}

      <div className="mt-4 px-5 pb-5">
        <p className="text-[12.5px] font-medium text-muted">Daily funding log</p>
        {flows.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-muted">No deposits or withdrawals yet — adjust funding on a bot's performance tab.</p>
        ) : (
          <ul className="scrollbar-thin mt-2 max-h-[220px] divide-y divide-line overflow-y-auto">
            {flows.map((flow) => (
              <li key={flow.id} className="flex items-center gap-3 py-2">
                <span className={cx('inline-block size-1.5 shrink-0 rounded-full', flow.amount > 0 ? 'bg-success' : 'bg-danger')} />
                <span className="w-[86px] shrink-0 text-[12.5px] text-faint">{shortDate(flow.at)}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {flow.botName ?? 'Removed bot'}
                  {flow.note && <span className="text-faint"> · {flow.note}</span>}
                </span>
                <span className={cx('text-[13px] font-medium tabular-nums', flow.amount > 0 ? 'text-success' : 'text-danger')}>
                  {flow.amount > 0 ? '+' : '−'}{moneyExactPlain(Math.abs(flow.amount))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function Row({ left, right, signed }: { left: string; right: string; signed?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{left}</span>
      <span className={signed ? (right.startsWith('-') || right.startsWith('−') ? 'text-danger' : 'text-success') : undefined}>{signed && !right.startsWith('-') && !right.startsWith('−') ? `+${right}` : right}</span>
    </div>
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
      <td className="px-2 text-right tabular-nums text-muted">{moneyExactPlain(bot.capital)}</td>
      <td className="px-2 text-right tabular-nums">{moneyExactPlain(bot.equity)}</td>
      <td className={cx('px-2 text-right tabular-nums font-medium', mark(net))}>
        {net >= 0 ? <ArrowUpRight className="mr-0.5 inline size-3.5" /> : <ArrowDownRight className="mr-0.5 inline size-3.5" />}
        {moneyExactPlain(net)}
      </td>
      <td className={cx('px-2 text-right tabular-nums text-muted', mark(bot.realizedPnl))}>{moneyExactPlain(bot.realizedPnl)}</td>
      <td className={cx('px-2 text-right tabular-nums text-muted', mark(bot.unrealizedPnl))}>{moneyExactPlain(bot.unrealizedPnl)}</td>
      <td className="px-2 text-right tabular-nums text-faint">{moneyExactPlain(bot.fees)}</td>
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
function BotPerformance({ audit, flows, onBack }: { audit: PortfolioBotAudit; flows: CashFlow[]; onBack: () => void }) {
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

  // Cumulative funding on the same timeline as the equity curve: 0 before the
  // first flow, one visible step per deposit/withdrawal, carried forward to
  // now so the current funding level reads off the chart directly.
  const fundingSeries = (() => {
    if (flows.length === 0) return []
    const sorted = [...flows].sort((a, b) => a.at - b.at)
    const start = Math.min(detail?.equity[0]?.t ?? sorted[0].at, sorted[0].at)
    let cum = 0
    const points: { label: string; value: number }[] = [{ label: shortDate(start), value: 0 }]
    for (const flow of sorted) {
      cum += flow.amount
      points.push({ label: shortDate(Math.max(flow.at, start)), value: cum })
    }
    points.push({ label: shortDate(Date.now()), value: cum })
    return points
  })()

  const kpis = [
    { label: 'Capital', value: moneyExact(audit.capital), hint: `deployed on ${audit.timeframe} bars` },
    { label: 'Current equity', value: moneyExact(audit.equity), hint: `${audit.roundTrips} round trips`, tone: undefined },
    { label: 'Net P&L', value: moneyExactPlain(net), hint: pct(net / (audit.capital || 1) * 100), tone: mark(net) },
    { label: 'Realized', value: moneyExactPlain(audit.realizedPnl), hint: `${audit.wins} wins`, tone: mark(audit.realizedPnl) },
    { label: 'Unrealized', value: moneyExactPlain(audit.unrealizedPnl), hint: `${positions.length} open`, tone: mark(audit.unrealizedPnl) },
    { label: 'Fees / Fills', value: moneyExact(audit.fees), hint: `${audit.fills} fills at the venue`, tone: 'text-muted' },
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
          {!isLoading && curve.length > 1 && (
            <>
              <p className="mt-5 text-[12.5px] font-medium text-muted">Same run, percent below the running peak</p>
              <div className="mt-3">
                <DrawdownChart data={curve} height={120} />
              </div>
            </>
          )}
        </Card>

        {fundingSeries.length > 1 && (
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold">Cumulative funding</h3>
              <span className="text-[12.5px] text-faint">
                same timeline as the curve above · net {moneyExact(audit.netDeposits)}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-faint">Steps are the bot's own deposits and withdrawals — read together with the equity line to separate cash movement from P&L.</p>
            <div className="mt-3">
              <AreaChart data={fundingSeries} height={140} stroke="var(--color-info)" />
            </div>
          </Card>
        )}

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

      <FundingPanel audit={audit} flows={flows} />

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <PositionsCard positions={positions} title="Open positions" countLabel={positions.length} />
        <LedgerCard transactions={transactions} countLabel={`${transactions.length} fills`} />
      </div>
    </div>
  )
}

/** Deposit/withdraw funding for one bot. Moves capital; never the P&L. */
function FundingPanel({ audit, flows }: { audit: PortfolioBotAudit; flows: CashFlow[] }) {
  const toast = useToast()
  const client = useQueryClient()
  const [amount, setAmount] = useState('')

  const transfer = useMutation({
    mutationFn: (delta: number) => adjustFunding(audit.id, { amount: delta }),
    onSuccess: (_result, delta) => {
      toast(`${delta > 0 ? 'Deposited' : 'Withdrew'} ${moneyExact(Math.abs(delta))} · ${audit.name}`)
      setAmount('')
      void Promise.all([
        client.invalidateQueries({ queryKey: ['portfolio'] }),
        client.invalidateQueries({ queryKey: ['bots'] }),
        client.invalidateQueries({ queryKey: ['bot'] }),
      ])
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Funding adjustment failed', 'danger'),
  })

  const value = Number(amount)
  const valid = Number.isFinite(value) && value > 0 && value <= 10_000_000
  const tooMuchOut = value > audit.cash + 1e-6

  return (
    <Card className="mt-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold">Funding adjustments</h3>
          <p className="mt-0.5 text-[12px] text-faint">Move money in or out of this bot — capital shifts, P&amp;L stays put.</p>
        </div>
        <div className="text-right text-[12.5px]">
          <span className="text-faint">Net funding </span>
          <span className={cx('font-medium tabular-nums', audit.netDeposits >= 0 ? 'text-success' : 'text-danger')}>
            {audit.netDeposits >= 0 ? '+' : '−'}{moneyExactPlain(Math.abs(audit.netDeposits))}
          </span>
          <span className="text-faint"> · idle cash {moneyExactPlain(audit.cash)}</span>
        </div>
      </div>

      <div className="mt-4 flex max-w-md flex-wrap items-center gap-2">
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-32"
          aria-label="Funding amount"
        />
        <Button
          variant="primary"
          disabled={!valid || transfer.isPending}
          loading={transfer.isPending}
          onClick={() => valid && transfer.mutate(value)}
        >
          <Plus />
          Deposit
        </Button>
        <Button
          disabled={!valid || tooMuchOut || transfer.isPending}
          onClick={() => valid && !tooMuchOut && transfer.mutate(-value)}
          title={tooMuchOut ? 'Withdrawal exceeds idle cash — close positions first.' : undefined}
        >
          <Minus />
          Withdraw
        </Button>
        {valid && tooMuchOut && <span className="text-[12px] text-warning">Only {moneyExactPlain(audit.cash)} is idle cash right now.</span>}
      </div>

      {flows.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {flows.slice(0, 6).map((flow) => (
            <li key={flow.id} className="flex items-center gap-3 py-2">
              <span className={cx('inline-block size-1.5 shrink-0 rounded-full', flow.amount > 0 ? 'bg-success' : 'bg-danger')} />
              <span className="w-[86px] shrink-0 text-[12.5px] text-faint">{shortDate(flow.at)}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{flow.note ?? (flow.amount > 0 ? 'Deposit' : 'Withdrawal')}</span>
              <span className={cx('text-[13px] font-medium tabular-nums', flow.amount > 0 ? 'text-success' : 'text-danger')}>
                {flow.amount > 0 ? '+' : '−'}{moneyExactPlain(Math.abs(flow.amount))}
              </span>
            </li>
          ))
          }
        </ul>
      )}
    </Card>
  )
}

/** Capital structure: how much equity sits in open stock and crypto
 * positions and how much is idle liquidity, with a stacked bar, a per-symbol
 * invested chart and the reconciliation style rows. */
function AllocationCard({ data }: { data: Portfolio }) {
  const bySymbol = new Map<string, { invested: number; positions: number }>()
  for (const position of data.positions) {
    const entry = bySymbol.get(position.symbol) ?? { invested: 0, positions: 0 }
    entry.invested += position.costBasis
    entry.positions += 1
    bySymbol.set(position.symbol, entry)
  }
  const symbols = [...bySymbol.entries()].sort((a, b) => b[1].invested - a[1].invested)

  // Stock symbols on the venue carry no USD suffix; BTC/ETH/SOL are quoted as
  // `X-USD`, so that suffix splits the venue into asset classes.
  const isCrypto = (symbol: string) => symbol.endsWith('-USD')
  const stocksInvested = symbols.filter(([symbol]) => !isCrypto(symbol)).reduce((sum, [, e]) => sum + e.invested, 0)
  const cryptoInvested = symbols.filter(([symbol]) => isCrypto(symbol)).reduce((sum, [, e]) => sum + e.invested, 0)
  const invested = stocksInvested + cryptoInvested
  const cash = data.bots.reduce((sum, bot) => sum + bot.cash, 0)
  const deployed = invested + cash
  const share = (value: number) => (deployed > 0 ? `${((value / deployed) * 100).toFixed(1)}%` : '—')

  const segments = [
    { key: 'stocks', label: 'Stocks', value: stocksInvested, color: 'var(--color-accent)' },
    { key: 'crypto', label: 'Crypto', value: cryptoInvested, color: 'var(--color-info)' },
    { key: 'cash', label: 'Cash reserve', value: cash, color: 'var(--color-line-strong)' },
  ].filter((seg) => seg.value > 0.01)

  return (
    <Card className="mt-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">Allocation &amp; liquidity</h2>
        <span className="text-[12.5px] text-faint">
          cost basis of open positions · {data.positions.length} position{data.positions.length === 1 ? '' : 's'} · {money(cash)} idle
        </span>
      </div>

      {deployed > 0.01 ? (
        <>
          {/* Stacked invested-vs-cash bar, labelled segments. */}
          <div className="mt-4 flex h-3.5 overflow-hidden rounded-card" role="img" aria-label="Allocation bar: invested vs cash">
            {segments.map((segment, i) => (
              <div
                key={segment.key}
                className="h-full transition-all"
                style={{ width: `${(segment.value / deployed) * 100}%`, background: segment.color, borderRight: i < segments.length - 1 ? '2px solid var(--color-surface)' : undefined }}
                title={`${segment.label}: ${moneyExact(segment.value)} (${share(segment.value)})`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            {segments.map((segment) => (
              <span key={segment.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-[3px]" style={{ background: segment.color }} />
                <span className="text-muted">{segment.label}</span>
                <span className="font-medium tabular-nums">{moneyExact(segment.value)}</span>
                <span className="text-faint">{share(segment.value)}</span>
              </span>
            ))}
          </div>

          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <dl className="divide-y divide-line">
              {[
                { label: 'Invested — stocks', value: moneyExact(stocksInvested), detail: 'open stock positions at cost', tone: 'text-fg' },
                { label: 'Invested — crypto', value: moneyExact(cryptoInvested), detail: 'open crypto positions at cost', tone: 'text-fg' },
                { label: 'Total invested', value: moneyExact(invested), detail: `of ${moneyExact(data.summary.currentEquity)} fleet equity`, tone: 'text-fg' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between py-2">
                  <dt>
                    <span className="block text-[13px] text-muted">{row.label}</span>
                    {row.detail && <span className="block text-[11.5px] text-faint">{row.detail}</span>}
                  </dt>
                  <dd className={cx('text-[14px] font-semibold tabular-nums', row.tone)}>{row.value}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between py-2">
                <dt>
                  <span className="block text-[13px] text-muted">Liquidity (idle cash)</span>
                  <span className="block text-[11.5px] text-faint">not yet committed to positions</span>
                </dt>
                <dd className="text-[14px] font-semibold tabular-nums">{moneyExact(cash)}</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt>
                  <span className="block text-[13px] text-muted">Deployed</span>
                  <span className="block text-[11.5px] text-faint">invested share of cost basis + idle cash</span>
                </dt>
                <dd className="text-[14px] font-semibold tabular-nums">{invested > 0 ? `${((invested / deployed) * 100).toFixed(1)}%` : '—'}</dd>
              </div>
            </dl>

            <div>
              <p className="text-[12.5px] font-medium text-muted">Invested by symbol</p>
              <div className="mt-3">
                <p className="mb-3 text-[12px] text-faint">Amount committed per symbol at cost basis · share of {moneyExact(invested)} invested</p>
                <CompareBars
                  format={(v) => moneyExact(v)}
                  items={symbols.map(([symbol, entry]) => ({
                    label: symbol,
                    caption: `${entry.positions} position${entry.positions === 1 ? '' : 's'} · ${invested > 0 ? pct((entry.invested / invested) * 100) : '—'} of invested`,
                    value: entry.invested,
                  }))}
                />
              </div>
            </div>
          </div>
        </>
      ) : (
        <EmptyState icon={<Wallet />} title="No allocation yet" description="Open a position and it appears here with its cost basis; idle cash shows as liquidity." />
      )}
    </Card>
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
                <td className={cx('px-5 text-right tabular-nums', mark(position.unrealizedPnl))}>{moneyExactPlain(position.unrealizedPnl)}</td>
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
