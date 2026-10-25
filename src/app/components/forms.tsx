import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { TIMEFRAMES, type ParamDef, type ParamValue, type Strategy, type Timeframe } from '../../shared/types'
import { createConnection, launchBot, runBacktest, useApiMutation, useConnections, useStrategies, type BacktestInput, type LaunchInput } from '../lib/api'
import { Button, Checkbox, Dialog, Field, Input, Select, useFieldId, useToast } from './ui'

// Forms built from the strategy param schema, so the catalog, the launch
// wizard and the backtester never disagree about what a strategy takes.

function FieldInput(props: React.ComponentPropsWithoutRef<typeof Input>) {
  const id = useFieldId()
  return <Input id={id} {...props} />
}
function FieldSelect(props: React.ComponentPropsWithoutRef<typeof Select>) {
  const id = useFieldId()
  return <Select id={id} {...props} />
}
function FieldCheck(props: React.ComponentPropsWithoutRef<typeof Checkbox>) {
  const id = useFieldId()
  return <Checkbox id={id} {...props} />
}

export function paramDefaults(strategy: Strategy): Record<string, ParamValue> {
  return Object.fromEntries(strategy.params.map((p) => [p.key, p.default]))
}

export function ParamFields({
  params,
  defs,
  onChange,
}: {
  params: Record<string, ParamValue>
  defs: ParamDef[]
  onChange: (next: Record<string, ParamValue>) => void
}) {
  if (defs.length === 0) return null
  return (
    <div className="grid gap-3">
      <p className="text-[13px] font-medium">Parameters</p>
      <div className="grid grid-cols-2 gap-3">
        {defs.map((def) => (
          <Field key={def.key} label={def.label} hint={def.hint} className={def.type === 'boolean' ? 'col-span-2' : undefined}>
            {def.type === 'select' ? (
              <FieldSelect value={String(params[def.key] ?? def.default)} onChange={(e) => onChange({ ...params, [def.key]: e.target.value })}>
                {def.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </FieldSelect>
            ) : def.type === 'boolean' ? (
              <FieldCheck
                checked={Boolean(params[def.key] ?? def.default)}
                onChange={(e) => onChange({ ...params, [def.key]: e.target.checked })}
              />
            ) : (
              <span className="relative block">
                <FieldInput
                  type="number"
                  min={def.min}
                  max={def.max}
                  step={def.step ?? 'any'}
                  className={def.unit ? 'pr-14' : undefined}
                  value={String(params[def.key] ?? def.default)}
                  onChange={(e) => onChange({ ...params, [def.key]: e.target.value === '' ? '' : Number(e.target.value) })}
                />
                {def.unit && (
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-faint">{def.unit}</span>
                )}
              </span>
            )}
          </Field>
        ))}
      </div>
    </div>
  )
}

function SymbolPicker({ symbols, value, onChange }: { symbols: string[]; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[13px] font-medium text-fg">Symbols</span>
      <div className="flex flex-wrap gap-1.5">
        {symbols.map((symbol) => {
          const active = value.includes(symbol)
          return (
            <button
              key={symbol}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(active ? value.filter((s) => s !== symbol) : [...value, symbol])}
              className={
                active
                  ? 'h-8 rounded-tile bg-fg px-3 text-[12.5px] font-medium text-white'
                  : 'h-8 rounded-tile border border-line-strong bg-surface px-3 text-[12.5px] text-muted transition-colors hover:text-fg'
              }
            >
              {symbol}
            </button>
          )
        })}
      </div>
      <span className="text-[12px] text-faint">Pick up to six.</span>
    </div>
  )
}

export function LaunchWizard({
  open,
  onClose,
  strategyKey,
}: {
  open: boolean
  onClose: () => void
  strategyKey: string | null
}) {
  const toast = useToast()
  const navigate = useNavigate()
  const { data: catalog } = useStrategies()
  const { data: connections } = useConnections()
  const strategy = catalog?.strategies.find((s) => s.key === strategyKey)
  const catalogKey = catalog ? `${strategyKey}:${catalog.symbols.join(',')}` : ''
  const connectionIds = (connections?.items ?? []).map((c) => c.id).join(',')

  const [name, setName] = useState('')
  const [symbols, setSymbols] = useState<string[]>([])
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [capital, setCapital] = useState('10000')
  const [riskPct, setRiskPct] = useState('25')
  const [mode, setMode] = useState<'paper' | 'live'>('paper')
  const [connectionId, setConnectionId] = useState('')
  const [params, setParams] = useState<Record<string, ParamValue>>({})

  useEffect(() => {
    if (!open || !strategy) return
    setParams(paramDefaults(strategy))
    setTimeframe(strategy.timeframes[Math.floor(strategy.timeframes.length / 2)])
    setSymbols(catalog?.symbols.slice(0, 1) ?? [])
    setName('')
    setMode('paper')
    setConnectionId(connections?.items[0]?.id ?? '')
    setCapital('10000')
    setRiskPct('25')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalogKey, connectionIds])

  const launch = useApiMutation((input: LaunchInput) => launchBot(input), ['bots', 'bot', 'dashboard', 'search'], {
      onSuccess: (result) => {
        toast('Bot launched')
        onClose()
        navigate(`/bots/${result.bot.id}`)
      },
    },
  )

  if (!strategy) return null
  const usableConnections = connections?.items ?? []

  function submit(e: FormEvent) {
    e.preventDefault()
    launch.mutate({
      strategyKey: strategy!.key,
      name: name.trim() || undefined,
      symbols,
      timeframe,
      params,
      capital: Number(capital),
      riskPct: Number(riskPct),
      mode,
      connectionId: mode === 'live' ? connectionId || null : null,
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      title={`Launch ${strategy.name}`}
      description={strategy.summary}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="launch-form" loading={launch.isPending}>
            Launch bot
          </Button>
        </>
      }
    >
      <form id="launch-form" onSubmit={submit} className="grid gap-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bot name" hint="Defaults to strategy + symbols">
            <FieldInput value={name} onChange={(e) => setName(e.target.value)} placeholder={`${strategy.name} · BTC-USD`} maxLength={90} />
          </Field>
          <Field label="Starting capital">
            <span className="relative block">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13.5px] text-faint">$</span>
              <FieldInput type="number" min={100} step={100} className="pl-7" value={capital} onChange={(e) => setCapital(e.target.value)} />
            </span>
          </Field>
        </div>

        <SymbolPicker symbols={catalog?.symbols ?? []} value={symbols} onChange={setSymbols} />

        <div className="grid grid-cols-3 gap-3">
          <Field label="Timeframe">
            <FieldSelect value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
              {TIMEFRAMES.filter((tf) => strategy.timeframes.includes(tf.key)).map((tf) => (
                <option key={tf.key} value={tf.key}>
                  {tf.label}
                </option>
              ))}
            </FieldSelect>
          </Field>
          <Field label="Risk per entry" hint="% of equity">
            <FieldInput type="number" min={1} max={100} step={1} value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
          </Field>
          <Field label="Mode">
            <FieldSelect value={mode} onChange={(e) => setMode(e.target.value as 'paper' | 'live')}>
              <option value="paper">Paper</option>
              <option value="live">Live</option>
            </FieldSelect>
          </Field>
        </div>

        {mode === 'live' && (
          <Field label="Exchange connection" hint="Live order routing has no adapter in v1 — the bot will pause on its first fill.">
            <FieldSelect value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">{usableConnections.length ? 'Select a connection…' : 'No connections yet'}</option>
              {usableConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name} · {connection.exchange}
                </option>
              ))}
            </FieldSelect>
          </Field>
        )}

        <ParamFields params={params} defs={strategy.params} onChange={setParams} />

        {launch.error && <p className="text-[13px] text-danger">{launch.error.message}</p>}
      </form>
    </Dialog>
  )
}

const PERIODS = [
  { days: 3, label: '3 days' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' },
]

export function BacktestDialog({ open, onClose, strategyKey }: { open: boolean; onClose: () => void; strategyKey: string | null }) {
  const toast = useToast()
  const navigate = useNavigate()
  const { data: catalog } = useStrategies()
  const [picked, setPicked] = useState('')
  const activeKey = strategyKey ?? picked
  const strategy = catalog?.strategies.find((s) => s.key === activeKey)
  const catalogKey = catalog ? `${activeKey}:${catalog.symbols.join(',')}` : ''

  useEffect(() => {
    if (open && catalog && !strategyKey && !picked) setPicked(catalog.strategies[0]?.key ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog, strategyKey])

  const [symbol, setSymbol] = useState('')
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [capital, setCapital] = useState('10000')
  const [days, setDays] = useState(30)
  const [params, setParams] = useState<Record<string, ParamValue>>({})

  useEffect(() => {
    if (!open || !strategy) return
    setParams(paramDefaults(strategy))
    setTimeframe(strategy.timeframes[Math.floor(strategy.timeframes.length / 2)])
    setSymbol(catalog?.symbols[0] ?? '')
    setCapital('10000')
    setDays(strategy.timeframes[0] === '1m' || strategy.timeframes[0] === '5m' ? 7 : 30)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalogKey])

  const run = useApiMutation((input: BacktestInput) => runBacktest(input), ['backtests'], {
    onSuccess: (result) => {
      toast('Backtest complete')
      onClose()
      navigate(`/backtests?id=${result.backtest.id}`)
    },
  })

  if (!catalog) return null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!strategy) return
    run.mutate({ strategyKey: strategy.key, symbol, timeframe, capital: Number(capital), days, params })
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
          <Field label="Strategy">
            <FieldSelect value={activeKey} onChange={(e) => setPicked(e.target.value)}>
              {catalog.strategies.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </FieldSelect>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Symbol">
            <FieldSelect value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {(catalog?.symbols ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
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
          <Field label="Starting capital">
            <span className="relative block">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13.5px] text-faint">$</span>
              <FieldInput type="number" min={100} step={100} className="pl-7" value={capital} onChange={(e) => setCapital(e.target.value)} />
            </span>
          </Field>
          <Field label="Period">
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

export function ConnectionForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const { data: catalog } = useConnections()
  const [form, setForm] = useState({ name: '', exchange: 'Alpaca', apiKey: '', apiSecret: '', mode: 'paper' as 'paper' | 'live' })

  useEffect(() => {
    if (open) setForm({ name: '', exchange: catalog?.exchanges[1] ?? 'Alpaca', apiKey: '', apiSecret: '', mode: 'paper' })
  }, [open, catalog])

  const save = useApiMutation((input: typeof form) => createConnection(input), ['connections'], {
    onSuccess: () => {
      toast('Connection saved')
      onClose()
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    save.mutate(form)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add exchange connection"
      description="Credentials are stored per workspace, masked after save, and never returned by the API."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="connection-form" loading={save.isPending}>
            Save connection
          </Button>
        </>
      }
    >
      <form id="connection-form" onSubmit={submit} className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <FieldInput required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Alpaca paper account" />
          </Field>
          <Field label="Exchange">
            <FieldSelect value={form.exchange} onChange={(e) => setForm({ ...form, exchange: e.target.value })}>
              {(catalog?.exchanges ?? ['Alpaca']).map((exchange) => (
                <option key={exchange} value={exchange}>
                  {exchange}
                </option>
              ))}
            </FieldSelect>
          </Field>
        </div>
        <Field label="API key">
          <FieldInput required autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
        </Field>
        <Field label="API secret">
          <FieldInput required type="password" autoComplete="new-password" value={form.apiSecret} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} />
        </Field>
        <Field label="Default mode" hint="v1 executes in paper mode only — no live adapter is wired up yet.">
          <FieldSelect value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'paper' | 'live' })}>
            <option value="paper">Paper</option>
            <option value="live">Live</option>
          </FieldSelect>
        </Field>
        {save.error && <p className="text-[13px] text-danger">{save.error.message}</p>}
      </form>
    </Dialog>
  )
}
