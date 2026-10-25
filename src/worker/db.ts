import type { MiddlewareHandler } from 'hono'

import type { AppContext } from './env'
import type {
  Backtest,
  Bot,
  BotEvent,
  BotMode,
  BotStage,
  BotStatus,
  Connection,
  EquityPoint,
  ParamValue,
  RunMetrics,
  Timeframe,
  Trade,
} from '../shared/types'

// Schema lives with the Worker: D1 has no migration tool on Freebuff Sites, so
// tables are created on the first request of each isolate (cheap: one batch of
// IF NOT EXISTS statements). Add new statements at the end for new columns or
// tables; never edit existing ones in place once deployed.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    owner_sub TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    seeded_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    exchange TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'paper',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS connections_owner ON connections(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    strategy_key TEXT NOT NULL,
    symbols TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    capital REAL NOT NULL DEFAULT 0,
    risk_pct REAL NOT NULL DEFAULT 25,
    mode TEXT NOT NULL DEFAULT 'paper',
    stage TEXT NOT NULL DEFAULT 'paper',
    status TEXT NOT NULL DEFAULT 'stopped',
    position REAL NOT NULL DEFAULT 0,
    connection_id TEXT,
    cash REAL NOT NULL DEFAULT 0,
    equity REAL NOT NULL DEFAULT 0,
    initial_equity REAL NOT NULL DEFAULT 0,
    net_deposits REAL NOT NULL DEFAULT 0,
    realized_pnl REAL NOT NULL DEFAULT 0,
    round_trips INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    last_tick_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS bots_owner ON bots(owner_sub, stage, position)`,
  // Operator cash flows: funding adjustments that move capital without being
  // P&L, so equity reconciles against real-world cash movement.
  `CREATE TABLE IF NOT EXISTS cashflows (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cashflows_owner ON cashflows(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    qty REAL NOT NULL,
    avg_price REAL NOT NULL,
    opened_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS positions_bot_symbol ON positions(bot_id, symbol)`,
  `CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    pnl REAL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS trades_bot ON trades(owner_sub, bot_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS bot_events (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS bot_events_bot ON bot_events(owner_sub, bot_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS bot_events_recent ON bot_events(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS equity_points (
    bot_id TEXT NOT NULL,
    owner_sub TEXT NOT NULL,
    at INTEGER NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (bot_id, at)
  )`,
  `CREATE TABLE IF NOT EXISTS backtests (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    strategy_key TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    capital REAL NOT NULL,
    from_ts INTEGER NOT NULL,
    to_ts INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'done',
    error TEXT,
    metrics TEXT,
    curve TEXT,
    trades TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS backtests_owner ON backtests(owner_sub, created_at DESC)`,
  // The template shipped a CRM; this build is HTF, so its tables are removed
  // rather than left behind. Safe: the project has never been deployed.
  `DROP TABLE IF EXISTS activities`,
  `DROP TABLE IF EXISTS tasks`,
  `DROP TABLE IF EXISTS files`,
  `DROP TABLE IF EXISTS deals`,
  `DROP TABLE IF EXISTS contacts`,
  `DROP TABLE IF EXISTS companies`,
]

let ready: Promise<void> | undefined

export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= (async () => {
    await db.batch(SCHEMA.map((sql) => db.prepare(sql)))
    // Databases created before this column existed (local dev state) miss it;
    // ADD COLUMN on a fresh copy fails harmlessly as a duplicate column.
    try {
      await db.prepare(`ALTER TABLE bots ADD COLUMN net_deposits REAL NOT NULL DEFAULT 0`).run()
    } catch {
      /* already present */
    }
  })().then(
    () => undefined,
    (error) => {
      ready = undefined
      throw error
    },
  )
  return ready
}

/** Rejects early with a clear message when the database binding is missing. */
export const requireDb: MiddlewareHandler<AppContext> = async (c, next) => {
  const db = c.env.DB
  if (!db) {
    return c.json(
      { error: 'database_missing', message: 'No database is attached yet. Add D1 storage named DB and redeploy.' },
      503,
    )
  }
  await ensureSchema(db)
  c.set('db', db)
  await next()
}

export const id = () => crypto.randomUUID()
export const now = () => Date.now()

export type Row = Record<string, unknown>

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function mapConnection(r: Row): Connection {
  const key = String(r.api_key ?? '')
  return {
    id: r.id as string,
    name: r.name as string,
    exchange: r.exchange as string,
    keyMasked: key.length > 4 ? `••••${key.slice(-4)}` : '••••',
    mode: r.mode as BotMode,
    createdAt: Number(r.created_at),
  }
}

export function mapBot(r: Row): Bot {
  return {
    id: r.id as string,
    name: r.name as string,
    strategyKey: r.strategy_key as string,
    strategyName: (r.strategy_name as string | undefined) ?? (r.strategy_key as string),
    symbols: parseJson<string[]>(r.symbols, []),
    timeframe: r.timeframe as Timeframe,
    params: parseJson<Record<string, ParamValue>>(r.params, {}),
    capital: Number(r.capital ?? 0),
    riskPct: Number(r.risk_pct ?? 25),
    mode: r.mode as BotMode,
    stage: r.stage as BotStage,
    status: r.status as BotStatus,
    position: Number(r.position ?? 0),
    connectionId: (r.connection_id as string | null) ?? null,
    connectionName: (r.connection_name as string | null) ?? null,
    cash: Number(r.cash ?? 0),
    equity: Number(r.equity ?? 0),
    initialEquity: Number(r.initial_equity ?? 0),
    netDeposits: Number(r.net_deposits ?? 0),
    realizedPnl: Number(r.realized_pnl ?? 0),
    roundTrips: Number(r.round_trips ?? 0),
    wins: Number(r.wins ?? 0),
    openPositions: Number(r.open_positions ?? 0),
    lastEvent: (r.last_event as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
    lastTickAt: r.last_tick_at === null || r.last_tick_at === undefined ? null : Number(r.last_tick_at),
    updatedAt: Number(r.updated_at),
  }
}

export const BOT_SELECT = `
  SELECT b.*, c.name AS connection_name,
    (SELECT COUNT(*) FROM positions p WHERE p.bot_id = b.id) AS open_positions,
    (SELECT e.message FROM bot_events e WHERE e.bot_id = b.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_event
  FROM bots b
  LEFT JOIN connections c ON c.id = b.connection_id AND c.owner_sub = b.owner_sub`

export function mapPosition(r: Row) {
  const qty = Number(r.qty ?? 0)
  const avgPrice = Number(r.avg_price ?? 0)
  const mark = r.mark_price === undefined ? avgPrice : Number(r.mark_price)
  return {
    symbol: r.symbol as string,
    qty,
    avgPrice,
    markPrice: mark,
    unrealizedPnl: (mark - avgPrice) * qty,
    openedAt: Number(r.opened_at),
  }
}

export function mapTrade(r: Row): Trade {
  return {
    id: r.id as string,
    botId: (r.bot_id as string | null) ?? null,
    symbol: r.symbol as string,
    side: r.side as 'buy' | 'sell',
    qty: Number(r.qty ?? 0),
    price: Number(r.price ?? 0),
    fee: Number(r.fee ?? 0),
    pnl: r.pnl === null || r.pnl === undefined ? null : Number(r.pnl),
    at: Number(r.created_at),
  }
}

export function mapEvent(r: Row): BotEvent {
  return {
    id: r.id as string,
    botId: (r.bot_id as string | null) ?? null,
    botName: (r.bot_name as string | undefined) ?? undefined,
    level: r.level as BotEvent['level'],
    message: r.message as string,
    at: Number(r.created_at),
  }
}

export function mapBacktest(r: Row): Backtest {
  return {
    id: r.id as string,
    name: r.name as string,
    strategyKey: r.strategy_key as string,
    strategyName: (r.strategy_name as string | undefined) ?? (r.strategy_key as string),
    symbol: r.symbol as string,
    timeframe: r.timeframe as Timeframe,
    params: parseJson<Record<string, ParamValue>>(r.params, {}),
    capital: Number(r.capital ?? 0),
    from: Number(r.from_ts),
    to: Number(r.to_ts),
    status: r.status as Backtest['status'],
    error: (r.error as string | null) ?? null,
    metrics: parseJson<RunMetrics | null>(r.metrics, null),
    curve: parseJson<EquityPoint[]>(r.curve, []),
    trades: parseJson<Trade[]>(r.trades, []),
    createdAt: Number(r.created_at),
  }
}
