import { TIMEFRAME_MS, barsBetween, type Bar } from '../market'
import { analyseSeries } from '../patterns'
import type { AgentMarketRead, AnomalySignal, NewsPin, SymbolPattern } from '../../shared/types'
import { rsi } from '../toolshed/indicators'

// Harvester, ported from market_agent_env's harvester.py and wired to the
// market this platform actually holds. The Python app seeded six world indices
// and a bank of four canned headlines; here the macro markets are catalog
// symbols and the pins are the pattern classifier's read of their tape.
//
// The harvester is pure: every function takes the bars it reads, so the caller
// decides the source. That is what lets the engine and the backtester feed the
// shell the same merged bars they trade (barsForRun ?? synthetic) while the
// macro breadth stays a cheap synthetic read.

/** The markets the macro breadth is read from: six, like the Python app's world
 * positions, but symbols this platform actually quotes. */
export const MACRO_SYMBOLS = ['NVDA', 'AAPL', 'TSLA', 'ASML', 'BTC-USD', 'ETH-USD']

/** Where the harvester's data comes from. The Python app kept an `active_endpoints`
 * dict of URLs; here the sources are the platform's real feeds and the
 * credentials for live venues already live in `connections`, so a second
 * endpoint registry would only duplicate them. */
export const SOURCES = [
  { id: 'bar-store', kind: 'bars', detail: 'D1 rows imported through the market-data API' },
  { id: 'synthetic-feed', kind: 'bars', detail: 'deterministic feed used when a symbol has no stored rows' },
] as const

/**
 * The screener, ported from market_agent_env's harvester.py: nothing reaches the
 * environment until it passes the sanity checks. The Python screens were a
 * confidence threshold on news and OHLC invariants on candles; both survive,
 * with the candle check also rejecting out-of-order and duplicate timestamps,
 * which a merged (stored-over-synthetic) series can produce.
 */
/** Why a bar never reached the rules. Every reject is counted under one of
 * these, so the read says what the tape was rejected for instead of just how
 * many rows were dropped. */
export type BarRejectReason = 'non_finite' | 'non_positive' | 'bad_range' | 'negative_volume' | 'out_of_order'

/** Why a pin never reached the rules. */
export type PinRejectReason = 'missing_fields' | 'sentiment_out_of_range'

export interface BarScreen {
  bars: Bar[]
  rejected: number
  reasons: Partial<Record<BarRejectReason, number>>
}

export function screenBars(bars: Bar[]): BarScreen {
  const clean: Bar[] = []
  const reasons: Partial<Record<BarRejectReason, number>> = {}
  const reject = (reason: BarRejectReason) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  for (const bar of bars) {
    if (![bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite)) {
      reject('non_finite')
      continue
    }
    if (!(bar.o > 0 && bar.h > 0 && bar.l > 0 && bar.c > 0)) {
      reject('non_positive')
      continue
    }
    if (bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c)) {
      reject('bad_range')
      continue
    }
    if (bar.v < 0) {
      reject('negative_volume')
      continue
    }
    const previous = clean.at(-1)
    if (previous && bar.t <= previous.t) {
      reject('out_of_order')
      continue
    }
    clean.push(bar)
  }
  return { bars: clean, rejected: bars.length - clean.length, reasons }
}

/** A pin must carry the fields the rules read and a sentiment inside range.
 * Returns the reason it was dropped, or null when it is admissible. */
export function screenPin(pin: NewsPin): PinRejectReason | null {
  if (!pin.ticker || !pin.title) return 'missing_fields'
  if (!Number.isFinite(pin.sentiment) || Math.abs(pin.sentiment) > 1) return 'sentiment_out_of_range'
  return null
}

export const MACRO_TIMEFRAME = '1h' as const
/** A full day of 1h bars — covers the 24h change and the 20-bar z-window. */
export const MACRO_BARS = 48

/** Volume/price dislocation from the scan's own z-scores: a violent move on
 * heavy volume is a real break, the same move on thin volume a vacuum. */
function anomalyOf(pattern: SymbolPattern | null): AgentMarketRead['anomaly'] {
  if (!pattern || pattern.priceZ === null || pattern.volZ === null) return { signal: 'NORMAL_VARIATION', details: null }
  const { priceZ, volZ } = pattern
  const read = `price z ${priceZ.toFixed(2)}, volume z ${volZ.toFixed(2)}`
  let signal: AnomalySignal = 'NORMAL_VARIATION'
  if (priceZ <= -2.5 && volZ >= 1.5) signal = 'CRASH_TRIGGER'
  else if (priceZ >= 2.5 && volZ >= 1.5) signal = 'BOOM_TRIGGER'
  else if (Math.abs(priceZ) >= 2.5 && volZ < 0.5) signal = 'LIQUIDITY_VACUUM'
  return { signal, details: signal === 'NORMAL_VARIATION' ? null : read }
}

/** Read one market: its 24h change, RSI and dislocation, plus the pattern read
 * the pins are built from. Bars are screened first, so a malformed row cannot
 * skew the change, the RSI or the dislocation it reports. */
export function harvestMarket(
  symbol: string,
  rawBars: Bar[],
): { market: AgentMarketRead; pattern: SymbolPattern | null; rejected: number; reasons: Partial<Record<BarRejectReason, number>> } {
  const { bars, rejected, reasons } = screenBars(rawBars)
  const closes = bars.map((bar) => bar.c)
  const last = closes.at(-1) ?? 0
  const dayAgo = closes.at(-25) ?? closes[0] ?? last
  const pattern = analyseSeries(symbol, bars)

  return {
    pattern,
    rejected,
    reasons,
    market: {
      symbol,
      changePct: round(dayAgo > 0 ? ((last - dayAgo) / dayAgo) * 100 : 0, 2),
      rsi: round(rsi(closes), 1),
      anomaly: anomalyOf(pattern),
    },
  }
}

/** The macro breadth for one read: every tracked market's 1h bars ending at
 * `at`. Synthetic — the breadth is a cheap cross-market read, and a bot's own
 * symbols are the ones that must come from the merged store. */
export function macroBarsAt(at: number): { symbol: string; bars: Bar[] }[] {
  const span = MACRO_BARS * TIMEFRAME_MS[MACRO_TIMEFRAME]
  return MACRO_SYMBOLS.map((symbol) => ({ symbol, bars: barsBetween(symbol, MACRO_TIMEFRAME, at - span, at) }))
}

/** The last `count` bars at or before `at`, from a series sorted oldest first. */
export function windowAt(bars: Bar[], at: number, count = MACRO_BARS): Bar[] {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].t <= at) lo = mid + 1
    else hi = mid
  }
  return bars.slice(Math.max(0, lo - count), lo)
}

/** A tape event worth pinning: only the regimes an operator must act on, and
 * only when the classifier is at least 65% confident. */
export function pinFromPattern(pattern: SymbolPattern | null, at: number): NewsPin | null {
  if (!pattern || pattern.confidence < 65) return null
  const crash = pattern.regime === 'crash' || pattern.regime === 'selloff'
  const hype = pattern.regime === 'hype' || pattern.regime === 'breakout'
  if (!crash && !hype) return null

  const severe = pattern.regime === 'crash' || pattern.regime === 'hype'
  return {
    id: `pin:${pattern.symbol}:${pattern.regime}`,
    ticker: pattern.symbol,
    title: crash
      ? `${pattern.symbol} ${pattern.drawdownPct.toFixed(1)}% off its window high`
      : `${pattern.symbol} ${pattern.runupPct.toFixed(1)}% off its window low`,
    summary: pattern.evidence[0] ?? `${pattern.regime} regime at ${pattern.confidence}% confidence`,
    source: 'tape: patterns',
    timestamp: at,
    impactLevel: pattern.regime === 'crash' && pattern.drawdownPct >= 15 ? 'CRITICAL' : severe ? 'HIGH' : 'MEDIUM',
    sentiment: crash ? (severe ? -0.85 : -0.5) : severe ? 0.75 : 0.5,
  }
}

const round = (value: number, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
