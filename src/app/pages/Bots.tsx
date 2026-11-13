import { Bot as BotIcon, Plus, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { BoardPanel } from './Board'
import { EdgePanel } from './Edge'
import { FleetPatternPanel } from './Patterns'
import { ToolboxPanel } from './Toolbox'
import { StrategyBookPanel } from './Book'
import { BotImportDialog } from '../components/forms'
import { CompareBars } from '../components/charts'
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '../components/ui'
import { useBots } from '../lib/api'
import { cx } from '../lib/cx'
import { money, relativeTime } from '../lib/format'
import { ACTIVITIES, BOT_STAGES, activityOf, type Bot, type BotActivity } from '../../shared/types'

const activityTone: Record<BotActivity, 'success' | 'warning' | 'neutral' | 'info'> = {
  active: 'success',
  inactive: 'warning',
  grounded: 'neutral',
  training: 'info',
  hangar: 'neutral',
}
const FILTERS: { key: BotActivity | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'training', label: 'Training' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'hangar', label: 'In hangar' },
  { key: 'grounded', label: 'Grounded' },
]
const TABS: { key: 'list' | 'board' | 'edge' | 'patterns' | 'toolbox' | 'book'; label: string }[] = [
  { key: 'list', label: 'Bot list' },
  { key: 'board', label: 'Lifecycle board' },
  { key: 'edge', label: 'Edge ranking' },
  { key: 'patterns', label: 'Pattern ranking' },
  { key: 'toolbox', label: 'Tool box' },
  { key: 'book', label: 'Strategy book' },
]

export function Bots() {
  const { data, isLoading } = useBots()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<BotActivity | 'all'>('all')
  const [importing, setImporting] = useState(false)
  const tab = params.get('tab')
  const view = (['board', 'edge', 'patterns', 'toolbox', 'book'] as const).includes(tab as never) ? (tab as typeof TABS[number]['key']) : 'list'

  const items = useMemo(() => data?.items ?? [], [data])
  const bots = useMemo(() => items.filter((bot) => filter === 'all' || activityOf(bot) === filter), [items, filter])
  const active = items.filter((bot) => activityOf(bot) === 'active').length

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Bots"
        subtitle={
          data
            ? view === 'board'                    ? 'Drag bots across their lifecycle: draft → backtest → paper → live.'
                    : view === 'edge'
                      ? 'Ranked by market-edge accuracy — whose entry signals predict the next bar best.'
                      : view === 'patterns'
                        ? 'Which bots are trading crash, hype or squeeze markets right now, strongest tape first.'
                        : view === 'toolbox'
                          ? 'Trading execution plans — the bot configuration a recognised pattern calls for, ready to deploy.'
                          : view === 'book'
                            ? 'Which plan fires for each recognised regime — and the patterns the book would trade right now.'
                            : `${items.length} launched · ${active} active — each read fast-forwards the fleet`
            : undefined
        }
        actions={
          <>
            <Button onClick={() => setImporting(true)}>
              <Upload />
              Import bots
            </Button>
            <Button variant="primary" onClick={() => navigate('/strategies')}>
              <Plus />
              New bot
            </Button>
          </>
        }
      />

      <div className="mt-5 flex w-fit items-center gap-1 rounded-control bg-bg p-1" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={view === tab.key}
            onClick={() => setParams(tab.key === 'list' ? {} : { tab: tab.key })}
            className={cx(
              'h-8 rounded-[9px] px-3.5 text-[12.5px] font-medium transition-colors',
              view === tab.key ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <BotImportDialog open={importing} onClose={() => setImporting(false)} />

      {view === 'board' ? (
        <div className="mt-4">
          <BoardPanel />
        </div>
      ) : view === 'edge' ? (
        <EdgePanel />
      ) : view === 'patterns' ? (
        <FleetPatternPanel />
      ) : view === 'toolbox' ? (
        <ToolboxPanel />
      ) : view === 'book' ? (
        <StrategyBookPanel />
      ) : (
        <>
          <BotCharts items={items} isLoading={isLoading} />

          <div className="mt-3 flex items-center gap-1 rounded-control bg-bg p-1">
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
              <th scope="col" className="w-[28%] px-4 font-medium">Bot</th>
              <th scope="col" className="hidden w-[14%] px-4 font-medium md:table-cell">Symbols</th>
              <th scope="col" className="hidden w-[12%] px-4 font-medium sm:table-cell">Stage</th>
              <th scope="col" className="w-[14%] px-4 font-medium">Status</th>
              <th scope="col" className="w-[14%] px-4 text-right font-medium">Equity</th>
              <th scope="col" className="hidden w-[12%] px-4 text-right font-medium md:table-cell">P&L</th>
              <th scope="col" className="hidden w-[14%] px-4 font-medium lg:table-cell">Last event</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {bots.map((bot) => {
              const pnl = bot.capital > 0 ? ((bot.equity - bot.capital) / bot.capital) * 100 : 0
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
                  <td className="px-4" title="Active: live trading · Training: paper trading / being backtested · Inactive: holding only · Hangar: parked paper bot · Grounded: not trading or holding">
                    <Badge tone={activityTone[activityOf(bot)]} dot>
                      {activityOf(bot)}
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
            title= {filter === 'all' ? 'No bots yet' : `No ${ACTIVITIES.find((a) => a.key === filter)?.label.toLowerCase() ?? filter} bots`}
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
        </>
      )}
    </div>
  )
}

/** Fleet comparison charts above the list: where capital sits and how each
 * bot is performing. Plotted directly from the list data — no extra request. */
function BotCharts({ items, isLoading }: { items: Bot[]; isLoading: boolean }) {
  if (isLoading || items.length === 0) return null
  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Capital allocation by bot</h2>
          <span className="text-[12.5px] text-faint">equity split</span>
        </div>
        <div className="mt-4">
          <CompareBars items={items.map((bot) => ({ label: bot.name, caption: bot.strategyName, value: bot.equity }))} />
        </div>
      </Card>
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Net P&L by bot</h2>
          <span className="text-[12.5px] text-faint">% of initial capital</span>
        </div>
        <div className="mt-4">
          <CompareBars
            signed
            format={(v) => `${v.toFixed(1)}%`}
            items={items.map((bot) => ({
              label: bot.name,
              caption: `${activityOf(bot)} · ${bot.symbols[0]}`,
              value: bot.capital > 0 ? ((bot.equity - bot.capital) / bot.capital) * 100 : 0,
            }))}
          />
        </div>
      </Card>
    </div>
  )
}
