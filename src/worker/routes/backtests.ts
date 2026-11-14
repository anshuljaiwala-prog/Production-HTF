import { Hono } from 'hono'

import { privateJson } from '../auth'
import { backtestWindow, runBacktest, runTraining, scheduleBacktest, simBudget, withName } from '../backtest'
import type { BacktestSpec, TrainSpec } from '../backtest'
import { mapBacktest, now } from '../db'
import type { AppContext } from '../env'
import { barsBetween, toCandles } from '../market'
import { barsForRun } from '../marketstore'
import type { Backtest } from '../../shared/types'

type Row = Record<string, unknown>

export const backtests = new Hono<AppContext>()

/** Backtests can be expensive; cap how many resolve in one list request. */
const MAX_RESOLVE_PER_REQUEST = 6

/** List view drops the trade payload; the detail route returns it in full. */
const summary = (backtest: Backtest): Backtest => ({ ...withName(backtest), trades: [] })

// The Worker is request-scoped and a run is bounded work, so backtests
// execute lazily on read — the same model as bots. POST validates and stores
// a `running` row; the next read (list or detail) executes it and flips the
// status to done or failed, so a UI that polls sees the transition without
// any long-lived process.

/**
 * Executes one pending backtest and persists the outcome. Returns the row
 * (fresh fields) whether the run succeeded or failed.
 */
async function resolveBacktest(db: D1Database, row: Row): Promise<Row> {
  if (String(row.status) !== 'running') return row
  const backtest = mapBacktest(row)
  try {
    // Imported bars overlay the synthetic feed so the run replays the same
    // window the market API would serve — null when nothing was imported.
    const { from, to } = backtestWindow(backtest.timeframe, backtest.from, backtest.to)
    const bars = await barsForRun(db, backtest.symbol, backtest.timeframe, from, to + 1) ?? undefined
    const result = runBacktest({
      strategyKey: backtest.strategyKey,
      symbol: backtest.symbol,
      timeframe: backtest.timeframe,
      params: backtest.params,
      capital: backtest.capital,
      from: backtest.from,
      to: backtest.to,
      ...(bars && { bars }),
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
  const { from, to } = backtestWindow(backtest.timeframe, backtest.from, backtest.to, now())
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
  const result = await scheduleBacktest(c.get('db'), c.get('user').sub, await c.req.json<BacktestSpec>())
  if ('error' in result) return c.json(result, 400)
  return privateJson(c, { backtest: result.backtest }, 201)
})

backtests.post('/optimize', async (c) => {
  const result = await runTraining(c.get('db'), c.get('user').sub, await c.req.json<TrainSpec>())
  if ('error' in result) return c.json(result, result.status ?? (400 as const))
  return privateJson(c, result)
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
