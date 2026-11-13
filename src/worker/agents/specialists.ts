import type { AgentProposal, AgentVerdict, AgentWorkingMemory, CompanyMovePrediction, NewsPin, SymbolPattern } from '../../shared/types'
import type { CompanyProfile } from './models'

// The specialist analysts of market_agent_env's bots.py, kept as separate reads
// over the same working memory instead of separate processes — a Worker has no
// long-lived agents to run. Each one returns a direction and the conviction its
// own facts support; `arbitrate` picks the winner.
//
// The Python app compared fixed confidences baked into each strategy template
// and resolved with winner-takes-all. Those numbers were constants, so they
// could not say which read was stronger on a given tape. Here every conviction
// is computed from the measured facts (ownership concentration, price/volume
// z-scores, pin sentiment, move probability), so the arbitration is a real
// comparison and an analyst with weak evidence cannot outvote one with strong
// evidence just because its template was confident.

/** Conviction a proposal needs before it can win. Below this the environment
 * reports no verdict rather than letting noise pick a direction. */
export const CONVICTION_THRESHOLD = 0.6

const IMPACT_WEIGHT: Record<NewsPin['impactLevel'], number> = {
  LOW: 0.25,
  MEDIUM: 0.5,
  HIGH: 0.75,
  CRITICAL: 1,
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** What a corporate-move prediction implies for price: a repurchase or an
 * expansion is bullish, a defensive restructuring bearish, status quo makes no
 * directional claim. Used both by the move analyst and by prediction scoring. */
export function moveDirection(move: string): -1 | 1 | 0 {
  if (/repurchase|buyback|expansion/i.test(move)) return 1
  if (/restructur|defensive|target/i.test(move)) return -1
  return 0
}

export interface SpecialistInput {
  memory: AgentWorkingMemory
  pattern: SymbolPattern | null
  company: CompanyProfile
  pins: NewsPin[]
  move: CompanyMovePrediction
}

/** Institutional support: how far ownership sits past the 50% mark, blended
 * with how far sentiment sits from neutral. Needs seeded ownership to say
 * anything at all. */
function ownershipAnalyst({ memory, company }: SpecialistInput): AgentProposal {
  const facts = company.ownership.length
    ? [
        `institutional ${round(memory.institutionalPct * 100, 1)}% of shares`,
        `sentiment ${round(memory.sentiment, 2)}`,
      ]
    : ['no ownership facts for this ticker']
  if (!company.ownership.length) {
    return {
      agent: 'ownership',
      bias: 0,
      conviction: 0,
      rationale: 'No seeded ownership for this company.',
      facts,
      factIds: ['ownership:absent'],
    }
  }
  // Scaled to the top-holder book the environment holds (see predictNextMove):
  // the reference's 0.70 threshold was never reachable from its own seed data,
  // which made this analyst's conviction permanently zero.
  const concentration = clamp01((memory.institutionalPct - 0.05) / 0.11)
  const tone = clamp01(Math.abs(memory.sentiment))
  return {
    agent: 'ownership',
    bias: memory.sentiment >= 0 ? 1 : -1,
    conviction: clamp01(0.5 * concentration + 0.5 * tone),
    rationale:
      memory.sentiment >= 0
        ? 'Concentrated institutional ownership with a positive tone supports the book.'
        : 'Heavy institutional ownership is leaning against a negative tone.',
    facts,
    factIds: ['ownership:institutional_pct', 'ownership:sentiment'],
  }
}

/** Dislocation: how far price sits past the trigger threshold, gated by how
 * much volume confirmed the move. Thin-volume moves read as a vacuum and are
 * faded rather than followed. */
function anomalyAnalyst({ pattern }: SpecialistInput): AgentProposal {
  if (!pattern || pattern.priceZ === null) {
    return {
      agent: 'anomaly',
      bias: 0,
      conviction: 0,
      rationale: 'No usable z-read on this tape.',
      facts: ['price z unavailable'],
      factIds: ['pattern:price_z:unavailable'],
    }
  }
  const priceZ = pattern.priceZ
  const volZ = pattern.volZ ?? 0
  const stretch = clamp01((Math.abs(priceZ) - 1) / 2)
  const participation = clamp01(volZ / 1.5)
  const vacuum = Math.abs(priceZ) >= 2.5 && volZ < 0.5
  const bias = vacuum ? (priceZ > 0 ? -0.5 : 0.5) : priceZ >= 0 ? 1 : -1
  return {
    agent: 'anomaly',
    bias,
    conviction: vacuum ? clamp01(stretch * 0.7) : clamp01(stretch * participation),
    rationale: vacuum
      ? 'Price moved through an empty book — fading the excursion, not following it.'
      : `Price ${priceZ >= 0 ? 'above' : 'below'} its mean with volume ${participation > 0.5 ? 'confirming' : 'lagging'}.`,
    facts: [`price z ${round(priceZ, 2)}`, `volume z ${round(volZ, 2)}`],
    factIds: ['pattern:price_z', 'pattern:vol_z'],
  }
}

/** News tone on this ticker: magnitude of the pinned sentiment, weighted by the
 * strongest impact level pinned. */
function newsAnalyst({ pins }: SpecialistInput): AgentProposal {
  if (!pins.length) {
    return {
      agent: 'news',
      bias: 0,
      conviction: 0,
      rationale: 'No pinned tape event on this ticker.',
      facts: ['no pins'],
      factIds: ['news:none'],
    }
  }
  const weight = Math.max(...pins.map((pin) => IMPACT_WEIGHT[pin.impactLevel]))
  const mean = pins.reduce((sum, pin) => sum + pin.sentiment, 0) / pins.length
  return {
    agent: 'news',
    bias: mean >= 0 ? 1 : -1,
    conviction: clamp01(Math.abs(mean) * weight),
    rationale: `${pins.length} pinned ${pins.length === 1 ? 'event' : 'events'} at ${round(mean, 2)} mean sentiment.`,
    facts: [`sentiment ${round(mean, 2)}`, `top impact ${pins.reduce((best, pin) => (IMPACT_WEIGHT[pin.impactLevel] > IMPACT_WEIGHT[best.impactLevel] ? pin : best)).impactLevel}`],
    factIds: [...pins.map((pin) => `news:${pin.id}`), 'news:mean_sentiment', 'news:top_impact'],
  }
}

/** Corporate-move probability as a directional read: a share repurchase or an
 * expansion is bullish, a defensive restructuring bearish, status quo neutral. */
function moveAnalyst({ move }: SpecialistInput): AgentProposal {
  const bias = moveDirection(move.move)
  return {
    agent: 'move',
    bias,
    conviction: bias === 0 ? 0 : clamp01((move.probability - 0.5) * 2),
    rationale: `${move.move} at ${round(move.probability * 100)}% — ${move.rationale}`,
    facts: [`probability ${round(move.probability, 2)}`, `basis ${move.factsAvailable ? 'ownership + sentiment' : 'no ownership facts'}`],
    factIds: ['move:probability', 'move:basis'],
  }
}

/** Tie-break order when two analysts land on identical conviction: the analyst
 * with the most direct market evidence leads. */
const PRIORITY: Record<AgentProposal['agent'], number> = { anomaly: 0, news: 1, ownership: 2, move: 3 }

/** Run every analyst, then let the strongest evidence set the environment's
 * verdict. */
export function runSpecialists(input: SpecialistInput): { proposals: AgentProposal[]; verdict: AgentVerdict } {
  const proposals = [
    ownershipAnalyst(input),
    anomalyAnalyst(input),
    newsAnalyst(input),
    moveAnalyst(input),
  ]
  const eligible = proposals
    .filter((proposal) => proposal.conviction >= CONVICTION_THRESHOLD && proposal.bias !== 0)
    .sort((a, b) => b.conviction - a.conviction || PRIORITY[a.agent] - PRIORITY[b.agent])
  const winner = eligible[0]
  return {
    proposals,
    verdict: winner
      ? {
          winner: winner.agent,
          bias: winner.bias,
          conviction: winner.conviction,
          rationale: winner.rationale,
          threshold: CONVICTION_THRESHOLD,
        }
      : {
          winner: null,
          bias: 0,
          conviction: 0,
          rationale: `No analyst cleared ${CONVICTION_THRESHOLD} conviction on measured facts.`,
          threshold: CONVICTION_THRESHOLD,
        },
  }
}

const round = (value: number, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
