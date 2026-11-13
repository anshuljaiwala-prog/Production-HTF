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

/** How many markets one bot tracks at once. Enforced by the launch and patch
 * ingress and mirrored by the symbol picker, so the form never offers a
 * selection the server would trim. */
export const MAX_TRACKED_SYMBOLS = 6

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
 * Live-running bots are actively trading; a live bot that is not running but
 * still holds open positions is inactive (holds its book, opens nothing
 * new); a flat, non-running bot is grounded (no trades, no positions).
 * Paper-mode bots sit in the training hangar: a running one is training
 * (serving paper trades / being backtested), a stopped one is parked in the
 * hangar (backtesting or holding its paper wallet offline). */
export type BotActivity = 'active' | 'inactive' | 'grounded' | 'training' | 'hangar'

export const ACTIVITIES: { key: BotActivity; label: string; hint: string }[] = [
  { key: 'active', label: 'Active', hint: 'actively trading (live)' },
  { key: 'inactive', label: 'Inactive', hint: 'holding positions, opening none' },
  { key: 'grounded', label: 'Grounded', hint: 'not trading, not holding' },
  { key: 'training', label: 'Training', hint: 'paper trading / being backtested' },
  { key: 'hangar', label: 'In hangar', hint: 'parked paper bot — backtesting or idle' },
]

export function activityOf(bot: Pick<Bot, 'status' | 'openPositions' | 'mode'>): BotActivity {
  if (bot.mode === 'paper') return bot.status === 'running' ? 'training' : 'hangar'
  if (bot.status === 'running') return 'active'
  return bot.openPositions > 0 ? 'inactive' : 'grounded'
}

export type ParamValue = number | string | boolean

/** Asset classes the simulated market covers. Options are modelled as
 * constant-maturity synthetic derivatives over an underlying; everything
 * else is a plain instrument with its own synthetic price path. */
export type AssetKind = 'crypto' | 'equity' | 'etf' | 'fund' | 'commodity' | 'fx' | 'option' | 'future'

export const ASSET_CLASSES: { key: AssetKind; label: string; hint: string }[] = [
  { key: 'crypto', label: 'Crypto', hint: '24/7 spot pairs' },
  { key: 'equity', label: 'Stocks', hint: 'US and foreign single-name equities' },
  { key: 'etf', label: 'ETFs', hint: 'exchange-traded funds' },
  { key: 'fund', label: 'Mutual funds', hint: 'once-daily NAV-like funds' },
  { key: 'commodity', label: 'Commodities', hint: 'metals, energy' },
  { key: 'fx', label: 'Forex', hint: 'multi-nation currency pairs' },
  { key: 'option', label: 'Options', hint: 'calls & puts on the same synthetic feed' },
  { key: 'future', label: 'Futures', hint: 'expiry-dated contracts (BSE index futures)' },
]

/** Cached state of one exchange's instrument master (currently BSE's BSE_FO
 * contracts), as loaded from the venue into the workspace database. */
export interface InstrumentMasterStatus {
  /** Live contracts stored: futures, calls and puts. */
  contracts: number
  /** When the master was last downloaded, epoch ms; null when never loaded. */
  syncedAt: number | null
  /** How long a cached master is trusted before it is reloaded. */
  ttlMs: number
  /** Underlyings the master carries derivatives for. */
  underlyings: string[]
}

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
  /** Which venue environment the adapter talks to: exchange sandbox or the
   * production order API. */
  environment: VenueEnvironment
  createdAt: number
}

export type VenueEnvironment = 'sandbox' | 'production'

/** How many exchanges one live bot can route across (best price wins). */
export const MAX_BOT_VENUES = 4

/** One exchange connection a bot can route an order through. */
export interface BotVenue {
  connectionId: string
  name: string
  exchange: string
  environment: VenueEnvironment
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
  /** Primary venue (first in `venueIds`), kept for older call sites. */
  connectionId: string | null
  connectionName: string | null
  /** Every venue this bot may route through, primary first. */
  venueIds: string[]
  venues: BotVenue[]
  /** Consecutive risk-off reads, for the agent gate's damping. */
  riskOffStreak: number
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
  /** `short` opens a negative book, `cover` closes it. */
  side: 'buy' | 'sell' | 'short' | 'cover'
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
  /** Whole-fleet counts in the operator's vocabulary, for the status strip. */
  fleet: { running: number; paused: number; grounded: number; training: number; hangar: number; paper: number; live: number; total: number }
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
  /** Always the live book ('live') — present so clients can verify no
   * paper fill leaked into the money ledger. */
  mode?: 'paper' | 'live'
  symbol: string
  side: 'buy' | 'sell' | 'short' | 'cover'
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
  /** One row per ISO week covered by the stored flows/trades: net funding
   * (deposits − withdrawals) against realized P&L for the same week, so the
   * fleet overview can reconcile cash movement against trading results. */
  weekly: { label: string; funding: number; pnl: number }[]
  bots: PortfolioBotAudit[]
  positions: PortfolioPosition[]
  transactions: PortfolioTransaction[]
  /** Live-book cash flows; paper bots are not part of this ledger. */
  funding: CashFlow[]
}

/** The simulated wallet, reported separately under Backtesting. It is never
 * mixed into the Portfolio page's money book. */
export interface PaperBook {
  summary: {
    bots: number
    capital: number
    equity: number
    pnl: number
    realizedPnl: number
    unrealizedPnl: number
    fees: number
    fills: number
    roundTrips: number
    wins: number
    winRate: number | null
    netFunding: number
    openPositions: number
  }
  equity: { label: string; value: number }[]
  bots: PortfolioBotAudit[]
  funding: CashFlow[]
}

export interface Me {
  user: { sub: string; name?: string; email?: string; picture?: string }
  workspace: { name: string; seededAt: number | null }
  capabilities: { database: boolean; files: boolean; auth: 'freebuff' | 'development' }
}

// --- Pattern scan & event linkage -------------------------------------------

/** What a symbol's recent tape looks like, measured not guessed: a crash is a
 * deep drawdown with a fast recent leg, a hype the mirror, a squeeze
 * compressed volatility, etc. Every regime carries the numbers behind it. */
export type PatternRegime = 'crash' | 'selloff' | 'hype' | 'breakout' | 'squeeze' | 'uptrend' | 'downtrend' | 'range'

export const PATTERN_REGIMES: { key: PatternRegime; label: string; hint: string }[] = [
  { key: 'crash', label: 'Crash', hint: 'deep drawdown with a fast recent leg' },
  { key: 'selloff', label: 'Selloff', hint: 'marked drawdown, slower than a crash' },
  { key: 'hype', label: 'Hype', hint: 'fast run-up off a recent low' },
  { key: 'breakout', label: 'Breakout', hint: 'new high with expanding volatility' },
  { key: 'squeeze', label: 'Squeeze', hint: 'compressed volatility, no direction' },
  { key: 'uptrend', label: 'Uptrend', hint: 'rising slope with contained drawdown' },
  { key: 'downtrend', label: 'Downtrend', hint: 'falling slope with contained run-up' },
  { key: 'range', label: 'Range', hint: 'no dominant direction' },
]

/** One symbol's pattern read over the bot's own timeframe and history window. */
export interface SymbolPattern {
  symbol: string
  kind: AssetKind
  /** Last closed price. */
  price: number
  /** Return across the whole analysis window, in percent. */
  changePct: number
  /** Return over the recent leg (last RECENT_BARS of the window), in percent. */
  recentPct: number
  /** Price return over the last 50 bars, in percent. */
  trendPct: number
  /** Close below the window high, in percent (0 when at the high). */
  drawdownPct: number
  /** Close above the window low, in percent (0 when at the low). */
  runupPct: number
  /** Realised per-bar volatility in percent. */
  volPct: number
  /** Where `volPct` sits among the window's other 20-bar blocks, 0–100. */
  volPercentile: number
  /** Recent volatility as a multiple of the window's median block volatility —
   * a percentile alone can call a calm tape a spike. */
  volVsMedian: number
  /** How far the latest close sits from the recent window's mean, in standard
   * deviations. Null when the window carries no dispersion. */
  priceZ: number | null
  /** The same z-score for volume: >0 heavy participation, <0 thin. Null when
   * the tape carries no usable volume. */
  volZ: number | null
  /** A violent price excursion (|priceZ| ≥ 2.5) on thin volume (volZ < 0.5):
   * the tape was pushed through an empty book, not confirmed by participation. */
  liquidityVacuum: boolean
  /** Bars since the window high / low — how fast the move happened. */
  barsSinceHigh: number
  barsSinceLow: number
  regime: PatternRegime
  /** How far past the rule's threshold this read sits, 0–100. */
  confidence: number
  /** Human-readable facts behind the classification, with the numbers. */
  evidence: string[]
  /** Last closes, sampled for a sparkline. */
  spark: number[]
  /** Position the bot holds in this symbol (0 when flat). */
  positionQty: number
}

export type EpisodeKind = 'crash' | 'hype'

/** A large historical crash or hype the scanner compares the current tape
 * against. Figures are the published peak-to-trough (or low-to-peak) moves
 * and rough durations of the episode. */
export interface CrisisEpisode {
  id: string
  name: string
  kind: EpisodeKind
  /** Period label, e.g. "Sep 1929 – Jul 1932". */
  period: string
  /** Peak-to-trough for crashes (negative) / low-to-peak for hypes (positive). */
  magnitudePct: number
  /** Days the move took, start to trough/peak. */
  days: number
  /** Realised volatility as a multiple of the preceding calm baseline. */
  volMultiple: number
  /** Markets most associated with the episode. */
  assets: string[]
  /** One line on what happened. */
  what: string
}

/** A tracked symbol scored against one episode. Direction must agree: a
 * drawdown is only compared with crashes, a run-up only with hypes. */
export interface EpisodeMatch {
  episode: CrisisEpisode
  symbol: string
  /** 0–100 shape similarity (magnitude, speed, volatility multiple). */
  similarity: number
  /** The current reading that produced the score. */
  why: string
}

/** Something the market is doing right now, derived from the same stored feed
 * the bots trade — the events a pattern read is linked to. */
export interface MarketEvent {
  id: string
  kind: 'drawdown' | 'runup' | 'vol-spike' | 'stress' | 'breadth'
  severity: 'info' | 'warn' | 'alert'
  headline: string
  detail: string
  symbols: string[]
  /** The measured number behind it (percent, or a count for breadth). */
  value: number
  at: number
}

/** Everything the bot detail page shows for a multi-symbol pattern scan. */
export interface BotPatterns {
  botId: string
  timeframe: Timeframe
  generatedAt: number
  window: { from: number; to: number; bars: number }
  symbols: SymbolPattern[]
  /** Best historic crash/hype analogs across every tracked symbol. */
  episodes: EpisodeMatch[]
  events: MarketEvent[]
}

/** The regimes the fleet ranking acts on: tapes an operator has to react to
 * now, rather than the full regime vocabulary of a single-symbol scan. */
export type FleetRegime = Extract<PatternRegime, 'crash' | 'hype' | 'squeeze'>

export const FLEET_REGIMES: { key: FleetRegime; label: string; hint: string }[] = [
  { key: 'crash', label: 'Crash', hint: 'deep drawdown with a fast recent leg' },
  { key: 'hype', label: 'Hype', hint: 'fast run-up off a recent low' },
  { key: 'squeeze', label: 'Squeeze', hint: 'compressed volatility, direction not set' },
]

/** One bot in the fleet pattern ranking, scored on the strongest crash, hype or
 * squeeze read among the markets it tracks. */
export interface FleetPatternEntry {
  rank: number
  botId: string
  name: string
  strategyName: string
  status: BotStatus
  stage: BotStage
  mode: BotMode
  timeframe: Timeframe
  /** The strongest target-regime market among this bot's tracked symbols. */
  symbol: string
  regime: FleetRegime
  /** Composite 0–100: regime confidence blended with move intensity, lifted
   * when the bot actually holds the market. */
  score: number
  /** The classifier's confidence in the regime read, 0–100. */
  confidence: number
  /** How far past the regime threshold the tape sits, 0–100. */
  intensity: number
  /** Position held in `symbol` (0 when flat). */
  positionQty: number
  /** Other tracked markets also reading crash, hype or squeeze. */
  others: string[]
  /** Target-regime counts across every market this bot tracks. */
  breakdown: Record<FleetRegime, number>
  changePct: number
  recentPct: number
  drawdownPct: number
  runupPct: number
  volPercentile: number
  /** Volume z-score behind this read — see SymbolPattern.volZ. */
  volZ: number | null
  /** Violent move on thin volume; the regime read is unconfirmed. */
  liquidityVacuum: boolean
  evidence: string[]
  spark: number[]
}

/** Fleet-wide pattern ranking: which bots are trading markets that read crash,
 * hype or squeeze right now, strongest tape first. */
export interface FleetPatternRanking {
  generatedAt: number
  /** Bars analysed per market. */
  bars: number
  /** Bots evaluated in this scan. */
  scanned: number
  /** Bots with at least one target-regime market. */
  matched: number
  /** Bots whose strongest read belongs to each regime. */
  counts: Record<FleetRegime, number>
  /** Matched bots that are currently running. */
  active: number
  /** Matched bots holding a position in one of those markets. */
  positions: number
  items: FleetPatternEntry[]
}

/** One historical bar imported into the API database (bulk data upload). */
export interface ImportedBar {
  symbol: string
  timeframe: Timeframe
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** Result of a bulk import: how many rows landed, and why the rest were
 * screened out — duplicates (same bucket, same bar), invalid (non-finite
 * prices, broken OHLC), unknown symbol/timeframe. */
export interface MarketImportResult {
  accepted: number
  updated: number
  duplicates: { index: number; reason: string }[]
  invalid: { index: number; reason: string }[]
}

/** What the API database holds today, per symbol+timeframe bucket. */
export interface StoredBarsSummary {
  symbol: string
  timeframe: Timeframe
  bars: number
  first: number
  last: number
}

// --- Tool box (execution plans) & strategy book ------------------------------

/** A trading execution plan in the tool box: the concrete bot configuration to
 * run when the pattern scanner recognises the plan's regime on a tracked
 * market. Plans exist as ready-to-deploy configs — the book decides when they
 * fire, execution copies them onto a bot. */
export interface Playbook {
  id: string
  name: string
  /** The regime read that calls for this plan. */
  regime: PatternRegime
  strategyKey: string
  params: Record<string, ParamValue>
  /** The bar timeframe the plan wants to run on; null follows the bot's own. */
  timeframe: Timeframe | null
  /** Position sizing as a percent of equity, per fill. */
  riskPct: number
  /** Why this response, in one operator-readable line. */
  note: string
  source: 'builtin' | 'custom'
  createdAt: number
}

/** One regime's entry in the strategy book: which plan fires when that
 * regime is recognised and execution follows. `overridden` marks an entry
 * the operator has replaced from the tool box defaults. */
export interface BookEntry {
  regime: PatternRegime
  playbook: Playbook
  strategyName: string
  overridden: boolean
}

/** A live, actionable read from the strategy book: a recognised pattern on a
 * tracked market whose regime has a book entry, on a bot not already trading
 * it — the row the operator executes to trade the pattern. */
export interface BookSignal {
  botId: string
  botName: string
  botStatus: BotStatus
  symbol: string
  regime: PatternRegime
  /** The classifier's confidence in the regime read, 0–100. */
  confidence: number
  playbook: Playbook
  strategyName: string
  /** The bot's tracked capital for sizing an executed plan against. */
  botCapital: number
  /** Why the scanner classed this market into the regime, with numbers. */
  evidence: string[]
  price: number
  changePct: number
  drawdownPct: number
  runupPct: number
  spark: number[]
}

/** Tool box payload: every plan the operator can deploy, builtin first. */
export interface ToolBox {
  items: Playbook[]

  /** How many regimes of the book this box's plans cover. */
  bookCoverage: number
}

/** Current-affairs payload: today's cross-market snapshot plus a world news
 * wire (live RSS when the sandbox can reach it, market-driven wire otherwise). */
export interface Affairs {
  generatedAt: number
  newsSource: 'rss' | 'feed'
  snapshot: { symbol: string; label: string; kind: string; price: number; dayPct: number }[]
  regions: { region: string; proxy: string; dayPct: number; series: number[] }[]
  movers: { symbol: string; dayPct: number; price: number }[]
  news: { title: string; source: string; link: string; publishedAt: number }[]
}

// --- Agent shell (ported from market_agent_env) -----------------------------

/** The macro regime the expert system derives from cross-market breadth. */
export type MacroRegime = 'RISK_ON_BOOM' | 'NEUTRAL' | 'RISK_OFF_CONTAGION'

/** Volume/price dislocation read (the Python app's AnomalyDetector). */
export type AnomalySignal = 'CRASH_TRIGGER' | 'BOOM_TRIGGER' | 'LIQUIDITY_VACUUM' | 'NORMAL_VARIATION'

/** A tape event pinned for the inference rules. Rebuilt from the market on
 * every environment read — there is no decaying news store to age. */
export interface NewsPin {
  id: string
  ticker: string
  title: string
  summary: string
  source: string
  timestamp: number
  impactLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  /** −1…1. */
  sentiment: number
}

/** One fired production rule: the fact it derived and the action it suggests. */
export interface AgentInference {
  inferredFact: string
  bias: string
  salience: number
  nextAction: string
  triggeredByRule: string
}

/** One market's technical read inside the environment. */
export interface AgentMarketRead {
  symbol: string
  /** Change over the last 24 bars, in percent. */
  changePct: number
  rsi: number
  anomaly: { signal: AnomalySignal; details: string | null }
}

/** The facts the forward-chaining rules resolved against. */
export interface AgentWorkingMemory {
  ticker: string
  institutionalPct: number
  sentiment: number
  rsi: number
  affiliationsCount: number
  anomalySignal: string
  criticalNegativeNews: boolean
  globalNegativeCount: number
}

/** Everything one environment read produced: the regime, the markets behind
 * it, the pins it harvested, the facts it fired on and whether new buys are
 * allowed. */
export interface AgentRead {
  generatedAt: number
  regime: MacroRegime
  markets: AgentMarketRead[]
  /** Markets dislocated badly enough that bots trading them stand down. */
  criticalMarkets: string[]
  pins: NewsPin[]
  inferences: AgentInference[]
  workingMemory: AgentWorkingMemory
  /** The focused company's ownership, affiliations and sentiment. */
  company: AgentCompanyFacts
  /** What each specialist analyst concluded, before arbitration. */
  proposals: AgentProposal[]
  /** The specialist that won, or null when none cleared the threshold. */
  verdict: AgentVerdict
  /** The company's most likely next strategic move. */
  nextMove: CompanyMovePrediction
  /** Rows the screener rejected before they reached the rules, by reason. */
  screened: {
    rejectedBars: number
    rejectedPins: number
    /** e.g. `{ bad_range: 2, out_of_order: 1 }`. */
    barReasons: Record<string, number>
    pinReasons: Record<string, number>
  }
}

/** The gate's verdict for one bot (or, with no symbols, the macro view). */
export interface AgentGateVerdict {
  blocked: boolean
  /** Why entries are held back, or null when they are allowed. */
  reason: string | null
  /** Consecutive risk-off checks, to persist and pass back on the next read. */
  streak: number
}

/** The specialised analysts of the expert system (market_agent_env's bots.py).
 * Each reads one slice of the environment and proposes a direction with the
 * conviction its own facts support. */
export type SpecialistAgent = 'ownership' | 'anomaly' | 'news' | 'move'

export interface AgentProposal {
  agent: SpecialistAgent
  /** −1…1. Negative is bearish, positive bullish. */
  bias: number
  /** 0…1 — how strongly the agent's own measured facts back its bias. Derived
   * from those facts, never assigned by hand. */
  conviction: number
  rationale: string
  /** The numbers behind the proposal, so a reader can check the arithmetic. */
  facts: string[]
  /** Stable ids of the facts each entry in `facts` came from, e.g.
   * `ownership:institutional_pct` or `news:<pin id>` — so a trace can say which
   * inputs a proposal actually used, not just that it had some. */
  factIds: string[]
}

/** Which specialist won the arbitration, and on what. */
export interface AgentVerdict {
  winner: SpecialistAgent | null
  bias: number
  conviction: number
  rationale: string
  /** Proposals below this conviction never win. */
  threshold: number
}

export interface CompanyMoveCandidate {
  move: string
  /** 0…1. */
  probability: number
  rationale: string
}

/** The company's most likely next strategic move. `probability` is always
 * present — with no ownership facts it is the status-quo baseline and
 * `factsAvailable` says why, rather than the prediction disappearing. */
export interface CompanyMovePrediction {
  move: string
  probability: number
  rationale: string
  candidates: CompanyMoveCandidate[]
  factsAvailable: boolean
}

/** The company knowledge the environment holds for one ticker. */
export interface AgentCompanyFacts {
  ticker: string
  ownership: { holder: string; percentage: number; holderType: string }[]
  affiliations: string[]
  sentimentScore: number
  /** Sum of institutional stakes, 0…1. */
  institutionalPct: number
  /** False when this ticker has no seeded knowledge: nothing is inferred. */
  factsAvailable: boolean
}

/** A pin as the environment stores it: the same tape event, with how long it
 * has been held and how many reads re-saw it. */
export interface EnvironmentPin extends NewsPin {
  firstSeen: number
  lastSeen: number
  reads: number
}

/** Live environment state, as the Durable Object holds it between requests. */
export interface EnvironmentState {
  generatedAt: number
  controls: { paused: boolean; pauseBuys: boolean }
  /** The last read the environment performed. */
  read: AgentRead
  pins: EnvironmentPin[]
}

// --- Decision trace & prediction calibration ---------------------------------

/** Why a signal the strategy emitted never filled. */
export type TraceRejectReason = 'gate' | 'sizing' | 'fill_cap' | 'live_short' | 'no_position'

/** One symbol's outcome inside a closed bar. */
export interface TraceDecision {
  symbol: string
  action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
  /** The strategy's own reason for the signal, if it gave one. */
  reason: string | null
  /** Size the engine placed, or null when nothing was placed. */
  qty: number | null
  fill: boolean
  reject: TraceRejectReason | null
}

/** One closed bar's decision, as the engine made it: the gate, every specialist
 * proposal with the fact ids behind it, the arbitration result and what each
 * symbol did. */
export interface AgentDecisionTrace {
  botId: string
  botName: string
  /** Bar close time, ms. */
  at: number
  gate: AgentGateVerdict
  proposals: AgentProposal[]
  verdict: AgentVerdict
  decisions: TraceDecision[]
}

/** Predicted-probability bucket vs the frequency it actually happened. */
export interface PredictionBin {
  from: number
  to: number
  count: number
  /** Mean probability the forecasts in this bucket carried. */
  meanPredicted: number
  /** Share of them whose predicted event actually happened. */
  observed: number
}

export interface ScoredPrediction {
  symbol: string
  /** Bar close the prediction was made at. */
  at: number
  move: string
  probability: number
  returnPct: number | null
  outcome: boolean | null
}

/** How well the always-on move probability has tracked what followed. */
export interface PredictionCalibration {
  /** Rows scored, and the window the aggregate covers. */
  resolved: number
  /** Mean squared error of the probabilities; 0 is perfect, 0.25 is a coin. */
  brier: number | null
  /** Brier score of a constant 0.5 forecast, for comparison. */
  baseline: number
  bins: PredictionBin[]
  latest: ScoredPrediction[]
}

export interface EnvironmentTrace {
  traces: AgentDecisionTrace[]
  calibration: PredictionCalibration
}
