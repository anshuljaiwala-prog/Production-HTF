import type { MiddlewareHandler } from 'hono'

import type { AppContext } from './env'
import type {
  AccuracyStat,
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
    risk_off_streak INTEGER NOT NULL DEFAULT 0,
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
  // Uploaded strategies are durable and versioned: every upload of a name
  // stores a new version beside its history, so a re-upload never destroys
  // the previous rules (bots keep their own inline copies regardless).
  `CREATE TABLE IF NOT EXISTS uploaded_strategies (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    rules TEXT NOT NULL,
    lookback INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS uploaded_strategies_owner ON uploaded_strategies(owner_sub, name, version DESC)`,
  // Imported market history lives in the API database, keyed by the exact
  // (symbol, timeframe, bar time) bucket, so re-importing the same feed is
  // idempotent: a second upload UPSERTS over the same rows instead of
  // duplicating them. Shared across the workspace's needs — not per-owner —
  // because a market's price is not operator-private data.
  `CREATE TABLE IF NOT EXISTS market_bars (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    t INTEGER NOT NULL,
    o REAL NOT NULL,
    h REAL NOT NULL,
    l REAL NOT NULL,
    c REAL NOT NULL,
    v REAL NOT NULL DEFAULT 0,
    source TEXT,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, timeframe, t)
  )`,
  `CREATE INDEX IF NOT EXISTS market_bars_window ON market_bars(symbol, timeframe, t DESC)`,
  // Custom execution plans (the tool box): operator-drafted responses to a
  // recognised regime, stored per workspace. Builtin plans live in code
  // (plans.ts) and are merged beside these at read time.
  `CREATE TABLE IF NOT EXISTS custom_playbooks (` +
    `id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, name TEXT NOT NULL, regime TEXT NOT NULL,` +
    `strategy_key TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', timeframe TEXT,` +
    `risk_pct REAL NOT NULL DEFAULT 25, note TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS custom_playbooks_owner ON custom_playbooks(owner_sub, created_at DESC)`,
  // Strategy book assignments: one plan per regime per workspace (replacing
  // a regime's plan upserts this row; deleting it falls back to the builtin
  // default this table mirrors in plans.ts DEFAULT_BOOK).
  `CREATE TABLE IF NOT EXISTS book_entries (
    owner_sub TEXT NOT NULL,
    regime TEXT NOT NULL,
    playbook_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_sub, regime)
  )`,
  // Operator kill-switches for the agent environment. The Durable Object owns
  // the live copy; this row is its projection, because the request-scoped
  // engine only has a database handle and must not pay an RPC per pass.
  `CREATE TABLE IF NOT EXISTS environment_controls (
    owner_sub TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    pause_buys INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  // Per-workspace key for the AES encryption of connection API secrets at
  // rest. Created lazily on first use; a deployment key from the environment
  // (SECRETS_KEY) takes precedence for writes when it is set.
  `CREATE TABLE IF NOT EXISTS connection_keys (
    owner_sub TEXT PRIMARY KEY,
    key_b64 TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Exchange instrument master, as loaded from the venue (see instruments.ts).
  // BSE keys every derivative contract by expiry and strike, so a live order
  // cannot be placed from a ticker alone: this table is what turns
  // `SENSEX-940-CE` into BSE_FO|<token> plus its lot size. Kept whole-workspace
  // (not per owner) — it is public exchange reference data, and refreshing it
  // is idempotent.
  `CREATE TABLE IF NOT EXISTS bse_contracts (
    instrument_key TEXT PRIMARY KEY,
    underlying TEXT NOT NULL,
    instrument_type TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    strike REAL NOT NULL DEFAULT 0,
    lot_size INTEGER NOT NULL DEFAULT 1,
    tick_size REAL,
    trading_symbol TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS bse_contracts_lookup ON bse_contracts(underlying, instrument_type, expiry)`,
  // One row per closed bar per bot: the gate, every specialist proposal with
  // the fact ids behind it, the arbitration result and what each symbol did
  // (fill with size, or the typed reason nothing was placed). Written by the
  // engine's replay loop, pruned to a trailing window per bot.
  `CREATE TABLE IF NOT EXISTS decision_traces (
    bot_id TEXT NOT NULL,
    owner_sub TEXT NOT NULL,
    at INTEGER NOT NULL,
    gate_blocked INTEGER NOT NULL,
    gate_reason TEXT,
    risk_off_streak INTEGER NOT NULL,
    proposals TEXT NOT NULL,
    verdict TEXT NOT NULL,
    decisions TEXT NOT NULL,
    PRIMARY KEY (bot_id, at)
  )`,
  `CREATE INDEX IF NOT EXISTS decision_traces_owner ON decision_traces(owner_sub, at DESC)`,
  // Every move prediction the engine saw, scored against the move that
  // actually followed on the next closed bar. One row per (symbol, timeframe,
  // bar) — two bots reading the same bar record the same forecast.
  `CREATE TABLE IF NOT EXISTS move_predictions (
    owner_sub TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    at INTEGER NOT NULL,
    move TEXT NOT NULL,
    probability REAL NOT NULL,
    facts_available INTEGER NOT NULL,
    direction INTEGER NOT NULL,
    price REAL NOT NULL,
    next_close REAL,
    return_pct REAL,
    outcome INTEGER,
    PRIMARY KEY (owner_sub, symbol, timeframe, at)
  )`,
  `CREATE INDEX IF NOT EXISTS move_predictions_owner ON move_predictions(owner_sub, at DESC)`,
  // Screened news pins, written once per engine pass. The environment DO keeps
  // the panel's copy in its own storage; this table is the engine's, readable
  // with a D1 handle and nothing else, so a bot's later pass sees (and a later
  // reader audits) what an earlier pass harvested. `expires_at` is what stops
  // an old pin moving sentiment forever.
  `CREATE TABLE IF NOT EXISTS news_pins (
    owner_sub TEXT NOT NULL,
    id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    at INTEGER NOT NULL,
    impact_level TEXT NOT NULL,
    sentiment REAL NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    source TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_sub, id, at)
  )`,
  `CREATE INDEX IF NOT EXISTS news_pins_symbol ON news_pins(owner_sub, symbol, at DESC)`,
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
    // Advance lease for the paper engine: a compare-and-set token that makes
    // bar replay single-writer across every isolate (see engine.ts). Fresh
    // databases miss the column too, so it is added here after the CREATEs.
    try {
      await db.prepare(`ALTER TABLE bots ADD COLUMN lease_token TEXT`).run()
    } catch {
      /* already present */
    }
    // Agent gate damping: consecutive risk-off reads. Fresh databases get it
    // from the CREATE above; existing local ones need the ALTER.
    try {
      await db.prepare(`ALTER TABLE bots ADD COLUMN risk_off_streak INTEGER NOT NULL DEFAULT 0`).run()
    } catch {
      /* already present */
    }
    // Multi-venue routing: the ordered connection ids a live bot may fill on.
    // NULL means the legacy single `connection_id`.
    try {
      await db.prepare(`ALTER TABLE bots ADD COLUMN venue_ids TEXT`).run()
    } catch {
      /* already present */
    }
    // Exchange sandbox vs production order API, per saved connection.
    try {
      await db.prepare(`ALTER TABLE connections ADD COLUMN environment TEXT NOT NULL DEFAULT 'production'`).run()
    } catch {
      /* already present */
    }
    // Last venue mark per open position. Live books are marked from the venue
    // the engine quoted, so read paths never price real fills off the
    // synthetic feed. Paper positions leave these NULL.
    try {
      await db.prepare(`ALTER TABLE positions ADD COLUMN mark_price REAL`).run()
    } catch {
      /* already present */
    }
    try {
      await db.prepare(`ALTER TABLE positions ADD COLUMN mark_at INTEGER`).run()
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
    environment: String(r.environment ?? '') === 'sandbox' ? 'sandbox' : 'production',
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
    venueIds: parseJson<string[]>(r.venue_ids, r.connection_id ? [String(r.connection_id)] : []),
    venues: [],
    riskOffStreak: Number(r.risk_off_streak ?? 0),
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

/** Append a run-event row for one bot. Shared by every route that mutates
 * bot state — controls, settings edits, funding, connection lifecycle. */
export function logEvent(db: D1Database, owner: string, botId: string, level: string, message: string) {
  return db
    .prepare(`INSERT INTO bot_events (id, owner_sub, bot_id, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id(), owner, botId, level, message, now())
    .run()
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
  // Accuracy rides inside the metrics blob; split it out on the way through.
  const metricsRaw = parseJson<(RunMetrics & { accuracy?: AccuracyStat }) | null>(r.metrics, null)
  const { accuracy, ...metrics } = metricsRaw ?? { accuracy: undefined }
  const params = parseJson<Record<string, ParamValue>>(r.params, {})
  // Custom (uploaded) strategies carry their display name inside the params.
  let strategyName = (r.strategy_name as string | undefined) ?? String(r.strategy_key)
  if (String(r.strategy_key) === 'custom' && typeof params.rules === 'string') {
    try {
      const parsed = JSON.parse(params.rules) as { name?: string }
      if (parsed?.name) strategyName = parsed.name
    } catch {
      /* keep key fallback */
    }
  }
  return {
    id: r.id as string,
    name: r.name as string,
    strategyKey: r.strategy_key as string,
    strategyName,
    symbol: r.symbol as string,
    timeframe: r.timeframe as Timeframe,
    params,
    capital: Number(r.capital ?? 0),
    from: Number(r.from_ts),
    to: Number(r.to_ts),
    status: r.status as Backtest['status'],
    error: (r.error as string | null) ?? null,
    metrics: metricsRaw ? (metrics as RunMetrics) : null,
    accuracy: metricsRaw ? (accuracy ?? null) : null,
    curve: parseJson<EquityPoint[]>(r.curve, []),
    trades: parseJson<Trade[]>(r.trades, []),
    createdAt: Number(r.created_at),
  }
}
