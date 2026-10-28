import { Hono } from 'hono'

import { privateJson } from '../auth'
import { backtestWindow } from '../backtest'
import { now } from '../db'
import type { AppContext } from '../env'
import { HISTORY_YEARS, TIMEFRAME_MS, barsBetween, historyStart } from '../market'
import type { Timeframe } from '../../shared/types'
import { toCandles } from './backtests'

export const market = new Hono<AppContext>()

/**
 * Stored historical data, served by the API: GET /api/market/history
 * ?symbol=BTC-USD&timeframe=1h&from=&to=
 *
 * The platform retains five years of history per symbol/timeframe (see
 * HISTORY_YEARS). The window is clamped with the same `backtestWindow` the
 * backtester and the trainer use, so what this endpoint returns is exactly
 * what a run replays — charts, training windows and backtests all agree.
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
  const bars = barsBetween(symbol, timeframe, from, clampedTo + 1)
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
