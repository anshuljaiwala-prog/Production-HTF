import type {
  AssetKind,
  BotPatterns,
  CrisisEpisode,
  EpisodeMatch,
  FleetPatternEntry,
  FleetPatternRanking,
  FleetRegime,
  MarketEvent,
  PatternRegime,
  SymbolPattern,
  Timeframe,
} from '../shared/types'
import type { Bot } from '../shared/types'
import { DAY, TIMEFRAME_MS, barsBetween, historyStart, symbolMeta } from './market'
import { barsForRun } from './marketstore'

// Pattern scan: every tracked symbol is described by what its tape did — not
// by a guess about what a chart "looks like". A crash is a deep drawdown with
// a fast recent leg, a hype the mirror of it, a squeeze compressed volatility.
// The same read is then scored against the largest crashes and hypes on
// record, and against what the market is doing right now (the event wire in
// deriveEvents below), so a bot's pattern read always carries its context.
//
// Everything here reads the merged store (imported bars over the synthetic
// feed) that the engine and backtester replay, so the scan describes exactly
// the bars the bot traded.

/** Bars analysed per symbol: enough for a 240-bar regime read at any
 * timeframe while staying inside the five-year retention window. */
export const ANALYSIS_BARS = 240
const RECENT_BARS = 20
const TREND_BARS = 50
const BLOCK_BARS = 20
const MAX_SPARK = 40
const MIN_EXCURSION_PCT = 5
const MAX_EPISODE_MATCHES = 4

const round = (value: number, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
const signed = (value: number, decimals = 2) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(decimals)}%`

function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function returns(bars: { c: number }[]): number[] {
  const out: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c
    if (prev > 0) out.push((bars[i].c - prev) / prev)
  }
  return out
}

const ordinal = (value: number) => {
  const n = Math.round(value)
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/** Volatility context: where the latest 20-bar realised volatility sits among
 * the same measure over the rest of the window (0–100), and how many times the
 * window's median block volatility it is. The percentile alone would call a
 * dead-calm tape a spike; the multiple is what makes the claim mean something. */
function volatilityContext(barReturns: number[]): { percentile: number; vsMedian: number } {
  const recentVol = stdev(barReturns.slice(-BLOCK_BARS))
  if (!Number.isFinite(recentVol) || barReturns.length < BLOCK_BARS * 2) return { percentile: 50, vsMedian: 1 }
  const blocks: number[] = []
  for (let end = BLOCK_BARS; end <= barReturns.length; end += BLOCK_BARS) {
    blocks.push(stdev(barReturns.slice(end - BLOCK_BARS, end)))
  }
  if (blocks.length === 0) return { percentile: 50, vsMedian: 1 }
  const sorted = [...blocks].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  const below = blocks.filter((vol) => vol < recentVol).length
  return {
    percentile: clamp(Math.round((below / blocks.length) * 100), 0, 100),
    vsMedian: median > 0 ? round(recentVol / median, 2) : 1,
  }
}

// Volume read. A price move means something different on heavy participation
// than on none: a violent excursion on thin volume is the tape being pushed
// through an empty book, not money agreeing with the move. These are the
// thresholds for that distinction, measured in standard deviations of the
// recent window's closes and volumes.
const DISLOCATION_PRICE_Z = 2.5
const CONFIRMING_VOLUME_Z = 0.5
const HEAVY_VOLUME_Z = 1.5

/** How far the last value sits from the window mean, in standard deviations.
 * Null when the series is flat or too short — a z-score against zero
 * dispersion would be infinite rather than informative. */
function zScore(values: number[]): number | null {
  if (values.length < 3) return null
  const sd = stdev(values)
  if (!(sd > 0)) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  return (values[values.length - 1] - mean) / sd
}

/** Sample a series down to a sparkline-sized window. */
function sampleSeries(values: number[]): number[] {
  if (values.length <= MAX_SPARK) return values
  const step = (values.length - 1) / (MAX_SPARK - 1)
  return Array.from({ length: MAX_SPARK }, (_, i) => values[Math.round(i * step)])
}

/** One symbol's pattern read. Callers pass closed bars, oldest first. */
export function analyseSeries(symbol: string, bars: { t: number; h: number; l: number; c: number; v?: number }[], positionQty = 0): SymbolPattern | null {
  if (bars.length < RECENT_BARS + 2) return null
  const window = bars.slice(-ANALYSIS_BARS)
  const last = window[window.length - 1]
  const first = window[0]
  if (!last || !first || first.c <= 0) return null

  let highIndex = 0
  let lowIndex = 0
  for (let i = 1; i < window.length; i++) {
    if (window[i].h > window[highIndex].h) highIndex = i
    if (window[i].l < window[lowIndex].l) lowIndex = i
  }
  const maxHigh = window[highIndex].h
  const minLow = window[lowIndex].l
  const lastIndex = window.length - 1

  const drawdownPct = maxHigh > 0 ? Math.max(0, (maxHigh - last.c) / maxHigh) * 100 : 0
  const runupPct = minLow > 0 ? Math.max(0, (last.c - minLow) / minLow) * 100 : 0
  const changePct = first.c > 0 ? ((last.c - first.c) / first.c) * 100 : 0
  const recentBase = window[Math.max(0, lastIndex - RECENT_BARS)].c
  const recentPct = recentBase > 0 ? ((last.c - recentBase) / recentBase) * 100 : 0
  const trendBase = window[Math.max(0, lastIndex - TREND_BARS)].c
  const trendPct = trendBase > 0 ? ((last.c - trendBase) / trendBase) * 100 : 0

  const barReturns = returns(window)
  const volPct = stdev(barReturns) * 100
  const { percentile: volPercentile, vsMedian: volVsMedian } = volatilityContext(barReturns)

  // The volume read, on the same recent window as the price leg: how far the
  // latest close and the latest bar's volume sit from their own means. Both
  // are needed — a price z-score alone cannot tell a real break from a move
  // nobody traded through.
  const recentBars = window.slice(-RECENT_BARS)
  const priceZ = zScore(recentBars.map((bar) => bar.c))
  const volZ = zScore(recentBars.map((bar) => bar.v ?? 0))
  const liquidityVacuum =
    priceZ !== null && volZ !== null && Math.abs(priceZ) >= DISLOCATION_PRICE_Z && volZ < CONFIRMING_VOLUME_Z

  const barsSinceHigh = lastIndex - highIndex
  const barsSinceLow = lastIndex - lowIndex
  // The reference high for a breakout: the window high *before* the final bar,
  // so a fresh high on the last bar is measured against prior structure.
  const priorHigh = window.slice(0, lastIndex).reduce((hi, bar) => Math.max(hi, bar.h), first.h)

  let regime: PatternRegime = 'range'
  let confidence = 45
  const evidence: string[] = []

  const deepDrawdown = drawdownPct >= 10 && recentPct <= -4
  const fastRunup = runupPct >= 12 && recentPct >= 5
  const freshHigh = last.c >= priorHigh * 0.999

  if (deepDrawdown) {
    regime = 'crash'
    // Strength: how far past both thresholds the tape is, in threshold units.
    const strength = Math.min(3, (drawdownPct - 10) / 10 + Math.abs(recentPct + 4) / 8)
    confidence = clamp(Math.round(55 + strength * 14), 55, 98)
    evidence.push(
      `${signed(-drawdownPct, 1)} from the ${window.length}-bar high, set ${barsSinceHigh} ${barsSinceHigh === 1 ? 'bar' : 'bars'} ago`,
      `${barsSinceHigh <= RECENT_BARS ? 'the leg is still running' : 'the low was reached earlier'}: last ${RECENT_BARS} bars ${signed(recentPct, 1)}`,
      `volatility ${volPct.toFixed(2)}%/bar — ${ordinal(volPercentile)} percentile of this window`,
    )
  } else if (fastRunup) {
    regime = 'hype'
    const strength = Math.min(3, (runupPct - 12) / 12 + Math.abs(recentPct - 5) / 8)
    confidence = clamp(Math.round(55 + strength * 14), 55, 98)
    evidence.push(
      `${signed(runupPct, 1)} above the ${window.length}-bar low, set ${barsSinceLow} ${barsSinceLow === 1 ? 'bar' : 'bars'} ago`,
      `last ${RECENT_BARS} bars ${signed(recentPct, 1)} — ${recentPct >= 12 ? 'vertical' : 'accelerating'}`,
      `volatility ${volPct.toFixed(2)}%/bar — ${ordinal(volPercentile)} percentile of this window`,
    )
  } else if (freshHigh && volPercentile >= 50 && drawdownPct <= 3) {
    regime = 'breakout'
    confidence = clamp(Math.round(48 + (volPercentile - 50) * 0.5 + Math.min(20, runupPct)), 48, 90)
    evidence.push(
      `close at a new ${window.length}-bar high (prior high ${priorHigh.toFixed(2)})`,
      `run-up ${signed(runupPct, 1)} over ${barsSinceLow} bars`,
      `volatility expanding — ${ordinal(volPercentile)} percentile`,
    )
  } else if (drawdownPct >= 5) {
    regime = 'selloff'
    confidence = clamp(Math.round(48 + (drawdownPct - 5) * 3), 48, 88)
    evidence.push(
      `${signed(-drawdownPct, 1)} from the ${window.length}-bar high, set ${barsSinceHigh} bars ago`,
      `last ${RECENT_BARS} bars ${signed(recentPct, 1)} — ${recentPct < 0 ? 'still leaking' : 'stabilising'}`,
      `trend ${signed(trendPct, 1)} over ${Math.min(TREND_BARS, lastIndex)} bars`,
    )
  } else if (volPercentile <= 20 && drawdownPct < 5 && runupPct < 10) {
    regime = 'squeeze'
    confidence = clamp(Math.round(50 + (20 - volPercentile) * 2), 50, 88)
    evidence.push(
      `volatility ${volPct.toFixed(2)}%/bar — ${ordinal(volPercentile)} percentile, compressed`,
      `price inside a ${(drawdownPct + runupPct).toFixed(1)}% band for the last ${barsSinceHigh} bars`,
      'compressed ranges precede expansion — direction is not yet set',
    )
  } else if (trendPct >= 3) {
    regime = 'uptrend'
    confidence = clamp(Math.round(45 + trendPct * 2), 45, 85)
    evidence.push(
      `trend ${signed(trendPct, 1)} over ${Math.min(TREND_BARS, lastIndex)} bars`,
      `drawdown held to ${drawdownPct.toFixed(1)}% from the window high`,
      `window return ${signed(changePct, 1)} (${window.length} bars)`,
    )
  } else if (trendPct <= -3) {
    regime = 'downtrend'
    confidence = clamp(Math.round(45 + Math.abs(trendPct) * 2), 45, 85)
    evidence.push(
      `trend ${signed(trendPct, 1)} over ${Math.min(TREND_BARS, lastIndex)} bars`,
      `drawdown ${drawdownPct.toFixed(1)}% with no 10%+ flush on the recent leg`,
      `window return ${signed(changePct, 1)} (${window.length} bars)`,
    )
  } else {
    evidence.push(
      `window return ${signed(changePct, 1)} with no dominant slope (${signed(trendPct, 1)} over ${Math.min(TREND_BARS, lastIndex)} bars)`,
      `range ${(drawdownPct + runupPct).toFixed(1)}% between the window extremes`,
      `volatility ${ordinal(volPercentile)} percentile`,
    )
  }

  // One extra evidence line for the volume read, so the number behind the
  // flag travels with the rest of the read instead of living only in the UI.
  if (priceZ !== null && volZ !== null) {
    const z = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}σ`
    const read = `price ${z(priceZ)} against volume ${z(volZ)} over the last ${recentBars.length} bars`
    if (liquidityVacuum) evidence.push(`${read} — a dislocation on thin volume, not confirmed by participation`)
    else if (Math.abs(priceZ) >= DISLOCATION_PRICE_Z && volZ >= HEAVY_VOLUME_Z) evidence.push(`${read} — the move is confirmed by participation`)
    else evidence.push(`${read} — participation ${volZ >= HEAVY_VOLUME_Z ? 'heavy' : volZ < CONFIRMING_VOLUME_Z ? 'thin' : 'normal'}`)
  }

  return {
    symbol,
    kind: symbolMeta(symbol).kind as AssetKind,
    price: round(last.c, 6),
    changePct: round(changePct),
    recentPct: round(recentPct),
    trendPct: round(trendPct),
    drawdownPct: round(drawdownPct),
    runupPct: round(runupPct),
    volPct: round(volPct, 3),
    volPercentile,
    volVsMedian,
    priceZ: priceZ === null ? null : round(priceZ, 2),
    volZ: volZ === null ? null : round(volZ, 2),
    liquidityVacuum,
    barsSinceHigh,
    barsSinceLow,
    regime,
    confidence,
    evidence,
    spark: sampleSeries(window.map((bar) => bar.c)),
    positionQty: round(positionQty, 6),
  }
}

// --- Historic crashes and hypes --------------------------------------------

/** The largest crashes and hypes on record, with the published peak-to-trough
 * (crash) or low-to-peak (hype) moves and rough durations. These are the
 * references the scanner scores a current tape against; the comparison is of
 * shape (magnitude, speed, volatility expansion), never a prediction. */
export const CRISIS_EPISODES: CrisisEpisode[] = [
  {
    id: 'wall-street-1929',
    name: 'Wall Street Crash',
    kind: 'crash',
    period: 'Sep 1929 – Jul 1932',
    magnitudePct: -89,
    days: 1_030,
    volMultiple: 2.6,
    assets: ['Dow Jones', 'US equities'],
    what: 'The 1929 break unwound into a three-year deflationary bear market — the deepest equity drawdown of the century.',
  },
  {
    id: 'black-monday-1987',
    name: 'Black Monday',
    kind: 'crash',
    period: 'Oct 1987',
    magnitudePct: -33,
    days: 5,
    volMultiple: 5.5,
    assets: ['S&P 500', 'global equities'],
    what: 'A single-session −22.6% collapse on programme-trading feedback, followed by a violent but short-lived recovery.',
  },
  {
    id: 'asian-crisis-1997',
    name: 'Asian financial crisis',
    kind: 'crash',
    period: 'Jul 1997 – Jan 1998',
    magnitudePct: -60,
    days: 190,
    volMultiple: 3.2,
    assets: ['THB', 'KRW', 'emerging Asia equities'],
    what: 'Currency pegs broke in sequence, forcing rate spikes and equity collapses across emerging Asia.',
  },
  {
    id: 'dotcom-2000',
    name: 'Dot-com bust',
    kind: 'crash',
    period: 'Mar 2000 – Oct 2002',
    magnitudePct: -78,
    days: 930,
    volMultiple: 2.4,
    assets: ['Nasdaq', 'growth equities'],
    what: 'The internet-capex bubble deflated over 2.5 years; most loss came in the first twelve months.',
  },
  {
    id: 'gfc-2008',
    name: 'Global financial crisis',
    kind: 'crash',
    period: 'Oct 2007 – Mar 2009',
    magnitudePct: -57,
    days: 517,
    volMultiple: 3.6,
    assets: ['S&P 500', 'banks', 'credit'],
    what: 'Housing-linked credit losses became a funding run; equities halved with volatility multiples of the prior year.',
  },
  {
    id: 'flash-crash-2010',
    name: 'Flash Crash',
    kind: 'crash',
    period: 'May 2010',
    magnitudePct: -9,
    days: 1,
    volMultiple: 6.5,
    assets: ['S&P 500', 'ETFs'],
    what: 'An intraday liquidity vacuum took the index down ~9% in minutes before a full retrace — extreme speed, shallow depth.',
  },
  {
    id: 'china-2015',
    name: 'China devaluation shock',
    kind: 'crash',
    period: 'Jun 2015 – Feb 2016',
    magnitudePct: -45,
    days: 180,
    volMultiple: 2.9,
    assets: ['Shanghai Composite', 'CNY', 'commodities'],
    what: 'Margin-funded retail leverage unwound, then a surprise CNY devaluation exported the shock to global risk assets.',
  },
  {
    id: 'crypto-winter-2018',
    name: 'Crypto winter',
    kind: 'crash',
    period: 'Dec 2017 – Dec 2018',
    magnitudePct: -84,
    days: 360,
    volMultiple: 2.1,
    assets: ['BTC', 'ETH', 'altcoins'],
    what: 'The 2017 retail mania reversed; a long grind lower with repeated failed 20%+ bounces.',
  },
  {
    id: 'covid-crash-2020',
    name: 'COVID crash',
    kind: 'crash',
    period: 'Feb – Mar 2020',
    magnitudePct: -34,
    days: 33,
    volMultiple: 5.0,
    assets: ['S&P 500', 'credit', 'oil'],
    what: 'A pandemic shock compressed a bear market into five weeks; the fastest 30%+ drawdown on record.',
  },
  {
    id: 'tech-rout-2022',
    name: 'Rate-shock tech rout',
    kind: 'crash',
    period: 'Jan – Dec 2022',
    magnitudePct: -35,
    days: 250,
    volMultiple: 2.0,
    assets: ['Nasdaq', 'long-duration bonds', 'crypto'],
    what: 'Policy tightening repriced duration assets together — a slow, correlated grind rather than a single break.',
  },
  {
    id: 'svb-2023',
    name: 'Regional-bank crisis',
    kind: 'crash',
    period: 'Mar 2023',
    magnitudePct: -60,
    days: 21,
    volMultiple: 4.4,
    assets: ['regional banks', 'Treasuries'],
    what: 'A deposit run at SVB took the regional-bank index down ~60% in three weeks while mega-caps held.',
  },
  {
    id: 'crypto-hype-2017',
    name: 'ICO mania',
    kind: 'hype',
    period: 'Jan – Dec 2017',
    magnitudePct: 1_300,
    days: 340,
    volMultiple: 2.2,
    assets: ['BTC', 'ETH', 'altcoins'],
    what: 'Retail inflows and token launches produced a near-vertical year, ending with a 65% break in weeks.',
  },
  {
    id: 'meme-squeeze-2021',
    name: 'Meme-stock squeeze',
    kind: 'hype',
    period: 'Jan 2021',
    magnitudePct: 1_700,
    days: 20,
    volMultiple: 8.0,
    assets: ['GME', 'AMC', 'retail flow'],
    what: 'A short squeeze drove a small-cap up 17x in under a month on extreme volume, then halved twice.',
  },
  {
    id: 'covid-liquidity-2020',
    name: 'Liquidity-fueled melt-up',
    kind: 'hype',
    period: 'Apr – Dec 2020',
    magnitudePct: 70,
    days: 250,
    volMultiple: 2.4,
    assets: ['Nasdaq', 'growth equities', 'crypto'],
    what: 'Fiscal transfers and zero rates produced a fast, broad re-rating under a still-elevated volatility regime.',
  },
  {
    id: 'ai-hype-2024',
    name: 'AI capex mania',
    kind: 'hype',
    period: '2023 – 2025',
    magnitudePct: 800,
    days: 700,
    volMultiple: 1.7,
    assets: ['NVDA', 'AI suppliers', 'hyperscalers'],
    what: 'Datacentre capex guidance kept beating; a concentrated, persistent uptrend with shallow pullbacks.',
  },
]

/** Bars the current leg took, converted to days so it can be compared with an
 * episode's calendar duration. */
function barsToDays(bars: number, timeframe: Timeframe): number {
  return Math.max(0.5, (bars * TIMEFRAME_MS[timeframe]) / DAY)
}

/** Score one symbol against the episodes of the matching direction. */
export function matchEpisodes(patterns: SymbolPattern[], timeframe: Timeframe): EpisodeMatch[] {
  const matches: EpisodeMatch[] = []
  for (const pattern of patterns) {
    const crashLeg = pattern.drawdownPct >= pattern.runupPct
    const magnitude = crashLeg ? pattern.drawdownPct : pattern.runupPct
    if (magnitude < MIN_EXCURSION_PCT) continue
    const kind = crashLeg ? 'crash' : 'hype'
    const legBars = crashLeg ? pattern.barsSinceHigh : pattern.barsSinceLow
    const legDays = barsToDays(legBars, timeframe)
    // Percentile → an implied volatility multiple (1x calm … 6x extreme).
    const volMultiple = 1 + (pattern.volPercentile / 100) * 5

    for (const episode of CRISIS_EPISODES) {
      if (episode.kind !== kind) continue
      const episodeMagnitude = Math.abs(episode.magnitudePct)
      // Magnitude: relative distance, so 12% vs 34% reads closer than 12% vs 89%.
      const magnitudeScore = 1 - Math.min(1, Math.abs(magnitude - episodeMagnitude) / Math.max(magnitude, episodeMagnitude))
      // Speed: log ratio of the two durations; three doublings off scores zero.
      const speedScore = 1 - Math.min(1, Math.abs(Math.log2(legDays / episode.days)) / 3)
      // Volatility: relative distance between the implied multiple and the episode's.
      const volScore = 1 - Math.min(1, Math.abs(volMultiple - episode.volMultiple) / Math.max(volMultiple, episode.volMultiple))
      const similarity = Math.round((magnitudeScore * 0.55 + speedScore * 0.25 + volScore * 0.2) * 100)
      if (similarity < 30) continue
      matches.push({
        episode,
        symbol: pattern.symbol,
        similarity,
        why: `${signed(crashLeg ? -magnitude : magnitude, 1)} in ${legBars} ${legBars === 1 ? 'bar' : 'bars'} (≈${legDays < 1 ? `${Math.round(legDays * 24)}h` : `${Math.round(legDays)}d`}) at the ${ordinal(pattern.volPercentile)} volatility percentile`,
      })
    }
  }
  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, MAX_EPISODE_MATCHES)
}

/** What the market is doing right now, derived from the tracked symbols' own
 * tapes: the drawdowns, run-ups, volatility spikes and breadth that a pattern
 * read has to be understood against. Deterministic for a given clock, so the
 * panel does not flicker between polls. */
export function deriveEvents(patterns: SymbolPattern[], at: number): MarketEvent[] {
  const events: MarketEvent[] = []
  for (const pattern of patterns) {
    if (pattern.drawdownPct >= 8 && (pattern.regime === 'crash' || pattern.regime === 'selloff')) {
      events.push({
        id: `drawdown-${pattern.symbol}`,
        kind: 'drawdown',
        severity: pattern.regime === 'crash' ? 'alert' : 'warn',
        headline: `${pattern.symbol} ${signed(-pattern.drawdownPct, 1)} from its window high`,
        detail: `${pattern.regime} regime with ${pattern.confidence}% confidence — ${pattern.evidence[1] ?? pattern.evidence[0]}`,
        symbols: [pattern.symbol],
        value: pattern.drawdownPct,
        at,
      })
    }
    if (pattern.runupPct >= 10 && (pattern.regime === 'hype' || pattern.regime === 'breakout')) {
      events.push({
        id: `runup-${pattern.symbol}`,
        kind: 'runup',
        severity: pattern.regime === 'hype' ? 'warn' : 'info',
        headline: `${pattern.symbol} ${signed(pattern.runupPct, 1)} off its window low`,
        detail: `${pattern.regime} regime with ${pattern.confidence}% confidence — ${pattern.evidence[1] ?? pattern.evidence[0]}`,
        symbols: [pattern.symbol],
        value: pattern.runupPct,
        at,
      })
    }
    // A high percentile on a dead-calm tape is not a spike: demand the recent
    // volatility also be at least double the window's median.
    if (pattern.volPercentile >= 90 && pattern.volVsMedian >= 2) {
      events.push({
        id: `vol-${pattern.symbol}`,
        kind: 'vol-spike',
        severity: 'warn',
        headline: `${pattern.symbol} volatility spike`,
        detail: `Realised volatility ${pattern.volPct.toFixed(2)}%/bar — ${pattern.volVsMedian.toFixed(1)}× the window median, ${ordinal(pattern.volPercentile)} percentile.`,
        symbols: [pattern.symbol],
        value: pattern.volPercentile,
        at,
      })
    }
  }

  // Breadth: when most of the tracked book leans the same way it is a shared
  // shock, not a single-name move — the distinction an operator acts on.
  const riskOff = patterns.filter((p) => p.regime === 'crash' || p.regime === 'selloff' || p.regime === 'downtrend')
  const riskOn = patterns.filter((p) => p.regime === 'hype' || p.regime === 'breakout' || p.regime === 'uptrend')
  const majority = Math.ceil(patterns.length / 2)
  if (patterns.length > 1 && riskOff.length >= majority) {
    events.push({
      id: 'breadth-stress',
      kind: 'stress',
      severity: 'alert',
      headline: `Broad stress: ${riskOff.length} of ${patterns.length} tracked symbols are risk-off`,
      detail: `A shared drawdown, not a single-name move — ${riskOff.map((p) => p.symbol).join(', ')}.`,
      symbols: riskOff.map((p) => p.symbol),
      value: riskOff.length,
      at,
    })
  } else if (patterns.length > 1 && riskOn.length >= majority) {
    events.push({
      id: 'breadth-risk-on',
      kind: 'breadth',
      severity: 'info',
      headline: `Broad risk-on: ${riskOn.length} of ${patterns.length} tracked symbols are trending up`,
      detail: `${riskOn.map((p) => p.symbol).join(', ')} — a market-wide bid rather than one leader.`,
      symbols: riskOn.map((p) => p.symbol),
      value: riskOn.length,
      at,
    })
  }

  const rank = { alert: 0, warn: 1, info: 2 } as const
  return events
    .sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 8)
}

/** Full scan for one bot: every tracked symbol read on its own timeframe, the
 * positions it holds, the historic analogs and the current event wire. */
export async function analyseBotPatterns(
  db: D1Database,
  bot: Bot,
  clock: number,
  /** Fleet scans share one read per symbol+timeframe: bots that trade the same
   * market are scored on identical bars. Keyed by `${timeframe}|${symbol}`. */
  barCache?: Map<string, ReturnType<typeof barsBetween>>,
): Promise<BotPatterns> {
  const tfMs = TIMEFRAME_MS[bot.timeframe]
  const to = clock
  const requestedFrom = clock - ANALYSIS_BARS * tfMs
  const from = Math.max(requestedFrom, historyStart(clock))

  const positionRows = await db
    .prepare(`SELECT symbol, qty FROM positions WHERE bot_id = ?`)
    .bind(bot.id)
    .all<{ symbol: string; qty: number }>()
  const held = new Map((positionRows.results ?? []).map((row) => [String(row.symbol), Number(row.qty)]))

  const patterns: SymbolPattern[] = []
  for (const symbol of bot.symbols) {
    const cacheKey = `${bot.timeframe}|${symbol}`
    let bars = barCache?.get(cacheKey)
    if (!bars) {
      const merged = await barsForRun(db, symbol, bot.timeframe, from, to + 1)
      bars = merged ?? barsBetween(symbol, bot.timeframe, from, to + 1)
      barCache?.set(cacheKey, bars)
    }
    const pattern = analyseSeries(symbol, bars, held.get(symbol) ?? 0)
    if (pattern) patterns.push(pattern)
  }

  return {
    botId: bot.id,
    timeframe: bot.timeframe,
    generatedAt: clock,
    window: {
      from: patterns.length > 0 ? clock - ANALYSIS_BARS * tfMs : from,
      to,
      bars: ANALYSIS_BARS,
    },
    symbols: patterns,
    episodes: matchEpisodes(patterns, bot.timeframe),
    events: deriveEvents(patterns, clock),
  }
}

// --- Fleet-wide pattern ranking -------------------------------------------

const isFleetRegime = (regime: PatternRegime): regime is FleetRegime =>
  regime === 'crash' || regime === 'hype' || regime === 'squeeze'

/** How far past the regime's own threshold the tape sits, 0–100. A 10%
 * drawdown is the minimum crash, 40% the maximum; the mirror for a hype at
 * 12%→42%; a squeeze runs from the 20th volatility percentile to the calmest
 * decile. Kept separate from confidence so the ranking can show both the
 * classifier's certainty and the size of the move behind it. */
export function regimeIntensity(pattern: SymbolPattern): number {
  switch (pattern.regime) {
    case 'crash':
      return clamp(Math.round(((pattern.drawdownPct - 10) / 30) * 100), 0, 100)
    case 'hype':
      return clamp(Math.round(((pattern.runupPct - 12) / 30) * 100), 0, 100)
    case 'squeeze':
      return clamp(Math.round((20 - pattern.volPercentile) * 5), 0, 100)
    default:
      return 0
  }
}

/** Rank the fleet by what its markets are doing right now: each bot is scored
 * on its strongest crash / hype / squeeze read, so the list leads with the
 * bots whose book is most exposed to a regime an operator must act on. A bot
 * with a position in that market is lifted 10%: same tape, real exposure.
 * Every read comes from the merged feed the engine replay uses, and is cached
 * per symbol+timeframe so shared markets cost one read. */
export async function rankFleetPatterns(db: D1Database, bots: Bot[], clock: number): Promise<FleetPatternRanking> {
  const barCache = new Map<string, ReturnType<typeof barsBetween>>()
  const rows: Omit<FleetPatternEntry, 'rank'>[] = []
  const holding = new Set<string>()

  for (const bot of bots) {
    const read = await analyseBotPatterns(db, bot, clock, barCache)
    const matching = read.symbols.filter(
      (pattern): pattern is SymbolPattern & { regime: FleetRegime } => isFleetRegime(pattern.regime),
    )
    if (matching.length === 0) continue

    const breakdown: Record<FleetRegime, number> = { crash: 0, hype: 0, squeeze: 0 }
    for (const pattern of matching) breakdown[pattern.regime] += 1
    if (matching.some((pattern) => pattern.positionQty !== 0)) holding.add(bot.id)

    const scored = matching
      .map((pattern) => {
        const intensity = regimeIntensity(pattern)
        const base = pattern.confidence * 0.65 + intensity * 0.35
        const score = clamp(Math.round(base * (pattern.positionQty !== 0 ? 1.1 : 1)), 0, 100)
        return { pattern, intensity, score }
      })
      .sort((a, b) => b.score - a.score || b.pattern.confidence - a.pattern.confidence || b.intensity - a.intensity)

    const best = scored[0]
    if (!best) continue
    const { pattern } = best
    rows.push({
      botId: bot.id,
      name: bot.name,
      strategyName: bot.strategyName,
      status: bot.status,
      stage: bot.stage,
      mode: bot.mode,
      timeframe: bot.timeframe,
      symbol: pattern.symbol,
      regime: pattern.regime,
      score: best.score,
      confidence: pattern.confidence,
      intensity: best.intensity,
      positionQty: pattern.positionQty,
      others: scored.slice(1).map((entry) => entry.pattern.symbol),
      breakdown,
      changePct: pattern.changePct,
      recentPct: pattern.recentPct,
      drawdownPct: pattern.drawdownPct,
      runupPct: pattern.runupPct,
      volPercentile: pattern.volPercentile,
      volZ: pattern.volZ,
      liquidityVacuum: pattern.liquidityVacuum,
      evidence: pattern.evidence,
      spark: pattern.spark,
    })
  }

  // Same read: an actively running bot outranks a parked one, then name for a
  // stable order between identical tapes.
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.confidence - a.confidence ||
      Number(b.status === 'running') - Number(a.status === 'running') ||
      a.name.localeCompare(b.name),
  )
  const counts: Record<FleetRegime, number> = { crash: 0, hype: 0, squeeze: 0 }
  for (const row of rows) counts[row.regime] += 1

  return {
    generatedAt: clock,
    bars: ANALYSIS_BARS,
    scanned: bots.length,
    matched: rows.length,
    counts,
    active: rows.filter((row) => row.status === 'running').length,
    positions: holding.size,
    items: rows.map((row, index) => ({ ...row, rank: index + 1 })),
  }
}
