import type { ParamValue, PatternRegime, Playbook, Timeframe } from '../shared/types'
import { PATTERN_REGIMES } from '../shared/types'
import { sanitizeParams, strategyBy } from './strategies'

// The tool box: ready-made trading execution plans, one primary response per
// pattern regime, deployable against any bot or fresh wallet. Plans here use
// the same language the rest of the platform speaks — a strategy key, its
// sanitized params, a timeframe and a risk percent — so "executing" a plan is
// just copy-onto-a-bot through the normal create path: same validation, same
// event log, same everything the launch wizard produces.
//
// The defaults are deliberately drafted as the textbook response to each
// regime (a mean-reversion dip catch for the crash, a trend rider for the
// hype, a breakout follow for the squeeze's expansion, …). They are starting
// points, not advice; the classifier scores the regime, the operator keeps
// the final say on sizing and venue.

const playbook = (
  id: string,
  name: string,
  regime: PatternRegime,
  strategyKey: string,
  timeframe: Timeframe | null,
  riskPct: number,
  params: Record<string, ParamValue>,
  note: string,
): Playbook => ({ id, name, regime, strategyKey, timeframe, riskPct, params, note, source: 'builtin', createdAt: 0 })

export const BUILTIN_PLAYBOOKS: Playbook[] = [
  playbook('builtin:catch-the-bounce', 'Catch the Bounce', 'crash', 'mean-reversion', '1h', 15, { lookback: 30, entryZ: 1, exitZ: 1, stopLossPct: 15 }, 'A flush that stretched past its own bands is mean-reverting fuel: buy stretched-to-the-downside, exit when price re-centres, stop wide enough for another leg down.'),
  playbook('builtin:ride-the-runner', 'Ride the Runner', 'hype', 'momentum', '4h', 25, { fastEma: 9, slowEma: 21, stopLossPct: 6 }, 'Fast leg off a low with expanding volatility: a shorter EMA pair trades the runner itself and a tighter stop gives back less when the frenzy breaks.'),
  playbook('builtin:breakout-follow', 'Breakout Follow', 'breakout', 'breakout', '1h', 25, { highWindow: 30, lowWindow: 12, stopLossPct: 5 }, 'New highs with expanding volatility are the pattern that pays a range-breakout trader: enter on the break, exit on the first range break back.'),
  playbook('builtin:coiled-spring', 'Coiled Spring', 'squeeze', 'breakout', '4h', 20, { highWindow: 45, lowWindow: 20, stopLossPct: 4 }, 'Compressed volatility precedes expansion with no direction yet: stand above the coiled range and let the close out of the box pick the side.'),
  playbook('builtin:stay-with-the-trend', 'Stay With the Trend', 'uptrend', 'momentum', '1d', 25, { fastEma: 12, slowEma: 48, stopLossPct: 8 }, 'A rising slope with contained drawdowns is the hard part of trading — nothing to do but hold with the trend crossovers and let it run.'),
  playbook('builtin:reversion-grid', 'Reversion Grid', 'downtrend', 'grid', '4h', 15, { gridStepPct: 2, stopLossPct: 15 }, 'A grind lower keeps offering bounces: a grid buys each step down and sells each step up, harvesting the chop while the trend does its work.'),
  playbook('builtin:slow-accumulation', 'Slow Accumulation', 'selloff', 'dca', '1d', 15, { intervalBars: 8, takeProfitPct: 8, stopLossPct: 12 }, 'A marked but unhurried drawdown is a DCA tape: fixed slices on a schedule build the position without timing one entry, target and stop exit it.'),
  playbook('builtin:work-the-range', 'Work the Range', 'range', 'market-making', '15m', 20, { spreadPct: 0.5, inventorySteps: 3, stopLossPct: 6 }, 'No dominant direction is exactly the market-making regime: lift dips, sell ripples, repeat — thin margin per fill, so keep fees tight.'),
]

/** The strategy book's default registry: which builtin plan answers each
 * regime before the operator replaces any of it. Every regime lands in the
 * book out of the box — execution is wired up the moment a plan is drafted. */
export const DEFAULT_BOOK: Record<PatternRegime, string> = Object.fromEntries(
  BUILTIN_PLAYBOOKS.map((plan) => [plan.regime, plan.id]),
) as Record<PatternRegime, string>

export const BUILTIN_PLAYBOOK_MAP = new Map(BUILTIN_PLAYBOOKS.map((plan) => [plan.id, plan]))

export const BOOK_REGIMES = PATTERN_REGIMES.map((r) => r.key)

export function isBookRegime(regime: string): regime is PatternRegime {
  return (BOOK_REGIMES as string[]).includes(regime)
}

/** One typo to catch at the source, not in code review: correct it here. */
const BUILTIN_IDS = BUILTIN_PLAYBOOKS.map((plan) => plan.id)
if (new Set(BUILTIN_IDS).size !== BUILTIN_IDS.length || BUILTIN_IDS.some((preset) => preset.startsWith('uiltin:'))) {
  throw new Error('Duplicate or malformed builtin playbook id.')
}

/** Validate an operator-drafted execution plan, or return the reason it was
 * rejected. Mirrors what `createBot`/`sanitizeParams` enforce at launch, so
 * a plan executed into a bot cannot produce a config the launch wizard or
 * the engine would refuse. */
export function validatePlanDraft(input: {
  name?: unknown
  regime?: unknown
  strategyKey?: unknown
  timeframe?: unknown
  riskPct?: unknown
  note?: unknown
  params?: unknown
}): { plan: Omit<Playbook, 'id' | 'source' | 'createdAt'> } | { error: string; message: string } {
  const name = String(input.name ?? '').trim().slice(0, 90)
  if (!name) return { error: 'name_required', message: 'Give the plan a name.' }

  const regime = String(input.regime ?? '')
  if (!isBookRegime(regime)) {
    return { error: 'unknown_regime', message: `Pick a regime the scanner recognises — one of ${BOOK_REGIMES.join(', ')}.` }
  }

  const strategy = strategyBy(String(input.strategyKey ?? ''))
  if (!strategy) return { error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }

  const timeframe = input.timeframe === null || input.timeframe === undefined || input.timeframe === '' ? null : String(input.timeframe)
  if (timeframe && !strategy.timeframes.includes(timeframe as Timeframe)) {
    return { error: 'timeframe_unsupported', message: `${strategy.name} does not run on the ${timeframe} timeframe.` }
  }

  const riskPct = Number(input.riskPct)
  if (!Number.isFinite(riskPct) || riskPct < 1 || riskPct > 100) {
    return { error: 'invalid_risk', message: 'Risk per fill must be 1–100 percent.' }
  }
  const note = String(input.note ?? '').trim().slice(0, 200)
  if (!note) return { error: 'note_required', message: 'One line on why this plan answers this regime.' }

  const params = sanitizeParams(strategy.key, input.params as Record<string, unknown> | undefined)

  return {
    plan: {
      name,
      regime: regime as PatternRegime,
      strategyKey: strategy.key,
      timeframe: timeframe as Timeframe | null,
      riskPct: Math.round(riskPct * 10) / 10,
      note,
      params,
    },
  }
}
