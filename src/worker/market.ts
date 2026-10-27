import { type AssetKind, type SymbolMeta, type Timeframe } from '../shared/types'

// Deterministic synthetic market data. Every price comes from a layered value
// noise over the symbol's seed, so the same (symbol, timeframe, timestamp)
// always yields the same OHLC — backtests reproduce exactly and nothing here
// depends on the network. A real feed would replace priceAt/bars wholesale.
//
// The universe spans asset classes: spot crypto, single-name equities, index
// ETFs, mutual funds (slow, NAV-like paths), commodities, and options. Options
// are modelled as constant-maturity synthetic derivatives over one of the
// underlying series: premium = intrinsic + a wobbling time-value term, so the
// series exhibits delta-like tracking with expiry-style decay. Real option
// chains would arrive through the same bars/quote interface.

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
  kind: AssetKind
  base: number
  vol: number
  drift: number
  decimals: number
}

const UNIVERSE: Record<string, SymbolSpec> = {
  // Crypto
  'BTC-USD': { kind: 'crypto', base: 64_200, vol: 0.11, drift: 0.0009, decimals: 1 },
  'ETH-USD': { kind: 'crypto', base: 3_140, vol: 0.13, drift: 0.0006, decimals: 2 },
  'SOL-USD': { kind: 'crypto', base: 148, vol: 0.17, drift: 0.0011, decimals: 2 },
  // Single-name equities
  NVDA: { kind: 'equity', base: 128, vol: 0.1, drift: 0.0013, decimals: 2 },
  AAPL: { kind: 'equity', base: 232, vol: 0.06, drift: 0.0005, decimals: 2 },
  TSLA: { kind: 'equity', base: 268, vol: 0.12, drift: 0.0007, decimals: 2 },
  // Index ETFs
  SPY: { kind: 'etf', base: 583, vol: 0.045, drift: 0.0004, decimals: 2 },
  QQQ: { kind: 'etf', base: 505, vol: 0.055, drift: 0.0005, decimals: 2 },
  VTI: { kind: 'etf', base: 268, vol: 0.042, drift: 0.0004, decimals: 2 },
  // Mutual funds: calm, NAV-like series
  FXAIX: { kind: 'fund', base: 198, vol: 0.038, drift: 0.0004, decimals: 2 },
  VWELX: { kind: 'fund', base: 48.6, vol: 0.031, drift: 0.00035, decimals: 2 },
  // Commodities: metals and energy
  'XAU-USD': { kind: 'commodity', base: 2_680, vol: 0.05, drift: 0.0005, decimals: 2 },
  'XAG-USD': { kind: 'commodity', base: 31.5, vol: 0.09, drift: 0.0004, decimals: 3 },
  WTI: { kind: 'commodity', base: 71.4, vol: 0.1, drift: 0.0002, decimals: 2 },
  NGAS: { kind: 'commodity', base: 3.2, vol: 0.14, drift: 0.0001, decimals: 3 },
}

/** Synthetic option symbols: UNDERLYING-STRIKE-CALL|PUT-DTE(D). The maturity
 * constant comes from the ticker — V1 models them as always-at-that-maturity. */
export const OPTION_SYMBOLS = [
  'BTC-62000-CALL-30D',
  'BTC-60000-PUT-30D',
  'ETH-3200-CALL-45D',
  'SOL-150-CALL-14D',
  'NVDA-140-CALL-30D',
  'AAPL-240-PUT-45D',
  'SPY-580-PUT-45D',
  'XAU-2800-CALL-30D',
]

export interface OptionSpec {
  underlying: string
  strike: number
  type: 'call' | 'put'
  /** Days to expiry; every option is constant-maturity at its own value. */
  dteDays: number
}

const OPTION_RE = /^([A-Z][A-Z0-9.-]*?)-([0-9]+(?:\.[0-9]+)?)-(CALL|PUT)-(\d+)D$/

export function parseOptionSymbol(symbol: string): OptionSpec | null {
  const match = OPTION_RE.exec(symbol)
  if (!match) return null
  const underlying = UNIVERSE[match[1]] ? match[1] : match[1].endsWith('-USD') ? match[1] : `${match[1]}-USD`
  if (!UNIVERSE[underlying]) return null
  return { underlying, strike: Number(match[2]), type: match[3] === 'CALL' ? 'call' : 'put', dteDays: Math.max(1, Number(match[4])) }
}

export function isOptionSymbol(symbol: string): boolean {
  return parseOptionSymbol(symbol) !== null
}

export const SYMBOL_LIST = [...Object.keys(UNIVERSE), ...OPTION_SYMBOLS]

/** Catalogue metadata: what each symbol is and what it belongs to. */
export function symbolMeta(symbol: string): SymbolMeta {
  const option = parseOptionSymbol(symbol)
  if (option) return { symbol, kind: 'option', underlying: option.underlying, label: `${option.type} ${option.strike} · ${option.dteDays}D` }
  const spec = UNIVERSE[symbol]
  return { symbol, kind: spec ? spec.kind : 'equity' }
}

export const SYMBOL_METAS: SymbolMeta[] = SYMBOL_LIST.map(symbolMeta)

export const symbolClass = (symbol: string): AssetKind => symbolMeta(symbol).kind

// Drift is measured from a fixed anchor date, not from the epoch: otherwise
// 20,000-odd days of compounding turn every symbol into an absurd number.
// Around the anchor, prices sit at their `base` value.
const DRIFT_ANCHOR_DAYS = Date.UTC(2026, 9, 1) / DAY

export const symbolLabel = (symbol: string) => symbol

function specOf(symbol: string): SymbolSpec {
  const spec = UNIVERSE[symbol]
  if (spec) return spec
  // Unknown symbols still get a stable, plausible series.
  return { kind: 'equity', base: 100 + (seedOf(symbol) % 400), vol: 0.09, drift: 0.0004, decimals: 2 }
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

/** Underlying mid price at an arbitrary timestamp (never routed through the
 * option model, so calls stay well-defined against their own underlying). */
function underlyingPriceAt(symbol: string, t: number): number {
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

/**
 * Option premium model (constant maturity): intrinsic value plus a synthetic
 * time-value term. Time value peaks at-the-money, fades as the underlying
 * moves away, and wobbles per (index, symbol) so the series is tradeable and
 * reproducible while still reading as "decay". Not a Black-Scholes price —
 * a real chain model is exactly what the broker seam is for.
 */
function optionPremiumAt(option: OptionSpec, underlyingPrice: number, wobbleTime: number): number {
  const intrinsic = Math.max(0, option.type === 'call' ? underlyingPrice - option.strike : option.strike - underlyingPrice)
  const moneyness = Math.min(1, Math.abs(underlyingPrice - option.strike) / (option.strike * 0.35))
  const undSpec = specOf(option.underlying)
  const seed = seedOf(`${option.underlying}-${option.strike}-${option.type}-${option.dteDays}D`)
  // Same derivation as seedOf of the option symbol itself: both call sites
  // (quote and bar construction) agree on the series deterministically.
  // Width of the time-value skirt scaled to the underlying's volatility.
  const tvBase = option.strike * undSpec.vol * 0.045
  const wobble = 0.7 + 0.6 * Math.max(0, noise(wobbleTime / (2.5 * DAY), seed)) // decays between wobbles
  const tv = tvBase * (1 - moneyness) * wobble
  return Math.max(0.02, round(intrinsic + tv, 2))
}

/** Mid price at an arbitrary timestamp, in milliseconds since the epoch. */
export function priceAt(symbol: string, t: number): number {
  const option = parseOptionSymbol(symbol)
  if (option) {
    const und = underlyingPriceAt(option.underlying, t)
    return optionPremiumAt(option, und, t)
  }
  return underlyingPriceAt(symbol, t)
}

export function quote(symbol: string, at: number): number {
  return priceAt(symbol, at)
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

export const priceDecimals = (symbol: string) => (parseOptionSymbol(symbol) ? 2 : specOf(symbol).decimals)

/** Bar index of the bar containing `t` for a timeframe (bars open at index * ms). */
export const barIndexAt = (tf: Timeframe, t: number) => Math.floor(t / TIMEFRAME_MS[tf])

/** Index of the newest bar that has fully closed at `t`. */
export const lastClosedIndex = (tf: Timeframe, t: number) => Math.floor(t / TIMEFRAME_MS[tf]) - 1

export function barAt(symbol: string, tf: Timeframe, index: number): Bar {
  const ms = TIMEFRAME_MS[tf]
  const t = index * ms
  const option = parseOptionSymbol(symbol)
  if (option) {
    // Option bars: map the underlying bar's OHLC through the premium model,
    // then re-derive the wick spread from an option-seeded jitter so the
    // candle shapes stay plausible without breaking monotonicity. Open and
    // close carry separate time-value wobble phases so intrabar theta is
    // visible on faster tapes.
    const undBar = barAt(option.underlying, tf, index)
    const o = optionPremiumAt(option, undBar.o, t + ms * 0.1)
    const c = optionPremiumAt(option, undBar.c, t + ms * 0.9)
    const seed = seedOf(symbol) ^ Math.imul(index + 1, 1103515245)
    const wickPct = (0.002 + hash01(seed, 31) * 0.01) / Math.sqrt(ms / 60_000 > 1 ? ms / 60_000 / 5 : 1)
    const hi = Math.max(o, c) * (1 + wickPct * hash01(seed, 32))
    const lo = Math.min(o, c) * (1 - wickPct * hash01(seed, 33))
    const volume = Math.round((80 + hash01(seed, 34) * 900) * (1 + Math.abs(c - o) / Math.max(0.02, o) * 40))
    return { t, o, h: round(hi, 2), l: round(lo, 2), c, v: volume }
  }
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
