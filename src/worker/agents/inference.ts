import type { AgentInference, MacroRegime } from '../../shared/types'
import type { WorkingMemory } from './models'

// Forward-chaining inference, ported from market_agent_env's bots.py. Rules are
// IF premise THEN conclusion over the working memory the environment assembles;
// every rule that fires produces a deduction, and deductions are ordered by
// salience so the strongest read leads.
//
// Two rules of the Python app are deliberately absent, and not because they
// were inconvenient:
//
// - `winner_takes_all`: it arbitrated between four sub-agents, each proposing
//   an order for the same ticker. A bot here runs exactly one strategy and has
//   no confidence score to compare, so there is no contest to resolve and no
//   number to threshold — porting it would have been dead code pretending to
//   arbitrate, and inventing a confidence would be fake precision.
// - canned news: the Python harvester returned four hard-coded headlines whose
//   sentiment fed the rules. This platform has a real tape, so pins are
//   harvested from what the markets did; injecting synthetic headlines into a
//   gate that can block real orders would put fiction in the decision path.

interface Rule {
  name: string
  test(memory: WorkingMemory): boolean
  infer(): Omit<AgentInference, 'triggeredByRule'>
}

const RULES: Rule[] = [
  {
    name: 'Institutional_Accumulation_Rule',
    test: (m) => m.institutionalPct >= 0.7 && m.sentiment > 0.3,
    infer: () => ({
      inferredFact: 'INSTITUTIONAL_SUPPORT_HIGH',
      bias: 'BULLISH',
      salience: 0.85,
      nextAction: 'EXPANSION_OR_BUYBACK',
    }),
  },
  {
    name: 'Crash_Contagion_Rule',
    test: (m) => m.criticalNegativeNews && m.anomalySignal === 'CRASH_TRIGGER',
    infer: () => ({
      inferredFact: 'SEVERE_MARKET_DISTRESS',
      bias: 'EXTREME_BEARISH',
      salience: 0.98,
      nextAction: 'EMERGENCY_CAPITAL_DEFENSE',
    }),
  },
  {
    name: 'Affiliated_Ecosystem_Support_Rule',
    test: (m) => m.rsi < 30 && m.affiliationsCount >= 2,
    infer: () => ({
      inferredFact: 'RESILIENT_ECOSYSTEM_SAFETY_NET',
      bias: 'BULLISH_REVERSAL',
      salience: 0.75,
      nextAction: 'SYNERGISTIC_PARTNER_INTERVENTION',
    }),
  },
  {
    name: 'Market_Boom_Wave_Rule',
    test: (m) => m.anomalySignal === 'BOOM_TRIGGER',
    infer: () => ({
      inferredFact: 'MARKET_BOOM_ACCELERATION',
      bias: 'EXTREME_BULLISH',
      salience: 0.9,
      nextAction: 'AGGRESSIVE_MARKET_EXPANSION',
    }),
  },
  {
    name: 'Global_Macro_Contagion_Rule',
    test: (m) => m.globalNegativeCount >= 3,
    infer: () => ({
      inferredFact: 'GLOBAL_MACRO_RISK_OFF',
      bias: 'MACRO_BEARISH_REGIME',
      salience: 0.95,
      nextAction: 'ACTIVATE_INDEX_SHORT_HEDGE',
    }),
  },
]

/** Fire every rule whose premise holds, strongest salience first. */
export function runForwardChaining(memory: WorkingMemory): AgentInference[] {
  const deductions: AgentInference[] = []
  for (const rule of RULES) {
    if (!rule.test(memory)) continue
    deductions.push({ ...rule.infer(), triggeredByRule: rule.name })
  }
  return deductions.sort((a, b) => b.salience - a.salience)
}

interface MacroRead {
  regime: MacroRegime
  negCount: number
}

/** Breadth across the tracked world markets: how many are meaningfully down,
 * how many up, and whether the whole set leans one way hard enough to be a
 * regime rather than noise. */
export function computeMacroRegime(changes: number[]): MacroRead {
  const negCount = changes.filter((change) => change < -0.2).length
  const posCount = changes.filter((change) => change > 0.2).length
  const avgChangePct = changes.length === 0 ? 0 : changes.reduce((sum, change) => sum + change, 0) / changes.length

  if (negCount >= 3 || avgChangePct < -0.3) return { regime: 'RISK_OFF_CONTAGION', negCount }
  if (posCount >= 3 && avgChangePct > 0.4) return { regime: 'RISK_ON_BOOM', negCount }
  return { regime: 'NEUTRAL', negCount }
}
