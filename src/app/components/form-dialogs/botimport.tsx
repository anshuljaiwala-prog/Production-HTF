import { Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { TIMEFRAMES, type ParamValue, type Strategy, type Timeframe } from '../../../shared/types'
import { importBots, importBotsFromGithub, useApiMutation, useStrategies, type ImportIntent, type LaunchInput } from '../../lib/api'
import { Badge, Button, Dialog, useToast } from '../ui'
import { paramDefaults } from '../form-fields'

// --- Bot config import -----------------------------------------------------

/** Where an uploaded batch goes. All three create the bot through the same
 * launch path as a live launch; backtest/train additionally queue runs from
 * the stored config (simulation pot, never the operator's wallet). */
const INTENTS: { key: ImportIntent; label: string; hint: string; description: string }[] = [
  {
    key: 'live',
    label: 'Live',
    hint: 'Paper or live bots, paused for review',
    description: 'Upload a JSON file of bot configs — valid rows launch as paper bots, paused so you can review them.',
  },
  {
    key: 'backtest',
    label: 'Backtest',
    hint: 'Also queue a backtest from each stored config',
    description: 'Configs are created through the same launch pipeline as live bots (parked in paper), and each one queues a backtest on stored history — simulation money, never your wallet.',
  },
  {
    key: 'train',
    label: 'Train',
    hint: 'Also sweep each config on historical data',
    description: 'Configs are created through the same launch pipeline as live bots (parked in paper), and each is trained — a parameter sweep with in-window and hold-out scores.',
  },
]

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
  const navigate = useNavigate()
  const { data: catalog } = useStrategies()
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [intent, setIntent] = useState<ImportIntent>('live')
  const [rows, setRows] = useState<ImportedRow[] | null>(null)
  const [parseError, setParseError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')

  useEffect(() => {
    if (open) {
      setRows(null)
      setFileName('')
      setIntent('live')
      setParseError('')
      setDragging(false)
      setRepoUrl('')
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

  const run = useApiMutation((input: { items: LaunchInput[]; intent: ImportIntent }) => importBots(input.items, input.intent), ['bots', 'bot', 'dashboard', 'search', 'portfolio'], {
    onSuccess: (result) => {
      const skipped = result.failed.length
      const runErrors = result.runs.errors.length
      if (result.intent === 'backtest') {
        toast(`Imported ${result.launched.length} bot${result.launched.length === 1 ? '' : 's'} · queued ${result.runs.queued} backtest${result.runs.queued === 1 ? '' : 's'}${skipped || runErrors ? ` · ${Math.max(skipped, runErrors)} not queued` : ''}`, skipped || runErrors ? 'danger' : undefined)
        onClose()
        navigate('/training?tab=backtests')
      } else if (result.intent === 'train') {
        const trained = result.runs.training.length
        toast(`Imported ${result.launched.length} bot${result.launched.length === 1 ? '' : 's'} · trained ${trained}${skipped || runErrors ? ` · ${Math.max(skipped, runErrors)} not trained` : ''}`, skipped || runErrors ? 'danger' : undefined)
        onClose()
        navigate('/training')
      } else {
        toast(`Imported ${result.launched.length} bot${result.launched.length === 1 ? '' : 's'} (paused)${skipped ? ` · ${skipped} skipped` : ''}`)
        onClose()
      }
    },
  })

  // The repo path creates server-side from the fetched file, so there is no
  // preview step here: the toast is the receipt and the fleet refetch follows.
  const repoRun = useApiMutation(
    (input: { url: string; intent: ImportIntent }) => importBotsFromGithub(input.url, input.intent),
    ['bots', 'bot', 'dashboard', 'search', 'portfolio'],
    {
      onSuccess: (result) => {
        const skipped = result.failed.length
        toast(
          `Imported ${result.launched.length} bot${result.launched.length === 1 ? '' : 's'} from GitHub (paused)${skipped ? ` · ${skipped} skipped` : ''}`,
          skipped ? 'danger' : undefined,
        )
        onClose()
      },
    },
  )
  const asLaunchInput = (row: ImportedRow): LaunchInput => ({
    strategyKey: row.strategyKey,
    name: row.name,
    symbols: row.symbols,
    timeframe: row.timeframe as Timeframe,
    params: row.params,
    capital: row.capital as number,
    riskPct: row.riskPct ?? 25,
    // Backtest/train runs draw on simulation money, so a live-routed row is
    // parked as paper — it still imported, but never pretends to trade live.
    mode: intent === 'live' ? row.mode : 'paper',
    connectionId: row.connectionId ?? null,
    ...(row.rules !== undefined ? { rules: row.rules } : {}),
  })

const dialog = INTENTS.find((entry) => entry.key === intent) ?? INTENTS[0]

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title="Import bots"
      description={dialog.description}
      footer={
        <>
          <Button onClick={downloadSample} type="button">Download sample</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="button"
            disabled={importable.length === 0 || run.isPending}
            loading={run.isPending}
            onClick={() => importable.length > 0 && run.mutate({ items: importable.map(asLaunchInput), intent })}
          >
            {intent === 'live'
              ? `Import ${importable.length} bot${importable.length === 1 ? '' : 's'}`
              : intent === 'backtest'
                ? `Import ${importable.length} · queue backtests`
                : `Import ${importable.length} · train configs`}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {/* Destination: the three places an uploaded batch can go */}
        <div className="grid">
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px] font-medium text-muted">Destination</span>
            <span className="text-[11.5px] text-faint">{dialog.hint}</span>
          </div>
          <div role="radiogroup" aria-label="Import destination" className="mt-1.5 flex flex-wrap gap-1.5">
            {INTENTS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="radio"
                aria-checked={intent === entry.key}
                onClick={() => setIntent(entry.key)}
                className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ${intent === entry.key ? 'bg-fg text-bg' : 'border border-control bg-surface text-muted hover:bg-surface-2'}`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
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
        {rows === null && (
          <div className="rounded-card border border-line p-3">
            <span className="text-[12.5px] font-medium text-muted">…or import straight from a public repo</span>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                className="min-w-0 flex-1 rounded-control border border-control bg-surface px-3 py-1.5 text-[13px] outline-none focus:border-accent"
                placeholder="https://github.com/owner/repo/blob/main/bots.json"
                aria-label="GitHub bot config URL"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && repoUrl.trim() && !repoRun.isPending) repoRun.mutate({ url: repoUrl.trim(), intent })
                }}
              />
              <Button
                type="button"
                disabled={!repoUrl.trim() || repoRun.isPending}
                loading={repoRun.isPending}
                onClick={() => repoRun.mutate({ url: repoUrl.trim(), intent })}
              >
                Load
              </Button>
            </div>
            <p className="mt-1.5 text-[11.5px] text-faint">
              Public repos only · bot configs or inline rules · imported once, never re-synced.
            </p>
            {repoRun.error && <p className="mt-1 text-[13px] text-danger">{repoRun.error.message}</p>}
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


