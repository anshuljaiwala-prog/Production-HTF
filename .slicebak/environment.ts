import type { AgentCompanyFacts, AgentGateVerdict, AgentRead, AgentWorkingMemory, NewsPin } from '../../shared/types'
import type { Bar } from '../market'
import type { CompanyProfile } from './models'
import { harvestMarket, pinFromPattern, screenPin } from './harvester'
import { computeMacroRegime, runForwardChaining } from './inference'
import { runSpecialists } from './specialists'
import { predictNextMove } from '../toolshed/move'

// The environment hub, ported from market_agent_env's environment.py. The
// Python app held one long-lived object with companies, world positions, news
// pins, candle history and control state, ticked forward by the server. A
// Worker has no such process, so the hub is assembled on demand from the bars
// the caller supplies and handed back as an immutable snapshot.
//
// The gate lives here as one pure function, so the engine (per advance pass),
// the backtester (per bar) and the read-only route (for display) all apply the
// same rule instead of each inventing one.

/** Ownership and affiliation facts, seeded from the Python app's knowledge base.
 * These are the only static fundamentals in the shell — everything else
 * (prices, regimes, pins) is read from the platform's own market data. */
export const COMPANIES: CompanyProfile[] = [
  {
    ticker: 'NVDA',
    ownership: [
      { holder: 'Vanguard Group', percentage: 0.084, holderType: 'Institutional' },
      { holder: 'BlackRock', percentage: 0.076, holderType: 'Institutional' },
      { holder: 'Jensen Huang', percentage: 0.035, holderType: 'Insider' },
    ],
    affiliations: ['TSMC (foundry partner)', 'Microsoft (Azure cloud)', 'Foxconn (assembly)'],
    sentimentScore: 0.72,
  },
  {
    ticker: 'TSLA',
    ownership: [
      { holder: 'Elon Musk', percentage: 0.128, holderType: 'Insider' },
      { holder: 'Vanguard Group', percentage: 0.068, holderType: 'Institutional' },
      { holder: 'State Street', percentage: 0.033, holderType: 'Institutional' },
    ],
    affiliations: ['Panasonic (battery cells)', 'CATL (LFP cells)', 'SpaceX (material sharing)'],
    sentimentScore: 0.35,
  },
  {
    ticker: 'ASML',
    ownership: [
      { holder: 'Baillie Gifford', percentage: 0.062, holderType: 'Institutional' },
      { holder: 'BlackRock', percentage: 0.071, holderType: 'Institutional' },
    ],
    affiliations: ['TSMC (major client)', 'Samsung (major client)', 'Intel (major client)', 'Zeiss (optics)'],
    sentimentScore: 0.45,
  },
]

/** A seeded profile when the symbol has one; otherwise an empty one, so an
 * unknown ticker reads as "no ownership facts" rather than inheriting someone
 * else's fundamentals. */
function companyFor(symbol: string): CompanyProfile {
  return COMPANIES.find((company) => company.ticker === symbol) ?? { ticker: symbol, ownership: [], affiliations: [], sentimentScore: 0 }
}

/** The company knowledge the environment publishes for one ticker. */
export function companyFactsFor(symbol: string): AgentCompanyFacts {
  const company = companyFor(symbol)
  return {
    ticker: company.ticker,
    ownership: company.ownership.map((record) => ({ ...record })),
    affiliations: company.affiliations,
    sentimentScore: company.sentimentScore,
    institutionalPct: round(
      company.ownership.filter((record) => record.holderType === 'Institutional').reduce((sum, record) => sum + record.percentage, 0),
      3,
    ),
    factsAvailable: company.ownership.length > 0 || company.affiliations.length > 0,
  }
}

/** Consecutive risk-off checks before entries are held back: one noisy read
 * should not gate a bot. */
export const RISK_OFF_HOLD = 3

/** One pin per id, newest wins. A pin re-derived on a later bar supersedes the
 * earlier row with the same id; an expired one never arrives here (the read
 * filters it), so a stale headline cannot keep a gate shut. */
function mergePins(prior: NewsPin[], fresh: NewsPin[]): NewsPin[] {
  const byId = new Map<string, NewsPin>()
  for (const pin of prior) byId.set(pin.id, pin)
  for (const pin of fresh) {
    const seen = byId.get(pin.id)
    if (!seen || pin.timestamp >= seen.timestamp) byId.set(pin.id, pin)
  }
  return [...byId.values()]
}

export interface EnvironmentInput {
  at: number
  /** Every tracked market's bars ending at `at`, oldest first. */
  macroBars: { symbol: string; bars: Bar[] }[]
  /** The bot's own market, from the same merged bars the bot trades. */
  focus?: { symbol: string; bars: Bar[] }
  /** Pins an earlier pass screened and persisted and that have not expired.
   * A headline counts until its expiry, not only on the bar it was harvested
   * on, so sentiment and the critical-news read survive across passes. */
  priorPins?: NewsPin[]
}

/**
 * Assemble the environment: read the macro markets, harvest their tape events
 * into pins, take the focused market's facts, then run the production rules.
 * Pure — no writes, no cached state.
 */
export function readEnvironment(input: EnvironmentInput): AgentRead {
  const harvested = input.macroBars.map(({ symbol, bars }) => harvestMarket(symbol, bars))
  const markets = harvested.map((entry) => entry.market)
  const macro = computeMacroRegime(markets.map((market) => market.changePct))

  const pins: NewsPin[] = []
  let rejectedPins = 0
  // Reject counts keep the reason they were dropped for, so the panel can say
  // why the screener held a row back instead of only how many it held back.
  const barReasons: Record<string, number> = {}
  const pinReasons: Record<string, number> = {}
  for (const entry of harvested) {
    addReasons(barReasons, entry.reasons)
    const pin = pinFromPattern(entry.pattern, input.at)
    if (!pin) continue
    // The screener decides what is allowed into the environment at all.
    const rejected = screenPin(pin)
    if (rejected) {
      rejectedPins++
      pinReasons[rejected] = (pinReasons[rejected] ?? 0) + 1
    } else pins.push(pin)
  }

  // The tape's pins plus the ones still live from earlier passes: one by id,
  // newest wins. This is the read the rules, the specialists and the gate see.
  const livePins = mergePins(input.priorPins ?? [], pins)

  const focusEntry = input.focus ? harvestMarket(input.focus.symbol, input.focus.bars) : harvested[0]
  if (input.focus) addReasons(barReasons, focusEntry?.reasons ?? {})
  const focus = focusEntry?.market.symbol ?? 'BTC-USD'
  const company = companyFor(focus)

  // Sentiment: pins on this ticker move the baseline (the Python app's
  // pin_news blend); with no news it is the profile's own score.
  const tickerPins = livePins.filter((pin) => pin.ticker === focus)
  const sentiment = tickerPins.length
    ? tickerPins.reduce((sum, pin) => sum + pin.sentiment, 0) / tickerPins.length
    : company.sentimentScore

  const institutionalPct = company.ownership
    .filter((record) => record.holderType === 'Institutional')
    .reduce((sum, record) => sum + record.percentage, 0)
  const facts = companyFactsFor(focus)

  const memory: AgentWorkingMemory = {
    ticker: focus,
    institutionalPct,
    sentiment: round(sentiment, 3),
    rsi: focusEntry?.market.rsi ?? 50,
    affiliationsCount: company.affiliations.length,
    anomalySignal: focusEntry?.market.anomaly.signal ?? 'NORMAL_VARIATION',
    criticalNegativeNews: livePins.some((pin) => pin.impactLevel === 'CRITICAL' && pin.sentiment < -0.5),
    globalNegativeCount: macro.negCount,
  }

  // The move prediction always produces a probability: with no ownership it is
  // the tape-side baseline, and `factsAvailable` says which basis was used.
  const nextMove = predictNextMove({
    institutionalPct,
    sentiment: memory.sentiment,
    affiliationsCount: memory.affiliationsCount,
    volatility: (focusEntry?.pattern?.volPct ?? 0) / 100,
    factsAvailable: facts.factsAvailable,
  })
  const { proposals, verdict } = runSpecialists({ memory, pattern: focusEntry?.pattern ?? null, company, pins: tickerPins, move: nextMove })

  return {
    generatedAt: input.at,
    regime: macro.regime,
    markets,
    // The focus tape itself, for the bot-level gates that key off the market
    // rather than the macro read (a per-bot volatility ceiling).
    pattern: focusEntry?.pattern ?? null,
    // Which markets are dislocated badly enough for their own bots to stand
    // down; empty when nothing is.
    criticalMarkets: livePins.filter((pin) => pin.impactLevel === 'CRITICAL').map((pin) => pin.ticker),
    pins: livePins,
    inferences: runForwardChaining(memory),
    workingMemory: memory,
    company: facts,
    proposals,
    verdict,
    nextMove,
    screened: {
      rejectedBars: harvested.reduce((sum, entry) => sum + entry.rejected, 0) + (input.focus ? (focusEntry?.rejected ?? 0) : 0),
      rejectedPins,
      barReasons,
      pinReasons,
    },
  }
}

/**
 * The gate. Two conditions, both read from the markets:
 *
 * - a macro contagion holds every bot back fleet-wide, but only after it has
 *   been read `RISK_OFF_HOLD` times running (`priorStreak` carries the count
 *   across passes, so one noisy read cannot gate anything);
 * - a single market's critical dislocation holds back only the bots that trade
 *   that market.
 *
 * Returns the streak to persist, so the caller owns the state and this stays
 * pure. Exits are never gated — nowhere here can stop a stop.
 */
export function evaluateGate(read: AgentRead, symbols: readonly string[], priorStreak = 0): AgentGateVerdict {
  const streak = read.regime === 'RISK_OFF_CONTAGION' ? priorStreak + 1 : 0
  if (streak >= RISK_OFF_HOLD) {
    return {
      blocked: true,
      reason: `sustained macro risk-off — ${read.workingMemory.globalNegativeCount} of ${read.markets.length} tracked markets down (${streak} checks)`,
      streak,
    }
  }
  const hit = read.criticalMarkets.find((symbol) => symbols.includes(symbol))
  if (hit) {
    return { blocked: true, reason: `${hit} dislocation — ${read.pins.find((pin) => pin.ticker === hit)?.title ?? 'critical'}`, streak }
  }
  return { blocked: false, reason: null, streak }
}

/** Fold one screener's per-reason counts into the read's running totals. */
function addReasons(target: Record<string, number>, source: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source)) target[reason] = (target[reason] ?? 0) + count
}

const round = (value: number, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
