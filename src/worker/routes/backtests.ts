import { Hono } from 'hono'

import { privateJson } from '../auth'
import { backtestWindow, runBacktest } from '../backtest'
import { id, mapBacktest, mapBot, now } from '../db'
import type { AppContext } from '../env'
import { HISTORY_YEARS, TIMEFRAME_MS, barsBetween, historyStart } from '../market'
import type { CustomRules } from '../strategies'
import { parseRules, rulesToParams, sanitizeParams, strategyBy } from '../strategies'
import type { AccuracyStat, Backtest, Candle, EquityPoint, ParamDef, ParamValue, RunMetrics, SimBudget, Timeframe } from '../../shared/types'
import { SIM_BUDGET } from '../../shared/types'

type Row = Record<string, unknown>

export const backtests = new Hono<AppContext>()

const MAX_BARS = 5_000
/** Backtests can be expensive; cap how many resolve in one list request. */
const MAX_RESOLVE_PER_REQUEST = 6
const DEFAULTS: Record<Timeframe, number> = { '1m': 3, '5m': 7, '15m': 14, '1h': 90, '4h': 180, '1d': 365 }

/** List view drops the trade payload; the detail route returns it in full. */
const withName = (backtest: Backtest): Backtest => ({
  ...backtest,
  // Uploaded custom strategies already carry their rules name from mapBacktest.
  strategyName: backtest.strategyKey === 'custom' ? backtest.strategyName : (strategyBy(backtest.strategyKey)?.name ?? backtest.strategyKey),
})
const summary = (backtest: Backtest): Backtest => ({ ...withName(backtest), trades: [] })

// The Worker is request-scoped and a run is bounded work, so backtests
// execute lazily on read — the same model as bots. POST validates and stores
// a `running` row; the next read (list or detail) executes it and flips the
// status to done or failed, so a UI that polls sees the transition without
// any long-lived process.

/** Backtests play with made-up money: a fixed simulation pot, reported with
 * the list so the UI can show what is allocated. Deleting a run frees its
 * allocation. */
async function simBudget(db: D1Database, owner: string): Promise<SimBudget> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(capital), 0) AS v FROM backtests WHERE owner_sub = ?`)
    .bind(owner)
    .first<{ v: number }>()
  const used = Number(row?.v ?? 0)
  return { total: SIM_BUDGET, used, available: Math.max(0, SIM_BUDGET - used) }
}

/**
 * Executes one pending backtest and persists the outcome. Returns the row
 * (fresh fields) whether the run succeeded or failed.
 */
async function resolveBacktest(db: D1Database, row: Row): Promise<Row> {
  if (String(row.status) !== 'running') return row
  const backtest = mapBacktest(row)
  try {
    const result = runBacktest({
      strategyKey: backtest.strategyKey,
      symbol: backtest.symbol,
      timeframe: backtest.timeframe,
      params: backtest.params,
      capital: backtest.capital,
      from: backtest.from,
      to: backtest.to,
    })
    // Accuracy rides inside the metrics blob — no schema churn for it.
    const metricsJson = JSON.stringify({ ...result.metrics, accuracy: result.accuracy })
    await db
      .prepare(`UPDATE backtests SET status = 'done', error = NULL, metrics = ?, curve = ?, trades = ? WHERE id = ?`)
      .bind(metricsJson, JSON.stringify(result.curve), JSON.stringify(result.trades), backtest.id)
      .run()
    return { ...row, status: 'done', error: null, metrics: metricsJson, curve: JSON.stringify(result.curve), trades: JSON.stringify(result.trades) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backtest failed.'
    await db
      .prepare(`UPDATE backtests SET status = 'failed', error = ? WHERE id = ?`)
      .bind(message, backtest.id)
      .run()
    return { ...row, status: 'failed', error: message }
  }
}

backtests.get('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const result = await db
    .prepare(`SELECT * FROM backtests WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 50`)
    .bind(owner)
    .all<Row>()
  const rows = result.results ?? []
  const pending = rows.filter((row) => String(row.status) === 'running').slice(0, MAX_RESOLVE_PER_REQUEST)
  const resolved = new Map<string, Row>()
  for (const row of pending) resolved.set(String(row.id), await resolveBacktest(db, row))
  return privateJson(c, {
    items: rows.map((row) => summary(withName(mapBacktest(resolved.get(String(row.id)) ?? row)))),
    sim: await simBudget(db, owner),
  })
})

backtests.get('/:id', async (c) => {
  const row = await c
    .get('db')
    .prepare(`SELECT * FROM backtests WHERE id = ? AND owner_sub = ?`)
    .bind(c.req.param('id'), c.get('user').sub)
    .first<Row>()
  if (!row) return c.json({ error: 'not_found', message: 'Backtest not found.' }, 404)
  return privateJson(c, { backtest: withName(mapBacktest(await resolveBacktest(c.get('db'), row))) })
})

/** Bounded candle count for the market chart: raw bars are bucketed into
 * display candles so a 5,000-bar replay still draws legibly. */
const MAX_CANDLES = 160

export function toCandles(bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]): Candle[] {
  if (bars.length <= MAX_CANDLES) return bars
  const per = Math.ceil(bars.length / MAX_CANDLES)
  const candles: Candle[] = []
  for (let start = 0; start < bars.length; start += per) {
    const slice = bars.slice(start, start + per)
    candles.push({
      t: slice[0].t,
      o: slice[0].o,
      h: Math.max(...slice.map((b) => b.h)),
      l: Math.min(...slice.map((b) => b.l)),
      c: slice[slice.length - 1].c,
      v: slice.reduce((sum, b) => sum + b.v, 0),
    })
  }
  return candles
}

/** The market data a backtest replayed: the same deterministic feed, the same
 * window the engine used. Works before a run resolves too, so the chart is
 * available while a run is pending. */
backtests.get('/:id/market', async (c) => {
  const row = await c
    .get('db')
    .prepare(`SELECT * FROM backtests WHERE id = ? AND owner_sub = ?`)
    .bind(c.req.param('id'), c.get('user').sub)
    .first<Row>()
  if (!row) return c.json({ error: 'not_found', message: 'Backtest not found.' }, 404)
  const backtest = mapBacktest(await resolveBacktest(c.get('db'), row))
  const { from, to } = backtestWindow(backtest.timeframe, backtest.from, backtest.to)
  if (to <= from) return privateJson(c, { backtestId: backtest.id, bars: 0, candles: [] })
  const bars = barsBetween(backtest.symbol, backtest.timeframe, from, to + 1)
  return privateJson(c, {
    backtestId: backtest.id,
    symbol: backtest.symbol,
    timeframe: backtest.timeframe,
    status: backtest.status,
    bars: bars.length,
    windowFrom: from,
    windowTo: to,
    candles: toCandles(bars),
  })
})

backtests.post('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<{
    strategyKey?: string
    symbol?: string
    timeframe?: Timeframe
    params?: Record<string, unknown>
    capital?: number
    from?: number
    to?: number
    name?: string
    /** Upload a rules payload inline, pointing the run at the `custom`
     * strategist with these rules instead of a catalog template. */
    rules?: unknown
  }>()

  const strategy = strategyBy(String(body.strategyKey ?? ''))
  if (!strategy) return c.json({ error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }, 400)

  // Inline rules (uploaded strategy) route through the `custom` strategist.
  let rulesRules: CustomRules | null = null
  let displayName = strategy.name
  if (body.rules !== undefined) {
    try {
      rulesRules = parseRules(body.rules).rules
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid rules.'
      return c.json({ error: 'invalid_rules', message }, 400)
    }
    displayName = rulesRules.name
  }

  const timeframe = (body.timeframe ?? strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]) as Timeframe
  if (!strategy.timeframes.includes(timeframe)) {
    return c.json({ error: 'timeframe_unsupported', message: `${strategy.name} does not run on the ${timeframe} timeframe.` }, 400)
  }

  const symbol = String(body.symbol ?? '').trim().toUpperCase()
  if (!symbol) return c.json({ error: 'symbol_required', message: 'Choose a symbol.' }, 400)

  const capital = Number(body.capital)
  if (!Number.isFinite(capital) || capital < 100) {
    return c.json({ error: 'invalid_capital', message: 'Starting capital must be at least $100.' }, 400)
  }
  // Runs draw from the simulation pot, never from workspace funding.
  const sim = await simBudget(db, owner)
  if (capital > sim.available) {
    return c.json(
      { error: 'sim_budget_exhausted', message: `Backtests draw from the simulation pot — $${sim.available.toLocaleString('en-US')} available of the $${SIM_BUDGET.toLocaleString('en-US')} pot. Delete old runs to free money.` },
      400,
    )
  }

  const to = Number(body.to) || now()
  const requested = Number(body.from) || to - DEFAULTS[timeframe] * 86_400_000
  // The platform retains HISTORY_YEARS of stored history — a run entirely
  // outside that window has no data to replay.
  if (to < historyStart(now())) {
    return c.json(
      { error: 'outside_history', message: `Stored history covers the last ${HISTORY_YEARS} years — pick a period that reaches into it.` },
      400,
    )
  }
  // Keep the run bounded: the engine caps a backtest at MAX_BARS bars and
  // never replays earlier than the stored-history window.
  const from = Math.max(requested, to - MAX_BARS * TIMEFRAME_MS[timeframe], historyStart(to))

  const backtestId = id()
  const createdAt = now()
  // Custom rules become their own params blob; catalog strategies sanitize
  // against their declared schema as before.
  const params = rulesRules ? rulesToParams(rulesRules) : sanitizeParams(strategy.key, body.params)
  const strategyKey = rulesRules ? 'custom' : strategy.key
  const name = (body.name?.trim() || `${displayName} · ${symbol}`).slice(0, 90)

  await db
    .prepare(
      `INSERT INTO backtests (id, owner_sub, name, strategy_key, symbol, timeframe, params, capital, from_ts, to_ts, status, error, metrics, curve, trades, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, '[]', '[]', ?)`,
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
      from,
      to,
      createdAt,
    )
    .run()

  const row = await db.prepare(`SELECT * FROM backtests WHERE id = ?`).bind(backtestId).first<Row>()
  return privateJson(c, { backtest: row ? withName({ ...mapBacktest(row), strategyName: displayName }) : null }, 201)
})

// --- Training: grid search over stored history ------------------------------

/** One parameter knob to sweep: from → to across `steps` values (inclusive). */
interface VaryParam {
  key: string
  from: number
  to: number
  steps: number
}

const MAX_COMBOS = 12
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
backtests.post('/optimize', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<{
    strategyKey?: string
    botId?: string
    symbol?: string
    timeframe?: Timeframe
    capital?: number
    params?: Record<string, unknown>
    days?: number
    objective?: 'return' | 'sharpe'
    vary?: VaryParam[]
  }>()

  // A bot config seeds every field: pick "train this bot" and its strategy,
  // market, timeframe, capital and params come straight off the bot.
  let strategyKey = String(body.strategyKey ?? '')
  let baseParams: Record<string, ParamValue> = sanitizeParams(strategyKey, body.params)
  let symbol = String(body.symbol ?? '').trim().toUpperCase()
  let timeframe = body.timeframe
  let capital = Number(body.capital)
  let sourceName = 'new config'
  if (body.botId) {
    const botRow = await db
      .prepare(`SELECT * FROM bots WHERE id = ? AND owner_sub = ?`)
      .bind(body.botId, owner)
      .first<Row>()
    if (!botRow) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)
    const bot = mapBot(botRow)
    if (bot.strategyKey === 'custom') {
      return c.json(
        { error: 'custom_strategy', message: 'Uploaded-rules bots have no tunable parameters to train — backtest them from the Backtests tab instead.' },
        400,
      )
    }
    strategyKey = bot.strategyKey
    baseParams = bot.params
    symbol = bot.symbols[0] ?? symbol
    timeframe = bot.timeframe
    capital = bot.capital
    sourceName = bot.name
  }

  const strategy = strategyBy(strategyKey)
  if (!strategy) return c.json({ error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }, 400)
  const tf: Timeframe = timeframe ?? strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]
  if (!strategy.timeframes.includes(tf)) {
    return c.json({ error: 'timeframe_unsupported', message: `${strategy.name} does not run on the ${tf} timeframe.` }, 400)
  }
  if (!symbol) return c.json({ error: 'symbol_required', message: 'Choose a symbol.' }, 400)
  if (!Number.isFinite(capital) || capital < 100) {
    return c.json({ error: 'invalid_capital', message: 'Starting capital must be at least $100.' }, 400)
  }

  const days = Math.min(OPTIMIZE_DAYS_MAX, Math.max(OPTIMIZE_DAYS_MIN, Math.round(Number(body.days) || DEFAULTS[tf] * 2)))
  const objective: 'return' | 'sharpe' = body.objective === 'return' ? 'return' : 'sharpe'

  // Build the grid: 1–2 numeric knobs from the strategy's own param schema.
  const vary = (Array.isArray(body.vary) ? body.vary : []).slice(0, 2)
  if (vary.length === 0) {
    return c.json({ error: 'nothing_to_train', message: 'Pick at least one parameter to sweep.' }, 400)
  }
  const knobs: { def: ParamDef; values: number[] }[] = []
  for (const knob of vary) {
    const def = strategy.params.find((p) => p.key === knob.key)
    if (!def || def.type !== 'number') {
      return c.json({ error: 'unknown_param', message: `"${knob.key}" is not a tunable numeric parameter of ${strategy.name}.` }, 400)
    }
    const from = Number(knob.from)
    const to = Number(knob.to)
    const steps = Math.round(Number(knob.steps))
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || steps < 2 || steps > MAX_VARY_STEPS) {
      return c.json({ error: 'bad_sweep', message: `${def.label}: use a range from < to with 2–${MAX_VARY_STEPS} steps.` }, 400)
    }
    const values = Array.from({ length: steps }, (_, i) => from + ((to - from) * i) / (steps - 1))
    knobs.push({ def, values })
  }
  const combos = knobs.reduce((n, knob) => n * knob.values.length, 1)
  if (combos > MAX_COMBOS) {
    return c.json({ error: 'grid_too_big', message: `That grid is ${combos} runs — keep it to ${MAX_COMBOS} (fewer steps or parameters).` }, 400)
  }

  const to = now()
  const from = Math.max(to - days * 86_400_000, historyStart(to))
  const split = Math.round(from + (to - from) * TRAIN_SPLIT)

  const rows: OptimizerRun[] = []
  for (let combo = 0; combo < combos; combo++) {
    let rest = combo
    const params: Record<string, ParamValue> = { ...baseParams }
    for (const knob of [...knobs].reverse()) {
      const value = knob.values[rest % knob.values.length]
      rest = Math.floor(rest / knob.values.length)
      params[knob.def.key] = Number.isInteger(value) ? value : Number(value.toFixed(4))
    }
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
  let bestDetail: { curve: EquityPoint[]; accuracy: AccuracyStat; metrics: RunMetrics } | null = null
  if (!ranked[0]?.error) {
    try {
      const full = runBacktest({ strategyKey: strategy.key, symbol, timeframe: tf, params: ranked[0].params, capital, from, to })
      bestDetail = { curve: full.curve, accuracy: full.accuracy, metrics: full.metrics }
    } catch {
      bestDetail = null
    }
  }

  return privateJson(c, {
    source: { strategyKey: strategy.key, strategyName: strategy.name, symbol, timeframe: tf, capital, days, from, to, split, label: sourceName },
    objective,
    history: { years: HISTORY_YEARS, from: historyStart(to) },
    runs: rows,
    bestIndex,
    best: bestDetail,
    knobs: knobs.map((knob) => ({ key: knob.def.key, label: knob.def.label, unit: knob.def.unit ?? null, values: knob.values })),
  })
})

backtests.delete('/:id', async (c) => {
  const result = await c
    .get('db')
    .prepare(`DELETE FROM backtests WHERE id = ? AND owner_sub = ?`)
    .bind(c.req.param('id'), c.get('user').sub)
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found', message: 'Backtest not found.' }, 404)
  return privateJson(c, { ok: true })
})
