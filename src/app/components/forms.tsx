import { Upload } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { ASSET_CLASSES, TIMEFRAMES, type CustomStrategySummary, type ParamDef, type ParamValue, type Strategy, type SymbolMeta, type Timeframe } from '../../shared/types'
import { createConnection, importBots, launchBot, runBacktest, uploadConnections, uploadCustomStrategy, useApiMutation, useBacktests, useBots, useConnections, useCustomStrategy, useCustomStrategies, useStrategies, type BacktestInput, type LaunchInput } from '../lib/api'
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, Textarea, useFieldId, useToast } from './ui'

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

/** The Strategy shape an uploaded rules set presents in the wizards: the
 * rules themselves are the schema (no tuning params), and it can run on any
 * timeframe the feed supports. */
export function customStrategyView(id: string, detail: { strategy: CustomStrategySummary; rules: Record<string, unknown> }): Strategy {
  return {
    key: `custom:${id}`,
    name: detail.strategy.name,
    summary: `Uploaded rules · ${detail.strategy.rules} conditions · in-memory`,
    description: 'Direct JSON-payload upload held in worker memory (a restart clears it — re-upload to restore). Entry rules open a position, exit rules or stop/target close it, on standard indicators over the simulated feed.',
    risk: 'medium',
    tags: ['uploaded', 'rules DSL', `lookback ${detail.strategy.lookback}`],
    timeframes: TIMEFRAMES.map((tf) => tf.key),
    params: [],
  }
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

/** Symbol toggles grouped by asset class with a class label per group. */
export function SymbolPicker({ symbols, value, onChange }: { symbols: SymbolMeta[]; value: string[]; onChange: (next: string[]) => void }) {
  const groups = ASSET_CLASSES.map(({ key, label, hint }) => ({
    key,
    label,
    hint,
    items: symbols.filter((symbol) => symbol.kind === key),
  })).filter((group) => group.items.length > 0)
  return (
    <div className="grid gap-2">
      <span className="text-[13px] font-medium text-fg">Symbols</span>
      {groups.map((group) => (
        <div key={group.key} className="grid gap-1">
          <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint" title={group.hint}>
            {group.label}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {group.items.map(({ symbol, kind, label }) => {
              const active = value.includes(symbol)
              return (
                <button
                  key={symbol}
                  type="button"
                  aria-pressed={active}
                  title={kind === 'option' && label ? label : undefined}
                  onClick={() => onChange(active ? value.filter((s) => s !== symbol) : [...value, symbol])}
                  className={
                    active
                      ? 'h-8 rounded-tile bg-fg px-3 text-[12.5px] font-medium text-bg'
                      : 'h-8 rounded-tile border border-line-strong bg-surface px-3 text-[12.5px] text-muted transition-colors hover:text-fg'
                  }
                >
                  {symbol}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <span className="text-[12px] text-faint">Pick up to six.</span>
    </div>
  )
}

export function LaunchWizard({
  open,
  onClose,
  strategyKey,
  customId = null,
}: {
  open: boolean
  onClose: () => void
  strategyKey: string | null
  /** Set when launching an uploaded rules strategy (`custom:<id>`). */
  customId?: string | null
}) {
  const toast = useToast()
  const navigate = useNavigate()
  const { data: catalog } = useStrategies()
  const { data: connections } = useConnections()
  const [name, setName] = useState('')
  const [symbols, setSymbols] = useState<string[]>([])
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [capital, setCapital] = useState('10000')
  const [riskPct, setRiskPct] = useState('25')
  const [mode, setMode] = useState<'paper' | 'live'>('paper')
  const [connectionId, setConnectionId] = useState('')
  const [params, setParams] = useState<Record<string, ParamValue>>({})

  // Uploaded rules strategy: resolve its detail through the id, and present
  // the same Strategy shape the catalog cards use.
  const customEntry = strategyKey === 'custom' && customId ? customId : null
  const custom = useCustomStrategy(customEntry ?? undefined)
  const strategy = customEntry
    ? custom?.data
      ? customStrategyView(customEntry, custom.data)
      : null
    : catalog?.strategies.find((s) => s.key === strategyKey)
  const catalogKey = catalog && !customEntry ? `${strategyKey}:${catalog.symbols.map((s) => s.symbol).join(',')}` : ''
  const connectionIds = (connections?.items ?? []).map((c) => c.id).join(',')

  useEffect(() => {
    if (!open || !strategy) return
    setParams(paramDefaults(strategy))
    setTimeframe(strategy.timeframes[Math.floor(strategy.timeframes.length / 2)])
    setSymbols(catalog?.symbols.slice(0, 1).map((meta) => meta.symbol) ?? [])
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
    if (!strategy) return
    launch.mutate({
      strategyKey: customEntry ? 'custom' : strategy.key,
      name: name.trim() || undefined,
      symbols,
      timeframe,
      params,
      capital: Number(capital),
      riskPct: Number(riskPct),
      mode,
      connectionId: connectionId || null,
      ...(customEntry ? { rules: custom?.data?.rules } : {}),
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

        <Field
          label="Exchange connection"
          hint={
            mode === 'live'
              ? 'Live order routing has no adapter in v1 — the bot will pause on its first fill.'
              : 'Saved with the bot; routing only activates when the bot trades live.'
          }
        >
          <FieldSelect value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">{usableConnections.length ? 'None — demo venue' : 'No connections yet'}</option>
            {usableConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} · {connection.exchange}
              </option>
            ))}
          </FieldSelect>
        </Field>

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
  const strategy = customEntry
    ? custom?.data
      ? customStrategyView(customEntry, custom.data)
      : null
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
    const tf =
      bot && bot.strategyKey === strategy.key && strategy.timeframes.includes(bot.timeframe)
        ? bot.timeframe
        : strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]
    if (bot && bot.strategyKey === strategy.key) {
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
      toast('Backtest complete')
      onClose()
      navigate(`/strategies?tab=backtests&id=${result.backtest.id}`)
    },
  })

  if (!catalog) return null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!strategy) return
    run.mutate({
      strategyKey: customEntry ? 'custom' : strategy.key,
      symbol,
      timeframe,
      capital: Number(capital),
      days,
      params,
      ...(customEntry ? { rules: custom?.data?.rules } : {}),
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

// --- Bot config import -----------------------------------------------------

// A row as read from the file — deliberately looser than LaunchInput; rows
// become LaunchInputs only after passing validateRow.
interface ImportedRow {
  strategyKey: string
  name?: string
  symbols: string[]
  timeframe?: Timeframe
  params: Record<string, ParamValue>
  capital?: number
  riskPct?: number
  mode: 'paper' | 'live'
  /** Inline uploaded rules — the row runs the custom strategist with them. */
  rules?: unknown
  /** Exchange-API binding: which saved connection this bot routes through. */
  connectionId?: string | null
  _valid: boolean
  _problem?: string
}

function normalizeImportRow(raw: unknown): ImportedRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const symbols = (
    Array.isArray(row.symbols)
      ? row.symbols
      : typeof row.symbols === 'string'
        ? (row.symbols as string).split(',')
        : []
  )
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 6)
  const params =
    typeof row.params === 'object' && row.params !== null
      ? Object.fromEntries(Object.entries(row.params as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'boolean' ? v : v === '' ? v : Number.isFinite(Number(v)) ? Number(v) : String(v)]))
      : {}
  return {
    strategyKey: String(row.strategyKey ?? '').trim(),
    name: typeof row.name === 'string' ? row.name.slice(0, 90) : undefined,
    symbols,
    timeframe: typeof row.timeframe === 'string' ? (row.timeframe as Timeframe) : undefined,
    params,
    capital: Number(row.capital),
    riskPct: Number(row.riskPct) || undefined,
    mode: row.mode === 'live' ? 'live' : 'paper',
    rules: row.rules !== undefined ? row.rules : undefined,
    connectionId: typeof row.connectionId === 'string' && row.connectionId.trim() ? row.connectionId.trim() : null,
    _valid: false,
  }
}

/** Validate one normalized row against the catalog (what the server would
 * accept) so the preview marks problems before anything is sent. Rows with
 * inline `rules` run the uploaded-strategy path and skip the catalog lookup. */
function validateRow(row: ImportedRow, catalog: { strategies: Strategy[] } | undefined): ImportedRow {
  const strategy = catalog?.strategies.find((s) => s.key === row.strategyKey)
  const isCustom = row.strategyKey === 'custom' && row.rules !== undefined
  if (!strategy && !isCustom) {
    return { ...row, _valid: false, _problem: row.rules !== undefined && row.strategyKey !== 'custom' ? 'Rules rows must set strategyKey "custom"' : `Unknown strategy "${row.strategyKey}"` }
  }
  if (row.symbols.length === 0) return { ...row, _valid: false, _problem: 'No symbols' }
  const tfSupported = isCustom
    ? TIMEFRAMES.some((tf) => tf.key === row.timeframe)
    : Boolean(strategy && row.timeframe && strategy.timeframes.includes(row.timeframe))
  if (!row.timeframe || !tfSupported) {
    return { ...row, _valid: false, _problem: `Timeframe ${row.timeframe ?? '—'} unsupported` }
  }
  const capital = row.capital
  if (capital === undefined || !Number.isFinite(capital) || capital < 100) return { ...row, _valid: false, _problem: 'Capital below $100 or missing' }
  return { ...row, _valid: true }
}

export function BotImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const { data: catalog } = useStrategies()
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<ImportedRow[] | null>(null)
  const [parseError, setParseError] = useState('')
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (open) {
      setRows(null)
      setFileName('')
      setParseError('')
      setDragging(false)
    }
  }, [open])

  function ingest(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setFileName(file.name)
      try {
        const parsed: unknown = JSON.parse(String(reader.result))
        const rawItems = Array.isArray(parsed) ? parsed : (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : [])
        if (rawItems.length === 0) {
          setParseError('The file has no bot configs — expected an array of objects (or an object with an "items" array).')
          setRows(null)
          return
        }
        if (rawItems.length > 25) {
          setParseError(`${rawItems.length} configs found — only the first 25 will be imported.`)
        } else {
          setParseError('')
        }
        setRows(rawItems.slice(0, 25).map(normalizeImportRow).map((row) => row && validateRow(row, catalog)).filter((row): row is ImportedRow => row !== null))
      } catch {
        setParseError('Not valid JSON — check syntax (expected `.json` or `.txt`).')
        setRows(null)
      }
    }
    void reader.readAsText(file)
  }

  function downloadSample() {
    // Generated from the live catalog so the sample is always re-importable.
    const picks = (catalog?.strategies ?? []).slice(0, 3).map((strategy) => (
      {
        name: `${strategy.name} · sample`,
        strategyKey: strategy.key,
        symbols: (catalog?.symbols ?? []).slice(0, 1),
        timeframe: strategy.timeframes[Math.floor(strategy.timeframes.length / 2)],
        capital: 5000,
        riskPct: 20,
        mode: 'paper',
        params: paramDefaults(strategy),
      }
    ))
    const blob = new Blob([JSON.stringify({ items: picks }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'htf-bot-import-sample.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const importable = (rows ?? []).filter((row) => row._valid)
  const problems = (rows ?? []).filter((row) => !row._valid)

  const run = useApiMutation((input: LaunchInput[]) => importBots(input), ['bots', 'bot', 'dashboard', 'search', 'portfolio'], {
    onSuccess: (result) => {
      const skipped = result.failed.length
      toast(`Imported ${result.launched.length} bot${result.launched.length === 1 ? '' : 's'} (paused)${skipped ? ` · ${skipped} skipped` : ''}`)
      onClose()
    },
  })

  const asLaunchInput = (row: ImportedRow): LaunchInput => ({
    strategyKey: row.strategyKey,
    name: row.name,
    symbols: row.symbols,
    timeframe: row.timeframe as Timeframe,
    params: row.params,
    capital: row.capital as number,
    riskPct: row.riskPct ?? 25,
    mode: row.mode,
    connectionId: row.connectionId ?? null,
    ...(row.rules !== undefined ? { rules: row.rules } : {}),
  })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title="Import bots"
      description="Upload a JSON file of bot configs — valid rows launch as paper bots, paused so you can review them."
      footer={
        <>
          <Button onClick={downloadSample} type="button">Download sample</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="button"
            disabled={importable.length === 0 || run.isPending}
            loading={run.isPending}
            onClick={() => importable.length > 0 && run.mutate(importable.map(asLaunchInput))}
          >
            Import {importable.length} bot{importable.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {rows === null ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              ingest(e.dataTransfer.files?.[0])
            }}
            className={`grid place-items-center gap-1 rounded-card border border-dashed p-8 text-center transition-colors ${dragging ? 'border-accent bg-accent/5' : 'border-line-strong hover:bg-surface-2/60'}`}
          >
            <span className="grid size-10 place-items-center rounded-[12px] bg-surface-2 text-muted [&_svg]:size-5">
              <Upload />
            </span>
            <span className="mt-2 text-[13.5px] font-medium">Choose a .json file or drop it here</span>
            <span className="text-[12.5px] text-faint">
              Array of bot configs: strategyKey, symbols, capital… <button type="button" onClick={downloadSample} className="underline underline-offset-2">see the sample</button>
            </span>
          </div>
        ) : (
          <div className="rounded-card border border-line">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[12.5px]">
              <span className="truncate font-medium">{fileName}</span>
              <span className="tabular-nums text-faint">{importable.length} ready · {problems.length} problems</span>
            </div>
            <ul className="max-h-[240px] divide-y divide-line overflow-y-auto">
              {rows.map((row, index) => (
                <li key={index} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                  {row._valid ? (
                    <Badge tone="success" dot>ready</Badge>
                  ) : (
                    <Badge tone="danger" dot>{row._problem}</Badge>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {row.name ?? row.symbols.join(', ')}
                    <span className="ml-1.5 text-[12px] text-faint">
                      {row.symbols.join(', ')} · {row.timeframe ?? '?'} · {row.capital !== undefined && Number.isFinite(row.capital) ? `$${row.capital.toLocaleString('en-US')}` : '$?'} · {row.mode}
                      {row.connectionId ? ' · via saved API' : ''}
                      {row.rules !== undefined ? ' · uploaded rules' : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json,.txt,text/plain"
          className="hidden"
          aria-label="Bot config file"
          onChange={(e) => {
            ingest(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {parseError && <p className="text-[13px] text-warning">{parseError}</p>}
        {run.error && <p className="text-[13px] text-danger">{run.error.message}</p>}
      </div>
    </Dialog>
  )
}

// --- Direct JSON-payload strategy upload -----------------------------------

const RULES_SKELETON = `{
  "name": "Mean-reversion pullback",
  "entry": [
    { "metric": "rsi", "n": 14, "op": "<", "value": 30 }
  ],
  "entryLogic": "any",
  "exit": [
    { "metric": "rsi", "n": 14, "op": ">", "value": 55 }
  ],
  "exitLogic": "all",
  "stopLossPct": 3,
  "takeProfitPct": 6
}`

function ruleText(rule: unknown): string {
  const r = rule as { metric?: string; n?: number; op?: string; value?: number } | null
  if (!r || typeof r !== 'object') return String(rule)
  return `${String(r.metric ?? '?')}(${Number(r.n ?? 0)}) ${String(r.op ?? '')} ${Number(r.value ?? 0)}`
}

/** Paste a rules JSON payload, review what was recognized, then upload it to
 * the in-memory strategy store. The preview is the parsed payload — the
 * upload endpoint re-validates server-side and rejects anything malformed. */
export function UploadStrategyDialog({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean
  onClose: () => void
  onUploaded?: (id: string) => void
}) {
  const toast = useToast()
  const [payload, setPayload] = useState('')

  useEffect(() => {
    if (open) {
      setPayload('')
    }
  }, [open])

  let parseProblem = ''
  let rules: Record<string, unknown> | null = null
  const payloadTrim = payload.trim()
  if (payloadTrim) {
    try {
      const parsed = JSON.parse(payloadTrim) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rules = parsed as Record<string, unknown>
      } else {
        parseProblem = 'The payload must be a JSON object with name/entry/exit fields.'
      }
    } catch {
      parseProblem = 'Not valid JSON yet — fix the syntax to see the preview.'
    }
  }
  const entryList = Array.isArray(rules?.entry) ? (rules!.entry as unknown[]) : []
  const exitList = Array.isArray(rules?.exit) ? (rules!.exit as unknown[]) : []
  const name = typeof rules?.name === 'string' ? (rules!.name as string) : rules ? 'Unnamed strategy' : ''

  const upload = useApiMutation((rulesPayload: unknown) => uploadCustomStrategy(rulesPayload), ['custom-strategies', 'strategies'], {
    onSuccess: (result) => {
      toast(`Uploaded "${result.strategy.name}" · in-memory (${result.strategy.rules} rules, lookback ${result.strategy.lookback})`)
      onClose()
      onUploaded?.(result.strategy.id)
    },
  })

  function submit() {
    if (!rules || entryList.length === 0 || exitList.length === 0) return
    upload.mutate(rules)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title="Upload a strategy (JSON payload)"
      description="Entry/exit conditions on rsi, ema, zscore, donchian and momentum metrics. Stored in worker memory — a restart clears it, re-upload to restore."
      footer={
        <>
          <Button type="button" onClick={() => setPayload(RULES_SKELETON)}>Load a working skeleton</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="button"
            loading={upload.isPending}
            disabled={!rules || entryList.length === 0 || exitList.length === 0}
            onClick={submit}
          >
            Upload strategy
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Rules payload">
          <Textarea
            rows={10}
            spellCheck={false}
            className="font-mono text-[12.5px] leading-relaxed"
            placeholder={RULES_SKELETON}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </Field>

        {rules && !parseProblem ? (
          <div className="rounded-card border border-line">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[12.5px]">
              <span className="truncate font-medium">{name}</span>
              <span className="tabular-nums text-faint">{entryList.length} entry · {exitList.length} exit</span>
            </div>
            <ul className="divide-y divide-line px-4 py-2 text-[13px]">
              <li className="grid gap-1 py-1.5">
                <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">Enter when ({String(rules.entryLogic ?? 'all')})</span>
                {entryList.length ? entryList.map((rule, i) => <span key={i}>{ruleText(rule)}</span>) : <span className="text-warning">empty — the upload will be rejected</span>}
              </li>
              <li className="grid gap-1 py-1.5">
                <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">Exit when ({String(rules.exitLogic ?? 'all')})</span>
                {exitList.length ? exitList.map((rule, i) => <span key={i}>{ruleText(rule)}</span>) : <span className="text-warning">empty — the upload will be rejected</span>}
              </li>
              <li className="flex gap-4 py-1.5 text-[12.5px] text-muted">
                <span>Stop {Number(rules.stopLossPct ?? 0) || 'off'}{rules.stopLossPct ? '%' : ''}</span>
                <span>Target {Number(rules.takeProfitPct ?? 0) || 'off'}{rules.takeProfitPct ? '%' : ''}</span>
              </li>
            </ul>
          </div>
        ) : (
          parseProblem && <p className="text-[13px] text-warning">{parseProblem}</p>
        )}
        {upload.error && <p className="text-[13px] text-danger">{upload.error.message}</p>}
      </div>
    </Dialog>
  )
}

// --- Bulk exchange-API (connections) upload ---------------------------------

const CONNECTIONS_SKELETON = `[
  { "name": "My Alpaca paper", "exchange": "Alpaca", "apiKey": "AK123...", "apiSecret": "s3cr3t...", "mode": "paper" },
  { "name": "My Binance paper", "exchange": "Binance", "apiKey": "BNB432...", "apiSecret": "hush...", "mode": "paper" }
]`

interface ConnectionRowPreview {
  name: string
  exchange: string
  mode: 'paper' | 'live'
  problem: string | null
}

/** Paste many exchange-API credential sets from one JSON array; each row is
 * previewed with the exact problem the server would reject it for, and
 * upload validates the same way row-by-row before storing anything. */
export function BulkConnectionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [payload, setPayload] = useState('')

  useEffect(() => {
    if (open) setPayload('')
  }, [open])

  let parseProblem = ''
  let rawRows: unknown[] = []
  const payloadTrim = payload.trim()
  if (payloadTrim) {
    try {
      const parsed = JSON.parse(payloadTrim) as unknown
      const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : []
      if (list.length === 0) parseProblem = 'No rows found — expected a JSON array of connection objects.'
      else if (list.length > 20) parseProblem = `${list.length} rows — at most 20 can be uploaded at once.`
      else rawRows = list
    } catch {
      parseProblem = 'Not valid JSON yet — fix the syntax to see the preview.'
    }
  }

  const rows: ConnectionRowPreview[] = rawRows.map((raw) => {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 60) : ''
    const exchange = typeof row.exchange === 'string' && row.exchange.trim() ? row.exchange.trim() : 'Alpaca'
    const apiKey = typeof row.apiKey === 'string' ? row.apiKey.trim() : ''
    const apiSecret = typeof row.apiSecret === 'string' ? row.apiSecret.trim() : ''
    return {
      name: name || '—',
      exchange,
      mode: row.mode === 'live' ? 'live' : 'paper',
      problem: !name ? 'Missing a name.' : !apiKey || !apiSecret ? 'Missing the API key or secret.' : null,
    }
  })
  const ready = rows.filter((row) => row.problem === null).length

  const upload = useApiMutation((items: { name: string; exchange: string; apiKey: string; apiSecret: string; mode: 'paper' | 'live' }[]) => uploadConnections(items), ['connections'], {
    onSuccess: (result) => {
      const failed = result.failed.length
      toast(`${result.created.length} connection${result.created.length === 1 ? '' : 's'} saved${failed ? ` · ${failed} rejected` : ''}`)
      onClose()
    },
  })

  function submit() {
    if (ready === 0) return
    const items: { name: string; exchange: string; apiKey: string; apiSecret: string; mode: 'paper' | 'live' }[] = []
    for (const raw of rawRows) {
      const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 60) : ''
      const apiKey = typeof rec.apiKey === 'string' ? rec.apiKey.trim() : ''
      const apiSecret = typeof rec.apiSecret === 'string' ? rec.apiSecret.trim() : ''
      if (!name || !apiKey || !apiSecret) continue
      items.push({
        name,
        exchange: typeof rec.exchange === 'string' && rec.exchange.trim() ? rec.exchange.trim().slice(0, 40) : 'Alpaca',
        apiKey,
        apiSecret,
        mode: rec.mode === 'live' ? 'live' : 'paper',
      })
    }
    upload.mutate(items)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title="Upload exchange APIs (JSON)"
      description="Paste a JSON array of credential sets. Rows are validated one by one — previewed here before anything is stored."
      footer={
        <>
          <Button type="button" onClick={() => setPayload(CONNECTIONS_SKELETON)}>Load a skeleton</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="button" loading={upload.isPending} disabled={ready === 0} onClick={submit}>
            Save {ready || ''} connection{ready === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Connections payload">
          <Textarea
            rows={8}
            spellCheck={false}
            className="font-mono text-[12.5px] leading-relaxed"
            placeholder={CONNECTIONS_SKELETON}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </Field>
        {rows.length > 0 ? (
          <div className="rounded-card border border-line">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[12.5px]">
              <span className="font-medium">Preview</span>
              <span className="tabular-nums text-faint">{ready} ready · {rows.length - ready} rejected</span>
            </div>
            <ul className="max-h-[220px] divide-y divide-line overflow-y-auto">
              {rows.map((row, index) => (
                <li key={index} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                  {row.problem ? <Badge tone="danger" dot>{row.problem}</Badge> : <Badge tone="success" dot>ready {row.mode}</Badge>}
                  <span className="min-w-0 flex-1 truncate">
                    {row.name}
                    <span className="ml-1.5 text-[12px] text-faint">{row.exchange}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          parseProblem && <p className="text-[13px] text-warning">{parseProblem}</p>
        )}
        {upload.error && <p className="text-[13px] text-danger">{upload.error.message}</p>}
      </div>
    </Dialog>
  )
}
