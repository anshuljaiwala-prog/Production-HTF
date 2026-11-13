import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, FlaskConical, GraduationCap, Play, Rocket, SlidersHorizontal, Sparkles, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { AreaChart, BarChart } from '../components/charts'
import { BacktestDialog } from '../components/forms'
import { Backtests } from './Backtests'
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton, useFieldId, useToast } from '../components/ui'
import { ApiError, optimizeTraining, patchBot, useApiMutation, useBots, useCustomStrategies, useCustomStrategy, usePaperBook, useStrategies, type OptimizeResult, type OptimizeRunRow } from '../lib/api'
import { capture } from '../lib/analytics'
import { cx } from '../lib/cx'
import { money, relativeTime, shortDate } from '../lib/format'
import { activityOf, customKnobDefs, TRAIN_MAX_COMBOS, TIMEFRAMES, type CustomRules, type ParamDef, type ParamValue, type PortfolioBotAudit, type Timeframe } from '../../shared/types'

function TInput(props: React.ComponentPropsWithoutRef<typeof Input>) {
  const id = useFieldId()
  return <Input id={id} {...props} />
}
function TSelect(props: React.ComponentPropsWithoutRef<typeof Select>) {
  const id = useFieldId()
  return <Select id={id} {...props} />
}

/** One sweepable knob, as the form holds it (strings until submit). */
interface KnobForm {
  key: string
  from: string
  to: string
  steps: string
}

const DAYS_OPTIONS = [90, 180, 365, 730]
const statusTone: Record<PortfolioBotAudit['status'], 'success' | 'warning' | 'neutral'> = {
  running: 'success',
  paused: 'warning',
  stopped: 'neutral',
}

/** Sensible first sweep for a strategy: its first numeric param, min → max
 * (or a ±50% band around the default when the schema has no bounds). */
function defaultKnobs(defs: ParamDef[] | undefined): KnobForm[] {
  const first = defs?.find((p) => p.type === 'number')
  if (!first) return []
  const def = Number(first.default)
  const from = first.min ?? Math.max(0.01, def * 0.5)
  const to = first.max ?? def * 1.5
  return [{ key: first.key, from: String(from), to: String(to), steps: '4' }]
}

/**
 * Training lab: fit a strategy's parameters to the platform's stored
 * five-year history (train slice), score them on a hold-out tail (test
 * slice), then replay the winner in full. The Backtests tab on the same
 * page replays any bot — new, imported or uploaded-rules — over the same
 * stored history.
 */
export function Training() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: 'optimize' | 'backtests' | 'paper' = raw === 'backtests' || raw === 'paper' ? raw : 'optimize'

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Training"
        subtitle="Train and optimize bots against five years of stored market history, then backtest them and watch them trade in the paper lab — train/test split included."
      />

      <div className="mt-4 flex items-center gap-1.5" role="tablist" aria-label="Training sections">
        <TabButton active={tab === 'optimize'} onClick={() => setParams({})}>
          <SlidersHorizontal className="mr-1 inline size-3.5" />
          Train & optimize
        </TabButton>
        <TabButton active={tab === 'backtests'} onClick={() => setParams({ tab: 'backtests' })}>
          <FlaskConical className="mr-1 inline size-3.5" />
          Backtests
        </TabButton>
        <TabButton active={tab === 'paper'} onClick={() => setParams({ tab: 'paper' })}>
          <Wallet className="mr-1 inline size-3.5" />
          Paper portfolio
        </TabButton>
        {tab === 'backtests' && <NewBacktestButton />}
      </div>

      {tab === 'backtests' ? <Backtests embedded /> : tab === 'paper' ? <PaperLab /> : <Optimizer />}
    </div>
  )
}

// --- Paper portfolio -------------------------------------------------------

/** The simulated wallet beside the actual book: every paper-mode bot, its
 * running equity, and a one-click promotion to live trading. Paper proceeds
 * never blend into the real portfolio — the Portfolio page enforces that
 * split server-side; this tab is the lab where paper results are reviewed. */
function PaperLab() {
  const toast = useToast()
  const [, setParams] = useSearchParams()
  const { data, isLoading } = usePaperBook()
  const paperBots = data?.bots ?? []
  const invalidate = useQueryClient()

  const goLive = useMutation({
    mutationFn: (botId: string) => patchBot(botId, { mode: 'live' }),
    onSuccess: async (bot) => {
      await invalidate.invalidateQueries({ queryKey: ['portfolio'] })
      await invalidate.invalidateQueries({ queryKey: ['bots'] })
      toast(`"${bot.bot.name}" now trades live through its exchange connection`)
    },
    onError: (error) => toast(error instanceof ApiError ? error.message : 'Switch to live failed', 'danger'),
  })

  const paperPnl = data?.summary.pnl ?? 0
  return (
    <div className="mt-6 flex flex-col gap-3">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold">Paper trading portfolio</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              The simulated wallet every paper bot trades against. These numbers are carried
              <span className="font-medium text-fg"> beside</span> the actual portfolio — they never enter its equity, P&L or audit,
              so a training run can prove itself without pretending at real money.
            </p>
          </div>
          <Link to="/portfolio" className="text-[12.5px] font-medium text-accent hover:underline">Actual portfolio →</Link>
        </div>

        {isLoading && <Skeleton className="mt-4 h-16" />}
        {data && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {([
              { label: 'Paper bots', value: String(data.summary.bots) },
              { label: 'Paper capital', value: money(data.summary.capital) },
              { label: 'Paper equity', value: money(data.summary.equity) },
              { label: 'Paper P&L', value: `${paperPnl >= 0 ? '+' : ''}${money(paperPnl)}`, tone: paperPnl >= 0 ? 'text-success' : 'text-danger' },
              { label: 'Since launch', value: data.summary.capital > 0 ? `${(paperPnl / data.summary.capital * 100).toFixed(1)}%` : '—' },
            ] as const).map((tile) => (
              <div key={tile.label} className="rounded-card border border-line p-3">
                <p className="text-[12px] text-muted">{tile.label}</p>
                <p className={cx('mt-0.5 text-[16px] font-semibold tabular-nums', 'tone' in tile ? tile.tone : '')}>{tile.value}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {data && data.equity.length > 1 && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold">Simulated wallet equity</h2>
            <span className="text-[12.5px] text-faint">
              daily close across every paper bot · {data.equity.length} days · updates as running paper bots progress
            </span>
          </div>
          <div className="mt-3">
            <AreaChart data={data.equity} height={190} format={money} />
          </div>
        </Card>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Paper bots</h2>
          <span className="text-[12.5px] text-faint">promote a bot when its paper record proves the strategy</span>
        </div>

        {isLoading && <Skeleton className="mt-4 h-24" />}

        {data && paperBots.length === 0 && (
          <EmptyState
            icon={<Wallet />}
            title="No paper bots yet"
            description="Launch a bot in paper mode (the launch wizard's default) and it appears here with its simulated wallet. Train first if you want tested parameters."
            action={
              <div className="flex gap-2">
                <Link to="/strategies"><Button size="sm">Launch a bot</Button></Link>
                <Button size="sm" variant="ghost" onClick={() => setParams({ tab: 'optimize' })}>Train & optimize</Button>
              </div>
            }
          />
        )}

        {paperBots.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-card border border-line">
            <table className="w-full min-w-[880px] text-left text-[13px]">
              <thead>
                <tr className="h-9 border-b border-line bg-bg/60 text-[12px] text-muted">
                  <th scope="col" className="px-3 font-medium">Bot</th>
                  <th scope="col" className="px-3 font-medium">Status</th>
                  <th scope="col" className="px-3 font-medium">Market</th>
                  <th scope="col" className="px-3 text-right font-medium">Cash</th>
                  <th scope="col" className="px-3 text-right font-medium">Equity</th>
                  <th scope="col" className="px-3 text-right font-medium">Net P&L</th>
                  <th scope="col" className="px-3 text-right font-medium">Win rate</th>
                  <th scope="col" className="px-3 text-right font-medium">Last activity</th>
                  <th scope="col" className="px-3 text-right font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {paperBots.map((bot) => {
                  // Honest P&L: funding moves equity and capital together, so the
                  // difference isolates trading results — the portfolio's own basis.
                  const botPnl = bot.equity - bot.capital
                  const activity = activityOf(bot)
                  return (
                    <tr key={bot.id} className="h-12">
                      <td className="max-w-[220px] truncate px-3 font-medium">
                        <Link to={`/bots/${bot.id}`} className="hover:underline">{bot.name}</Link>
                      </td>
                      <td className="px-3">
                        <Badge tone={statusTone[bot.status]}>{bot.status}</Badge>
                        {activity === 'hangar' && <Badge tone="neutral" className="ml-1">in hangar</Badge>}
                      </td>
                      <td className="max-w-[150px] px-3 truncate text-muted">{bot.strategyName} · {bot.timeframe}</td>
                      <td className="px-3 text-right tabular-nums">{money(bot.cash)}</td>
                      <td className="px-3 text-right font-semibold tabular-nums">{money(bot.equity)}</td>
                      <td className={cx('px-3 text-right tabular-nums', botPnl >= 0 ? 'text-success' : 'text-danger')}>
                        {botPnl >= 0 ? '+' : ''}{money(botPnl)}
                      </td>
                      <td className="px-3 text-right tabular-nums text-muted">{bot.winRate === null ? '—' : `${bot.winRate.toFixed(0)}%`}</td>
                      <td className="px-3 text-right text-muted">{relativeTime(bot.lastActivityAt)}</td>
                      <td className="px-3 text-right">
                        <Button
                          size="sm"
                          variant="primary"
                          loading={goLive.isPending && goLive.variables === bot.id}
                          onClick={() => goLive.mutate(bot.id)}
                          title="Switch this bot to live trading through its exchange connection"
                        >
                          <ArrowUpRight className="size-3.5" />
                          Go live
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {paperBots.length > 0 && (
          <p className="mt-2 text-[11.5px] text-faint">
            Going live requires an exchange connection on the bot — switching a connectionless bot fails with a message to connect it first.
          </p>
        )}
      </Card>
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

/** Launch a backtest from the Backtests tab: catalog strategies, uploaded
 * rules, or any bot (new, imported or custom-rules) via "Start from a bot". */
function NewBacktestButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="primary" size="sm" className="ml-auto" onClick={() => setOpen(true)}>
        <Play />
        New backtest
      </Button>
      <BacktestDialog open={open} onClose={() => setOpen(false)} strategyKey={null} />
    </>
  )
}

// --- Optimizer ---------------------------------------------------------------

function Optimizer() {
  const toast = useToast()
  const { data: catalog } = useStrategies()
  const { data: botList } = useBots()

  // Source: compose a fresh config, train an existing bot's config, or tune
  // an uploaded rules strategy directly (its thresholds become the knobs).
  const [botId, setBotId] = useState('')
  const [customId, setCustomId] = useState('')
  const [strategyKey, setStrategyKey] = useState('')
  const [symbol, setSymbol] = useState('')
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [capital, setCapital] = useState('10000')
  const [days, setDays] = useState(180)
  const [objective, setObjective] = useState<'sharpe' | 'return'>('sharpe')
  const [knobs, setKnobs] = useState<KnobForm[]>([])

  const { data: customList } = useCustomStrategies()
  const { data: customDetail } = useCustomStrategy(customId || undefined)

  const bot = botList?.items.find((b) => b.id === botId)
  const isCustomSource = bot?.strategyKey === 'custom'
  // The sweep must train the strategy that will actually run: a picked bot's
  // own strategy wins over the standalone picker (the server trains the bot's
  // config, and rejects knobs from any other schema). Key-based so list
  // refetches can't reset an in-progress edit.
  const formStrategyKey = bot ? (isCustomSource ? null : bot.strategyKey) : customId ? 'custom' : strategyKey
  const strategy = catalog?.strategies.find((s) => s.key === formStrategyKey)

  // Rules behind the current source: an inline copy on a custom bot, or the
  // fetched detail of a picked upload. Signature-keyed so effects stay stable.
  const rulesSignature = isCustomSource
    ? String(bot?.params.rules ?? '')
    : customId
      ? customDetail
        ? JSON.stringify(customDetail.rules)
        : ''
      : ''
  const customRules: CustomRules | null = rulesSignature ? (JSON.parse(rulesSignature) as CustomRules) : null
  // Knobs: an uploaded strategy sweeps its rule thresholds + stop/target;
  // a catalog strategy sweeps its own numeric param schema.
  const numericParams: ParamDef[] = customRules
    ? customKnobDefs(customRules)
    : (strategy?.params ?? []).filter((p) => p.type === 'number')

  // First strategy by default; knobs follow the chosen strategy's schema.
  useEffect(() => {
    if (catalog && !strategyKey && !customId && !botId) setStrategyKey(catalog.strategies[0]?.key ?? '')
  }, [catalog, strategyKey, customId, botId])
  // The symbol select displays the first entry until state says otherwise —
  // initialize it for real so the run button isn't stuck disabled.
  useEffect(() => {
    if (catalog && !symbol) setSymbol(catalog.symbols[0]?.symbol ?? '')
  }, [catalog, symbol])
  useEffect(() => {
    const rules = rulesSignature ? (JSON.parse(rulesSignature) as CustomRules) : null
    const defs = rules
      ? customKnobDefs(rules)
      : (catalog?.strategies.find((s) => s.key === formStrategyKey)?.params ?? []).filter((p) => p.type === 'number')
    setKnobs(defaultKnobs(defs))
  }, [formStrategyKey, catalog, rulesSignature])

  const train = useApiMutation(
    (input: Parameters<typeof optimizeTraining>[0]) => optimizeTraining(input),
    [],
    { onSuccess: (result, input) => {
        // Feature adoption: how many grid runs, how wide the sweep.
        capture('training_run', {
          strategy: result.source.strategyKey,
          objective: result.objective,
          runs: result.runs.length,
          knobs: input.vary.length,
        })
        const best = result.runs[result.bestIndex]
        if (best && !best.error) toast(`Trained ${result.runs.length} runs · best ${result.objective === 'sharpe' ? 'Sharpe' : 'return'} ${(result.objective === 'sharpe' ? best.train.sharpe : best.train.totalReturn).toFixed(2)}`)
      },
    },
  )
  // The results panel sits below the fold: a rejected sweep (from > to,
  // oversized grid…) must toast up front or the operator sees nothing happen.
  useEffect(() => {
    if (train.isError && train.error) toast(train.error instanceof ApiError ? train.error.message : 'Training run failed', 'danger')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [train.isError, train.error])
  const result = train.data

  const apply = useApiMutation((input: { botId: string; params: Record<string, ParamValue> }) => patchBot(input.botId, { params: input.params }), ['bot', 'bots'], {
    onSuccess: () => toast('Best settings applied to the bot — its event stream records the change'),
  })

  function submit() {
    const vary = knobs
      .filter((knob) => knob.key)
      .map((knob) => ({ key: knob.key, from: Number(knob.from), to: Number(knob.to), steps: Number(knob.steps) }))
    train.mutate({
      // Uploaded rules trade a chosen market like any strategy: market,
      // timeframe and starting capital travel along with the rules payload
      // (the optimizer validates all three for every non-bot source).
      ...(botId
        ? { botId }
        : customId
          ? { strategyKey: 'custom', rules: customRules, symbol, timeframe, capital: Number(capital) }
          : { strategyKey, symbol, timeframe, capital: Number(capital) }),
      days,
      objective,
      vary,
    })
  }

  const gridRuns = knobs.filter((k) => k.key).reduce((n, k) => n * Math.max(2, Number(k.steps) || 2), 1)
  // Mirror the server's cap up front — the button shouldn't promise a run
  // the optimizer will always reject.
  const gridTooBig = gridRuns > TRAIN_MAX_COMBOS

  return (
    <div className="mt-6 grid gap-3 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:items-start">
      <Card className="p-5">
        <h2 className="text-[14px] font-semibold">Training run</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Sweeps a parameter grid over the stored history: <span className="font-medium text-fg">70% train</span> to fit,
          <span className="font-medium text-fg"> 30% hold-out test</span> to prove it generalizes. In-memory — no simulation pot spent.
        </p>

        <div className="mt-4 grid gap-3">
          <Field label="Train from">
            <TSelect
              value={botId || customId}
              onChange={(e) => {
                const value = e.target.value
                if (value.startsWith('custom:')) {
                  setCustomId(value.slice('custom:'.length))
                  setBotId('')
                } else {
                  setBotId(value)
                  setCustomId('')
                }
              }}
            >
              <option value="">New config — pick a strategy below</option>
              {(customList?.items ?? []).length > 0 && (
                <optgroup label="Uploaded strategies">
                  {(customList?.items ?? []).map((s) => (
                    <option key={s.id} value={`custom:${s.id}`}>
                      {s.name} · v{s.version}
                    </option>
                  ))}
                </optgroup>
              )}
              {(botList?.items ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · {b.strategyName}
                </option>
              ))}
            </TSelect>
          </Field>

          {bot ? (
            <div className="rounded-card border border-line bg-bg/60 p-3 text-[12.5px] text-muted">
              <p className="font-medium text-fg">{bot.name}</p>
              <p className="mt-1">
                {bot.strategyName} · {bot.symbols.join(', ')} · {bot.timeframe} · {money(bot.capital)}
              </p>
              {bot.strategyKey === 'custom' && (
                <p className="mt-1.5 text-muted">Uploaded rules — every threshold below sweeps like any parameter; Apply writes the tuned rules back.</p>
              )}
            </div>
          ) : (
            <>
              {!customId && (
                <Field label="Strategy">
                  <TSelect value={strategyKey} onChange={(e) => setStrategyKey(e.target.value)}>
                    {(catalog?.strategies ?? []).map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.name}
                      </option>
                    ))}
                  </TSelect>
                </Field>
              )}
              {customId && (
                <div className="rounded-card border border-line bg-bg/60 p-3 text-[12.5px] text-muted">
                  <p className="font-medium text-fg">{customDetail?.strategy.name ?? 'Uploaded strategy'} · v{customDetail?.strategy.version ?? '…'}</p>
                  <p className="mt-1">Uploaded rules — thresholds below sweep like any parameter.</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Symbol">
                  <TSelect value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                    {(catalog?.symbols ?? []).map((meta) => (
                      <option key={meta.symbol} value={meta.symbol}>
                        {meta.symbol}
                      </option>
                    ))}
                  </TSelect>
                </Field>
                <Field label="Timeframe">
                  <TSelect value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
                    {(customId ? TIMEFRAMES.map((t) => t.key) : (strategy?.timeframes ?? [])).map((tf) => (
                      <option key={tf} value={tf}>
                        {tf}
                      </option>
                    ))}
                  </TSelect>
                </Field>
                <Field label="Capital">
                  <span className="relative block">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13.5px] text-faint">$</span>
                    <TInput type="number" min={100} step={100} className="pl-7" value={capital} onChange={(e) => setCapital(e.target.value)} />
                  </span>
                </Field>
              </div>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Optimize for">
              <TSelect value={objective} onChange={(e) => setObjective(e.target.value as 'sharpe' | 'return')}>
                <option value="sharpe">Sharpe (risk-adjusted)</option>
                <option value="return">Total return</option>
              </TSelect>
            </Field>
            <Field label="History window" hint="of 5 stored years">
              <TSelect value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
                {DAYS_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </TSelect>
            </Field>
          </div>

          {/* Parameter sweep: 1–2 knobs — catalog params or uploaded-rule thresholds. */}
          <div className="grid gap-2">
            <span className="text-[13px] font-medium text-fg">Parameters to sweep</span>
              {knobs.map((knob, index) => (
                <div key={index} className="grid grid-cols-[minmax(0,1.4fr)_1fr_1fr_64px_28px] items-end gap-1.5">
                  <Field label={`Knob ${index + 1}`}>
                    <TSelect value={knob.key} onChange={(e) => setKnobs(knobs.map((k, i) => (i === index ? { ...k, key: e.target.value } : k)))}>
                      <option value="">—</option>
                      {numericParams.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </TSelect>
                  </Field>
                  <Field label="From">
                    <TInput type="number" value={knob.from} onChange={(e) => setKnobs(knobs.map((k, i) => (i === index ? { ...k, from: e.target.value } : k)))} />
                  </Field>
                  <Field label="To">
                    <TInput type="number" value={knob.to} onChange={(e) => setKnobs(knobs.map((k, i) => (i === index ? { ...k, to: e.target.value } : k)))} />
                  </Field>
                  <Field label="Steps">
                    <TInput type="number" min={2} max={6} value={knob.steps} onChange={(e) => setKnobs(knobs.map((k, i) => (i === index ? { ...k, steps: e.target.value } : k)))} />
                  </Field>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove knob ${index + 1}`}
                    className="mb-0.5"
                    disabled={knobs.length < 2}
                    onClick={() => setKnobs(knobs.filter((_, i) => i !== index))}
                  >
                    ×
                  </Button>
                </div>
              ))}
              {knobs.length < 2 && numericParams.length > 0 && (
                <Button
                  size="sm"
                  className="justify-self-start"
                  onClick={() => {
                    const used = new Set(knobs.map((k) => k.key))
                    const next = numericParams.find((p) => !used.has(p.key))
                    if (!next) return
                    const def = Number(next.default)
                    setKnobs([...knobs, { key: next.key, from: String(next.min ?? def * 0.5), to: String(next.max ?? def * 1.5), steps: '3' }])
                  }}
                >
                  + Add second parameter
                </Button>
              )}
              {numericParams.length === 0 && (
                <p className="text-[12.5px] text-warning">
                  {customId && !customDetail ? 'Loading uploaded rules…' : 'This strategy has no numeric parameters to sweep.'}
                </p>
              )}
            </div>

          <Button
            variant="primary"
            loading={train.isPending}
            disabled={
              gridTooBig ||
              knobs.filter((k) => k.key).length === 0 ||
              (!botId && (!customId ? !strategyKey || !symbol : !symbol || !customRules))
            }
            onClick={submit}
          >
            <Sparkles />
            Train {gridRuns} run{gridRuns === 1 ? '' : 's'}
          </Button>
          {gridTooBig && (
            <p className="text-[12.5px] text-warning">
              A grid of {gridRuns} runs exceeds the {TRAIN_MAX_COMBOS}-run cap — use fewer steps or one parameter.
            </p>
          )}
          {train.error && <p className="text-[13px] text-danger">{train.error.message}</p>}
          {!result && !train.isPending && (
            <p className="text-[12px] leading-relaxed text-faint">
              Each run trains on the first 70% of the window and is scored on the untouched last 30% — the test column is what
              would have happened out of sample.
            </p>
          )}
        </div>
      </Card>

      <div className="grid gap-3">
        {train.isPending && !result && (
          <Card className="grid gap-3 p-5">
            <Skeleton className="h-5 w-2/3 rounded" />
            <Skeleton className="h-40 rounded-tile" />
            <p className="text-[13px] text-muted">Replaying stored history for every combination…</p>
          </Card>
        )}
        {result && (
          <OptimizerResults
            result={result}
            onApply={botId ? (params) => apply.mutate({ botId, params }) : undefined}
            applying={apply.isPending}
            applyError={apply.error?.message}
          />
        )}
        {!result && !train.isPending && (
          <Card className="grid place-items-center gap-2 p-10 text-center">
            <GraduationCap className="size-8 text-faint" />
            <p className="text-[14px] font-medium">No training run yet</p>
            <p className="max-w-[420px] text-[13px] text-muted">
              Pick a strategy (or an existing bot), choose parameters to sweep, and train against the last five years of stored
              market data. The best combination comes back with its equity curve and hold-out score.
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}

const scoreOf = (row: OptimizeRunRow, objective: 'sharpe' | 'return') => (objective === 'sharpe' ? row.train.sharpe : row.train.totalReturn)
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

function OptimizerResults({
  result,
  onApply,
  applying,
  applyError,
}: {
  result: OptimizeResult
  onApply?: (params: Record<string, ParamValue>) => void
  applying: boolean
  applyError?: string
}) {
  const ranked = result.runs
    .map((row, index) => ({ row, index }))
    .sort((a, b) => scoreOf(b.row, result.objective) - scoreOf(a.row, result.objective))
  const paramString = (row: OptimizeRunRow) =>
    result.knobs
      .map((knob) => {
        const value = row.params[knob.key]
        const shown = typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value ?? '—')
        return `${knob.label} ${shown}${knob.unit ? ` ${knob.unit}` : ''}`
      })
      .join(' · ')

  const best = result.runs[result.bestIndex]
  const splitDate = shortDate(result.source.split)

  // Test-slice return per run: the honest out-of-sample number.
  const testChart = ranked.map(({ row, index }) => ({
    label: `#${index + 1}`,
    value: (row.test ?? row.train).totalReturn,
    note: String(row.params[result.knobs[0]?.key ?? ''] ?? ''),
  }))
  const sweepText = result.knobs
    .map((knob) => `${knob.label} ${knob.values[0]}–${knob.values.at(-1)} (${knob.values.length} steps)`)
    .join(' · ')

  return (
    <>
      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold">
            {result.source.label} · {result.source.strategyName}
          </h2>
          <span className="text-[12.5px] text-faint">
            {result.source.symbol} · {result.source.timeframe} · {shortDate(result.source.from)} – {shortDate(result.source.to)} ·
            split {splitDate} · {result.history.years}y stored history
          </span>
        </div>
        <p className="mt-1 text-[12.5px] text-muted">
          Ranked by {result.objective === 'sharpe' ? 'train Sharpe' : 'train return'} · {result.runs.length} combinations ·
          each trained on the first 70% and tested on the untouched last 30%.
        </p>

        <div className="mt-4 overflow-x-auto rounded-card border border-line">
          <table className="w-full min-w-[720px] table-fixed text-left text-[13px]">
            <thead>
              <tr className="h-9 border-b border-line bg-bg/60 text-[12px] text-muted">
                <th scope="col" className="w-[6%] px-3 font-medium">#</th>
                <th scope="col" className="w-[30%] px-3 font-medium">Parameters</th>
                <th scope="col" className="w-[16%] px-3 text-right font-medium">Train return</th>
                <th scope="col" className="w-[12%] px-3 text-right font-medium">Train Sharpe</th>
                <th scope="col" className="w-[16%] px-3 text-right font-medium">Test return</th>
                <th scope="col" className="w-[12%] px-3 text-right font-medium">Test Sharpe</th>
                <th scope="col" className="w-[8%] px-3 text-right font-medium">Test DD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ranked.map(({ row, index }, rank) => (
                <tr key={index} className={cx('h-11', index === result.bestIndex && 'bg-accent-soft/40')}>
                  <td className="px-3 tabular-nums text-muted">
                    {rank + 1}
                    {rank === 0 && <Badge tone="accent" className="ml-1.5 h-5">best</Badge>}
                  </td>
                  <td className="truncate px-3">{row.error ? <span className="text-danger">{row.error}</span> : paramString(row)}</td>
                  <td className={cx('px-3 text-right tabular-nums', row.train.totalReturn >= 0 ? 'text-success' : 'text-danger')}>
                    {pct(row.train.totalReturn)}
                  </td>
                  <td className="px-3 text-right tabular-nums text-muted">{row.train.sharpe.toFixed(2)}</td>
                  <td className={cx('px-3 text-right tabular-nums', row.test ? (row.test.totalReturn >= 0 ? 'text-success' : 'text-danger') : 'text-faint')}>
                    {row.test ? pct(row.test.totalReturn) : '—'}
                  </td>
                  <td className="px-3 text-right tabular-nums text-muted">{row.test ? row.test.sharpe.toFixed(2) : '—'}</td>
                  <td className="px-3 text-right tabular-nums text-muted">{row.test ? `-${row.test.maxDrawdown.toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-faint">Sweep: {sweepText}</p>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Hold-out test return per combination</h2>
          <span className="text-[12.5px] text-faint">last 30% of the window · higher is better</span>
        </div>
        <div className="mt-3">
          {testChart.length > 0 ? (
            // Returns arrive as percent values, not dollars — the axis and
            // hover must say "−1.5%", not "−$1.50".
            <BarChart data={testChart} height={150} format={pct} />
          ) : (
            <p className="py-4 text-center text-[13px] text-muted">No runs to chart</p>
          )}
        </div>
      </Card>

      {best && !best.error && result.best && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold">Best configuration — full-window replay</h2>
            <div className="flex items-center gap-2">
              {result.best.accuracy.rating && (
                <Badge tone={result.best.accuracy.rating === 'edge' ? 'success' : result.best.accuracy.rating === 'coin-flip' ? 'warning' : 'neutral'}>
                  accuracy {result.best.accuracy.directionalAccuracy?.toFixed(0) ?? '—'}% · {result.best.accuracy.rating}
                </Badge>
              )}
              {onApply && (
                <Button size="sm" variant="primary" loading={applying} onClick={() => onApply(best.params)}>
                  <Rocket />
                  Apply to bot
                </Button>
              )}
            </div>
          </div>
          {applyError && <p className="mt-2 text-[13px] text-danger">{applyError}</p>}
          <p className="mt-1 text-[12.5px] text-muted">{paramString(best)}</p>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              { label: 'Total return', value: pct(result.best.metrics.totalReturn) },
              { label: 'Final equity', value: money(result.best.metrics.finalEquity) },
              { label: 'Max drawdown', value: `-${result.best.metrics.maxDrawdown.toFixed(1)}%` },
              { label: 'Sharpe', value: result.best.metrics.sharpe.toFixed(2) },
              { label: 'Win rate', value: `${result.best.metrics.winRate.toFixed(0)}%` },
            ].map((card) => (
              <div key={card.label} className="rounded-card border border-line p-3">
                <p className="text-[12px] text-muted">{card.label}</p>
                <p className="mt-0.5 text-[16px] font-semibold tabular-nums">{card.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[13.5px] font-semibold">Equity curve</h3>
              <span className="text-[12px] text-faint">
                {result.best.curve.length} points · {shortDate(result.source.from)} – {shortDate(result.source.to)}
              </span>
            </div>
            <div className="mt-2">
              {result.best.curve.length > 1 ? (
                <AreaChart
                  data={result.best.curve.map((point) => ({ label: shortDate(point.t), value: point.value }))}
                  height={170}
                />
              ) : (
                <p className="py-4 text-center text-[13px] text-muted">No curve recorded</p>
              )}
            </div>
          </div>
        </Card>
      )}
    </>
  )
}
