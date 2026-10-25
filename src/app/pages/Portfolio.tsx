import { ArrowDownRight, ArrowUpRight, FileSearch, Wallet } from 'lucide-react'
import { Link } from 'react-router'

import { AreaChart } from '../components/charts'
import { Badge, Card, EmptyState, Live, PageHeader, Skeleton } from '../components/ui'
import { usePortfolio } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime } from '../lib/format'

const pnl = (value: number) => `${value >= 0 ? '+' : ''}${money(value)}`
const mark = (value: number) => (value >= 0 ? 'text-success' : 'text-danger')
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

/** Money with cents for audit rows where small numbers matter. */
const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const exactMoney = (value: number) => exact.format(value)

export function Portfolio() {
  const { data, isLoading } = usePortfolio()

  const isLive = (data?.summary.activeBots ?? 0) > 0

  const kpis = data
    ? [
        { label: 'Starting capital', value: money(data.summary.startingCapital), hint: `${data.summary.bots} bots seeded`, tone: undefined },
        { label: 'Current equity', value: money(data.summary.currentEquity), hint: 'cash + open marks', tone: undefined },
        {
          label: 'Net P&L',
          value: `${data.summary.netPnl >= 0 ? '+' : ''}${money(data.summary.netPnl)}`,
          hint: `${pct(data.summary.netPnlPct)} on capital, fees paid`,
          tone: ['text-success', 'text-danger'],
          which: data.summary.netPnl >= 0 ? 'up' : 'down',
        },
        { label: 'Realized P&L', value: pnl(data.summary.realizedPnl), hint: `${data.summary.roundTrips} closed round trips`, tone: [] },
        { label: 'Unrealized P&L', value: pnl(data.summary.unrealizedPnl), hint: `${data.summary.openPositions} open positions`, tone: [] },
        { label: 'Fees paid', value: `${data.summary.fees >= 0 ? '' : '-'}${exactMoney(data.summary.fees).slice(1)} fees`, hint: `${data.summary.fills} fills filled`, tone: [] },
      ]
    : []

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Portfolio"
        subtitle="Financial audit of the fleet: every dollar in, every dollar out, per bot."
      />

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-6">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-card" />)
          : kpis.map((kpi) => (
              <Card key={kpi.label} className="flex h-[104px] flex-col justify-between p-4">
                <p className="text-[13px] text-muted">{kpi.label}</p>
                <div>
                  <p className="text-[19px] font-semibold tracking-[-0.02em] tabular-nums">{kpi.value}</p>
                  <p className="mt-0.5 text-[12px] text-faint">{kpi.hint}</p>
                </div>
              </Card>
            ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Fleet equity</h2>
            {isLive ? <Live active label="live · 4s updates" /> : <span className="text-[12.5px] text-faint">Last 30 days</span>}
          </div>
          <div className="mt-4">
            {data ? (
              data.equity.length > 0 ? (
                <AreaChart data={data.equity} />
              ) : (
                <EmptyState icon={<Wallet />} title="No curve yet" description="Launch a bot to build the fleet curve." />
              )
            ) : (
              <Skeleton className="h-[200px]" />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Trade quality</h2>
            {isLive && <Live active label="live" />}
          </div>
          <dl className="mt-4 divide-y divide-line">
            {            [
              {
                label: 'Win rate',
                value: data && data.summary.expectedWinRate !== null ? `${data.summary.expectedWinRate.toFixed(0)}%` : '—',
                detail: data ? `${data.summary.wins}/${data.summary.roundTrips} round trips` : '',
              },
              { label: 'Profit factor', value: data && data.summary.profitFactor !== null ? data.summary.profitFactor.toFixed(2) : '—', detail: 'gross profit ÷ gross loss' },
              { label: 'Gross profit', value: data ? exactMoney(data.summary.grossProfit) : '', detail: '', tone: 'text-success' },
              { label: 'Gross loss', value: data ? exactMoney(data.summary.grossLoss) : '', detail: '', tone: 'text-danger' },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-2.5">
                <dt>
                  <span className="block text-[13px] text-muted">{row.label}</span>
                  {row.detail && <span className="block text-[11.5px] text-faint">{row.detail}</span>}
                </dt>
                <dd className={cx('text-[14px] font-semibold tabular-nums', 'tone' in row ? row.tone : undefined)}>{row.value || '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card className="mt-3 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-[14px] font-semibold">Per-bot audit</h2>
          {isLive ? <Live active label="live · 4s" /> : <span className="text-[12.5px] text-faint">{data?.summary.bots ?? 0} bots</span>}
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
              {(data?.bots ?? []).map((bot) => {
                const net = bot.equity - bot.capital
                const winRate = bot.winRate === null ? '—' : `${bot.winRate.toFixed(0)}%`
                return (
                  <tr key={bot.id} className="h-12 transition-colors hover:bg-surface-2/50">
                    <td className="px-5">
                      <Link to={`/bots/${bot.id}`} className="block truncate font-medium transition-colors hover:text-accent">
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
                    <td className="px-2 text-right tabular-nums text-muted">{winRate}</td>
                    <td className="px-5 text-right">
                      <Badge tone={bot.status === 'running' ? 'success' : bot.status === 'paused' ? 'warning' : 'neutral'} dot>
                        {bot.status}
                      </Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {data && data.bots.length > 0 && (
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
            )}
          </table>
          {(data?.bots.length ?? 0) === 0 && !isLoading && (
            <EmptyState icon={<FileSearch />} title="Nothing to audit yet" description="Launch a bot and the ledger starts filling here." />
          )}
        </div>
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-5">
            <h2 className="text-[14px] font-semibold">Open positions</h2>
            <span className="text-[12.5px] text-faint">{data?.summary.openPositions ?? 0} held</span>
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
                {(data?.positions ?? []).map((position, i) => (
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
            {data && data.positions.length === 0 && (
              <EmptyState title="Flat" description="No bot currently holds any position." />
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-5">
            <h2 className="text-[14px] font-semibold">Transaction ledger</h2>
            <span className="text-[12.5px] text-faint">{data?.transactions.length ?? 0} most recent</span>
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
                {(data?.transactions ?? []).map((tx) => (
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
            {data && data.transactions.length === 0 && (
              <EmptyState title="Ledger empty" description="Fills land here the moment a bot trades." />
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
