import { runBacktest } from './backtest'
import { id, mapBot, type Row } from './db'
import { advanceBot } from './engine'
import { TIMEFRAME_MS } from './market'
import { defaultParams, strategyBy } from './strategies'

// Sample workspace: a handful of bots across the lifecycle columns plus two
// finished backtests, so a new workspace is furnished on first open. Bots are
// created in the past and then fast-forwarded through the real engine, so the
// trades, events and equity curves are genuine engine output rather than fakes.

const DAY = 86_400_000

interface BotSeed {
  name: string
  strategyKey: string
  symbols: string[]
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
  capital: number
  riskPct: number
  mode: 'paper' | 'live'
  stage: 'draft' | 'backtest' | 'paper' | 'live'
  status: 'running' | 'paused' | 'stopped'
  /** How far back the bot starts, in bars of its own timeframe. */
  startedBarsAgo: number
  note?: string
}

const BOT_SEEDS: BotSeed[] = [
  {
    name: 'BTC momentum · 1h',
    strategyKey: 'momentum',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 25_000,
    riskPct: 30,
    mode: 'paper',
    stage: 'paper',
    status: 'running',
    startedBarsAgo: 118,
  },
  {
    name: 'ETH grid scalper',
    strategyKey: 'grid',
    symbols: ['ETH-USD'],
    timeframe: '15m',
    capital: 12_000,
    riskPct: 20,
    mode: 'paper',
    stage: 'paper',
    status: 'running',
    startedBarsAgo: 118,
  },
  {
    name: 'NVDA range breakout',
    strategyKey: 'breakout',
    symbols: ['NVDA'],
    timeframe: '1d',
    capital: 15_000,
    riskPct: 25,
    mode: 'paper',
    stage: 'backtest',
    status: 'stopped',
    startedBarsAgo: 9,
    note: 'Backtest showed a rough hit rate — parked until the exit window is retuned.',
  },
  {
    name: 'SOL mean reversion',
    strategyKey: 'mean-reversion',
    symbols: ['SOL-USD'],
    timeframe: '1h',
    capital: 8_000,
    riskPct: 15,
    mode: 'paper',
    stage: 'draft',
    status: 'stopped',
    startedBarsAgo: 6,
    note: 'Draft: parameters still being tuned before the first paper run.',
  },
  {
    name: 'Multi-symbol market making',
    strategyKey: 'market-making',
    symbols: ['BTC-USD', 'ETH-USD'],
    timeframe: '5m',
    capital: 40_000,
    riskPct: 10,
    mode: 'live',
    stage: 'live',
    status: 'paused',
    startedBarsAgo: 40,
    note: 'Staged for live: no exchange adapter is wired up yet, so it stays paused.',
  },
]

const BACKTEST_SEEDS: { name: string; strategyKey: string; symbol: string; timeframe: BotSeed['timeframe']; capital: number; days: number }[] = [
  { name: 'Momentum BTC · 90 days', strategyKey: 'momentum', symbol: 'BTC-USD', timeframe: '1h', capital: 10_000, days: 90 },
  { name: 'DCA NVDA · 1 year', strategyKey: 'dca', symbol: 'NVDA', timeframe: '1d', capital: 10_000, days: 365 },
]

export async function seedWorkspace(db: D1Database, owner: string) {
  const t = Date.now()
  const statements: D1PreparedStatement[] = []

  // Two demo connections so a fresh workspace can test the picker and live
  // routing immediately — throwaway credentials the simulated venue accepts.
  const connectionId = id()
  statements.push(
    db
      .prepare(
        `INSERT INTO connections (id, owner_sub, name, exchange, api_key, api_secret, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, 'paper', ?)`,
      )
      .bind(connectionId, owner, 'Demo · Alpaca paper', 'Alpaca', 'HTFDEMOALPACA0001', 'demo-secret-not-real', t - 30 * DAY),
  )
  statements.push(
    db
      .prepare(
        `INSERT INTO connections (id, owner_sub, name, exchange, api_key, api_secret, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, 'paper', ?)`,
      )
      .bind(id(), owner, 'Demo · Binance paper', 'Binance', 'HTFDEMOBINANCE001', 'demo-secret-not-real', t - 29 * DAY),
  )

  const seeded: Row[] = []
  BOT_SEEDS.forEach((spec, index) => {
    const strategy = strategyBy(spec.strategyKey)
    if (!strategy) return
    const tfMs = TIMEFRAME_MS[spec.timeframe]
    const createdAt = t - spec.startedBarsAgo * tfMs
    const botId = id()
    const params = JSON.stringify(defaultParams(strategy))
    const row: Row = {
      id: botId,
      owner_sub: owner,
      name: spec.name,
      strategy_key: spec.strategyKey,
      symbols: JSON.stringify(spec.symbols),
      timeframe: spec.timeframe,
      params,
      capital: spec.capital,
      risk_pct: spec.riskPct,
      mode: spec.mode,
      stage: spec.stage,
      status: spec.status,
      position: BOT_SEEDS.length - index,
      connection_id: spec.mode === 'live' ? connectionId : null,
      cash: spec.capital,
      equity: spec.capital,
      initial_equity: spec.capital,
      realized_pnl: 0,
      round_trips: 0,
      wins: 0,
      created_at: createdAt,
      started_at: spec.status === 'stopped' ? null : createdAt,
      last_tick_at: spec.status === 'running' ? null : createdAt,
      updated_at: createdAt,
      strategy_name: strategy.name,
      open_positions: 0,
      connection_name: spec.mode === 'live' ? 'Demo · Alpaca paper' : null,
      last_event: null,
    }
    seeded.push(row)

    statements.push(
      db
        .prepare(
          `INSERT INTO bots (id, owner_sub, name, strategy_key, symbols, timeframe, params, capital, risk_pct, mode, stage, status,
             position, connection_id, cash, equity, initial_equity, realized_pnl, round_trips, wins, created_at, started_at, last_tick_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)`,
        )
        .bind(
          botId,
          owner,
          spec.name,
          spec.strategyKey,
          row.symbols as string,
          spec.timeframe,
          params,
          spec.capital,
          spec.riskPct,
          spec.mode,
          spec.stage,
          spec.status,
          index,
          row.connection_id as string | null,
          spec.capital,
          spec.capital,
          spec.capital,
          createdAt,
          row.started_at as number | null,
          row.last_tick_at as number | null,
          createdAt,
        ),
    )
    statements.push(
      db
        .prepare(`INSERT INTO bot_events (id, owner_sub, bot_id, level, message, created_at) VALUES (?, ?, ?, 'info', ?, ?)`)
        .bind(id(), owner, botId, spec.note ?? `Created with ${strategy.name} on ${spec.symbols.join(', ')} (${spec.timeframe}).`, createdAt),
    )
  })

  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40))

  // Run the engine over the seeded history so fills, events and curves are real.
  for (const row of seeded) {
    const bot = mapBot(row)
    if (bot.status === 'running') await advanceBot(db, owner, bot, { at: t })
  }

  for (const spec of BACKTEST_SEEDS) {
    try {
      const result = runBacktest({
        strategyKey: spec.strategyKey,
        symbol: spec.symbol,
        timeframe: spec.timeframe,
        params: defaultParams(strategyBy(spec.strategyKey)!),
        capital: spec.capital,
        from: t - spec.days * DAY,
        to: t,
      })
      await db
        .prepare(
          `INSERT INTO backtests (id, owner_sub, name, strategy_key, symbol, timeframe, params, capital, from_ts, to_ts, status, error, metrics, curve, trades, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', NULL, ?, ?, ?, ?)`,
        )
        .bind(
          id(),
          owner,
          spec.name,
          spec.strategyKey,
          spec.symbol,
          spec.timeframe,
          JSON.stringify(defaultParams(strategyBy(spec.strategyKey)!)),
          spec.capital,
          t - spec.days * DAY,
          t,
          JSON.stringify(result.metrics),
          JSON.stringify(result.curve),
          JSON.stringify(result.trades),
          t - DAY,
        )
        .run()
    } catch {
      // A seeding backtest should never block a workspace from opening.
    }
  }

  await db.prepare(`UPDATE workspaces SET seeded_at = ? WHERE owner_sub = ?`).bind(t, owner).run()
}

export async function clearWorkspace(db: D1Database, owner: string) {
  await db.batch(
    ['bot_events', 'equity_points', 'trades', 'positions', 'bots', 'backtests', 'connections'].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE owner_sub = ?`).bind(owner),
    ),
  )
  await db.prepare(`UPDATE workspaces SET seeded_at = NULL WHERE owner_sub = ?`).bind(owner).run()
}
