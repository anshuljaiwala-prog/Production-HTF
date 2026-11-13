import type { CompanyMoveCandidate, CompanyMovePrediction } from '../../shared/types'

// The shell's analytical tools. Numeric reads (change, RSI, dislocation) come
// from the bars themselves; the dislocation z-scores are the pattern scan's own
// (priceZ / volZ in patterns.ts), so there is exactly one implementation of that
// measure in the codebase and the shell can never disagree with the pattern
// board about what is stretched.

/** Average-gain/average-loss RSI over the last `period` changes. */
export function calculateRsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50
  const window = prices.slice(-period - 1)
  let gain = 0
  let loss = 0
  for (let i = 1; i < window.length; i++) {
    const change = window[i] - window[i - 1]
    if (change > 0) gain += change
    else loss += -change
  }
  const avgLoss = loss / period
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + gain / period / avgLoss)
}

/** The facts the corporate-move predictor reads. */
export interface MoveContext {
  /** Institutional ownership, 0…1. */
  institutionalPct: number
  /** Pin-blended sentiment, −1…1. */
  sentiment: number
  affiliationsCount: number
  /** Realised volatility as a fraction of price (0.02 = 2%). */
  volatility: number
  /** False when the company has no seeded ownership: the probability still
   * runs on the tape-side rules, only the ownership rule abstains. */
  factsAvailable: boolean
}

/**
 * CompanyMovePredictor, ported from market_agent_env's tools.py: the probable
 * next strategic move given ownership concentration, sentiment and volatility.
 *
 * The Python version's M&A rule read "peer sentiment", which was a hardcoded
 * 0.35 at every call site — a constant pretending to be a measurement. There is
 * no peer-sentiment series here, so that rule is absent rather than fed a
 * number nobody computes.
 *
 * A probability is always returned. With no candidate rule firing it is the
 * status-quo baseline, and `factsAvailable` records what the number was made
 * of, so a weak basis is visible instead of the prediction vanishing.
 */
export function predictNextMove(context: MoveContext): CompanyMovePrediction {
  const candidates: CompanyMoveCandidate[] = []

  // The reference compared against 0.65, a total-float institutional share. Its
  // own seed data lists the top holders only (NVDA 8.4% + 7.6% = 16%), so that
  // rule could never fire — the predictor always returned status quo. The
  // threshold here is on what the environment actually holds: a concentrated
  // top-holder book. Keep it in step with specialists.ts.
  if (context.factsAvailable && context.institutionalPct > 0.12 && context.sentiment > 0.4) {
    candidates.push({
      move: 'Share repurchase program / dividend hike',
      probability: Math.min(0.92, 0.5 + 0.3 * context.sentiment + 0.2 * context.institutionalPct),
      rationale: 'High institutional ownership and a positive tone favour shareholder returns.',
    })
  }

  if (context.sentiment < -0.4 && context.volatility > 0.02) {
    candidates.push({
      move: 'Defensive restructuring / board restructuring',
      probability: Math.min(0.88, 0.45 + Math.abs(context.sentiment) * 0.35),
      rationale: 'Sustained negative sentiment and elevated volatility pressure governance.',
    })
  }

  if (!candidates.length) {
    candidates.push({
      move: 'Status quo / core R&D operations',
      probability: 0.6,
      rationale: context.factsAvailable
        ? 'Equilibrium between ownership, sentiment and affiliations.'
        : 'No ownership facts for this ticker; the baseline is the tape-side equilibrium.',
    })
  }

  const top = candidates.reduce((best, candidate) => (candidate.probability > best.probability ? candidate : best))
  return {
    move: top.move,
    probability: round(top.probability, 2),
    rationale: top.rationale,
    candidates: candidates.map((candidate) => ({ ...candidate, probability: round(candidate.probability, 2) })),
    factsAvailable: context.factsAvailable,
  }
}

const round = (value: number, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
