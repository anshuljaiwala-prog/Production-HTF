import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  Backtest,
  Bot,
  BotEvent,
  BotStage,
  BotStatus,
  Candle,
  Connection,
  Dashboard,
  EquityPoint,
  Me,
  ParamValue,
  Portfolio,
  Position,
  SearchResults,
  Strategy,
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
    queryFn: () => api<{ strategies: Strategy[]; symbols: string[]; timeframes: { key: Timeframe; label: string }[] }>('/strategies'),
    staleTime: 60_000,
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
    queryFn: () => api<{ items: Backtest[] }>('/backtests'),
    // Runs execute lazily on read; poll while anything is pending so the
    // status flips to done/failed (and the results appear) automatically.
    refetchInterval: liveInterval<{ items: Backtest[] }>(1_000, false, (d) => d.items.some((b) => b.status === 'running')),
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
}

export const launchBot = (input: LaunchInput) => api<{ bot: Bot }>('/bots', { method: 'POST', json: input })
export const controlBot = (botId: string, action: 'start' | 'pause' | 'stop') =>
  api<{ bot: Bot }>(`/bots/${botId}/control`, { method: 'POST', json: { action } })
export const adjustFunding = (botId: string, input: { amount: number; note?: string }) =>
  api<{ bot: Bot }>(`/bots/${botId}/cashflow`, { method: 'POST', json: input })
export const patchBot = (botId: string, patch: { name?: string; stage?: BotStage; position?: number }) =>
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
