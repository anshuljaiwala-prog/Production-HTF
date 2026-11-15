import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { Bot, CircleAlert, Cpu, Siren, Zap } from 'lucide-react'

import { MAX_BOT_VENUES, TIMEFRAMES, type ParamValue, type Timeframe } from '../../../shared/types'
import { capture } from '../../lib/analytics'
import { launchBot, useConnections, useCustomStrategy, useApiMutation, useStrategies, type LaunchInput } from '../../lib/api'
import { RiskBar } from '../controls'
import { Badge, Button, Dialog, Field, useToast } from '../ui'
import { customStrategyView, FieldInput, FieldSelect, paramDefaults, ParamFields, SymbolPicker } from '../form-fields'
import { money } from '../../lib/format'

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
  const [minConfidence, setMinConfidence] = useState('0')
  const [maxVolatility, setMaxVolatility] = useState('0')
  const [mode, setMode] = useState<'paper' | 'live'>('paper')
  const [venueIds, setVenueIds] = useState<string[]>([])
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
  // A synchronous double-fire (double click, both clicks in one batch)
  // beats React's isPending flip — the ref holds the gate between the two
  // click events, so one launch can never create two bots.
  const submitting = useRef(false)

  useEffect(() => {
    if (!open || !strategy) return
    setParams(paramDefaults(strategy))
    setTimeframe(strategy.timeframes[Math.floor(strategy.timeframes.length / 2)])
    setSymbols(catalog?.symbols.slice(0, 1).map((meta) => meta.symbol) ?? [])
    setName('')
    setMode('paper')
    setVenueIds(connections?.items[0] ? [connections.items[0].id] : [])
    setCapital('10000')
    setRiskPct('25')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalogKey, connectionIds, strategy?.key ?? null])

  const launch = useApiMutation((input: LaunchInput) => launchBot(input), ['bots', 'bot', 'dashboard', 'search'], {
      onSuccess: (result) => {
        // Onboarding funnel: strategy → launch → first running bot.
        capture('bot_launched', {
          strategy: result.bot.strategyKey,
          mode: result.bot.mode,
          timeframe: result.bot.timeframe,
          symbols: result.bot.symbols.length,
        })
        toast('Bot launched')
        onClose()
        navigate(`/bots/${result.bot.id}`)
      },
    },
  )

  if (!strategy) return null
  const usableConnections = connections?.items ?? []

  // Live routing needs at least one saved exchange account — mirrored
  // server-side on POST /bots; catching it here keeps the button from
  // promising a launch the venue will refuse.
  const liveWithoutConnection = mode === 'live' && venueIds.length === 0
  // Best-price routing: every checked venue is queried and the best fill wins.
  // The first checked venue is the primary (its book/cash is the reference).
  const toggleVenue = (connectionId: string) =>
    setVenueIds((current) =>
      current.includes(connectionId)
        ? current.filter((id) => id !== connectionId)
        : current.length >= MAX_BOT_VENUES
          ? current
          : [...current, connectionId],
    )
  const capitalValue = Number(capital)
  const riskValue = Number(riskPct)
  const validCapital = Number.isFinite(capitalValue) && capitalValue >= 100
  const validRisk = Number.isFinite(riskValue) && riskValue >= 1 && riskValue <= 100
  const minConfidenceValue = Math.max(0, Math.min(100, Math.round(Number(minConfidence) || 0)))
  const maxVolatilityValue = Math.max(0, Math.min(100, Number(maxVolatility) || 0))
  const ready = validCapital && validRisk && symbols.length > 0 && !liveWithoutConnection
  // The engine sizes every entry as equity × risk% (capped by idle cash) —
  // the number an operator actually cares about before committing capital.
  const entrySize = validCapital && validRisk ? capitalValue * (riskValue / 100) : null

  // BEAT-REACT: see submitting above.
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!strategy || !ready || submitting.current || launch.isPending) return
    submitting.current = true
    launch.mutate(
      {
        strategyKey: customEntry ? 'custom' : strategy.key,
        name: name.trim() || undefined,
        symbols,
        timeframe,
        params,
        capital: capitalValue,
        riskPct: riskValue,
        minConfidencePct: minConfidenceValue,
        maxVolatilityPct: maxVolatilityValue,
        mode,
        connectionId: venueIds[0] ?? null,
        venueIds: mode === 'live' ? venueIds : venueIds.slice(0, 1),
        ...(customEntry ? { rules: custom?.data?.rules } : {}),
      },
      { onSettled: () => { submitting.current = false } },
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={680}
      title={`Launch ${strategy.name}`}
      description={strategy.summary}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="launch-form" loading={launch.isPending} disabled={!ready} title={liveWithoutConnection ? 'Live mode needs a saved exchange connection' : undefined}>
            {mode === 'live' ? 'Launch live bot' : 'Launch paper bot'}
          </Button>
        </>
      }
    >
      <form id="launch-form" onSubmit={submit} className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={strategy.risk === 'high' ? 'danger' : strategy.risk === 'medium' ? 'warning' : 'success'}>{strategy.risk} risk</Badge>
          {strategy.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded-[8px] bg-surface-2 px-2 py-0.5 text-[11.5px] text-muted">
              {tag}
            </span>
          ))}
          <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-faint">
            <Zap className="size-3" />
            paper first
          </span>
        </div>

        {/* What it trades ------------------------------------------------------------ */}
        <section>
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
            <Bot className="size-3.5" />
            What it trades
          </h3>
          <div className="mt-2.5 grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bot name" hint="Defaults to strategy + symbols">
                <FieldInput value={name} onChange={(e) => setName(e.target.value)} placeholder={`${strategy.name} · ${symbols[0] ?? 'BTC-USD'}`} maxLength={90} />
              </Field>
              <Field label="Timeframe">
                <FieldSelect value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
                  {TIMEFRAMES.filter((tf) => strategy.timeframes.includes(tf.key)).map((tf) => (
                    <option key={tf.key} value={tf.key}>
                      {tf.label}
                    </option>
                  ))}
                </FieldSelect>
              </Field>
            </div>
            <SymbolPicker symbols={catalog?.symbols ?? []} value={symbols} onChange={setSymbols} />
          </div>
        </section>

        {/* Sizing -------------------------------------------------------------------- */}
        <section>
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
            <Cpu className="size-3.5" />
            Sizing
          </h3>
          <div className="mt-2.5 grid grid-cols-2 gap-3">
            <Field label="Starting capital" hint="min $100">
              <span className="relative block">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13.5px] text-faint">$</span>
                <FieldInput type="number" min={100} step={100} className="pl-7" value={capital} onChange={(e) => setCapital(e.target.value)} />
              </span>
            </Field>
            <Field label="Target entry size" hint="equity × risk %">
              <div className="flex h-9 items-center rounded-control border border-line bg-bg px-3 text-[13.5px] tabular-nums text-muted">
                {entrySize === null ? '—' : money(entrySize)}
              </div>
            </Field>
          </div>
          <RiskBar
            value={validRisk ? riskValue : 25}
            onChange={(next) => setRiskPct(String(next))}
            hint={`Drag the bar or type a number — every buy sizes to ${validRisk ? riskValue : 25}% of the running equity (capped by idle cash). The strategy's own parameters below shape when and how that target is reached.`}
          />
          {/* The strategy scores every signal 0–100; a signal under this floor
              never reaches the broker. 0 lets the strategy take them all. */}
          <div className="mt-3.5">
            <Field label="Minimum confidence" hint="0 takes every signal">
              <FieldInput type="number" min={0} max={100} step={1} value={minConfidence} onChange={(e) => setMinConfidence(e.target.value)} />
            </Field>
          </div>
          {/* Realised volatility is measured per bar by the pattern scan; a bot
              with a ceiling sits out the tape that chops wider than it tolerates. */}
          <div className="mt-3">
            <Field label="Volatility ceiling" hint="volPct per bar · 0 = none">
              <FieldInput type="number" min={0} max={100} step={0.1} value={maxVolatility} onChange={(e) => setMaxVolatility(e.target.value)} />
            </Field>
          </div>
        </section>

        <ParamFields params={params} defs={strategy.params} onChange={setParams} />

        {/* Where it runs -------------------------------------------------------------- */}
        <section>
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
            <Siren className="size-3.5" />
            Where it runs
          </h3>
          <div className="mt-2.5 grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode">
                <FieldSelect value={mode} onChange={(e) => setMode(e.target.value as 'paper' | 'live')}>
                  <option value="paper">Paper — simulated wallet</option>
                  <option value="live">Live — exchange APIs</option>
                </FieldSelect>
              </Field>
              <Field
                label={mode === 'live' ? 'Exchanges to route through' : 'Exchange connection'}
                hint={
                  mode === 'live'
                    ? `Best quote wins across up to ${MAX_BOT_VENUES} venues; the first checked one is primary.`
                    : 'Saved with the bot; routing only activates when the bot trades live.'
                }
              >
                {mode === 'live' ? (
                  <div className="grid gap-1.5">
                    {usableConnections.length === 0 ? (
                      <p className="rounded-control border border-line px-3 py-2 text-[12.5px] text-faint">No connections yet</p>
                    ) : (
                      usableConnections.map((connection) => {
                        const checked = venueIds.includes(connection.id)
                        return (
                          <label
                            key={connection.id}
                            className="flex cursor-pointer items-center gap-2 rounded-control border border-line bg-bg px-3 py-2 text-[13px]"
                          >
                            <input type="checkbox" className="accent-accent" checked={checked} onChange={() => toggleVenue(connection.id)} />
                            <span className="min-w-0 truncate">
                              {connection.name} · {connection.exchange} · {connection.environment}
                            </span>
                            {checked && venueIds[0] === connection.id && <span className="ml-auto text-[11px] text-faint">primary</span>}
                          </label>
                        )
                      })
                    )}
                  </div>
                ) : (
                  <FieldSelect value={venueIds[0] ?? ''} onChange={(e) => setVenueIds(e.target.value ? [e.target.value] : [])}>
                    <option value="">{usableConnections.length ? 'None — demo venue' : 'No connections yet'}</option>
                    {usableConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name} · {connection.exchange}
                      </option>
                    ))}
                  </FieldSelect>
                )}
              </Field>
            </div>
            {liveWithoutConnection && (
              <p className="flex items-start gap-1.5 rounded-[10px] bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                A live bot needs at least one saved exchange connection. Add one on the Connections page, or launch in paper mode first.
              </p>
            )}
            {symbols.length === 0 && (
              <p className="flex items-start gap-1.5 rounded-[10px] bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                Pick at least one symbol to trade.
              </p>
            )}
          </div>
        </section>

        {launch.error && <p className="text-[13px] text-danger">{launch.error.message}</p>}
      </form>
    </Dialog>
  )
}
