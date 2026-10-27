import type { Bot } from '../shared/types'
import { createBroker, LiveBrokerError, type Broker } from './broker'
import { id } from './db'
import { TIMEFRAME_MS, barIndexAt, lastClosedIndex, type Bar } from './market'
import { strategyBy } from './strategies'

// Lazy run loop. The Worker is request-scoped, so there is no long-lived
// process to tick a bot: every time a running bot is read or written we
// fast-forward it from its last processed bar up to the newest closed bar,
// apply the strategy, fill through the broker and append trades, events and
// equity points to D1. A bot therefore progresses whenever the UI polls it —
// honest paper-mode behaviour, and the same code path the backtester mirrors.

const MAX_BARS_PER_RUN = 120
const MAX_FILLS_PER_RUN = 40
const MAX_EVENTS_PER_RUN = 30
const MIN_NOTIONAL = 1
const QTY_STEP = 1e6
/** Fee+slippage head-room when sizing a buy against available cash. */
const COST_BUFFER = 1.003

type Row = Record<string, unknown>

interface PositionState {
  id: string
  symbol: string
  qty: number
  avgPrice: number
  openedAt: number
  dirty: 'insert' | 'update' | 'delete' | null
}

interface PendingRow {
  sql: string
  bind: unknown[]
}

export interface AdvanceOptions {
  /** Clock override, used by seeding and tests. */
  at?: number
  broker?: Broker
}

/**
 * Fast-forwards one bot to the latest closed bar. Returns when the bot has
 * caught up (or is not running); the caller re-reads the bot for fresh values.
 */
export async function advanceBot(db: D1Database, owner: string, bot: Bot, options: AdvanceOptions = {}): Promise<void> {
  if (bot.status !== 'running') return

  const strategy = strategyBy(bot.strategyKey)
  if (!strategy) {
    await write(db, bot.id, owner, [
      { sql: `UPDATE bots SET status = 'stopped', updated_at = ? WHERE id = ?`, bind: [Date.now(), bot.id] },
    ], [{ id: id(), level: 'error', message: `Unknown strategy "${bot.strategyKey}"; bot stopped.`, at: Date.now() }])
    return
  }

  const at = options.at ?? Date.now()
  const tfMs = TIMEFRAME_MS[bot.timeframe]
  const broker = options.broker ?? createBroker(bot.mode)

  const lastBar = lastClosedIndex(bot.timeframe, at)
  const firstBar =
    bot.lastTickAt === null ? barIndexAt(bot.timeframe, bot.createdAt) : barIndexAt(bot.timeframe, bot.lastTickAt)
  if (lastBar < firstBar || bot.symbols.length === 0) return

  let start = firstBar
  let skipped = 0
  if (lastBar - start + 1 > MAX_BARS_PER_RUN) {
    skipped = lastBar - start + 1 - MAX_BARS_PER_RUN
    start = lastBar - MAX_BARS_PER_RUN + 1
  }

  const historyStart = Math.max(0, start - strategy.lookback)
  const historyEnd = (lastBar + 1) * tfMs
  const histories = new Map<string, Bar[]>()
  for (const symbol of bot.symbols) {
    histories.set(symbol, broker.bars(symbol, bot.timeframe, historyStart * tfMs, historyEnd))
  }

  const positionRows = await db
    .prepare(`SELECT * FROM positions WHERE bot_id = ?`)
    .bind(bot.id)
    .all<Row>()
  const positions = new Map<string, PositionState>()
  for (const row of positionRows.results ?? []) {
    positions.set(String(row.symbol), {
      id: String(row.id),
      symbol: String(row.symbol),
      qty: Number(row.qty),
      avgPrice: Number(row.avg_price),
      openedAt: Number(row.opened_at),
      dirty: null,
    })
  }

  let cash = bot.cash
  let equity = bot.equity
  let realized = bot.realizedPnl
  let roundTrips = bot.roundTrips
  let wins = bot.wins

  const trades: PendingRow[] = []
  const events: { id: string; level: string; message: string; at: number }[] = []
  const points: { at: number; value: number }[] = []
  let fills = 0

  if (skipped > 0) {
    events.push({
      id: id(),
      level: 'warn',
      message: `Caught up over ${skipped} missed ${skipped === 1 ? 'bar' : 'bars'} in one pass.`,
      at: (start - 1) * tfMs,
    })
  }

  for (let bi = start; bi <= lastBar; bi++) {
    const barClose = (bi + 1) * tfMs
    for (const symbol of bot.symbols) {
      const history = histories.get(symbol)
      if (!history) continue
      const offset = bi - historyStart
      const bars = history.slice(Math.max(0, offset + 1 - strategy.lookback), offset + 1)
      const bar = bars.at(-1)
      if (!bar || bar.t !== bi * tfMs) continue

      const position = positions.get(symbol)
      const signal = strategy.signal({
        bars,
        position: position ? { qty: position.qty, avgPrice: position.avgPrice } : null,
        cash,
        equity,
        params: bot.params,
        tfMs,
      })

      if (signal.action === 'buy' && fills < MAX_FILLS_PER_RUN) {
        const price = bar.c
        const target = equity * (bot.riskPct / 100)
        const qty = Math.floor(Math.min(target / price, cash / (price * COST_BUFFER)) * QTY_STEP) / QTY_STEP
        if (qty > 0 && qty * price >= MIN_NOTIONAL) {
          try {
            const fill = broker.placeOrder({ symbol, side: 'buy', qty, at: barClose })
            fills++
            cash -= fill.price * fill.qty + fill.fee
            if (position && position.qty > 0) {
              const total = position.qty + fill.qty
              position.avgPrice = (position.avgPrice * position.qty + fill.price * fill.qty) / total
              position.qty = total
              position.dirty = 'update'
            } else {
              positions.set(symbol, {
                id: id(),
                symbol,
                qty: fill.qty,
                avgPrice: fill.price,
                openedAt: barClose,
                dirty: 'insert',
              })
            }
            trades.push({
              sql: `INSERT INTO trades (id, owner_sub, bot_id, symbol, side, qty, price, fee, pnl, created_at) VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, NULL, ?)`,
              bind: [id(), owner, bot.id, symbol, fill.qty, fill.price, fill.fee, barClose],
            })
            events.push({
              id: id(),
              level: 'fill',
              message: `Bought ${trim(fill.qty)} ${symbol} @ ${fill.price} — ${signal.reason ?? 'entry'}.`,
              at: barClose,
            })
          } catch (error) {
            return fail(db, owner, bot, error, events)
          }
        }
      } else if (signal.action === 'sell' && position && position.qty > 0 && fills < MAX_FILLS_PER_RUN) {
        try {
          const fill = broker.placeOrder({ symbol, side: 'sell', qty: position.qty, at: barClose })
          fills++
          const pnl = (fill.price - position.avgPrice) * fill.qty - fill.fee
          cash += fill.price * fill.qty - fill.fee
          realized += pnl
          roundTrips++
          if (pnl > 0) wins++
          trades.push({
            sql: `INSERT INTO trades (id, owner_sub, bot_id, symbol, side, qty, price, fee, pnl, created_at) VALUES (?, ?, ?, ?, 'sell', ?, ?, ?, ?, ?)`,
            bind: [id(), owner, bot.id, symbol, fill.qty, fill.price, fill.fee, pnl, barClose],
          })
          events.push({
            id: id(),
            level: 'fill',
            message: `Sold ${trim(fill.qty)} ${symbol} @ ${fill.price} — ${signal.reason ?? 'exit'} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}).`,
            at: barClose,
          })
          positions.set(symbol, { ...position, qty: 0, dirty: 'delete' })
        } catch (error) {
          return fail(db, owner, bot, error, events)
        }
      }
    }

    equity = cash
    for (const position of positions.values()) {
      if (position.dirty === 'delete' || position.qty <= 0) continue
      equity += position.qty * broker.quote(position.symbol, barClose)
    }
    points.push({ at: barClose, value: equity })
  }

  const statements: PendingRow[] = []
  for (const position of positions.values()) {
    if (position.dirty === 'insert') {
      // A sell→re-buy inside one pass leaves the old row in place with a new
      // entry in the map — clear the (bot_id, symbol) row first so the insert
      // never trips the unique index.
      statements.push({ sql: `DELETE FROM positions WHERE bot_id = ? AND symbol = ?`, bind: [bot.id, position.symbol] })
      statements.push({
        sql: `INSERT INTO positions (id, owner_sub, bot_id, symbol, qty, avg_price, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: [position.id, owner, bot.id, position.symbol, position.qty, position.avgPrice, position.openedAt],
      })
    } else if (position.dirty === 'update') {
      statements.push({
        sql: `UPDATE positions SET qty = ?, avg_price = ? WHERE bot_id = ? AND symbol = ?`,
        bind: [position.qty, position.avgPrice, bot.id, position.symbol],
      })
    } else if (position.dirty === 'delete') {
      statements.push({ sql: `DELETE FROM positions WHERE bot_id = ? AND symbol = ?`, bind: [bot.id, position.symbol] })
    }
  }
  statements.push(...trades)
  for (const point of points) {
    statements.push({
      sql: `INSERT OR REPLACE INTO equity_points (bot_id, owner_sub, at, value) VALUES (?, ?, ?, ?)`,
      bind: [bot.id, owner, point.at, point.value],
    })
  }
  statements.push({
    sql: `UPDATE bots SET cash = ?, equity = ?, realized_pnl = ?, round_trips = ?, wins = ?, last_tick_at = ?, updated_at = ? WHERE id = ?`,
    bind: [cash, equity, realized, roundTrips, wins, (lastBar + 1) * tfMs, (lastBar + 1) * tfMs, bot.id],
  })
  // Keep the curve bounded instead of growing forever.
  statements.push({
    sql: `DELETE FROM equity_points WHERE bot_id = ? AND at < ?`,
    bind: [bot.id, (lastBar - 1000) * tfMs],
  })

  const kept = events.slice(0, MAX_EVENTS_PER_RUN)
  if (events.length > MAX_EVENTS_PER_RUN) {
    kept.push({
      id: id(),
      level: 'info',
      message: `${events.length - MAX_EVENTS_PER_RUN} more fills and signals in this pass.`,
      at: (lastBar + 1) * tfMs,
    })
  }
  await write(db, bot.id, owner, statements, kept)
}

async function fail(
  db: D1Database,
  owner: string,
  bot: Bot,
  error: unknown,
  events: { id: string; level: string; message: string; at: number }[],
): Promise<void> {
  const message = error instanceof LiveBrokerError ? error.message : `Execution error: ${String(error)}`
  events.push({ id: id(), level: 'error', message, at: Date.now() })
  await write(
    db,
    bot.id,
    owner,
    [{ sql: `UPDATE bots SET status = 'paused', updated_at = ? WHERE id = ?`, bind: [Date.now(), bot.id] }],
    events,
    'error',
  )
}

async function write(
  db: D1Database,
  botId: string,
  owner: string,
  statements: PendingRow[],
  events: { id: string; level: string; message: string; at: number }[],
  forceLevel?: string,
): Promise<void> {
  for (const event of events) {
    statements.push({
      sql: `INSERT INTO bot_events (id, owner_sub, bot_id, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      bind: [event.id, owner, botId, forceLevel ?? event.level, event.message, event.at],
    })
  }
  for (let i = 0; i < statements.length; i += 40) {
    await db.batch(statements.slice(i, i + 40).map((s) => db.prepare(s.sql).bind(...s.bind)))
  }
}

const trim = (value: number) => (value >= 1000 ? value.toFixed(2) : value >= 1 ? value.toFixed(4) : value.toFixed(6))
