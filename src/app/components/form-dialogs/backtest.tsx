import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { TIMEFRAMES, type ParamValue, type Timeframe } from '../../../shared/types'
import { capture } from '../../lib/analytics'
import { runBacktest, useApiMutation, useBacktests, useBots, useCustomStrategy, useCustomStrategies, useStrategies, type BacktestInput } from '../../lib/api'
import { Button, Dialog, Field, useToast } from '../ui'
import { customStrategyView, FieldInput, FieldSelect, paramDefaults, ParamFields } from '../form-fields'

const PERIODS = [
  { days: 3, label: '3 days' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' },
]

export function BacktestDialog({
  open,
  onClose,
  strategyKey,
  customId = null,
}: {
  open: boolean
  onClose: () => void
  strategyKey: string | null
  /** Set when backtesting an uploaded rules strategy (`custom:<id>`). */
  customId?: string | null
}) {
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const { data: catalog } = useStrategies()
  const { data: botList } = useBots()
  const { data: backtestList } = useBacktests()
  const customList = useCustomStrategies().data?.items ?? []
  const [picked, setPicked] = useState('')
  const [botId, setBotId] = useState('')
  // A chosen bot drives the strategy too — its own strategyKey wins.
  const bot = botList?.items.find((b) => b.id === botId)
  const activeKey = strategyKey === 'custom' && customId ? `custom:${customId}` : strategyKey ?? (bot ? bot.strategyKey : picked)
  // Active strategy resolution: an uploaded custom strategy id wins, then
  // the preselected key, then the chosen bot's stored strategy.
  const customEntry = activeKey.startsWith('custom:') ? activeKey.slice('custom:'.length) : null
  const custom = useCustomStrategy(customEntry ?? undefined)
  // A picked bot running uploaded rules carries its own copy of the rules
  // blob — replay those verbatim, so imported / custom bots backtest as-is.
  let botRules: Record<string, unknown> | null = null
  if (bot && bot.strategyKey === 'custom' && typeof bot.params.rules === 'string') {
    try {
      const parsed = JSON.parse(bot.params.rules) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') botRules = parsed
    } catch {
      /* rules blob unreadable — fall through to the catalog lookup */
    }
  }
  const strategy = customEntry
    ? custom?.data
      ? customStrategyView(customEntry, custom.data)
      : null
    : botRules
      ? customStrategyView('from-bot', {
          strategy: {
            id: 'from-bot',
            name: typeof botRules.name === 'string' ? botRules.name : `${bot?.name ?? 'Bot'} rules`,
            lookback: Number((botRules.entry as { n?: number }[] | undefined)?.[0]?.n ?? 64) || 64,
            createdAt: 0,
            rules: (Array.isArray(botRules.entry) ? botRules.entry.length : 0) + (Array.isArray(botRules.exit) ? botRules.exit.length : 0),
            version: 1,
            versions: 1,
          },
          rules: botRules,
        })
      : catalog?.strategies.find((s) => s.key === activeKey)
  const catalogKey = catalog && !customEntry ? `${activeKey}:${catalog.symbols.map((s) => s.symbol).join(',')}` : ''

  useEffect(() => {
    if (open && catalog && !strategyKey && !picked) setPicked(catalog.strategies[0]?.key ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog, strategyKey])

  const [symbol, setSymbol] = useState('')
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [capital, setCapital] = useState('10000')
  const [days, setDays] = useState(30)
  const [params, setParams] = useState<Record<string, ParamValue>>({})

  /** Form defaults: from the picked bot when one is chosen — market,
   * timeframe, params and capital all come off the bot's real config — or
   * strategy defaults otherwise. */
  useEffect(() => {
    if (!open || !strategy) return
    const bot = botList?.items.find((b) => b.id === botId)
    const botMatches = Boolean(bot && (bot.strategyKey === strategy.key || (bot.strategyKey === 'custom' && strategy.key.startsWith('custom:'))))
    const tf =
      bot && botMatches && strategy.timeframes.includes(bot.timeframe)
        ? bot.timeframe
        : strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]
    if (bot && botMatches) {
      setParams({ ...paramDefaults(strategy), ...bot.params })
      setSymbol(bot.symbols[0] ?? catalog?.symbols[0]?.symbol ?? '')
      setCapital(String(bot.capital))
    } else {
      setParams(paramDefaults(strategy))
      setSymbol(catalog?.symbols[0]?.symbol ?? '')
      setCapital('10000')
    }
    setTimeframe(tf)
    // Default period must cover the strategy's lookback: daily bars need a
    // year, 4-hour bars a quarter, faster bars a month; under it the engine
    // refuses with "not enough history".
    setDays(tf === '1d' ? 365 : tf === '4h' ? 90 : tf === '1m' || tf === '5m' ? 7 : 30)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalogKey, botId])

  const run = useApiMutation((input: BacktestInput) => runBacktest(input), ['backtests'], {
    onSuccess: (result) => {
      // Feature adoption: does a launched strategy get validated first?
      capture('backtest_run', {
        strategy: result.backtest.strategyKey,
        symbol: result.backtest.symbol,
        timeframe: result.backtest.timeframe,
        accuracy: result.backtest.accuracy?.directionalAccuracy ?? null,
      })
      toast('Backtest complete')
      onClose()
      // Land on the Backtests tab of whichever page launched the run.
      const home = location.pathname.startsWith('/training') ? '/training' : '/strategies'
      navigate(`${home}?tab=backtests&id=${result.backtest.id}`)
    },
  })

  if (!catalog) return null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!strategy) return
    const rules = customEntry ? custom?.data?.rules : botRules ?? undefined
    run.mutate({
      strategyKey: rules ? 'custom' : strategy.key,
      symbol,
      timeframe,
      capital: Number(capital),
      days,
      params,
      ...(rules ? { rules } : {}),
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={600}
      title={`Backtest ${strategy?.name ?? 'a strategy'}`}
      description="Replays the strategy over the simulated feed — identical inputs always produce identical results."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="backtest-form" loading={run.isPending} disabled={!strategy}>
            Run backtest
          </Button>
        </>
      }
    >
      <form id="backtest-form" onSubmit={submit} className="grid gap-5">
        {!strategyKey && (
          <Field label="Start from a bot" hint="Prefills the market, timeframe, params and capital from an uploaded bot; everything stays editable.">
            <FieldSelect value={botId} onChange={(e) => setBotId(e.target.value)}>
              <option value="">Blank — strategy defaults below</option>
              {(botList?.items ?? []).map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name} · {bot.strategyName} · {bot.symbols.join(', ')}
                </option>
              ))}
            </FieldSelect>
          </Field>
        )}
        {!strategyKey && !botId && (
          <Field label="Strategy">
            <FieldSelect value={activeKey} onChange={(e) => setPicked(e.target.value)}>
              {catalog.strategies.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
              {customList.length > 0 && (
                <optgroup label="Uploaded rules strategies (in-memory)">
                  {customList.map((entry) => (
                    <option key={entry.id} value={`custom:${entry.id}`}>
                      {entry.name} · {entry.rules} rules · lookback {entry.lookback}
                    </option>
                  ))}
                </optgroup>
              )}
            </FieldSelect>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Symbol">
            <FieldSelect value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {(catalog?.symbols ?? []).map((meta) => (
                <option key={meta.symbol} value={meta.symbol}>
                  {meta.symbol}
                </option>
              ))}
            </FieldSelect>
          </Field>
          <Field label="Timeframe">
            <FieldSelect value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
              {TIMEFRAMES.filter((tf) => strategy?.timeframes.includes(tf.key)).map((tf) => (
                <option key={tf.key} value={tf.key}>
                  {tf.label}
                </option>
              ))}
            </FieldSelect>
          </Field>
          <Field
            label="Starting capital"
            hint={
              backtestList?.sim
                ? `sim-only money · ${backtestList.sim.available.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} free of the 1M pot`
                : 'sim-only money — never workspace funding'
            }
          >
            <span className="relative block">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13.5px] text-faint">$</span>
              <FieldInput type="number" min={100} step={100} className="pl-7" value={capital} onChange={(e) => setCapital(e.target.value)} />
            </span>
          </Field>
          <Field label="Period" hint="Replays the platform's stored history — the last 5 years per market.">
            <FieldSelect value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {PERIODS.map((period) => (
                <option key={period.days} value={period.days}>
                  Last {period.label}
                </option>
              ))}
            </FieldSelect>
          </Field>
        </div>

        {strategy && <ParamFields params={params} defs={strategy.params} onChange={setParams} />}

        {run.error && <p className="text-[13px] text-danger">{run.error.message}</p>}
      </form>
    </Dialog>
  )
}

