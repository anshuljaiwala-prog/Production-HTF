import type { AccuracyStat, EquityPoint, ParamValue, RunMetrics, Timeframe, Trade } from '../shared/types'
import { evaluateGate, readEnvironment } from './agents/environment'
import { MACRO_BARS, MACRO_SYMBOLS, MACRO_TIMEFRAME, windowAt } from './agents/harvester'
import { PaperBroker } from './broker'
import { id } from './db'
import { TIMEFRAME_MS, barsBetween, historyStart, type Bar } from './market'
import { measureAccuracy, strategyBy } from './strategies'

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
    const gate = evaluateGate(
      readEnvironment({
        at: agentAt,
        macroBars: macroSeries.map(({ symbol, bars: series }) => ({ symbol, bars: windowAt(series, agentAt) })),
        focus: { symbol: input.symbol, bars: bars.slice(Math.max(0, i + 1 - MACRO_BARS), i + 1) },
      }),
      [input.symbol],
      agentStreak,
    )
    agentStreak = gate.streak

    if (signal.action === 'buy' && !position && !gate.blocked) {
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
    } else if (signal.action === 'short' && !position) {
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
