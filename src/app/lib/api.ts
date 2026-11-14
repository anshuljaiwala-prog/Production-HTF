import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  AccuracyStat,
  Backtest,
  Bot,
  BotEdge,
  BotEvent,
  BotPatterns,
  BotStage,
  BotStatus,
  Candle,
  Connection,
  CustomStrategySummary,
  Dashboard,
  EnvironmentState,
  EnvironmentTrace,
  EquityPoint,
  FleetPatternRanking,
  InstrumentMasterStatus,
  Me,
  PaperBook,
  ParamValue,
  Portfolio,
  Position,
  RunMetrics,
  SearchResults,
  SimBudget,
  Strategy,
  SymbolMeta,
  Timeframe,
  ToolBox,
  Trade,
} from '../../shared/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (!response.ok) {
    let message = response.statusText
    let code: string | undefined
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      message = body.message ?? body.error ?? message
      code = body.error
    } catch {
      /* no body */
    }
    throw new ApiError(response.status, message, code)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

// Queries. Running bots are fast-forwarded server-side on every read, so
// polling is the live feed: intervals adapt to fleet activity. A running bot
// (or any active bot on the dashboard) gets a fast cadence — marks are
// recomputed server-side on each poll, so equity moves in real time — while an
// idle fleet drops to a slow heartbeat instead of re-polling at run speed.

/** Adaptive refetch cadence: fast while active, `slow` otherwise (false stops polling). */
function liveInterval<T>(fast: number, slow: number | false, hasActivity: (data: T) => boolean) {
  return (query: { state: { data?: T } }): number | false => {
    const data = query.state.data
    if (!data) return false
    return hasActivity(data) ? fast : slow
  }
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), retry: false, staleTime: 60_000 })
/** Workspace overview; `days` selects the equity window (7 / 30 / 365). */
export const useDashboard = (days = 30) =>
  useQuery({
    queryKey: ['dashboard', days],
    queryFn: () => api<Dashboard>(`/overview?days=${days}`),
    refetchInterval: liveInterval<Dashboard>(4_000, 20_000, (d) => d.kpis.activeBots > 0),
    placeholderData: (p) => p,
  })

export const useStrategies = () =>
  useQuery({
    queryKey: ['strategies'],
    queryFn: () =>
      api<{ strategies: Strategy[]; symbols: SymbolMeta[]; timeframes: { key: Timeframe; label: string }[] }>('/strategies'),
    staleTime: 60_000,
  })

export const useCustomStrategies = () =>
  useQuery({
    queryKey: ['custom-strategies'],
    queryFn: () => api<{ items: CustomStrategySummary[] }>('/strategies/custom'),
    staleTime: 15_000,
  })

/** Uploaded strategy detail (the validated rules payload as accepted). */
export const useCustomStrategy = (id: string | undefined) =>
  useQuery({
    queryKey: ['custom-strategy', id],
    queryFn: () =>
      api<{ strategy: CustomStrategySummary; rules: Record<string, unknown>; durable: boolean }>(`/strategies/custom/${id}`),
    enabled: Boolean(id),
    staleTime: 60_000,
  })

/** Upload a rules JSON payload to the durable, versioned strategy store:
 * the same name stores a new version beside its history. */
export const uploadCustomStrategy = (rules: unknown) =>
  api<
    { strategy: CustomStrategySummary; detail: Record<string, unknown>; durable: boolean }
  >('/strategies/custom', { method: 'POST', json: { rules } })
/** Deletes the whole strategy family — every stored version. */
export const deleteCustomStrategy = (id: string) => api<{ ok: true; removed: number }>(`/strategies/custom/${id}`, { method: 'DELETE' })

export interface BotAccuracy {
  botId: string
  strategyKey: string
  window: { bars: number; from: number; to: number; timeframe: Timeframe; symbol: string | null }
  accuracy: AccuracyStat
  live: { wins: number; roundTrips: number; hitRate: number | null }
}

/** How well this bot's strategy predicts the next bar (per request — wrapped
 * in 2s-poll cadence alongside the run monitor). */
export const useBotAccuracy = (botId: string | undefined) =>
  useQuery({
    queryKey: ['bot-accuracy', botId],
    queryFn: () => api<BotAccuracy>(`/bots/${botId}/accuracy`),
    enabled: Boolean(botId),
    refetchInterval: 30_000,
    placeholderData: (p) => p,
  })

/** Per-symbol pattern scan for one bot: regimes with their evidence, the
 * historic crash/hype analogs each tape resembles, and the events the market
 * is producing right now. Refreshes on the slow cadence — a regime read is
 * not a tick. */
export const useBotPatterns = (botId: string | undefined) =>
  useQuery({
    queryKey: ['bot-patterns', botId],
    queryFn: () => api<BotPatterns>(`/analysis/bots/${botId}/patterns`),
    enabled: Boolean(botId),
    refetchInterval: 60_000,
    placeholderData: (p) => p,
  })

/** Fleet-wide pattern ranking: which bots are trading markets reading crash,
 * hype or squeeze right now, strongest tape first. A regime read is not a
 * tick, so it refreshes on the slow cadence. */
export const useFleetPatterns = () =>
  useQuery({
    queryKey: ['fleet-patterns'],
    queryFn: () => api<FleetPatternRanking>('/analysis/patterns'),
    refetchInterval: 60_000,
    placeholderData: (p) => p,
  })

export interface BotEdgeRanking {
  items: BotEdge[]
  window: { bars: number; to: number }
}

/** Fleet-wide market-edge ranking: every bot scored on the same window,
 * best directional accuracy first. */
export const useBotEdge = () =>
  useQuery({
    queryKey: ['bot-edge'],
    queryFn: () => api<BotEdgeRanking>('/bots/accuracy'),
    refetchInterval: 30_000,
    placeholderData: (p) => p,
  })

export const useBots = () =>
  useQuery({
    queryKey: ['bots'],
    queryFn: () => api<{ items: Bot[] }>('/bots'),
    refetchInterval: liveInterval<{ items: Bot[] }>(4_000, 20_000, (d) => d.items.some((bot) => bot.status === 'running')),
    placeholderData: (p) => p,
  })

export interface BotDetail {
  bot: Bot
  positions: Position[]
  trades: Trade[]
  events: BotEvent[]
  equity: EquityPoint[]
}

export const useBot = (botId: string | undefined) =>
  useQuery({
    queryKey: ['bot', botId],
    queryFn: () => api<BotDetail>(`/bots/${botId}`),
    enabled: Boolean(botId),
    refetchInterval: liveInterval<BotDetail>(2_000, 20_000, (d) => d.bot.status === 'running'),
    placeholderData: (p) => p,
  })

export const useBacktests = () =>
  useQuery({
    queryKey: ['backtests'],
    queryFn: () => api<{ items: Backtest[]; sim: SimBudget }>('/backtests'),
    // Runs execute lazily on read; poll while anything is pending so the
    // status flips to done/failed (and the results appear) automatically.
    refetchInterval: liveInterval<{ items: Backtest[]; sim: SimBudget }>(1_000, false, (d) => d.items.some((b) => b.status === 'running')),
    placeholderData: (p) => p,
  })

export interface BacktestMarket {
  backtestId: string
  symbol: string
  timeframe: Timeframe
  status: Backtest['status']
  bars: number
  windowFrom: number
  windowTo: number
  candles: Candle[]
}

/** Full payload of one backtest. The list endpoint strips trades for size;
 * the drawer (charts, trade table) reads this instead. */
export const useBacktestDetail = (backtestId: string | undefined) =>
  useQuery({
    queryKey: ['backtest', backtestId],
    queryFn: () => api<{ backtest: Backtest }>(`/backtests/${backtestId}`),
    enabled: Boolean(backtestId),
    placeholderData: (p) => p,
  })

/** The simulated-feed bars a backtest replayed, bucketed into display
 * candles. Deterministic — the same run always charts the same bars. */
export const useBacktestMarket = (backtestId: string | undefined) =>
  useQuery({
    queryKey: ['backtest-market', backtestId],
    queryFn: () => api<BacktestMarket>(`/backtests/${backtestId}/market`),
    enabled: Boolean(backtestId),
    staleTime: 60_000,
    placeholderData: (p) => p,
  })

export const useConnections = () =>
  useQuery({ queryKey: ['connections'], queryFn: () => api<{ items: Connection[]; exchanges: string[] }>('/connections') })

export const usePortfolio = () =>
  useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api<Portfolio>('/portfolio'),
    refetchInterval: liveInterval<Portfolio>(4_000, 20_000, (d) => d.summary.activeBots > 0),
    placeholderData: (p) => p,
  })

/** The simulated wallet, reported under Backtesting — never part of the money
 * book above. */
export const usePaperBook = () =>
  useQuery({
    queryKey: ['portfolio', 'paper'],
    queryFn: () => api<PaperBook>('/portfolio/paper'),
    refetchInterval: 20_000,
    placeholderData: (p) => p,
  })

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ['search', q],
    queryFn: () => api<SearchResults>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    staleTime: 10_000,
  })

// Mutations. Each invalidates the lists it can affect; detail pages refetch
// through their own keys.

export function useInvalidate() {
  const client = useQueryClient()
  return (...keys: string[]) => Promise.all(keys.map((key) => client.invalidateQueries({ queryKey: [key] })))
}

export function useApiMutation<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  invalidates: string[],
  options?: { onSuccess?: (result: TResult, input: TInput) => void; onError?: (error: Error) => void },
) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: run,
    onSuccess: (result, input) => {
      // The mutation already succeeded, so its follow-up (toast, navigation)
      // runs first and unconditionally; the refetch is best-effort — a delete
      // can invalidate a query whose resource no longer exists.
      options?.onSuccess?.(result, input)
      void invalidate(...invalidates)
    },
    onError: options?.onError,
  })
}

export interface LaunchInput {
  strategyKey: string
  name?: string
  symbols: string[]
  timeframe: Timeframe
  params: Record<string, ParamValue>
  capital: number
  riskPct: number
  mode: 'paper' | 'live'
  connectionId?: string | null
  /** Multi-venue routing — first id is the primary venue. */
  venueIds?: string[]
  status?: BotStatus
  /** Inline uploaded rules — the bot runs the `custom` strategist with them. */
  rules?: unknown
}

export const launchBot = (input: LaunchInput) => api<{ bot: Bot }>('/bots', { method: 'POST', json: input })
/** Ground = stop with operator vocabulary (holds its book, opens nothing);
 * resume = start again. */
export type BotControl = 'start' | 'pause' | 'stop' | 'ground' | 'resume'
export const controlBot = (botId: string, action: BotControl) =>
  api<{ bot: Bot }>(`/bots/${botId}/control`, { method: 'POST', json: { action } })

/** Review the payload before importing: same validation, nothing created. */
export interface ImportReviewRow {
  label: string
  problem: string | null
}
export interface ImportPreview {
  ready: number
  rows: ImportReviewRow[]
}
export const reviewImport = (items: Record<string, unknown>[]) =>
  api<ImportPreview>('/bots/import?validate=1', { method: 'POST', json: { items } })/** Bulk bot config import (uploaded file or pasted JSON payload). Good rows
 * launch (paused); bad rows come back with the reason so the dialog can show
 * them. Rows may carry inline `rules` (custom strategy) and `connectionId`
 * (which saved exchange API the bot routes through). */
/** What the batch is for: live (paused paper/live bots awaiting review,
 * the previous behavior), or parked configs that immediately queue a
 * backtest / training sweep from their exact config. */
export type ImportIntent = 'live' | 'backtest' | 'train'
export interface TrainingSummary {
  botId: string
  botName: string
  swept: string | null
  combos: number
  bestTrain: number | null
  bestTest: number | null
  error: string | null
}
export interface ImportRunSummary {
  queued: number
  errors: string[]
  training: TrainingSummary[]
  backtests: { id: string; name: string }[]
}
export interface BotImportResult {
  launched: Bot[]
  failed: { name: string; error: string }[]
  intent: ImportIntent
  runs: ImportRunSummary
}
export const importBots = (items: LaunchInput[], intent: ImportIntent = 'live') =>
  api<BotImportResult>('/bots/import', { method: 'POST', json: { items, intent } })
/** One-shot import from a public repo file. No token, no re-sync: the bots
 * this creates are ordinary bots from then on. */
export const importBotsFromGithub = (url: string, intent: ImportIntent = 'live') =>
  api<BotImportResult & { source: string }>('/bots/import/github', { method: 'POST', json: { url, intent } })

/** Bulk exchange-API upload: create many connections from one pasted JSON
 * payload. Each row is validated exactly like a single create; good rows are
 * stored, bad rows come back with their reason for the preview table. */
export interface ConnectionImportResult {
  created: Connection[]
  failed: { name: string; error: string }[]
}
export const uploadConnections = (items: { name: string; exchange: string; apiKey: string; apiSecret: string; mode: 'paper' | 'live' }[]) =>
  api<ConnectionImportResult>('/connections/bulk', { method: 'POST', json: { items } })
export const adjustFunding = (botId: string, input: { amount: number; note?: string }) =>
  api<{ bot: Bot }>(`/bots/${botId}/cashflow`, { method: 'POST', json: input })
/** Operator edits. Trading settings (symbols, timeframe, risk, params,
 * connection) are only accepted while the bot is not active — the server
 * answers 409 otherwise. */
export interface BotPatch {
  name?: string
  stage?: BotStage
  position?: number
  symbols?: string[]
  timeframe?: Timeframe
  riskPct?: number
  params?: Record<string, ParamValue>
  connectionId?: string | null
  venueIds?: string[]
  /** Starting capital, treated as funding (P&L preserved). */
  capital?: number
  /** Paper ↔ live venue switch — blocked by the server while the bot runs. */
  mode?: 'paper' | 'live'
}
export const patchBot = (botId: string, patch: BotPatch) =>
  api<{ bot: Bot }>(`/bots/${botId}`, { method: 'PATCH', json: patch })
export const deleteBot = (botId: string) => api<{ ok: true }>(`/bots/${botId}`, { method: 'DELETE' })

export interface BacktestInput {
  strategyKey: string
  symbol: string
  timeframe: Timeframe
  params: Record<string, ParamValue>
  capital: number
  days: number
  name?: string
  /** Inline uploaded rules — run the `custom` strategist with them. */
  rules?: unknown
}

export const runBacktest = async (input: BacktestInput) => {
  const to = Date.now()
  return api<{ backtest: Backtest }>('/backtests', {
    method: 'POST',
    json: { ...input, from: to - input.days * 86_400_000, to },
  })
}
export const deleteBacktest = (backtestId: string) => api<{ ok: true }>(`/backtests/${backtestId}`, { method: 'DELETE' })

// --- Training (grid search over stored history) -----------------------------

/** One parameter knob to sweep: from → to across `steps` values. */
export interface OptimizeKnob {
  key: string
  from: number
  to: number
  steps: number
}

export interface OptimizeRunRow {
  params: Record<string, ParamValue>
  train: RunMetrics
  test: RunMetrics | null
  error: string | null
}

export interface OptimizeInput {
  strategyKey?: string
  /** Train an existing bot's config instead of composing one. */
  botId?: string
  /** Uploaded rules payload: trains the custom strategist directly, with
   * each threshold sweepable like any catalog parameter. */
  rules?: unknown
  symbol?: string
  timeframe?: Timeframe
  capital?: number
  params?: Record<string, ParamValue>
  days?: number
  objective?: 'return' | 'sharpe'
  vary: OptimizeKnob[]
}

export interface OptimizeResult {
  source: {
    strategyKey: string
    strategyName: string
    symbol: string
    timeframe: Timeframe
    capital: number
    days: number
    from: number
    to: number
    split: number
    label: string
  }
  objective: 'return' | 'sharpe'
  history: { years: number; from: number }
  runs: OptimizeRunRow[]
  bestIndex: number
  best: { curve: EquityPoint[]; accuracy: AccuracyStat; metrics: RunMetrics } | null
  knobs: { key: string; label: string; unit: string | null; values: number[] }[]
}

/** Sweep a parameter grid over the stored five-year history. Training runs
 * are in-memory: they never allocate the simulation pot and persist nothing. */
export const optimizeTraining = (input: OptimizeInput) => api<OptimizeResult>('/backtests/optimize', { method: 'POST', json: input })

/** The platform's stored historical candles, bounded to the retention window. */
export interface MarketHistory {
  symbol: string
  timeframe: Timeframe
  from: number
  to: number
  bars: number
  history: { years: number; from: number; to: number }
  candles: Candle[]
}
export const fetchMarketHistory = (symbol: string, timeframe: Timeframe, days = 90) => {
  const to = Date.now()
  return api<MarketHistory>(
    `/market/history?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&from=${to - days * 86_400_000}&to=${to}`,
  )
}

export const createConnection = (input: {
  name: string
  exchange: string
  apiKey: string
  apiSecret: string
  mode: 'paper' | 'live'
  environment?: 'sandbox' | 'production'
}) => api<{ connection: Connection }>('/connections', { method: 'POST', json: input })
/** Probe the saved credentials against the live venue (no order is placed). */
export const testConnection = (connectionId: string) =>
  api<{ ok: boolean; message: string }>(`/connections/${connectionId}/test`, { method: 'POST' })

/** Cached BSE instrument master (derivative contracts the adapter can route to). */
export const useInstrumentMaster = () =>
  useQuery({
    queryKey: ['instruments', 'bse'],
    queryFn: () => api<InstrumentMasterStatus>('/instruments/bse'),
    staleTime: 60_000,
  })

/** Force a fresh download of the exchange master from the venue. */
export const refreshInstrumentMaster = () => api<InstrumentMasterStatus>('/instruments/bse/refresh', { method: 'POST' })
/** Credential edits. Rotating the key requires rotating the secret too; other
 * fields edit independently. Deleting a connection detaches its bots. */
export interface ConnectionPatch {
  name?: string
  exchange?: string
  mode?: 'paper' | 'live'
  environment?: 'sandbox' | 'production'
  apiKey?: string
  apiSecret?: string
}
export const updateConnection = (connectionId: string, patch: ConnectionPatch) =>
  api<{ connection: Connection }>(`/connections/${connectionId}`, { method: 'PATCH', json: patch })
export const deleteConnection = (connectionId: string) =>
  api<{ ok: true; detached: number; grounded: number }>(`/connections/${connectionId}`, { method: 'DELETE' })
export const addDemoConnections = () => api<{ added: number }>('/connections/demo', { method: 'POST' })

// --- Tool box (execution plans) & strategy book -------------------------------

/** One trading execution plan in the tool box. */
export interface PlanDraft {
  name: string
  regime: string
  strategyKey: string
  params?: Record<string, ParamValue>
  timeframe: Timeframe | null
  riskPct: number
  note: string
}

export const useToolbox = () =>
  useQuery({
    queryKey: ['toolbox'],
    queryFn: () => api<ToolBox>('/toolbox'),
    staleTime: 15_000,
  })

export const createPlan = (draft: PlanDraft) =>
  api<{ playbook: PlaybookLike }>('/toolbox', { method: 'POST', json: draft })

export const deletePlan = (playbookId: string) =>
  api<{ ok: true }>(`/toolbox/${playbookId}`, { method: 'DELETE' })

/** One regime's entry in the strategy book, as the API serves it. */
export interface BookEntryLike {
  regime: string
  playbook: PlaybookLike
  strategyName: string
  overridden: boolean
}
export interface PlaybookLike {
  id: string
  name: string
  regime: string
  strategyKey: string
  strategyName?: string
  params: Record<string, ParamValue>
  timeframe: string | null
  riskPct: number
  note: string
  source: 'builtin' | 'custom'
  createdAt?: number
}

export const useBook = () =>
  useQuery({
    queryKey: ['book'],
    queryFn: () => api<{ items: BookEntryLike[] }>('/book'),
    staleTime: 15_000,
  })

export const assignPlan = (regime: string, playbookId: string) =>
  api<{ ok: true }>('/book', { method: 'PUT', json: { regime, playbookId } })

export const clearBookEntry = (regime: string) =>
  api<{ ok: true; cleared: boolean }>(`/book/${regime}`, { method: 'DELETE' })

/** One live, actionable strategy-book signal: a recognised pattern on a
 * tracked market whose regime has a book plan, on a parked bot — plus the
 * plan it would execute. */
export interface BookSignal {
  botId: string
  botName: string
  botStatus: string
  symbol: string
  regime: string
  confidence: number
  playbook: PlaybookLike
  strategyName: string
  botCapital: number
  evidence: string[]
  price: number
  changePct: number
  drawdownPct: number
  runupPct: number
  spark: number[]
}

export const useBookSignals = () =>
  useQuery({
    queryKey: ['book-signals'],
    queryFn: () => api<{ generatedAt: number; items: BookSignal[] }>('/book/signals'),
    refetchInterval: 60_000,
    placeholderData: (p) => p,
  })

/** The live agent environment: held pins, operator kill-switches and the last
 * read. `symbol` focuses the company half (ownership, specialists, next move). */
export const useEnvironment = (symbol?: string) =>
  useQuery({
    queryKey: ['environment', symbol ?? null],
    queryFn: () => api<EnvironmentState>(`/analysis/environment${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`),
    refetchInterval: 20_000,
    placeholderData: (p) => p,
  })

/** What the engine decided on each closed bar (gate, proposals with their fact
 * ids, arbitration, size or reject reason) plus the scored move predictions.
 * `bot` narrows the timeline, `symbol` the calibration. */
export const useEnvironmentTrace = (symbol?: string, bot?: string) =>
  useQuery({
    queryKey: ['environment-trace', symbol ?? null, bot ?? null],
    queryFn: () =>
      api<EnvironmentTrace>(
        `/analysis/environment/trace${symbol || bot ? `?${symbol ? `symbol=${encodeURIComponent(symbol)}` : ''}${symbol && bot ? '&' : ''}${bot ? `bot=${encodeURIComponent(bot)}` : ''}` : ''}`,
      ),
    refetchInterval: 20_000,
    placeholderData: (p) => p,
  })

/** Operator kill-switches. The environment holds them; the engine reads its
 * projection, so the change lands on the next advance pass. */
export const setEnvironmentControls = (patch: { paused?: boolean; pauseBuys?: boolean }) =>
  api<{ controls: { paused: boolean; pauseBuys: boolean } }>('/analysis/environment/controls', { method: 'PATCH', json: patch })

/** Execute a plan: `playbookId` (any box plan) or `regime` (the book's
 * resident answer); `botId` inherits its wallet, otherwise `capital` funds a
 * fresh paper wallet. Returns the bot created running in paper mode. */
export const executePlan = (input: { playbookId?: string; regime?: string; symbol: string; botId?: string; capital?: number }) =>
  api<{ bot: Bot; executed: { playbookId: string; plan: string; regime: string; strategyName: string; symbol: string } }>('/book/execute', {
    method: 'POST',
    json: input,
  })
