import { Hono } from 'hono'

import { privateJson } from '../auth'
import { runBacktest } from '../backtest'
import { id, mapBacktest, now } from '../db'
import type { AppContext } from '../env'
import { TIMEFRAME_MS } from '../market'
import { sanitizeParams, strategyBy } from '../strategies'
import type { Backtest, Timeframe } from '../../shared/types'

type Row = Record<string, unknown>

export const backtests = new Hono<AppContext>()

const MAX_BARS = 5_000
const DEFAULTS: Record<Timeframe, number> = { '1m': 3, '5m': 7, '15m': 14, '1h': 90, '4h': 180, '1d': 365 }

/** List view drops the trade payload; the detail route returns it in full. */
const withName = (backtest: Backtest): Backtest => ({
  ...backtest,
  strategyName: strategyBy(backtest.strategyKey)?.name ?? backtest.strategyKey,
})
const summary = (backtest: Backtest): Backtest => ({ ...withName(backtest), trades: [] })

backtests.get('/', async (c) => {
  const result = await c
    .get('db')
    .prepare(`SELECT * FROM backtests WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 50`)
    .bind(c.get('user').sub)
    .all<Row>()
  return privateJson(c, { items: (result.results ?? []).map((row) => summary(mapBacktest(row))) })
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
  }>()

  const strategy = strategyBy(String(body.strategyKey ?? ''))
  if (!strategy) return c.json({ error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }, 400)

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

  const to = Number(body.to) || now()
  const requested = Number(body.from) || to - DEFAULTS[timeframe] * 86_400_000
  // Keep the run bounded: the engine caps a backtest at MAX_BARS bars.
  const from = Math.max(requested, to - MAX_BARS * TIMEFRAME_MS[timeframe])

  const backtestId = id()
  const createdAt = now()
  const params = sanitizeParams(strategy.key, body.params)
  const name = (body.name?.trim() || `${strategy.name} · ${symbol}`).slice(0, 90)

  try {
    const result = runBacktest({ strategyKey: strategy.key, symbol, timeframe, params, capital, from, to })
    await db
      .prepare(
        `INSERT INTO backtests (id, owner_sub, name, strategy_key, symbol, timeframe, params, capital, from_ts, to_ts, status, error, metrics, curve, trades, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', NULL, ?, ?, ?, ?)`,
      )
      .bind(
        backtestId,
        owner,
        name,
        strategy.key,
        symbol,
        timeframe,
        JSON.stringify(params),
        capital,
        from,
        to,
        JSON.stringify(result.metrics),
        JSON.stringify(result.curve),
        JSON.stringify(result.trades),
        createdAt,
      )
      .run()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backtest failed.'
    await db
      .prepare(
        `INSERT INTO backtests (id, owner_sub, name, strategy_key, symbol, timeframe, params, capital, from_ts, to_ts, status, error, metrics, curve, trades, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, NULL, '[]', '[]', ?)`,
      )
      .bind(backtestId, owner, name, strategy.key, symbol, timeframe, JSON.stringify(params), capital, from, to, message, createdAt)
      .run()
    return c.json({ error: 'backtest_failed', message }, 422)
  }

  const row = await db.prepare(`SELECT * FROM backtests WHERE id = ?`).bind(backtestId).first<Row>()
  return privateJson(c, { backtest: row ? withName(mapBacktest(row)) : null }, 201)
})

backtests.get('/:id', async (c) => {
  const row = await c
    .get('db')
    .prepare(`SELECT * FROM backtests WHERE id = ? AND owner_sub = ?`)
    .bind(c.req.param('id'), c.get('user').sub)
    .first<Row>()
  if (!row) return c.json({ error: 'not_found', message: 'Backtest not found.' }, 404)
  return privateJson(c, { backtest: withName(mapBacktest(row)) })
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
