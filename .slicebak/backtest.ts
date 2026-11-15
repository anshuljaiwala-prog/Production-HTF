import type { AccuracyStat, Backtest, EquityPoint, ParamDef, ParamValue, RunMetrics, SimBudget, Timeframe, Trade } from '../shared/types'
import { SIM_BUDGET, TRAIN_MAX_COMBOS, customKnobDefs } from '../shared/types'
import { evaluateGate, readEnvironment } from './agents/environment'
import { MACRO_BARS, MACRO_SYMBOLS, MACRO_TIMEFRAME, windowAt } from './agents/harvester'
import { PaperBroker } from './broker'
import { id, mapBacktest, mapBot, now, type Row } from './db'
import { HISTORY_YEARS, TIMEFRAME_MS, barsBetween, historyStart, normalizeSymbol, type Bar } from './market'
import type { CustomRules } from './strategies'
import { applyCustomKnobs, measureAccuracy, parseRules, rulesToParams, sanitizeParams, strategyBy } from './strategies'

// Deterministic backtest over the synthetic feed. It mirrors the live engine:
// same signal function, same sizing rule, same fee and slippage model, so a
// strategy behaves the same on paper as it does in a backtest.

const MAX_BARS = 5_000
const MAX_TRADES = 400
const MAX_CURVE_POINTS = 400
const MIN_NOTIONAL = 1
const QTY_STEP = 1e6
const COST_BUFFER = 1.003
const YEAR_MS = 365 * 86_400_000

export interface BacktestInput {
  strategyKey: string
  symbol: string
  timeframe: Timeframe
  params: Record<string, ParamValue>
  capital: number
  from: number
  to: number
  riskPct?: number
  /** Entries below this confidence are skipped, like the engine floor. */
  minConfidencePct?: number
  /** Entries are skipped while the focus market's volPct is above this. */
  maxVolatilityPct?: number
  /** Preloaded (stored-import-overlaid) bars for exactly this window; run
   * from the routes so imported market data is what the backtest replays.
   * Absent ⇒ the synthetic feed. */
  bars?: Bar[]
}

export interface BacktestResult {
  metrics: RunMetrics
  /** Prediction accuracy of the strategy's entry rules over this window. */
  accuracy: AccuracyStat
  curve: EquityPoint[]
  trades: Trade[]
  bars: number
}

/** The exact bar window a run replayed: `to` floored to the bar grid and
 * `from` capped so the run stays within MAX_BARS bars — and never earlier
 * than the platform's stored-history window: five years back from `clock`
 * (the retention edge as of now, not as of the run's end), so a replay only
 * ever consumes data the market API would serve. Shared with the
 * market-data route so charts show precisely the bars that were traded. */
export function backtestWindow(timeframe: Timeframe, from: number, to: number, clock: number = Date.now()): { from: number; to: number } {
  const tfMs = TIMEFRAME_MS[timeframe]
  const toFloored = Math.floor(to / tfMs) * tfMs
  return {
    from: Math.max(Math.floor(from / tfMs) * tfMs, toFloored - MAX_BARS * tfMs, historyStart(clock)),
    to: toFloored,
  }
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const strategy = strategyBy(input.strategyKey)
  if (!strategy) throw new Error(`Unknown strategy "${input.strategyKey}".`)
  const tfMs = TIMEFRAME_MS[input.timeframe]
  const { from, to } = backtestWindow(input.timeframe, input.from, input.to)
  if (to <= from) throw new Error('The backtest period must end after it starts.')

  const bars = input.bars ?? barsBetween(input.symbol, input.timeframe, from, to + 1)
  if (bars.length < strategy.lookback + 10) {
    throw new Error(`Not enough history for ${input.timeframe} bars in that range — pick a longer period.`)
  }

  const broker = new PaperBroker()
  const riskPct = input.riskPct ?? 25
  let cash = input.capital
  let equity = input.capital
  let position: { qty: number; avgPrice: number } | null = null
  let roundTrips = 0
  let wins = 0

  const trades: Trade[] = []
  const curve: EquityPoint[] = []
  let peak = input.capital
  let maxDrawdown = 0

  // The agent gate runs here too, so a backtest reproduces what the live engine
  // would have done: the same read, the same hysteresis, one evaluation per
  // bar. Macro series are generated once over the whole window and sliced per
  // bar; the bot's own symbol uses the bars being replayed.
  const macroTfMs = TIMEFRAME_MS[MACRO_TIMEFRAME]
  const macroSeries = MACRO_SYMBOLS.map((symbol) => ({
    symbol,
    bars: barsBetween(symbol, MACRO_TIMEFRAME, from - MACRO_BARS * macroTfMs, to + macroTfMs),
  }))
  let agentStreak = 0

  const step = Math.max(1, Math.ceil(bars.length / MAX_CURVE_POINTS))

  for (let i = strategy.lookback; i < bars.length; i++) {
    const bar = bars[i]
    const slice = bars.slice(Math.max(0, i + 1 - strategy.lookback), i + 1)
    const signal = strategy.signal({
      bars: slice,
      position,
      cash,
      equity,
      params: input.params,
      tfMs,
    })

    const agentAt = bar.t + tfMs
    const envRead = readEnvironment({
      at: agentAt,
      macroBars: macroSeries.map(({ symbol, bars: series }) => ({ symbol, bars: windowAt(series, agentAt) })),
      focus: { symbol: input.symbol, bars: bars.slice(Math.max(0, i + 1 - MACRO_BARS), i + 1) },
    })
    const gate = evaluateGate(envRead, [input.symbol], agentStreak)
    agentStreak = gate.streak
    // Same rule as the engine: the template states its confidence and the rules
    // DSL inherits the verdict's conviction. A replay must skip the entries the
    // bot would skip, or it reports trades the bot cannot take.
    const confidence = signal.confidence ?? Math.round(envRead.verdict.conviction * 100)
    const clearsFloor = confidence >= (input.minConfidencePct ?? 0)
    // Same ceiling as the engine, on the same pattern-scan volPct.
    const volCeiling = input.maxVolatilityPct ?? 0
    const volOk = volCeiling <= 0 || (envRead.pattern?.volPct ?? 0) <= volCeiling

    if (signal.action === 'buy' && !position && !gate.blocked && clearsFloor && volOk) {
      const target = equity * (riskPct / 100)
      const qty = Math.floor(Math.min(target / bar.c, cash / (bar.c * COST_BUFFER)) * QTY_STEP) / QTY_STEP
      if (qty > 0 && qty * bar.c >= MIN_NOTIONAL) {
        const fill = broker.placeOrder({ symbol: input.symbol, side: 'buy', qty, at: bar.t + tfMs })
        cash -= fill.price * fill.qty + fill.fee
        position = { qty: fill.qty, avgPrice: fill.price }
        trades.push({
          id: id(),
          botId: null,
          symbol: input.symbol,
          side: 'buy',
          qty: fill.qty,
          price: fill.price,
          fee: fill.fee,
          pnl: null,
          confidence,
          at: bar.t + tfMs,
        })
      }
    } else if (signal.action === 'short' && !position && clearsFloor && volOk) {
      const target = equity * (riskPct / 100)
      const qty = Math.floor(Math.min(target / bar.c, equity / (bar.c * COST_BUFFER)) * QTY_STEP) / QTY_STEP
      if (qty > 0 && qty * bar.c >= MIN_NOTIONAL) {
        const fill = broker.placeOrder({ symbol: input.symbol, side: 'sell', qty, at: bar.t + tfMs })
        cash += fill.price * fill.qty - fill.fee
        position = { qty: -fill.qty, avgPrice: fill.price }
        trades.push({
          id: id(),
          botId: null,
          symbol: input.symbol,
          side: 'short',
          qty: fill.qty,
          price: fill.price,
          fee: fill.fee,
          pnl: null,
          confidence,
          at: bar.t + tfMs,
        })
      }
    } else if (signal.action === 'cover' && position && position.qty < 0) {
      const qty = -position.qty
      const fill = broker.placeOrder({ symbol: input.symbol, side: 'buy', qty, at: bar.t + tfMs })
      const pnl = (position.avgPrice - fill.price) * qty - fill.fee
      cash -= fill.price * qty + fill.fee
      roundTrips++
      if (pnl > 0) wins++
      trades.push({
        id: id(),
        botId: null,
        symbol: input.symbol,
        side: 'cover',
        qty,
        price: fill.price,
        fee: fill.fee,
        pnl,
        confidence,
        at: bar.t + tfMs,
      })
      position = null
    } else if (signal.action === 'sell' && position && position.qty > 0) {
      const fill = broker.placeOrder({ symbol: input.symbol, side: 'sell', qty: position.qty, at: bar.t + tfMs })
      const pnl = (fill.price - position.avgPrice) * fill.qty - fill.fee
      cash += fill.price * fill.qty - fill.fee
      roundTrips++
      if (pnl > 0) wins++
      trades.push({
        id: id(),
        botId: null,
        symbol: input.symbol,
        side: 'sell',
        qty: fill.qty,
        price: fill.price,
        fee: fill.fee,
        pnl,
        confidence,
        at: bar.t + tfMs,
      })
      position = null
    }

    equity = cash + (position ? position.qty * bar.c : 0)
    if (i % step === 0 || i === bars.length - 1) curve.push({ t: bar.t, value: equity })
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }

  // Mark-to-market the open position at the final close so the result is honest.
  if (position) {
    const last = bars.at(-1)!
    equity = cash + position.qty * last.c
    curve.push({ t: last.t, value: equity })
  }

  const returns: number[] = []
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].value
    if (prev > 0) returns.push((curve[i].value - prev) / prev)
  }
  const mean = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1) : 0
  const periodsPerYear = YEAR_MS / tfMs
  const sampledPeriods = Math.max(1, step)
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(periodsPerYear / sampledPeriods) : 0

  return {
    metrics: {
      totalReturn: input.capital > 0 ? ((equity - input.capital) / input.capital) * 100 : 0,
      maxDrawdown: maxDrawdown * 100,
      sharpe: Number.isFinite(sharpe) ? sharpe : 0,
      winRate: roundTrips > 0 ? (wins / roundTrips) * 100 : 0,
      trades: trades.length,
      finalEquity: equity,
    },
    accuracy: measureAccuracy(input.strategyKey, input.params, bars, tfMs),
    curve,
    trades: trades.slice(-MAX_TRADES),
    bars: bars.length,
  }
}

// --- Scheduling: validate a spec and queue the run ---------------------------

/** Default lookback per timeframe when a spec names no window. */
const DEFAULTS: Record<Timeframe, number> = { '1m': 3, '5m': 7, '15m': 14, '1h': 90, '4h': 180, '1d': 365 }

export const withName = (backtest: Backtest): Backtest => ({
  ...backtest,
  // Uploaded custom strategies already carry their rules name from mapBacktest.
  strategyName: backtest.strategyKey === 'custom' ? backtest.strategyName : (strategyBy(backtest.strategyKey)?.name ?? backtest.strategyKey),
})

/** Backtests play with made-up money: a fixed simulation pot, reported with
 * the list so the UI can show what is allocated. Deleting a run frees its
 * allocation. */
export async function simBudget(db: D1Database, owner: string): Promise<SimBudget> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(capital), 0) AS v FROM backtests WHERE owner_sub = ?`)
    .bind(owner)
    .first<{ v: number }>()
  const used = Number(row?.v ?? 0)
  return { total: SIM_BUDGET, used, available: Math.max(0, SIM_BUDGET - used) }
}

/** One backtest queueing, shared by POST / and the bot-upload backtest
 * intent: an uploaded config is scheduled by the exact same function a
 * hand-made backtest goes through, so strategy support, symbol
 * normalization, the sim pot and the five-year history bound all apply. */
export interface BacktestSpec {
  strategyKey?: string
  symbol?: string
  timeframe?: Timeframe
  params?: Record<string, unknown>
  capital?: number
  from?: number
  to?: number
  name?: string
  /** Entries below this confidence are skipped, matching the bot floor. */
  minConfidencePct?: number
  /** Entries are skipped while the focus market's volPct is above this. */
  maxVolatilityPct?: number
  /** Upload a rules payload inline, pointing the run at the `custom`
   * strategist with these rules instead of a catalog template. */
  rules?: unknown
}
export type TrainSpecError = { error: string; message: string }

export async function scheduleBacktest(db: D1Database, owner: string, body: BacktestSpec): Promise<{ backtest: Backtest } | TrainSpecError> {
  const strategy = strategyBy(String(body.strategyKey ?? ''))
  if (!strategy) return { error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }

  // Inline rules (uploaded strategy) route through the `custom` strategist.
  let rulesRules: CustomRules | null = null
  let displayName = strategy.name
  if (body.rules !== undefined) {
    try {
      rulesRules = parseRules(body.rules).rules
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid rules.'
      return { error: 'invalid_rules', message }
    }
    displayName = rulesRules.name
  }

  const timeframe = (body.timeframe ?? strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]) as Timeframe
  if (!strategy.timeframes.includes(timeframe)) {
    return { error: 'timeframe_unsupported', message: `${strategy.name} does not run on the ${timeframe} timeframe.` }
  }

  const symbol = normalizeSymbol(String(body.symbol ?? ''))
  if (!symbol) {
    const given = String(body.symbol ?? '').trim()
    return { error: 'unknown_symbols', message: given ? `"${given}" is not a tradeable symbol here — try catalog entries like BTC-USD or EUR-USD.` : 'Choose a symbol.' }
  }

  const capital = Number(body.capital)
  if (!Number.isFinite(capital) || capital < 100) {
    return { error: 'invalid_capital', message: 'Starting capital must be at least $100.' }
  }
  // Runs draw from the simulation pot, never from workspace funding.
  const sim = await simBudget(db, owner)
  if (capital > sim.available) {
    return {
      error: 'sim_budget_exhausted',
      message: `Backtests draw from the simulation pot — $${sim.available.toLocaleString('en-US')} available of the $${SIM_BUDGET.toLocaleString('en-US')} pot. Delete old runs to free money.`,
    }
  }

  const clock = now()
  const to = Number(body.to) || clock
  const requested = Number(body.from) || to - DEFAULTS[timeframe] * 86_400_000
  // The platform retains HISTORY_YEARS of stored history — a run entirely
  // outside that window has no data to replay.
  if (to < historyStart(clock)) {
    return {
      error: 'outside_history',
      message: `Stored history covers the last ${HISTORY_YEARS} years — pick a period that reaches into it.`,
    }
  }
  // Keep the run bounded: the engine caps a backtest at MAX_BARS bars, and a
  // user-entered range can never start before the retention edge as of now —
  // rolling the window five years back from the run's end would otherwise
  // replay data the market API reports as no longer stored.
  const from = Math.max(requested, to - MAX_BARS * TIMEFRAME_MS[timeframe], historyStart(clock))

  const backtestId = id()
  const createdAt = now()
  // Custom rules become their own params blob; catalog strategies sanitize
  // against their declared schema as before.
  const params = rulesRules ? rulesToParams(rulesRules) : sanitizeParams(strategy.key, body.params)
  const strategyKey = rulesRules ? 'custom' : strategy.key
  const name = (body.name?.trim() || `${displayName} · ${symbol}`).slice(0, 90)

  await db
    .prepare(
      `INSERT INTO backtests (id, owner_sub, name, strategy_key, symbol, timeframe, params, capital, min_confidence_pct, max_volatility_pct, from_ts, to_ts, status, error, metrics, curve, trades, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, '[]', '[]', ?)`,
    )
    .bind(
      backtestId,
      owner,
      name,
      strategyKey,
      symbol,
      timeframe,
      JSON.stringify(params),
      capital,
      Math.min(100, Math.max(0, Number(body.minConfidencePct) || 0)),
      Math.min(100, Math.max(0, Number(body.maxVolatilityPct) || 0)),
      from,
      to,
      createdAt,
    )
    .run()

  const row = await db.prepare(`SELECT * FROM backtests WHERE id = ?`).bind(backtestId).first<Row>()
  return row
    ? { backtest: withName({ ...mapBacktest(row), strategyName: displayName }) }
    : { error: 'create_failed', message: 'Backtest could not be created.' }
}

// --- Training: grid search over stored history ------------------------------

/** One parameter knob to sweep: from → to across `steps` values (inclusive). */
interface VaryParam {
  key: string
  from: number
  to: number
  steps: number
}

const MAX_COMBOS = TRAIN_MAX_COMBOS
const MAX_VARY_STEPS = 6
const OPTIMIZE_DAYS_MIN = 30
const OPTIMIZE_DAYS_MAX = 5 * 365
/** Share of the window used to train (fit params); the tail is the hold-out
 * test slice so the table shows generalisation, not just in-sample fit. */
const TRAIN_SPLIT = 0.7

interface OptimizerRun {
  params: Record<string, ParamValue>
  train: RunMetrics
  test: RunMetrics | null
  error: string | null
}

/** Training endpoint: sweeps a small parameter grid over the stored
 * five-year history, scoring every combination on a train slice (70% of the
 * window) and a hold-out test slice (30%). Nothing is persisted — training
 * runs are in-memory and never allocate the simulation pot. */
/** Grid-search training, shared by POST /optimize and the bot-upload train
 * intent. Trains an existing bot (botId), an uploaded rules payload (rules)
 * or a composed config, sweeping a small parameter grid over the stored
 * five-year history and scoring each combination on a train slice (70%) and
 * a hold-out test slice (30%). Nothing is persisted — runs stay in-memory
 * and never allocate the simulation pot. */
export interface TrainSpec {
  strategyKey?: string
  botId?: string
  symbol?: string
  timeframe?: Timeframe
  capital?: number
  params?: Record<string, unknown>
  days?: number
  objective?: 'return' | 'sharpe'
  vary?: VaryParam[]
  /** Upload a rules payload inline, pointing the run at the `custom`
   * strategist with these rules instead of a catalog template. */
  rules?: unknown
  /** No explicit grid supplied: default-sweep the first bounded numeric
   * knob (3 values) so uploaded configs can train without a form. */
  autoSweep?: boolean
  /** Skip the full-window winner replay — the bulk upload path only wants
   * per-row summaries, not every curve. */
  slim?: boolean
}

export type TrainResult =
  | {
      source: {
        strategyKey: string
        strategyName: string
        symbol: string
        timeframe: Timeframe
        capital: number
        days: number
        from: number
        to: number
        split: number
        label: string
      }
      objective: 'return' | 'sharpe'
      history: { years: number; from: number }
      runs: OptimizerRun[]
      bestIndex: number
      best: { curve: EquityPoint[]; accuracy: AccuracyStat; metrics: RunMetrics } | null
      knobs: { key: string; label: string; unit: string | null; values: number[] }[]
    }
  | { error: string; message: string; status?: 400 | 404 }

export async function runTraining(db: D1Database, owner: string, body: TrainSpec): Promise<TrainResult> {

  // A bot config seeds every field: pick "train this bot" and its strategy,
  // market, timeframe, capital and params come straight off the bot.
  let strategyKey = String(body.strategyKey ?? '')
  let baseParams: Record<string, ParamValue> = sanitizeParams(strategyKey, body.params)
  let symbol = normalizeSymbol(String(body.symbol ?? ''))?.trim().toUpperCase() ?? ''
  let timeframe = body.timeframe
  let capital = Number(body.capital)
  let sourceName = 'new config'
  // Uploaded rules train two ways: an inline payload (standalone) or any
  // custom-rules bot. Either way the rules become the base params and their
  // thresholds become sweepable knobs below.
  let baseRules: CustomRules | null = null
  if (body.rules !== undefined) {
    try {
      baseRules = parseRules(body.rules).rules
    } catch (error) {
      return { error: 'invalid_rules', message: error instanceof Error ? error.message : 'Invalid rules.' }
    }
    strategyKey = 'custom'
    baseParams = rulesToParams(baseRules)
    sourceName = baseRules.name
  }
  if (body.botId) {
    const botRow = await db
      .prepare(`SELECT * FROM bots WHERE id = ? AND owner_sub = ?`)
      .bind(body.botId, owner)
      .first<Row>()
    if (!botRow) return { error: 'not_found', message: 'Bot not found.', status: 404 }
    const bot = mapBot(botRow)
    if (bot.strategyKey === 'custom') {
      // Custom bots carry their rules inline — same training path as an
      // inline payload, seeded with the bot's stored config.
      try {
        baseRules = parseRules(JSON.parse(String(bot.params.rules ?? ''))).rules
      } catch (error) {
        return { error: 'invalid_rules', message: error instanceof Error ? error.message : 'The bot\u2019s rules payload is unreadable.' }
      }
    }
    baseParams = bot.params
    strategyKey = bot.strategyKey
    symbol = bot.symbols[0] ?? symbol
    timeframe = bot.timeframe
    capital = bot.capital
    sourceName = bot.name
  }

  const strategy = strategyBy(strategyKey)
  if (!strategy) return { error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }
  const tf: Timeframe = timeframe ?? strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]
  if (!strategy.timeframes.includes(tf)) {
    return { error: 'timeframe_unsupported', message: `${strategy.name} does not run on the ${tf} timeframe.` }
  }
  if (!symbol) return { error: 'symbol_required', message: 'Choose a symbol.' }
  if (!Number.isFinite(capital) || capital < 100) {
    return { error: 'invalid_capital', message: 'Starting capital must be at least $100.' }
  }

  const days = Math.min(OPTIMIZE_DAYS_MAX, Math.max(OPTIMIZE_DAYS_MIN, Math.round(Number(body.days) || DEFAULTS[tf] * 2)))
  const objective: 'return' | 'sharpe' = body.objective === 'return' ? 'return' : 'sharpe'

  // Build the grid: 1–2 numeric knobs. Catalog strategies sweep their own
  // param schema; uploaded rules sweep their thresholds and stop/target.
  const knobDefs = strategy.key === 'custom' && baseRules ? customKnobDefs(baseRules) : strategy.params
  const varies = (Array.isArray(body.vary) ? body.vary : []).slice(0, 2)
  const vary = varies.length > 0 ? varies : defaultSweep(knobDefs)
  if (vary.length === 0) {
    return { error: 'nothing_to_train', message: 'Pick at least one parameter to sweep.' }
  }
  const knobs: { def: ParamDef; values: number[] }[] = []
  for (const knob of vary) {
    const def = knobDefs.find((p) => p.key === knob.key)
    if (!def || def.type !== 'number') {
      return { error: 'unknown_param', message: `"${knob.key}" is not a tunable numeric parameter of ${strategy.name}.` }
    }
    const from = Number(knob.from)
    const to = Number(knob.to)
    const steps = Math.round(Number(knob.steps))
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || steps < 2 || steps > MAX_VARY_STEPS) {
      return { error: 'bad_sweep', message: `${def.label}: use a range from < to with 2–${MAX_VARY_STEPS} steps.` }
    }
    // Snap to the parameter's own step: an integer lever ("entry interval")
    // must never train on fractional bars.
    const grain = typeof def.step === 'number' && def.step > 0 ? def.step : 1
    const values = Array.from({ length: steps }, (_, i) => {
      const raw = from + ((to - from) * i) / (steps - 1)
      const snapped = Math.round(raw / grain) * grain
      const bounded = Math.min(def.max ?? snapped, Math.max(def.min ?? snapped, snapped))
      return Number(bounded.toFixed(4))
    })
    knobs.push({ def, values })
  }
  const combos = knobs.reduce((n, knob) => n * knob.values.length, 1)
  if (combos > MAX_COMBOS) {
    return { error: 'grid_too_big', message: `That grid is ${combos} runs — keep it to ${MAX_COMBOS} (fewer steps or parameters).` }
  }

  const to = now()
  const from = Math.max(to - days * 86_400_000, historyStart(to))
  const split = Math.round(from + (to - from) * TRAIN_SPLIT)

  const rows: OptimizerRun[] = []
  for (let combo = 0; combo < combos; combo++) {
    let rest = combo
    const params: Record<string, ParamValue> = { ...baseParams }
    const swept: Record<string, number> = {}
    for (const knob of [...knobs].reverse()) {
      const value = knob.values[rest % knob.values.length]
      rest = Math.floor(rest / knob.values.length)
      const clean = Number.isInteger(value) ? value : Number(value.toFixed(4))
      params[knob.def.key] = clean
      swept[knob.def.key] = clean
    }
    // Uploaded rules: bake the swept thresholds back into the rules blob so
    // the strategist runs this combination's levels (stop/target already
    // ride as plain params). The raw keys stay on params for display.
    if (baseRules) params.rules = JSON.stringify(applyCustomKnobs(baseRules, swept))
    try {
      const train = runBacktest({ strategyKey: strategy.key, symbol, timeframe: tf, params, capital, from, to: split })
      let test: RunMetrics | null = null
      try {
        test = runBacktest({ strategyKey: strategy.key, symbol, timeframe: tf, params, capital, from: split, to }).metrics
      } catch {
        // A tail slice too short for the lookback: keep the train score and
        // mark the hold-out null rather than failing the whole sweep.
        test = null
      }
      rows.push({ params, train: train.metrics, test, error: null })
    } catch (error) {
      rows.push({ params, train: null as unknown as RunMetrics, test: null, error: error instanceof Error ? error.message : 'Run failed.' })
    }
  }

  const score = (row: OptimizerRun) => {
    if (row.error || !row.train) return Number.NEGATIVE_INFINITY
    return objective === 'return' ? row.train.totalReturn : row.train.sharpe
  }
  const ranked = [...rows].sort((a, b) => score(b) - score(a))
  const bestIndex = rows.indexOf(ranked[0])

  // One full-window replay of the winner: curve + accuracy for the report.
  // Slim mode (bulk upload) skips it — the row summaries are all the client
  // needs and a 25-config batch must not pay for 25 full replays.
  let bestDetail: { curve: EquityPoint[]; accuracy: AccuracyStat; metrics: RunMetrics } | null = null
  if (!ranked[0]?.error && !body.slim) {
    try {
      const full = runBacktest({ strategyKey: strategy.key, symbol, timeframe: tf, params: ranked[0].params, capital, from, to })
      bestDetail = { curve: full.curve, accuracy: full.accuracy, metrics: full.metrics }
    } catch {
      bestDetail = null
    }
  }

  return {
    source: { strategyKey: strategy.key, strategyName: strategy.key === 'custom' ? (baseRules?.name ?? strategy.name) : strategy.name, symbol, timeframe: tf, capital, days, from, to, split, label: sourceName },
    objective,
    history: { years: HISTORY_YEARS, from: historyStart(to) },
    runs: rows,
    bestIndex,
    best: bestDetail,
    knobs: knobs.map((knob) => ({ key: knob.def.key, label: knob.def.label, unit: knob.def.unit ?? null, values: knob.values })),
  }
}

/** The upload path trains without a form: derive a small default grid from
 * the first bounded numeric knob (3 values). The strategy's primary lever
 * (first numeric knob in its schema) is swept across its declared bounds;
 * returns [] when nothing is sweepable. */
function defaultSweep(defs: ParamDef[]): VaryParam[] {
  const bounded = defs.filter((def) => def.type === 'number' && typeof def.min === 'number' && typeof def.max === 'number' && def.max > def.min && typeof def.default === 'number')
  if (bounded.length === 0) return []
  const def = bounded[0]
  return [{ key: def.key, from: def.min as number, to: def.max as number, steps: 3 }]
}
