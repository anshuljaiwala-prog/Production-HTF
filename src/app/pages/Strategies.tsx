import { FlaskConical, Play, Rocket, Trash2, Upload, Zap } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { BacktestDialog, LaunchWizard, UploadStrategyDialog } from '../components/forms'
import { Backtests } from './Backtests'
import { Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Skeleton, useToast } from '../components/ui'
import { deleteCustomStrategy, useApiMutation, useCustomStrategies, useStrategies } from '../lib/api'
import { shortDate } from '../lib/format'
import type { RiskLevel, Strategy } from '../../shared/types'

const riskTone: Record<RiskLevel, 'success' | 'warning' | 'danger'> = { low: 'success', medium: 'warning', high: 'danger' }

export function Strategies() {
  const { data, isLoading } = useStrategies()
  const [params, setParams] = useSearchParams()
  const [launchKey, setLaunchKey] = useState<string | null>(null)
  const [backtestKey, setBacktestKey] = useState<string | null>(null)
  // Uploaded rules strategies live outside the catalog — track which one is
  // being launched / backtested alongside the catalog key.
  const customList = useCustomStrategies().data?.items ?? []
  const toast = useToast()
  const [customId, setCustomId] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const remove = useApiMutation((id: string) => deleteCustomStrategy(id), ['custom-strategies'], {
    onSuccess: () => {
      toast('Uploaded strategy discarded')
      setRemoving(null)
    },
  })
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
        actions={
          <Button variant="primary" onClick={() => setUploadOpen(true)}>
            <Upload />
            Upload strategy (JSON)
          </Button>
        }
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
          {customList.length > 0 && (
            <section className="mt-6">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-[14px] font-semibold">Uploaded strategies (rules DSL · durable)</h2>
                <span className="text-[12px] text-faint">stored in D1 with version history — backtest with historical data before launching</span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {customList.map((entry) => (
                  <Card key={entry.id} className="flex flex-col p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-[15px] font-semibold tracking-tight">{entry.name}</h3>
                        <p className="mt-0.5 text-[12.5px] text-faint">
                          {entry.rules} rules · lookback {entry.lookback} bars · uploaded {shortDate(entry.createdAt)}
                        </p>
                      </div>
                      <Badge tone="info">custom</Badge>
                    </div>
                    <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
                      <Button
                        size="sm"
                        onClick={() => {
                          setCustomId(entry.id)
                          setBacktestKey('custom')
                          setBacktestOpen(true)
                        }}
                      >
                        <FlaskConical />
                        Backtest
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setCustomId(entry.id)
                          setLaunchKey('custom')
                        }}
                      >
                        <Rocket />
                        Launch
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${entry.name}`} className="ml-auto" onClick={() => setRemoving(entry.id)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

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

      <LaunchWizard open={launchKey !== null} onClose={() => setLaunchKey(null)} strategyKey={launchKey} customId={customId} />
      <BacktestDialog open={backtestOpen} onClose={() => setBacktestOpen(false)} strategyKey={backtestKey} customId={customId} />
      <UploadStrategyDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        title="Discard this uploaded strategy?"
        description="Every stored version of this strategy is removed from D1. Bots already launched with it keep running with their own copy of the rules."
      />
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
