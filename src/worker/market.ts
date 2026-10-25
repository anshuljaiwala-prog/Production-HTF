import type { Timeframe } from '../shared/types'

// Deterministic synthetic market data. Every price comes from a layered value
// noise over the symbol's seed, so the same (symbol, timeframe, timestamp)
// always yields the same OHLC — backtests reproduce exactly and nothing here
// depends on the network. A real feed would replace priceAt/bars wholesale.

export const DAY = 86_400_000

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': DAY,
}

export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface SymbolSpec {
  base: number
  vol: number
  drift: number
  decimals: number
}

const UNIVERSE: Record<string, SymbolSpec> = {
  'BTC-USD': { base: 64_200, vol: 0.11, drift: 0.0009, decimals: 1 },
  'ETH-USD': { base: 3_140, vol: 0.13, drift: 0.0006, decimals: 2 },
  'SOL-USD': { base: 148, vol: 0.17, drift: 0.0011, decimals: 2 },
  NVDA: { base: 128, vol: 0.1, drift: 0.0013, decimals: 2 },
  AAPL: { base: 232, vol: 0.06, drift: 0.0005, decimals: 2 },
  TSLA: { base: 268, vol: 0.12, drift: 0.0007, decimals: 2 },
  SPY: { base: 583, vol: 0.045, drift: 0.0004, decimals: 2 },
}

export const SYMBOL_LIST = Object.keys(UNIVERSE)

// Drift is measured from a fixed anchor date, not from the epoch: otherwise
// 20,000-odd days of compounding turn every symbol into an absurd number.
// Around the anchor, prices sit at their `base` value.
const DRIFT_ANCHOR_DAYS = Date.UTC(2026, 9, 1) / DAY

export const symbolLabel = (symbol: string) => symbol

function specOf(symbol: string): SymbolSpec {
  const spec = UNIVERSE[symbol]
  if (spec) return spec
  // Unknown symbols still get a stable, plausible series.
  return { base: 100 + (seedOf(symbol) % 400), vol: 0.09, drift: 0.0004, decimals: 2 }
}

function hashInt(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

function hash01(a: number, b: number): number {
  return hashInt(a, b) / 4294967296
}

function seedOf(symbol: string): number {
  let h = 2166136261
  for (let i = 0; i < symbol.length; i++) h = Math.imul(h ^ symbol.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Smooth value noise in [-1, 1]. */
function noise(x: number, seed: number): number {
  const i = Math.floor(x)
  const f = x - i
  const a = hash01(seed, i)
  const b = hash01(seed, i + 1)
  const u = f * f * (3 - 2 * f)
  return (a + (b - a) * u) * 2 - 1
}

/** Mid price at an arbitrary timestamp, in milliseconds since the epoch. */
export function priceAt(symbol: string, t: number): number {
  const spec = specOf(symbol)
  const seed = seedOf(symbol)
  const days = t / DAY
  // Three slow swings for regime-like moves, plus two fast layers so intraday
  // bars carry enough movement for strategies to trade on.
  // Layered value noise: slow layers carry the trend, faster layers add
  // realistic churn without dominating it (weights fall off with frequency so
  // variance accumulates with the horizon instead of flatlining).
  const macro = 0.55 * noise(days / 60, seed) + 0.28 * noise(days / 8, seed + 1) + 0.16 * noise(days / 1.4, seed + 2)
  const intraday = 0.09 * noise(days / 0.125, seed + 3)
  const fast = 0.05 * noise(days / 0.02, seed + 4)
  const exponent = spec.drift * (days - DRIFT_ANCHOR_DAYS) + spec.vol * (macro + intraday + fast)
  return round(spec.base * Math.exp(exponent), spec.decimals)
}

export function quote(symbol: string, at: number): number {
  return priceAt(symbol, at)
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

export const priceDecimals = (symbol: string) => specOf(symbol).decimals

/** Bar index of the bar containing `t` for a timeframe (bars open at index * ms). */
export const barIndexAt = (tf: Timeframe, t: number) => Math.floor(t / TIMEFRAME_MS[tf])

/** Index of the newest bar that has fully closed at `t`. */
export const lastClosedIndex = (tf: Timeframe, t: number) => Math.floor(t / TIMEFRAME_MS[tf]) - 1

export function barAt(symbol: string, tf: Timeframe, index: number): Bar {
  const ms = TIMEFRAME_MS[tf]
  const t = index * ms
  const o = priceAt(symbol, t)
  const c = priceAt(symbol, t + ms)
  const seed = seedOf(symbol) ^ Math.imul(index + 1, 2246822519)
  const wickPct = (0.0008 + hash01(seed, 11) * 0.004) / Math.sqrt(ms / 60_000 > 1 ? ms / 60_000 / 5 : 1)
  const hi = Math.max(o, c) * (1 + wickPct * hash01(seed, 12))
  const lo = Math.min(o, c) * (1 - wickPct * hash01(seed, 13))
  const spec = specOf(symbol)
  const volume = Math.round((400 + hash01(seed, 14) * 2200) * (1 + Math.abs(c - o) / o * 40))
  return { t, o: round(o, spec.decimals), h: round(hi, spec.decimals), l: round(lo, spec.decimals), c, v: volume }
}

/** Closed bars with `t` in [from, to], newest last. Bounded by MAX_BARS. */
export const MAX_BARS = 6_000

export function barsBetween(symbol: string, tf: Timeframe, from: number, to: number): Bar[] {
  const ms = TIMEFRAME_MS[tf]
  const first = Math.max(0, Math.floor(from / ms))
  const last = Math.floor(to / ms) - 1
  if (last < first) return []
  const count = Math.min(last - first + 1, MAX_BARS)
  const start = Math.max(first, last - count + 1)
  const bars: Bar[] = []
  for (let i = start; i <= last; i++) bars.push(barAt(symbol, tf, i))
  return bars
}
