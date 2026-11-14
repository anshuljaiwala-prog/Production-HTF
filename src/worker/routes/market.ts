import { Hono } from 'hono'

import { privateJson } from '../auth'
import { backtestWindow } from '../backtest'
import { now } from '../db'
import type { AppContext } from '../env'
import { HISTORY_YEARS, TIMEFRAME_MS, barsBetween, historyStart, toCandles } from '../market'
import { barsForRun, screenPayload, storedSummary, upsertBars } from '../marketstore'
import type { MarketImportResult, StoredBarsSummary, Timeframe } from '../../shared/types'

export const market = new Hono<AppContext>()

/**
 * Stored historical data, served by the API: GET /api/market/history
 * ?symbol=BTC-USD&timeframe=1h&from=&to=
 *
 * The platform retains five years of history per symbol/timeframe (see
 * HISTORY_YEARS). The window is clamped with the same `backtestWindow` the
 * backtester and the trainer use, so what this endpoint returns is exactly
 * what a run replays — charts, training windows and backtests all agree.
 * Bars imported through POST /import overlay the synthetic feed here, so
 * this endpoint is also the mirror of what a backtest replays.
 * `to` defaults to now; `from` defaults to 90 days back.
 */
market.get('/history', async (c) => {
  const symbol = String(c.req.query('symbol') ?? '').trim().toUpperCase()
  const timeframe = String(c.req.query('timeframe') ?? '1d') as Timeframe
  if (!symbol) return c.json({ error: 'symbol_required', message: 'Pass a symbol, e.g. ?symbol=BTC-USD.' }, 400)
  if (!TIMEFRAME_MS[timeframe]) return c.json({ error: 'timeframe_unsupported', message: 'Use one of 1m, 5m, 15m, 1h, 4h, 1d.' }, 400)

  const clock = now()
  const requestedTo = Number(c.req.query('to')) || clock
  const requestedFrom = Number(c.req.query('from')) || requestedTo - 90 * 86_400_000
  if (requestedTo < historyStart(clock)) {
    return c.json(
      {
        error: 'outside_history',
        message: `Stored history covers the last ${HISTORY_YEARS} years — requested window ends before it begins.`,
        history: { years: HISTORY_YEARS, from: historyStart(clock), to: clock },
      },
      400,
    )
  }

  const to = Math.min(requestedTo, clock)
  const { from, to: clampedTo } = backtestWindow(timeframe, requestedFrom, to, clock)
  const merged = await barsForRun(c.get('db'), symbol, timeframe, from, clampedTo + 1)
  const bars = merged ?? barsBetween(symbol, timeframe, from, clampedTo + 1)
  return privateJson(c, {
    symbol,
    timeframe,
    from: bars[0]?.t ?? from,
    to: clampedTo,
    bars: bars.length,
    history: { years: HISTORY_YEARS, from: historyStart(clock), to: clock },
    candles: toCandles(bars),
  })
})

/**
 * Bulk bar upload: POST /api/market/import with either a bare array or an
 * `{ items: [...] }` envelope (source feeds use whichever). Every row is
 * screened (symbol normalization, sane timestamps, real OHLC) and upserted
 * by its (symbol, timeframe, t) bucket — replaying the same feed returns a
 * clean report with zero new rows instead of duplicating history. Payloads
 * carry an optional `source` label so the report shows where data came from.
 */
market.post('/import', async (c) => {
  const db = c.get('db')
  const clock = now()
  const body = await c.req.json<{ items?: unknown[]; source?: unknown } | unknown[]>().catch(() => null)
  if (!body) return c.json({ error: 'bad_payload', message: 'Body must be JSON — an array of bars or `{ items: [...] }`.' }, 400)
  const source = typeof (body as { source?: unknown }).source === 'string' ? String((body as { source?: unknown }).source).slice(0, 60) : 'upload'

  let report
  try {
    report = screenPayload(body, clock)
  } catch (error) {
    return c.json({ error: 'too_many_rows', message: error instanceof Error ? error.message : 'Import payload too large.' }, 400)
  }

  // Count how many screened slots already exist so the report can separate
  // fresh rows from re-sent (duplicate) data without per-row queries. IN()
  // is bound in chunks so a big import never trips SQLite's param limit.
  const keyList = [...report.keys]
  const existingKeys = new Set<string>()
  for (let i = 0; i < keyList.length; i += 300) {
    const chunk = keyList.slice(i, i + 300)
    const existing = await db
      .prepare(
        `SELECT symbol || '|' || timeframe || '|' || t AS k FROM market_bars
         WHERE (symbol || '|' || timeframe || '|' || t) IN (${chunk.map(() => '?').join(', ')})`,
      )
      .bind(...chunk)
      .all<{ k: string }>()
    for (const r of existing.results ?? []) existingKeys.add(r.k)
  }
  const duplicates = [...report.keys].filter((k) => existingKeys.has(k))

  const written = await upsertBars(db, report.rows, source, clock)
  const result: MarketImportResult = {
    accepted: written,
    updated: duplicates.length,
    duplicates: duplicates.map((k, i) => ({ index: i, reason: `already stored — upserted: ${k}` })),
    invalid: report.invalid,
  }
  return privateJson(c, result, 201)
})

/** What the API database currently holds, newest uploads first. */
market.get('/stored', async (c) => {
  const rows = await storedSummary(c.get('db'))
  return privateJson(c, {
    buckets: rows.map((r) => ({
      symbol: String(r.symbol),
      timeframe: String(r.timeframe) as Timeframe,
      bars: Number(r.bars),
      first: Number(r.first),
      last: Number(r.last),
    })) satisfies StoredBarsSummary[],
  })
})
