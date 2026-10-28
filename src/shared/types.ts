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
export type AssetKind = 'crypto' | 'equity' | 'etf' | 'fund' | 'commodity' | 'fx' | 'option'

export const ASSET_CLASSES: { key: AssetKind; label: string; hint: string }[] = [
  { key: 'crypto', label: 'Crypto', hint: '24/7 spot pairs' },
  { key: 'equity', label: 'Stocks', hint: 'US and foreign single-name equities' },
  { key: 'etf', label: 'ETFs', hint: 'exchange-traded funds' },
  { key: 'fund', label: 'Mutual funds', hint: 'once-daily NAV-like funds' },
  { key: 'commodity', label: 'Commodities', hint: 'metals, energy' },
  { key: 'fx', label: 'Forex', hint: 'multi-nation currency pairs' },
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
  /** Version of this strategy family (1 for the first upload; re-uploads of
   * the same name store a new version alongside the old ones). */
  version: number
  /** Total stored versions in the family — how much history is retained. */
  versions: number
}

// --- Uploaded (custom) rules ------------------------------------------------

/** One testable condition, e.g. { metric: 'rsi', n: 14, op: '<', value: 30 }. */
export interface CustomRule {
  metric: 'rsi' | 'ema' | 'zscore' | 'donchianHigh' | 'donchianLow' | 'momentum'
  /** Window for the metric (default per metric). */
  n: number
  /** ema only: second window for a fast/slow relationship. */
  n2?: number
  op: '>' | '<'
  /** Threshold; unit depends on the metric (see METRIC_BOUNDS). */
  value: number
}

export interface CustomRules {
  name: string
  entry: CustomRule[]
  entryLogic: 'all' | 'any'
  exit: CustomRule[]
  exitLogic: 'all' | 'any'
  stopLossPct: number
  takeProfitPct: number
}

/** Per-metric bounds for validation (n window range, human hint) plus the
 * sweep style the optimizer uses when a threshold becomes a tuning knob:
 * an absolute range and a band around the current value for a sane default
 * grid. One table, shared by the parser and the knob builder. */
export const METRIC_BOUNDS: Record<CustomRule['metric'], {
  nMin: number
  nMax: number
  valueHint: string
  min: number
  max: number
  band: number
  step: number
  unit?: string
}> = {
  rsi: { nMin: 2, nMax: 100, valueHint: 'RSI level, 0–100', min: 0, max: 100, band: 20, step: 2 },
  ema: { nMin: 2, nMax: 200, valueHint: 'gap of close vs EMA(n), in percent (n2 for a fast/slow pair)', min: -50, max: 50, band: 2, step: 0.1, unit: '%' },
  zscore: { nMin: 2, nMax: 200, valueHint: 'z-score of close vs rolling mean(n)', min: -8, max: 8, band: 1, step: 0.1 },
  donchianHigh: { nMin: 2, nMax: 400, valueHint: 'distance of close above the highest high of the last n bars, in percent (negative = below)', min: -50, max: 50, band: 5, step: 0.5, unit: '%' },
  donchianLow: { nMin: 2, nMax: 400, valueHint: 'distance of close below the lowest low of the last n bars, in percent (negative = above)', min: -50, max: 50, band: 5, step: 0.5, unit: '%' },
  momentum: { nMin: 2, nMax: 400, valueHint: 'return over n bars, in percent', min: -100, max: 100, band: 10, step: 0.5, unit: '%' },
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000

/** Tunable knobs for an uploaded rules payload: every entry/exit threshold
 * plus the stop and target, as ParamDefs the optimizer and the Training form
 * both understand. A rule's default sweep is a band around its current value
 * so a first grid starts near something meaningful. Knob keys for thresholds
 * are dotted (`entry.0.value`) — the optimizer bakes them back into the
 * rules blob before each run. */
export function customKnobDefs(rules: CustomRules): ParamDef[] {
  const ruleDef = (rule: CustomRule, key: string, label: string): ParamDef => {
    const bounds = METRIC_BOUNDS[rule.metric]
    return {
      key,
      label,
      type: 'number',
      default: rule.value,
      min: round4(Math.max(bounds.min, rule.value - bounds.band)),
      max: round4(Math.min(bounds.max, rule.value + bounds.band)),
      step: bounds.step,
      unit: bounds.unit,
      hint: bounds.valueHint,
    }
  }
  return [
    ...rules.entry.map((rule, i) => ruleDef(rule, `entry.${i}.value`, `Entry ${i + 1} threshold (${rule.metric})`)),
    ...rules.exit.map((rule, i) => ruleDef(rule, `exit.${i}.value`, `Exit ${i + 1} threshold (${rule.metric})`)),
    { key: 'stopLossPct', label: 'Stop loss', type: 'number', default: rules.stopLossPct, min: 0, max: 90, step: 0.5, unit: '%', hint: '0 disables' },
    { key: 'takeProfitPct', label: 'Take profit', type: 'number', default: rules.takeProfitPct, min: 0, max: 500, step: 1, unit: '%' },
  ]
}

// --- Edge comparison --------------------------------------------------------

/** One bot's row in the fleet-wide market-edge ranking: how well its
 * strategy's entry signals predict the next bar, ranked best first. */
export interface BotEdge {
  rank: number
  botId: string
  name: string
  strategyName: string
  symbol: string | null
  timeframe: Timeframe
  status: BotStatus
  stage: BotStage
  accuracy: AccuracyStat
  live: { wins: number; roundTrips: number; hitRate: number | null }
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

/** Cap on a training sweep's parameter combinations — enforced server-side
 * and mirrored by the Training form so the button never promises a run the
 * optimizer will reject. */
export const TRAIN_MAX_COMBOS = 12

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
