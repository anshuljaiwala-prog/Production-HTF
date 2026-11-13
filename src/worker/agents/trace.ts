import type {
  AgentDecisionTrace,
  AgentProposal,
  AgentVerdict,
  PredictionBin,
  PredictionCalibration,
  ScoredPrediction,
  TraceDecision,
} from '../../shared/types'

// The read side of the decision trace: what the engine recorded per closed bar,
// and whether the always-on move probability has actually tracked what followed.
//
// Scoring rule, in one place so the engine's write and this read agree: a
// forecast is scored on the bar after the one it was made at, and its predicted
// event is the move's implied direction (see `moveDirection` in specialists.ts).
// Status quo forecasts carry no direction, so their event is "the tape stayed
// inside CALM_BAND_PCT" — without that, most forecasts would be unscoreable and
// the Brier score would say nothing.

/** Percent move treated as "no directional move" for status-quo forecasts. */
export const CALM_BAND_PCT = 0.5

export interface Scored {
  returnPct: number
  outcome: boolean
}

export function scorePrediction(price: number, nextClose: number, direction: -1 | 0 | 1): Scored | null {
  if (!(price > 0) || !(nextClose > 0)) return null
  const returnPct = ((nextClose - price) / price) * 100
  const outcome =
    direction > 0 ? returnPct > 0 : direction < 0 ? returnPct < 0 : Math.abs(returnPct) < CALM_BAND_PCT
  return { returnPct: round(returnPct, 3), outcome }
}

/** Constant-0.5 forecast reference: the score a decorative probability gets. */
const BASELINE_BRIER = 0.25
const WINDOW = 500
const LATEST = 12

const BUCKETS: [number, number][] = [
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1],
]

interface PredictionRow {
  symbol: string
  at: number
  move: string
  probability: number
  return_pct: number | null
  outcome: number | null
}

export async function readCalibration(
  db: D1Database,
  owner: string,
  symbol?: string | null,
): Promise<PredictionCalibration> {
  const rows = await db
    .prepare(
      `SELECT symbol, at, move, probability, return_pct, outcome FROM move_predictions
       WHERE owner_sub = ?${symbol ? ' AND symbol = ?' : ''}
       ORDER BY at DESC LIMIT ?`,
    )
    .bind(...(symbol ? [owner, symbol, WINDOW] : [owner, WINDOW]))
    .all<PredictionRow>()

  const scored = (rows.results ?? []).filter((row) => row.outcome !== null && row.return_pct !== null)
  const brier = scored.length
    ? scored.reduce((sum, row) => sum + (Number(row.probability) - Number(row.outcome)) ** 2, 0) / scored.length
    : null

  const bins: PredictionBin[] = BUCKETS.map(([from, to]) => {
    const inBin = scored.filter((row) => Number(row.probability) >= from && Number(row.probability) < (to === 1 ? 1.01 : to))
    return {
      from,
      to,
      count: inBin.length,
      meanPredicted: inBin.length ? round(inBin.reduce((sum, row) => sum + Number(row.probability), 0) / inBin.length, 3) : 0,
      observed: inBin.length ? round(inBin.filter((row) => Number(row.outcome) === 1).length / inBin.length, 3) : 0,
    }
  })

  const latest: ScoredPrediction[] = (rows.results ?? []).slice(0, LATEST).map((row) => ({
    symbol: String(row.symbol),
    at: Number(row.at),
    move: String(row.move),
    probability: Number(row.probability),
    returnPct: row.return_pct === null ? null : Number(row.return_pct),
    outcome: row.outcome === null ? null : Boolean(row.outcome),
  }))

  return {
    resolved: scored.length,
    brier: brier === null ? null : round(brier, 4),
    baseline: BASELINE_BRIER,
    bins,
    latest,
  }
}

interface TraceRow {
  bot_id: string
  bot_name: string | null
  at: number
  gate_blocked: number
  gate_reason: string | null
  risk_off_streak: number
  proposals: string
  verdict: string
  decisions: string
}

export async function readDecisionTraces(
  db: D1Database,
  owner: string,
  botId?: string | null,
  limit = 24,
): Promise<AgentDecisionTrace[]> {
  const rows = await db
    .prepare(
      `SELECT t.bot_id, b.name AS bot_name, t.at, t.gate_blocked, t.gate_reason, t.risk_off_streak,
              t.proposals, t.verdict, t.decisions
       FROM decision_traces t JOIN bots b ON b.id = t.bot_id
       WHERE t.owner_sub = ?${botId ? ' AND t.bot_id = ?' : ''}
       ORDER BY t.at DESC LIMIT ?`,
    )
    .bind(...(botId ? [owner, botId, limit] : [owner, limit]))
    .all<TraceRow>()

  return (rows.results ?? []).map((row) => ({
    botId: String(row.bot_id),
    botName: String(row.bot_name ?? row.bot_id),
    at: Number(row.at),
    gate: { blocked: Boolean(row.gate_blocked), reason: row.gate_reason, streak: Number(row.risk_off_streak) },
    proposals: parse<AgentProposal[]>(row.proposals, []),
    verdict: parse<AgentVerdict>(row.verdict, { winner: null, bias: 0, conviction: 0, rationale: '', threshold: 0 }),
    decisions: parse<TraceDecision[]>(row.decisions, []),
  }))
}

function parse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const round = (value: number, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}
