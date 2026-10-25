import type { ParamValue, Strategy, Timeframe } from '../shared/types'
import type { Bar } from './market'

// Strategy templates. Each returns a signal for the current closed bar; the
// engine and the backtester both decide position sizing, so the same function
// runs in both paths and behaves identically.

export interface SignalContext {
  /** History ending with the current closed bar (at least `lookback` bars when available). */
  bars: Bar[]
  position: { qty: number; avgPrice: number } | null
  cash: number
  equity: number
  params: Record<string, ParamValue>
  tfMs: number
}

export interface Signal {
  action: 'buy' | 'sell' | 'hold'
  reason?: string
}

export interface StrategyDef extends Strategy {
  /** Bars of history the signal needs. */
  lookback: number
  signal(ctx: SignalContext): Signal
}

const num = (v: ParamValue | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function sma(values: number[], n: number): number {
  if (values.length === 0) return 0
  const slice = values.slice(-n)
  return slice.reduce((s, v) => s + v, 0) / slice.length
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function ema(values: number[], n: number): number {
  if (values.length === 0) return 0
  const k = 2 / (n + 1)
  let out = values[0]
  for (let i = 1; i < values.length; i++) out = values[i] * k + out * (1 - k)
  return out
}

function highest(bars: Bar[], n: number): number {
  return Math.max(...bars.slice(-n).map((b) => b.h))
}

function lowest(bars: Bar[], n: number): number {
  return Math.min(...bars.slice(-n).map((b) => b.l))
}

/** Gain/loss of the current mark against the average entry, in percent. */
function gainPct(ctx: SignalContext): number | null {
  if (!ctx.position || ctx.position.qty <= 0) return null
  const last = ctx.bars.at(-1)
  if (!last) return null
  return ((last.c - ctx.position.avgPrice) / ctx.position.avgPrice) * 100
}

/** Shared exit: a stop loss checked before any strategy-specific entry logic. */
function stopExit(ctx: SignalContext, stopPct: number): Signal | null {
  const gain = gainPct(ctx)
  if (gain !== null && stopPct > 0 && gain <= -stopPct) return { action: 'sell', reason: `stop loss at ${gain.toFixed(1)}%` }
  return null
}

export const STRATEGIES: StrategyDef[] = [
  {
    key: 'dca',
    name: 'Dollar-Cost Averaging',
    summary: 'Buy on a fixed schedule, exit at a target or stop.',
    description:
      'Buys a fixed slice of the allocation every N bars while flat, then holds until the take-profit target or stop loss is reached. The calmest way to build a position.',
    risk: 'low',
    tags: ['Passive', 'Long only'],
    timeframes: ['1h', '4h', '1d'],
    lookback: 64,
    params: [
      { key: 'intervalBars', label: 'Entry interval', type: 'number', default: 6, min: 1, max: 500, step: 1, unit: 'bars' },
      { key: 'takeProfitPct', label: 'Take profit', type: 'number', default: 6, min: 0.5, max: 100, step: 0.5, unit: '%' },
      { key: 'stopLossPct', label: 'Stop loss', type: 'number', default: 10, min: 0, max: 100, step: 0.5, unit: '%', hint: '0 disables' },
    ],
    signal(ctx) {
      const bar = ctx.bars.at(-1)
      if (!bar) return { action: 'hold' }
      const stop = stopExit(ctx, num(ctx.params.stopLossPct, 10))
      if (stop) return stop
      const gain = gainPct(ctx)
      if (gain !== null && gain >= num(ctx.params.takeProfitPct, 6)) return { action: 'sell', reason: `target hit at +${gain.toFixed(1)}%` }
      if (ctx.position) return { action: 'hold' }
      const interval = Math.max(1, Math.round(num(ctx.params.intervalBars, 6)))
      const slot = Math.floor(bar.t / ctx.tfMs) % interval
      if (slot === 0) return { action: 'buy', reason: 'scheduled entry' }
      return { action: 'hold' }
    },
  },
  {
    key: 'grid',
    name: 'Grid Trading',
    summary: 'Add on every step down, sell every step up.',
    description:
      'Works a grid around the average entry: buys another slice each time price falls a full grid step below it, and sells a slice when price climbs a step above. Profits from chop, hurt by a one-way trend.',
    risk: 'medium',
    tags: ['Mean reversion', 'Long only'],
    timeframes: ['5m', '15m', '1h', '4h'],
    lookback: 64,
    params: [
      { key: 'gridStepPct', label: 'Grid step', type: 'number', default: 1.5, min: 0.1, max: 20, step: 0.1, unit: '%' },
      { key: 'stopLossPct', label: 'Stop loss', type: 'number', default: 18, min: 0, max: 100, step: 0.5, unit: '%', hint: '0 disables' },
    ],
    signal(ctx) {
      if (!ctx.bars.at(-1)) return { action: 'hold' }
      const stop = stopExit(ctx, num(ctx.params.stopLossPct, 18))
      if (stop) return stop
      const step = num(ctx.params.gridStepPct, 1.5)
      const gain = gainPct(ctx)
      if (gain === null) return { action: 'buy', reason: 'seed grid at market' }
      if (gain >= step) return { action: 'sell', reason: `grid ceiling +${gain.toFixed(1)}%` }
      if (gain <= -step) return { action: 'buy', reason: `grid step down ${gain.toFixed(1)}%` }
      return { action: 'hold' }
    },
  },
  {
    key: 'momentum',
    name: 'EMA Momentum',
    summary: 'Ride the trend while fast EMA leads slow EMA.',
    description:
      'Buys when the fast exponential moving average crosses above the slow one and price is above the trend average, and exits when the averages flip. Classic trend following: few, longer trades.',
    risk: 'medium',
    tags: ['Trend', 'Long only'],
    timeframes: ['15m', '1h', '4h', '1d'],
    lookback: 240,
    params: [
      { key: 'fastEma', label: 'Fast EMA', type: 'number', default: 12, min: 2, max: 200, step: 1, unit: 'bars' },
      { key: 'slowEma', label: 'Slow EMA', type: 'number', default: 48, min: 5, max: 500, step: 1, unit: 'bars' },
      { key: 'stopLossPct', label: 'Stop loss', type: 'number', default: 8, min: 0, max: 100, step: 0.5, unit: '%', hint: '0 disables' },
    ],
    signal(ctx) {
      const bars = ctx.bars
      const fastN = Math.round(num(ctx.params.fastEma, 12))
      const slowN = Math.max(fastN + 1, Math.round(num(ctx.params.slowEma, 48)))
      if (bars.length < slowN + 2) return { action: 'hold' }
      const stop = stopExit(ctx, num(ctx.params.stopLossPct, 8))
      if (stop) return stop
      const closes = bars.map((b) => b.c)
      const fast = ema(closes, fastN)
      const slow = ema(closes, slowN)
      const prevFast = ema(closes.slice(0, -1), fastN)
      const prevSlow = ema(closes.slice(0, -1), slowN)
      // Trade the crossover itself, not the level: comparing levels alone
      // flips the signal on every wiggle and the fee bill eats the account.
      // A small edge filter skips the weak crosses that only cost money.
      const edge = (fast - slow) / slow
      const crossUp = prevFast <= prevSlow && fast > slow && edge >= 0.0005
      const crossDown = prevFast >= prevSlow && fast < slow
      if (!ctx.position) return crossUp ? { action: 'buy', reason: 'fast EMA crossed above slow EMA' } : { action: 'hold' }
      if (crossDown) return { action: 'sell', reason: 'trend reversal' }
      return { action: 'hold' }
    },
  },
  {
    key: 'mean-reversion',
    name: 'Mean Reversion (Z-Score)',
    summary: 'Buy statistical dips, exit when the price re-centres.',
    description:
      'Measures how far price sits from its rolling mean in standard deviations. Enters when the move is stretched to the downside and exits when price normalises or a stop is hit.',
    risk: 'medium',
    tags: ['Statistical', 'Long only'],
    timeframes: ['5m', '15m', '1h', '4h'],
    lookback: 120,
    params: [
      { key: 'lookback', label: 'Lookback', type: 'number', default: 20, min: 5, max: 200, step: 1, unit: 'bars' },
      { key: 'entryZ', label: 'Entry z-score', type: 'number', default: 1.5, min: 0.5, max: 4, step: 0.1 },
      { key: 'exitZ', label: 'Exit z-score', type: 'number', default: 0.2, min: -2, max: 2, step: 0.1 },
      { key: 'stopLossPct', label: 'Stop loss', type: 'number', default: 9, min: 0, max: 100, step: 0.5, unit: '%', hint: '0 disables' },
    ],
    signal(ctx) {
      const bars = ctx.bars
      const n = Math.round(num(ctx.params.lookback, 20))
      if (bars.length < n + 2) return { action: 'hold' }
      const stop = stopExit(ctx, num(ctx.params.stopLossPct, 9))
      if (stop) return stop
      const closes = bars.map((b) => b.c)
      const mean = sma(closes, n)
      const sd = stdev(closes.slice(-n))
      if (sd <= 0) return { action: 'hold' }
      const z = (closes.at(-1)! - mean) / sd
      const entry = num(ctx.params.entryZ, 1.5)
      const exit = num(ctx.params.exitZ, 0.2)
      if (!ctx.position) return z <= -entry ? { action: 'buy', reason: `oversold at z ${z.toFixed(2)}` } : { action: 'hold' }
      return z >= exit ? { action: 'sell', reason: `re-centred at z ${z.toFixed(2)}` } : { action: 'hold' }
    },
  },
  {
    key: 'breakout',
    name: 'Range Breakout',
    summary: 'Buy new highs, exit on a lower-range break.',
    description:
      'Buys when price closes above the highest high of the preceding window and exits when it closes below the lowest low of the exit window. Fast and aggressive: catches runs, whipsaws flat ranges.',
    risk: 'high',
    tags: ['Momentum', 'Long only'],
    timeframes: ['15m', '1h', '4h', '1d'],
    lookback: 200,
    params: [
      { key: 'highWindow', label: 'Breakout window', type: 'number', default: 55, min: 5, max: 400, step: 1, unit: 'bars' },
      { key: 'lowWindow', label: 'Exit window', type: 'number', default: 20, min: 2, max: 200, step: 1, unit: 'bars' },
      { key: 'stopLossPct', label: 'Stop loss', type: 'number', default: 7, min: 0, max: 100, step: 0.5, unit: '%', hint: '0 disables' },
    ],
    signal(ctx) {
      const bars = ctx.bars
      const highN = Math.round(num(ctx.params.highWindow, 55))
      const lowN = Math.round(num(ctx.params.lowWindow, 20))
      if (bars.length < highN + 2) return { action: 'hold' }
      const stop = stopExit(ctx, num(ctx.params.stopLossPct, 7))
      if (stop) return stop
      const last = bars.at(-1)!
      const prior = bars.slice(0, -1)
      const upper = highest(prior, highN)
      const lower = lowest(prior, lowN)
      if (!ctx.position) return last.c > upper ? { action: 'buy', reason: `break of ${upper.toFixed(2)}` } : { action: 'hold' }
      return last.c < lower ? { action: 'sell', reason: `support broke at ${lower.toFixed(2)}` } : { action: 'hold' }
    },
  },
  {
    key: 'market-making',
    name: 'Market Making',
    summary: 'Capture the spread: buy dips, sell rips, repeat.',
    description:
      'Continuously flips inventory: fills on a down bar, lifts the offer a spread later, and tops up when inventory runs against it. High trade count, thin margin per fill — needs tight fees.',
    risk: 'high',
    tags: ['High turnover', 'Long only'],
    timeframes: ['1m', '5m', '15m'],
    lookback: 64,
    params: [
      { key: 'spreadPct', label: 'Target spread', type: 'number', default: 0.4, min: 0.05, max: 10, step: 0.05, unit: '%' },
      { key: 'inventorySteps', label: 'Inventory steps', type: 'number', default: 3, min: 1, max: 20, step: 1, hint: 'Adds before standing down' },
      { key: 'stopLossPct', label: 'Stop loss', type: 'number', default: 6, min: 0, max: 100, step: 0.5, unit: '%', hint: '0 disables' },
    ],
    signal(ctx) {
      const bars = ctx.bars
      if (bars.length < 3) return { action: 'hold' }
      const stop = stopExit(ctx, num(ctx.params.stopLossPct, 6))
      if (stop) return stop
      const spread = num(ctx.params.spreadPct, 0.4)
      const gain = gainPct(ctx)
      if (gain === null) return { action: 'buy', reason: 'quote filled' }
      if (gain >= spread) return { action: 'sell', reason: `spread captured +${gain.toFixed(2)}%` }
      const steps = Math.max(1, Math.round(num(ctx.params.inventorySteps, 3)))
      const slot = Math.floor(bars.at(-1)!.t / ctx.tfMs) % steps
      if (gain <= -spread && slot === 0) return { action: 'buy', reason: `restock at ${gain.toFixed(2)}%` }
      return { action: 'hold' }
    },
  },
]

export const strategyBy = (key: string): StrategyDef | undefined => STRATEGIES.find((s) => s.key === key)

/** Parameter defaults as a flat record, ready to store on a bot. */
export function defaultParams(strategy: Strategy): Record<string, ParamValue> {
  return Object.fromEntries(strategy.params.map((p) => [p.key, p.default]))
}

/** Coerce and clamp submitted values against the strategy's param schema. */
export function sanitizeParams(strategyKey: string, input: Record<string, unknown> | undefined): Record<string, ParamValue> {
  const strategy = strategyBy(strategyKey)
  const out: Record<string, ParamValue> = {}
  for (const def of strategy?.params ?? []) {
    const raw = input?.[def.key]
    if (def.type === 'number') {
      const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
      const clean = Number.isFinite(value) ? value : Number(def.default)
      out[def.key] = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, clean))
    } else if (def.type === 'boolean') {
      out[def.key] = typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : Boolean(def.default)
    } else {
      const allowed = def.options?.map((o) => o.value) ?? []
      out[def.key] = typeof raw === 'string' && allowed.includes(raw) ? raw : String(def.default)
    }
  }
  return out
}

export const ALL_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d']
