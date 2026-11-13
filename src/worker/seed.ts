import { runBacktest } from './backtest'
import { id } from './db'
import { TIMEFRAME_MS } from './market'
import { BSE_INSTRUMENTS } from './venues'
import { encryptSecret, loadSecretKeys } from './secrets'
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

// The demo fleet. All five are live-mode and paused: they appear in the
// live-only Dashboard and Portfolio, but seeding never places an order —
// starting one is an operator decision that needs real venue credentials.
const BOT_SEEDS: BotSeed[] = [
  {
    name: 'BTC momentum · live',
    strategyKey: 'momentum',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 25_000,
    riskPct: 30,
    mode: 'live',
    stage: 'live',
    status: 'paused',
    startedBarsAgo: 118,
    note: 'Staged for live trading on the saved demo venue — paused until real credentials replace the demo ones.',
  },
  {
    name: 'ETH grid scalper · live',
    strategyKey: 'grid',
    symbols: ['ETH-USD'],
    timeframe: '15m',
    capital: 12_000,
    riskPct: 20,
    mode: 'live',
    stage: 'live',
    status: 'paused',
    startedBarsAgo: 118,
    note: 'Staged for live trading — grid steps are set for 15m ETH.',
  },
  {
    name: 'NVDA range breakout · live',
    strategyKey: 'breakout',
    symbols: ['NVDA'],
    timeframe: '1d',
    capital: 15_000,
    riskPct: 25,
    mode: 'live',
    stage: 'live',
    status: 'paused',
    startedBarsAgo: 9,
    note: 'Staged for live trading after the daily breakout backtest.',
  },
  {
    name: 'INFY trend · BSE',
    strategyKey: 'momentum',
    symbols: ['INFY'],
    timeframe: '1h',
    capital: 8_000,
    riskPct: 15,
    mode: 'live',
    stage: 'live',
    status: 'paused',
    startedBarsAgo: 40,
    note: 'Staged for BSE cash equities through the Upstox adapter — add a real access token to route it.',
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
    note: 'Staged for live: it routes across venues once more than one connection is attached.',
  },
]

/**
 * Insert the demo fleet for a workspace. Bots are backdated so the lifecycle
 * board reads like a real desk, but they stay paused (no live adapter is
 * assumed) and carry one launch equity point so their curves are honest.
 */
export async function insertDemoBots(
  db: D1Database,
  owner: string,
  connectionId: string | null,
  t = Date.now(),
  bseConnectionId: string | null = null,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  BOT_SEEDS.forEach((spec, index) => {
    const strategy = strategyBy(spec.strategyKey)
    if (!strategy) return
    const tfMs = TIMEFRAME_MS[spec.timeframe]
    const createdAt = t - spec.startedBarsAgo * tfMs
    const botId = id()
    const params = JSON.stringify(defaultParams(strategy))
    // A BSE symbol routes through the BSE demo venue when one is saved, so the
    // demo fleet exercises the live adapter seam too.
    const venueId = spec.symbols.some((symbol) => BSE_INSTRUMENTS[symbol]) && bseConnectionId ? bseConnectionId : connectionId
    statements.push(
      db
        .prepare(
          `INSERT INTO bots (id, owner_sub, name, strategy_key, symbols, timeframe, params, capital, risk_pct, mode, stage, status,
             position, connection_id, venue_ids, cash, equity, initial_equity, realized_pnl, round_trips, wins, created_at, started_at, last_tick_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)`,
        )
        .bind(
          botId,
          owner,
          spec.name,
          spec.strategyKey,
          JSON.stringify(spec.symbols),
          spec.timeframe,
          params,
          spec.capital,
          spec.riskPct,
          spec.mode,
          spec.stage,
          spec.status,
          index,
          venueId,
          JSON.stringify(venueId ? [venueId] : []),
          spec.capital,
          spec.capital,
          spec.capital,
          createdAt,
          createdAt,
          createdAt,
          createdAt,
        ),
    )
    statements.push(
      db
        .prepare(`INSERT INTO bot_events (id, owner_sub, bot_id, level, message, created_at) VALUES (?, ?, ?, 'info', ?, ?)`)
        .bind(id(), owner, botId, spec.note ?? `Created with ${strategy.name} on ${spec.symbols.join(', ')} (${spec.timeframe}).`, createdAt),
    )
    statements.push(
      db
        .prepare(`INSERT INTO equity_points (bot_id, owner_sub, at, value) VALUES (?, ?, ?, ?)`)
        .bind(botId, owner, createdAt, spec.capital),
    )
  })
  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40))
}

const BACKTEST_SEEDS: { name: string; strategyKey: string; symbol: string; timeframe: BotSeed['timeframe']; capital: number; days: number }[] = [
  { name: 'Momentum BTC · 90 days', strategyKey: 'momentum', symbol: 'BTC-USD', timeframe: '1h', capital: 10_000, days: 90 },
  { name: 'DCA NVDA · 1 year', strategyKey: 'dca', symbol: 'NVDA', timeframe: '1d', capital: 10_000, days: 365 },
]

export async function seedWorkspace(db: D1Database, owner: string) {
  const t = Date.now()
  const statements: D1PreparedStatement[] = []

  // Two demo connections so a fresh workspace can test the picker and live
  // routing immediately — throwaway credentials the simulated venue accepts.
  // Their secrets are encrypted at rest like every other connection's.
  const keys = await loadSecretKeys(db, owner)
  const connectionId = id()
  statements.push(
    db
      .prepare(
        `INSERT INTO connections (id, owner_sub, name, exchange, api_key, api_secret, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, 'paper', ?)`,
      )
      .bind(connectionId, owner, 'Demo · Alpaca paper', 'Alpaca', 'HTFDEMOALPACA0001', await encryptSecret(keys, 'demo-secret-not-real'), t - 30 * DAY),
  )
  statements.push(
    db
      .prepare(
        `INSERT INTO connections (id, owner_sub, name, exchange, api_key, api_secret, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, 'paper', ?)`,
      )
      .bind(id(), owner, 'Demo · Binance paper', 'Binance', 'HTFDEMOBINANCE001', await encryptSecret(keys, 'demo-secret-not-real'), t - 29 * DAY),
  )
  // A BSE sandbox venue so the demo fleet has one routable live adapter. The
  // token is a placeholder: it fails authentication until real keys are pasted.
  const bseConnectionId = id()
  statements.push(
    db
      .prepare(
        `INSERT INTO connections (id, owner_sub, name, exchange, api_key, api_secret, mode, environment, created_at) VALUES (?, ?, ?, ?, ?, ?, 'live', 'sandbox', ?)`,
      )
      .bind(bseConnectionId, owner, 'Demo · BSE sandbox', 'BSE (via Upstox)', 'HTFDEMOBSE0001', await encryptSecret(keys, 'sandbox-demo-token-not-real'), t - 28 * DAY),
  )

  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40))

  // The demo fleet is live-mode and paused, so no engine replay: seeding never
  // places (or pretends to place) an order.
  await insertDemoBots(db, owner, connectionId, t, bseConnectionId)

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
    ['bot_events', 'equity_points', 'trades', 'positions', 'bots', 'backtests', 'connections', 'connection_keys'].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE owner_sub = ?`).bind(owner),
    ),
  )
  await db.prepare(`UPDATE workspaces SET seeded_at = NULL WHERE owner_sub = ?`).bind(owner).run()
}
