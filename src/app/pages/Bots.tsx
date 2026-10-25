import { Bot as BotIcon, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { Badge, Button, EmptyState, PageHeader, Skeleton } from '../components/ui'
import { useBots } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime } from '../lib/format'
import { BOT_STAGES, type BotStatus } from '../../shared/types'

const statusTone: Record<BotStatus, 'success' | 'warning' | 'neutral'> = { running: 'success', paused: 'warning', stopped: 'neutral' }
const FILTERS: { key: BotStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'paused', label: 'Paused' },
  { key: 'stopped', label: 'Stopped' },
]

export function Bots() {
  const { data, isLoading } = useBots()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<BotStatus | 'all'>('all')

  const bots = useMemo(() => (data?.items ?? []).filter((bot) => filter === 'all' || bot.status === filter), [data, filter])
  const running = (data?.items ?? []).filter((bot) => bot.status === 'running').length

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Bots"
        subtitle={data ? `${data.items.length} launched · ${running} running — each read fast-forwards the fleet` : undefined}
        actions={
          <Button variant="primary" onClick={() => navigate('/strategies')}>
            <Plus />
            New bot
          </Button>
        }
      />

      <div className="mt-5 flex items-center gap-1 rounded-control bg-bg p-1">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={filter === option.key}
            onClick={() => setFilter(option.key)}
            className={cx(
              'h-8 rounded-[9px] px-3 text-[12.5px] font-medium transition-colors',
              filter === option.key ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-4 overflow-hidden rounded-card border border-line">
        <table className="w-full table-fixed text-left text-[13.5px]">
          <thead>
            <tr className="h-10 border-b border-line bg-bg/60 text-[12.5px] text-muted">
              <th className="w-[28%] px-4 font-medium">Bot</th>
              <th className="hidden w-[14%] px-4 font-medium md:table-cell">Symbols</th>
              <th className="hidden w-[12%] px-4 font-medium sm:table-cell">Stage</th>
              <th className="w-[14%] px-4 font-medium">Status</th>
              <th className="w-[14%] px-4 text-right font-medium">Equity</th>
              <th className="hidden w-[12%] px-4 text-right font-medium md:table-cell">P&L</th>
              <th className="hidden w-[14%] px-4 font-medium lg:table-cell">Last event</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {bots.map((bot) => {
              const pnl = bot.initialEquity > 0 ? ((bot.equity - bot.initialEquity) / bot.initialEquity) * 100 : 0
              return (
                <tr key={bot.id} onClick={() => navigate(`/bots/${bot.id}`)} className="h-13 cursor-pointer transition-colors hover:bg-surface-2/60">
                  <td className="truncate px-4">
                    <span className="flex items-center gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-muted [&_svg]:size-3.5">
                        <BotIcon />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{bot.name}</span>
                        <span className="block truncate text-[12px] text-faint">{bot.strategyName}</span>
                      </span>
                    </span>
                  </td>
                  <td className="hidden truncate px-4 text-muted md:table-cell">{bot.symbols.join(', ')}</td>
                  <td className="hidden px-4 sm:table-cell">
                    <Badge tone={bot.stage === 'live' ? 'success' : bot.stage === 'paper' ? 'info' : 'neutral'}>
                      {BOT_STAGES.find((s) => s.key === bot.stage)?.label}
                    </Badge>
                  </td>
                  <td className="px-4">
                    <Badge tone={statusTone[bot.status]} dot>
                      {bot.status}
                    </Badge>
                  </td>
                  <td className="px-4 text-right tabular-nums">{money(bot.equity)}</td>
                  <td className={cx('hidden px-4 text-right tabular-nums md:table-cell', pnl >= 0 ? 'text-success' : 'text-danger')}>
                    {pnl >= 0 ? '+' : ''}
                    {pnl.toFixed(1)}%
                  </td>
                  <td className="hidden truncate px-4 text-faint lg:table-cell">
                    {bot.lastEvent ? `${bot.lastEvent} · ${relativeTime(bot.updatedAt)}` : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {isLoading && (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 rounded-tile" />
            ))}
          </div>
        )}
        {!isLoading && bots.length === 0 && (
          <EmptyState
            icon={<BotIcon />}
            title={filter === 'all' ? 'No bots yet' : `No ${filter} bots`}
            description="Pick a strategy from the catalog, set your risk and launch it into paper mode."
            action={
              <Button variant="primary" onClick={() => navigate('/strategies')}>
                <Plus />
                Launch a bot
              </Button>
            }
          />
        )}
      </div>
    </div>
  )
}
