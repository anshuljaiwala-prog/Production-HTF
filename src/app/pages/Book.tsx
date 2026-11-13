import { BookOpen, Play } from 'lucide-react'
import { useState } from 'react'

import { Sparkline } from '../components/charts'
import { Badge, Button, Card, EmptyState, Input, Skeleton, useToast } from '../components/ui'
import { assignPlan, clearBookEntry, executePlan, useApiMutation, useBook, useBookSignals } from '../lib/api'
import { PATTERN_REGIMES } from '../../shared/types'
import type { BookSignal } from '../lib/api'
import type { PatternRegime } from '../../shared/types'

const REGIME_HINTS: Record<string, string> = Object.fromEntries(PATTERN_REGIMES.map((r) => [r.key, r.hint]))

/** The strategy book: the registry that turns recognised patterns into
 * executed trades. Every scanner regime the platform reads has one answered
 * play — the tool box plan that fires when that regime is recognised — and
 * the live signal list below cites the market, the read and the plan, then
 * executes it onto a wallet when the operator says go. */

const regimeTone: Record<PatternRegime, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  crash: 'danger',
  selloff: 'warning',
  hype: 'success',
  breakout: 'success',
  squeeze: 'info',
  uptrend: 'success',
  downtrend: 'warning',
  range: 'info',
}

const regimeLabel = (regime: string) => PATTERN_REGIMES.find((r) => r.key === regime)?.label ?? regime

export function StrategyBookPanel() {
  const { data, isLoading } = useBook()
  const toast = useToast()

  const assign = useApiMutation(
    (input: { regime: string; playbookId: string }) => assignPlan(input.regime, input.playbookId),
    ['book'],
    { onSuccess: () => toast('Book updated — the plan now answers that regime.') },
  )
  const clear = useApiMutation((regime: string) => clearBookEntry(regime), ['book'], {
    onSuccess: () => toast('Override cleared — the regime reads its builtin default again.'),
  })

  if (isLoading) {
    return (
      <div className="grid gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-card" />
        ))}
      </div>
    )
  }

  const entries = data?.items ?? []
  return (
    <>
      <div className="mt-4 space-y-2">
        {entries.map((entry) => (
          <BookRow
            key={entry.regime}
            entry={entry}
            planIds={entries.map((e) => ({ id: e.playbook.id, name: e.playbook.name, regime: e.regime }))}
            onAssign={(playbookId) => assign.mutate({ regime: entry.regime, playbookId })}
            onClear={entry.overridden ? () => clear.mutate(entry.regime) : undefined}
            busy={assign.isPending || clear.isPending}
          />
        ))}
      </div>
      {entries.length === 0 && (
        <EmptyState icon={<BookOpen />} title="The book is empty" description="Assign plans from the tool box to the regimes the scanner reads." />
      )}
      <SignalList />
    </>
  )
}

function BookRow({
  entry,
  planIds,
  onAssign,
  onClear,
  busy,
}: {
  entry: { regime: string; playbook: { id: string; name: string; regime: string; strategyName?: string; timeframe: string | null; riskPct: number; note: string; source: 'builtin' | 'custom' }; strategyName: string; overridden: boolean }
  planIds: { id: string; name: string; regime: string }[]
  onAssign: (playbookId: string) => void
  onClear?: () => void
  busy: boolean
}) {
  const [choice, setChoice] = useState('')
  const regime = entry.regime as PatternRegime
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={regimeTone[regime]}>{regimeLabel(regime)}</Badge>
            <span className="text-[12px] text-faint">{REGIME_HINTS[regime] ?? ''}</span>
          </div>
          <p className="mt-1 text-[14px] font-semibold">{entry.playbook.name}</p>
          <p className="text-[12.5px] text-muted">
            {entry.strategyName} · {entry.playbook.riskPct}% per fill ·{' '}
            {entry.playbook.timeframe ? `${entry.playbook.timeframe} bars` : 'follows the bot'}{' '}
            {entry.overridden && <span className="text-faint">· your override</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <select
            aria-label={`Change the ${regimeLabel(regime)} plan`}
            value={choice || entry.playbook.id}
            onChange={(e) => setChoice(e.target.value)}
            className="h-8 rounded-[9px] border border-control bg-surface px-2 text-[12.5px]"
          >
            {planIds.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} ({regimeLabel(plan.regime)})
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={() => onAssign(choice || entry.playbook.id)} disabled={busy || (!choice || choice === entry.playbook.id)}>
            Assign
          </Button>
          {onClear && (
            <Button variant="secondary" onClick={onClear} disabled={busy}>
              Clear override
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

/** Live signals: recognised patterns the book would trade right now, with a
 * one-click execution that launches the plan as a running paper bot. */
function SignalList() {
  const { data } = useBookSignals()
  const toast = useToast()
  const [fundings, setFundings] = useState<Record<string, string>>({})

  const execute = useApiMutation(
    (input: { playbookId: string; symbol: string; capital: number }) => executePlan(input),
    ['bots', 'book-signals', 'dashboard'],
    {
      onSuccess: (result) =>
        toast(`Executed "${result.executed.plan}" — ${result.executed.symbol} is trading it in paper mode.`),
    },
  )

  const items = data?.items ?? []
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<BookOpen />}
        title="No live signals"
        description="When the scanner reads a regime the book answers, on a parked bot's market, the plan lands here to execute."
      />
    )
  }

  return (
    <div className="mt-6">
      <h2 className="text-[14px] font-semibold">Live signals — recognised patterns ready to execute</h2>
      <p className="text-[12.5px] text-faint">Regime reads on parked bots' markets, strongest first · scans every 60s</p>
      <div className="mt-3 grid gap-3">
        {items.map((signal) => (
          <SignalRow
            key={`${signal.botId}:${signal.symbol}:${signal.regime}`}
            signal={signal}
            capital={fundings[`${signal.botId}:${signal.symbol}`] ?? ''}
            onCapital={(value) => setFundings((prev) => ({ ...prev, [`${signal.botId}:${signal.symbol}`]: value }))}
            onExecute={(capital) => execute.mutate({ playbookId: signal.playbook.id, symbol: signal.symbol, capital })}
            executing={execute.isPending && execute.variables?.symbol === signal.symbol}
          />
        ))}
      </div>
      {execute.error && <p className="mt-2 text-[13px] text-danger">{execute.error.message}</p>}
    </div>
  )
}

function SignalRow({
  signal,
  capital,
  onCapital,
  onExecute,
  executing,
}: {
  signal: BookSignal
  capital: string
  onCapital: (value: string) => void
  onExecute: (capital: number) => void
  executing: boolean
}) {
  const regime = signal.regime as PatternRegime
  const parsed = Number(capital)
  const ready = capital.trim() !== '' && Number.isFinite(parsed) && parsed >= 100
  const hint = `${regimeLabel(regime)} read at ${signal.confidence}% confidence`
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkline data={signal.spark} positive={signal.changePct >= 0} className="mt-1 h-8 w-24 shrink-0" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{signal.symbol}</span>
              <Badge tone={regimeTone[regime]}>{regimeLabel(regime)}</Badge>
              <span className="text-[12px] text-faint">{hint}</span>
            </div>
            <p className="mt-1 text-[13px] text-muted">
              {signal.evidence[0]} · {signal.evidence[1] ?? signal.evidence[0]}
            </p>
            <p className="text-[12.5px] text-faint">
              Would execute <span className="font-medium text-fg">{signal.playbook.name}</span> ({signal.strategyName} · {signal.playbook.riskPct}
              % per fill) — read off {signal.botName}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Input
            aria-label="Starting capital (USD)"
            type="number"
            min={100}
            step={100}
            placeholder={String(Math.max(100, Math.round(signal.botCapital)))}
            value={capital}
            onChange={(e) => onCapital(e.target.value)}
            className="w-32"
          />
          <Button variant="primary" disabled={!ready} loading={executing} onClick={() => onExecute(parsed)}>
            <Play />
            Execute
          </Button>
        </div>
      </div>
    </Card>
  )
}
