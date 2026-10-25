import type { EquityPoint, ParamValue, RunMetrics, Timeframe, Trade } from '../shared/types'
import { PaperBroker } from './broker'
import { id } from './db'
import { TIMEFRAME_MS, barsBetween } from './market'
import { strategyBy } from './strategies'

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
}

export interface BacktestResult {
  metrics: RunMetrics
  curve: EquityPoint[]
  trades: Trade[]
  bars: number
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const strategy = strategyBy(input.strategyKey)
  if (!strategy) throw new Error(`Unknown strategy "${input.strategyKey}".`)
  const tfMs = TIMEFRAME_MS[input.timeframe]
  const to = Math.floor(input.to / tfMs) * tfMs
  // Never simulate more than MAX_BARS bars, whatever range was requested.
  const from = Math.max(Math.floor(input.from / tfMs) * tfMs, to - MAX_BARS * tfMs)
  if (to <= from) throw new Error('The backtest period must end after it starts.')

  const bars = barsBetween(input.symbol, input.timeframe, from, to + 1)
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

    if (signal.action === 'buy' && !position) {
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
          at: bar.t + tfMs,
        })
      }
    } else if (signal.action === 'sell' && position) {
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
    curve,
    trades: trades.slice(-MAX_TRADES),
    bars: bars.length,
  }
}
