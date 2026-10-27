import { Hono } from 'hono'

import { privateJson } from '../auth'
import { backtestWindow, runBacktest } from '../backtest'
import { id, mapBacktest, now } from '../db'
import type { AppContext } from '../env'
import { TIMEFRAME_MS, barsBetween } from '../market'
import type { CustomRules } from '../strategies'
import { parseRules, rulesToParams, sanitizeParams, strategyBy } from '../strategies'
import type { Backtest, Candle, SimBudget, Timeframe } from '../../shared/types'
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

function toCandles(bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]): Candle[] {
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
  // Keep the run bounded: the engine caps a backtest at MAX_BARS bars.
  const from = Math.max(requested, to - MAX_BARS * TIMEFRAME_MS[timeframe])

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

backtests.delete('/:id', async (c) => {
  const result = await c
    .get('db')
    .prepare(`DELETE FROM backtests WHERE id = ? AND owner_sub = ?`)
    .bind(c.req.param('id'), c.get('user').sub)
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found', message: 'Backtest not found.' }, 404)
  return privateJson(c, { ok: true })
})
