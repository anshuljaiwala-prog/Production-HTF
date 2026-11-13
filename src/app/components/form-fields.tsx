import { ASSET_CLASSES, MAX_TRACKED_SYMBOLS, TIMEFRAMES, type CustomStrategySummary, type ParamDef, type ParamValue, type Strategy, type SymbolMeta } from '../../shared/types'
import { Checkbox, Field, Input, Select, useFieldId } from './ui'

// Forms built from the strategy param schema, so the catalog, the launch
// wizard and the backtester never disagree about what a strategy takes.

export function FieldInput(props: React.ComponentPropsWithoutRef<typeof Input>) {
  const id = useFieldId()
  return <Input id={id} {...props} />
}
export function FieldSelect(props: React.ComponentPropsWithoutRef<typeof Select>) {
  const id = useFieldId()
  return <Select id={id} {...props} />
}
export function FieldCheck(props: React.ComponentPropsWithoutRef<typeof Checkbox>) {
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

/** Symbol toggles grouped by asset class with a class label per group. The
 * server tracks at most MAX_TRACKED_SYMBOLS markets per bot, so unselected
 * chips disable at the cap instead of letting the form build a selection the
 * ingress would reject. */
export function SymbolPicker({ symbols, value, onChange }: { symbols: SymbolMeta[]; value: string[]; onChange: (next: string[]) => void }) {
  const atCap = value.length >= MAX_TRACKED_SYMBOLS
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
              const blocked = atCap && !active
              return (
                <button
                  key={symbol}
                  type="button"
                  aria-pressed={active}
                  disabled={blocked}
                  title={blocked ? `Tracks up to ${MAX_TRACKED_SYMBOLS} markets — remove one first` : kind === 'option' && label ? label : undefined}
                  onClick={() => onChange(active ? value.filter((s) => s !== symbol) : [...value, symbol])}
                  className={
                    active
                      ? 'h-8 rounded-tile bg-fg px-3 text-[12.5px] font-medium text-bg'
                      : blocked
                        ? 'h-8 rounded-tile border border-line bg-surface px-3 text-[12.5px] text-faint opacity-60'
                        : 'h-8 rounded-tile border border-control bg-surface px-3 text-[12.5px] text-muted transition-colors hover:text-fg'
                  }
                >
                  {symbol}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <span className="text-[12px] text-faint">
        {value.length} of {MAX_TRACKED_SYMBOLS} tracked
        {atCap ? ' — remove a market to add another' : ''}
      </span>
    </div>
  )
}

