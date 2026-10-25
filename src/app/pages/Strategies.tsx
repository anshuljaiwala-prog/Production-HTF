import { FlaskConical, Play, Rocket, Zap } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { BacktestDialog, LaunchWizard } from '../components/forms'
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '../components/ui'
import { useStrategies } from '../lib/api'
import type { RiskLevel, Strategy } from '../../shared/types'

const riskTone: Record<RiskLevel, 'success' | 'warning' | 'danger'> = { low: 'success', medium: 'warning', high: 'danger' }

export function Strategies() {
  const { data, isLoading } = useStrategies()
  const [params] = useSearchParams()
  const [launchKey, setLaunchKey] = useState<string | null>(null)
  const [backtestKey, setBacktestKey] = useState<string | null>(null)
  const highlighted = params.get('s')

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Strategies"
        subtitle="Six templates on one engine. Backtest before you launch, or go straight to paper."
        actions={
          <Button variant="primary" onClick={() => setBacktestKey(null)}>
            <Play />
            New backtest
          </Button>
        }
      />

      {isLoading ? (
        <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[230px] rounded-card" />
          ))}
        </div>
      ) : (
        <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data?.strategies.map((strategy) => (
            <StrategyCard
              key={strategy.key}
              strategy={strategy}
              highlighted={highlighted === strategy.key}
              onLaunch={() => setLaunchKey(strategy.key)}
              onBacktest={() => setBacktestKey(strategy.key)}
            />
          ))}
        </div>
      )}

      {data && data.strategies.length === 0 && (
        <EmptyState icon={<FlaskConical />} title="No strategies" description="The catalog is defined in code — none were found." />
      )}

      <LaunchWizard open={launchKey !== null} onClose={() => setLaunchKey(null)} strategyKey={launchKey} />
      <BacktestDialog open={backtestKey !== null} onClose={() => setBacktestKey(null)} strategyKey={backtestKey} />
    </div>
  )
}

function StrategyCard({
  strategy,
  highlighted,
  onLaunch,
  onBacktest,
}: {
  strategy: Strategy
  highlighted: boolean
  onLaunch: () => void
  onBacktest: () => void
}) {
  return (
    <Card className={`flex flex-col p-5 ${highlighted ? 'ring-2 ring-accent/40' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{strategy.name}</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-muted">{strategy.summary}</p>
        </div>
        <Badge tone={riskTone[strategy.risk]}>{strategy.risk} risk</Badge>
      </div>

      <p className="mt-3 line-clamp-3 text-[12.5px] leading-relaxed text-faint">{strategy.description}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {strategy.tags.map((tag) => (
          <span key={tag} className="rounded-[8px] bg-surface-2 px-2 py-1 text-[11.5px] text-muted">
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {strategy.timeframes.map((tf) => (
          <span key={tf} className="rounded-[7px] border border-line px-1.5 py-0.5 text-[11px] tabular-nums text-faint">
            {tf}
          </span>
        ))}
        <span className="rounded-[7px] border border-line px-1.5 py-0.5 text-[11px] tabular-nums text-faint">
          {strategy.params.length} params
        </span>
      </div>

      <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
        <Button size="sm" onClick={onBacktest}>
          <FlaskConical />
          Backtest
        </Button>
        <Button variant="primary" size="sm" onClick={onLaunch}>
          <Rocket />
          Launch
        </Button>
        <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-faint">
          <Zap className="size-3" />
          paper first
        </span>
      </div>
    </Card>
  )
}
