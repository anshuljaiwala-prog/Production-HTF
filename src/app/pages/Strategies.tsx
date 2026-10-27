import { FlaskConical, Play, Rocket, Zap } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { BacktestDialog, LaunchWizard } from '../components/forms'
import { Backtests } from './Backtests'
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '../components/ui'
import { useStrategies } from '../lib/api'
import type { RiskLevel, Strategy } from '../../shared/types'

const riskTone: Record<RiskLevel, 'success' | 'warning' | 'danger'> = { low: 'success', medium: 'warning', high: 'danger' }

export function Strategies() {
  const { data, isLoading } = useStrategies()
  const [params, setParams] = useSearchParams()
  const [launchKey, setLaunchKey] = useState<string | null>(null)
  const [backtestKey, setBacktestKey] = useState<string | null>(null)
  // Separate open flag: `strategyKey = null` means "free-form backtest", not
  // "closed".
  const [backtestOpen, setBacktestOpen] = useState(false)
  const highlighted = params.get('s')
  // The Backtests page lives here as a second tab, so strategy research and
  // its replays stay in one place.
  const tab = params.get('tab') === 'backtests' ? 'backtests' : 'catalog'

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Strategies"
        subtitle="Six templates on one engine. Backtest before you launch, or go straight to paper."
      />

      {/* Tab switcher: catalog / backtests */}
      <div className="mt-4 flex items-center gap-1.5" role="tablist" aria-label="Strategy sections">
        <TabButton
          active={tab === 'catalog'}
          onClick={() => setParams(highlighted ? { s: highlighted } : {})}
        >
          <FlaskConical className="mr-1 inline size-3.5" />
          Catalog
        </TabButton>
        <TabButton active={tab === 'backtests'} onClick={() => setParams({ tab: 'backtests' })}>
          Backtests
        </TabButton>
        {tab === 'backtests' && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setBacktestOpen(true)}>
            <Play />
            New backtest
          </Button>
        )}
      </div>

      {tab === 'backtests' ? (
        <Backtests embedded />
      ) : (
        <>
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
                  onBacktest={() => {
                    setBacktestKey(strategy.key)
                    setBacktestOpen(true)
                  }}
                />
              ))}
            </div>
          )}

          {data && data.strategies.length === 0 && (
            <EmptyState icon={<FlaskConical />} title="No strategies" description="The catalog is defined in code — none were found." />
          )}
        </>
      )}

      <LaunchWizard open={launchKey !== null} onClose={() => setLaunchKey(null)} strategyKey={launchKey} />
      <BacktestDialog open={backtestOpen} onClose={() => setBacktestOpen(false)} strategyKey={backtestKey} />
    </div>
  )
}

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? 'flex h-8 items-center gap-1 rounded-[9px] bg-fg px-3 text-[12.5px] font-medium text-bg'
          : 'flex h-8 items-center gap-1 rounded-[9px] border border-line bg-surface px-3 text-[12.5px] font-medium text-muted transition-colors hover:text-fg'
      }
    >
      {children}
    </button>
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
