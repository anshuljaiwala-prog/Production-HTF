import { Upload } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { TIMEFRAMES, type ParamDef, type ParamValue, type Strategy, type Timeframe } from '../../shared/types'
import { createConnection, importBots, launchBot, runBacktest, useApiMutation, useConnections, useStrategies, type BacktestInput, type LaunchInput } from '../lib/api'
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, useFieldId, useToast } from './ui'

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
                  ? 'h-8 rounded-tile bg-fg px-3 text-[12.5px] font-medium text-bg'
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
      connectionId: connectionId || null,
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
    _valid: false,
  }
}

/** Validate one normalized row against the catalog (what the server would
 * accept) so the preview marks problems before anything is sent. */
function validateRow(row: ImportedRow, catalog: { strategies: Strategy[] } | undefined): ImportedRow {
  const strategy = catalog?.strategies.find((s) => s.key === row.strategyKey)
  if (!strategy) return { ...row, _valid: false, _problem: `Unknown strategy "${row.strategyKey}"` }
  if (row.symbols.length === 0) return { ...row, _valid: false, _problem: 'No symbols' }
  if (!row.timeframe || !strategy.timeframes.includes(row.timeframe)) {
    return { ...row, _valid: false, _problem: `Timeframe ${row.timeframe ?? '—'} unsupported for ${strategy.name}` }
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
