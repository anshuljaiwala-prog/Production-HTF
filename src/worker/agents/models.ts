// Domain models of the agent shell, ported from market_agent_env. Only the
// fields a rule reads survive: the Python profiles also carried sector,
// country, market cap and a headline event, none of which fed anything here, so
// keeping them would have been decoration with no consumer.

type HolderType = 'Institutional' | 'Insider' | 'Sovereign' | 'Retail'

/** One holder's stake. Percentages are fractions (0.084 = 8.4%). */
interface OwnershipRecord {
  holder: string
  percentage: number
  holderType: HolderType
}

/** The company facts the ownership and affiliation rules read. */
export interface CompanyProfile {
  ticker: string
  ownership: OwnershipRecord[]
  /** Joint ventures, key suppliers, alliances — the ecosystem around it. */
  affiliations: string[]
  /** −1…1, the sentiment baseline the news pins move. */
  sentimentScore: number
}

/** The fact set the forward-chaining rules resolve against. */
export interface WorkingMemory {
  ticker: string
  institutionalPct: number
  sentiment: number
  rsi: number
  affiliationsCount: number
  anomalySignal: string
  criticalNegativeNews: boolean
  globalNegativeCount: number
}
