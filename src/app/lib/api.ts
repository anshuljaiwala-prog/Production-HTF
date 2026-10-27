import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  AccuracyStat,
  Backtest,
  Bot,
  BotEvent,
  BotStage,
  BotStatus,
  Candle,
  Connection,
  CustomStrategySummary,
  Dashboard,
  EquityPoint,
  Me,
  ParamValue,
  Portfolio,
  Position,
  SearchResults,
  SimBudget,
  Strategy,
  SymbolMeta,
  Timeframe,
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
export const useDashboard = () =>
  useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/overview'),
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

/** Upload a rules JSON payload to the in-memory strategy store. */
export const uploadCustomStrategy = (rules: unknown) =>
  api<
    { strategy: CustomStrategySummary; detail: Record<string, unknown>; durable: boolean }
  >('/strategies/custom', { method: 'POST', json: { rules } })
export const deleteCustomStrategy = (id: string) => api<{ ok: true }>(`/strategies/custom/${id}`, { method: 'DELETE' })

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
  options?: { onSuccess?: (result: TResult, input: TInput) => void },
) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: run,
    onSuccess: async (result, input) => {
      await invalidate(...invalidates)
      options?.onSuccess?.(result, input)
    },
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
  status?: BotStatus
  /** Inline uploaded rules — the bot runs the `custom` strategist with them. */
  rules?: unknown
}

export const launchBot = (input: LaunchInput) => api<{ bot: Bot }>('/bots', { method: 'POST', json: input })
export const controlBot = (botId: string, action: 'start' | 'pause' | 'stop') =>
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
  api<ImportPreview>('/bots/import?validate=1', { method: 'POST', json: { items } })

/** Bulk bot config import (uploaded file or pasted JSON payload). Good rows
 * launch (paused); bad rows come back with the reason so the dialog can show
 * them. Rows may carry inline `rules` (custom strategy) and `connectionId`
 * (which saved exchange API the bot routes through). */
export interface BotImportResult {
  launched: Bot[]
  failed: { name: string; error: string }[]
}
export const importBots = (items: LaunchInput[]) =>
  api<BotImportResult>('/bots/import', { method: 'POST', json: { items } })

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

export const createConnection = (input: { name: string; exchange: string; apiKey: string; apiSecret: string; mode: 'paper' | 'live' }) =>
  api<{ connection: Connection }>('/connections', { method: 'POST', json: input })
export const deleteConnection = (connectionId: string) => api<{ ok: true }>(`/connections/${connectionId}`, { method: 'DELETE' })
export const addDemoConnections = () => api<{ added: number }>('/connections/demo', { method: 'POST' })
