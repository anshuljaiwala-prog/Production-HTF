// Types shared by the Worker (src/worker) and the app (src/app).

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key: '1m', label: '1 minute' },
  { key: '5m', label: '5 minutes' },
  { key: '15m', label: '15 minutes' },
  { key: '1h', label: '1 hour' },
  { key: '4h', label: '4 hours' },
  { key: '1d', label: '1 day' },
]

/** Lifecycle column on the strategy board. */
export type BotStage = 'draft' | 'backtest' | 'paper' | 'live'
export const BOT_STAGES: { key: BotStage; label: string }[] = [
  { key: 'draft', label: 'Draft' },
  { key: 'backtest', label: 'Backtest' },
  { key: 'paper', label: 'Paper' },
  { key: 'live', label: 'Live' },
]

export type BotStatus = 'running' | 'paused' | 'stopped'
export type BotMode = 'paper' | 'live'

/** What a bot is doing right now, in the operator's vocabulary.
 * Running bots are actively trading; a bot that is not running but still
 * holds open positions is inactive (holds its book, opens nothing new); a
 * flat, non-running bot is grounded (no trades, no positions). */
export type BotActivity = 'active' | 'inactive' | 'grounded'

export const ACTIVITIES: { key: BotActivity; label: string; hint: string }[] = [
  { key: 'active', label: 'Active', hint: 'actively trading' },
  { key: 'inactive', label: 'Inactive', hint: 'holding positions, opening none' },
  { key: 'grounded', label: 'Grounded', hint: 'not trading, not holding' },
]

export function activityOf(bot: Pick<Bot, 'status' | 'openPositions'>): BotActivity {
  if (bot.status === 'running') return 'active'
  return bot.openPositions > 0 ? 'inactive' : 'grounded'
}

export type ParamValue = number | string | boolean

/** Asset classes the simulated market covers. Options are modelled as
 * constant-maturity synthetic derivatives over an underlying; everything
 * else is a plain instrument with its own synthetic price path. */
export type AssetKind = 'crypto' | 'equity' | 'etf' | 'fund' | 'commodity' | 'option'

export const ASSET_CLASSES: { key: AssetKind; label: string; hint: string }[] = [
  { key: 'crypto', label: 'Crypto', hint: '24/7 spot pairs' },
  { key: 'equity', label: 'Stocks', hint: 'single-name equities' },
  { key: 'etf', label: 'ETFs', hint: 'exchange-traded funds' },
  { key: 'fund', label: 'Mutual funds', hint: 'once-daily NAV-like funds' },
  { key: 'commodity', label: 'Commodities', hint: 'metals, energy' },
  { key: 'option', label: 'Options', hint: 'calls & puts on the same synthetic feed' },
]

export interface SymbolMeta {
  symbol: string
  kind: AssetKind
  /** For options: the instrument it derives from. */
  underlying?: string
  label?: string
}

/** Accuracy of a strategy's directional predictions over a bar window:
 * at every entry-signal bar, did the next bar close in the sign the
 * strategy put money on, and by how much was such a bar better than the
 * unconditional average bar? */
export interface AccuracyStat {
  /** Bars evaluated (bars with full history for the signal). */
  sample: number
  /** Bars where the strategy fired an entry signal. */
  entryBars: number
  /** Entry-signal bars whose next bar closed in the predicted direction. */
  correct: number
  /** `correct / entryBars` in percent — the raw prediction accuracy. */
  directionalAccuracy: number | null
  /** Mean next-bar return on signal bars minus the unconditional mean, in
   * percent of price. Positive means the signals land on above-average
   * moves, not merely directionally correct ones. */
  edgePct: number | null
  /** Mean next-bar return on signal bars, in percent. */
  signalReturnPct: number | null
  rating: 'edge' | 'coin-flip' | 'anti' | 'thin-sample' | null}

export interface CustomStrategySummary {
  id: string
  name: string
  lookback: number
  createdAt: number
  /** Rule count across entry and exit lists — a rough size hint. */
  rules: number
}

/** Drives both the launch wizard and the backtest form from one definition. */
export interface ParamDef {
  key: string
  label: string
  type: 'number' | 'select' | 'boolean'
  default: ParamValue
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: string }[]
  hint?: string
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface Strategy {
  key: string
  name: string
  summary: string
  description: string
  risk: RiskLevel
  tags: string[]
  timeframes: Timeframe[]
  params: ParamDef[]
}

export interface Connection {
  id: string
  name: string
  exchange: string
  /** API key shown masked (last four only); the secret is never returned. */
  keyMasked: string
  mode: BotMode
  createdAt: number
}

export interface Bot {
  id: string
  name: string
  strategyKey: string
  strategyName: string
  symbols: string[]
  timeframe: Timeframe
  params: Record<string, ParamValue>
  capital: number
  riskPct: number
  mode: BotMode
  stage: BotStage
  status: BotStatus
  position: number
  connectionId: string | null
  connectionName: string | null
  cash: number
  equity: number
  initialEquity: number
  /** Signed sum of operator cash flows: deposits positive, withdrawals negative. */
  netDeposits: number
  realizedPnl: number
  roundTrips: number
  wins: number
  openPositions: number
  lastEvent: string | null
  createdAt: number
  startedAt: number | null
  lastTickAt: number | null
  updatedAt: number
}

export interface Position {
  symbol: string
  qty: number
  avgPrice: number
  markPrice: number
  unrealizedPnl: number
  openedAt: number
}

export interface Trade {
  id: string
  botId: string | null
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  fee: number
  /** Realised P&L booked by this fill when it reduces a position; null for opens. */
  pnl: number | null
  at: number
}

export interface BotEvent {
  id: string
  botId: string | null
  botName?: string
  level: 'signal' | 'fill' | 'info' | 'warn' | 'error'
  message: string
  at: number
}

export interface EquityPoint {
  t: number
  value: number
}

/** One (possibly bucketed) OHLC candle from the simulated feed. */
export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface RunMetrics {
  totalReturn: number
  maxDrawdown: number
  sharpe: number
  winRate: number
  trades: number
  finalEquity: number
}

/** Pot of made-up money backtests draw from. Backtests are hypotheticals:
 * they never touch workspace funding, only this simulation budget. */
export const SIM_BUDGET = 1_000_000

export interface SimBudget {
  total: number
  used: number
  available: number
}

export interface Backtest {
  id: string
  name: string
  strategyKey: string
  strategyName: string
  symbol: string
  timeframe: Timeframe
  params: Record<string, ParamValue>
  capital: number
  from: number
  to: number
  status: 'running' | 'done' | 'failed'
  error: string | null
  metrics: RunMetrics | null
  /** How well the strategy's entry signals predicted the next bar, over the
   * exact window the run replayed. Present on completed runs. */
  accuracy: AccuracyStat | null
  curve: EquityPoint[]
  trades: Trade[]
  createdAt: number
}

export interface Dashboard {
  kpis: {
    capitalDeployed: number
    liveBots: number
    activeBots: number
    todayPnl: number
    winRate: number | null
    openPositions: number
  }
  equity: { label: string; value: number }[]
  stageTotals: { stage: BotStage; count: number }[]
  attention: Bot[]
  events: BotEvent[]
}

export interface SearchResults {
  bots: { id: string; name: string; strategyName: string }[]
  strategies: { key: string; name: string; risk: RiskLevel }[]
}

export interface CashFlow {
  id: string
  botId: string
  botName: string | null
  /** Deposit positive, withdrawal negative. */
  amount: number
  note: string | null
  at: number
}

/** Financial audit, aggregate across the fleet and per bot. */
export interface PortfolioBotAudit {
  id: string
  name: string
  strategyKey: string
  strategyName: string
  status: BotStatus
  mode: BotMode
  timeframe: Timeframe
  capital: number
  cash: number
  equity: number
  netDeposits: number
  realizedPnl: number
  unrealizedPnl: number
  /** Fees paid across every fill this bot made. */
  fees: number
  fills: number
  roundTrips: number
  wins: number
  winRate: number | null
  openPositions: number
  lastActivityAt: number
}

export interface PortfolioPosition {
  botId: string
  botName: string
  symbol: string
  qty: number
  avgPrice: number
  markPrice: number
  costBasis: number
  unrealizedPnl: number
}

export interface PortfolioTransaction {
  id: string
  botId: string | null
  botName: string | null
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  fee: number
  pnl: number | null
  at: number
}

export interface Portfolio {
  summary: {
    startingCapital: number
    currentEquity: number
    /** Launch funding across the fleet: Σ (capital − net Deposits). */
    launchCapital: number
    netPnl: number
    netPnlPct: number
    realizedPnl: number
    unrealizedPnl: number
    deposits: number
    withdrawals: number
    netFunding: number
    fees: number
    grossProfit: number
    grossLoss: number
    profitFactor: number | null
    expectedWinRate: number | null
    roundTrips: number
    wins: number
    fills: number
    bots: number
    activeBots: number
    openPositions: number
  }
  equity: { label: string; value: number }[]
  bots: PortfolioBotAudit[]
  positions: PortfolioPosition[]
  transactions: PortfolioTransaction[]
  funding: CashFlow[]
}

export interface Me {
  user: { sub: string; name?: string; email?: string; picture?: string }
  workspace: { name: string; seededAt: number | null }
  capabilities: { database: boolean; files: boolean; auth: 'freebuff' | 'development' }
}
