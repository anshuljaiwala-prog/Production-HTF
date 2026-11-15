import type { Bot, BotMode, TraceDecision, TraceRejectReason } from '../shared/types'
import { environmentControlsFor } from './agents/environment-do'
import { evaluateGate, readEnvironment } from './agents/environment'
import { pinStatements, prunePinStatements, readRecentPins } from './agents/pins'
import { MACRO_BARS, macroBarsAt } from './agents/harvester'
import { moveDirection } from './agents/specialists'
import { scorePrediction } from './agents/trace'
import { LiveBrokerError, PaperBroker, type Broker } from './broker'
import { createVenueBroker } from './venues'
import { BOT_SELECT, id, loadBots, mapBot } from './db'
import { TIMEFRAME_MS, barIndexAt, barsBetween, lastClosedIndex, type Bar } from './market'
import { barsForRun } from './marketstore'
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
/** Closed bars of decision trace kept per bot, newest first. */
const TRACE_BARS = 300

/** Bots (per workspace) whose simulation is currently writing. The engine is
 * lazy — every read/write route advances running bots — so two parallel HTTP
 * reads of the same bot would both replay the same bars and interleave their
 * D1 statements: filled buys without their cash debits, clobbered `cash`,
 * vanished position rows. Within one isolate the in-memory set collapses
 * those to one writer. Across isolates (Workers runs many), the replay is
 * also guarded by a compare-and-set lease in D1 below, so only one replay
 * ever lands. A skipped advance simply hasn't caught up yet and the next
 * read does it. */
const advancingBots = new Set<string>()

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
  /** Deployment secrets key, so live venues can decrypt stored credentials. */
  secretsKey?: string
}

/** Running bots advanced per read. Every route that fast-forwards the fleet
 * shares this budget, so the work one request can do lives in one place. */
export const ADVANCE_BUDGET = 12

/**
 * Fast-forwards the running bots and returns the fleet as it stands after the
 * advance, so a route's numbers reflect the latest closed bar. `mode` narrows
 * the fleet to one book (the paper wallet advances separately from the book).
 */
export async function fastForwardFleet(
  db: D1Database,
  owner: string,
  secretsKey: string | undefined,
  mode?: BotMode,
): Promise<Bot[]> {
  const bots = await loadBots(db, owner)
  const running = bots
    .filter((bot) => bot.status === 'running' && (mode === undefined || bot.mode === mode))
    .slice(0, ADVANCE_BUDGET)
  if (!running.length) return bots
  for (const bot of running) await advanceBot(db, owner, bot, { secretsKey })
  return loadBots(db, owner)
}

/**
 * Fast-forwards one bot to the latest closed bar. Returns when the bot has
 * caught up (or is not running); the caller re-reads the bot for fresh values.
 */
export async function advanceBot(db: D1Database, owner: string, bot: Bot, options: AdvanceOptions = {}): Promise<void> {
  if (bot.status !== 'running') return
  const lockKey = `${owner}:${bot.id}`
  if (advancingBots.has(lockKey)) return
  advancingBots.add(lockKey)
  try {
    await advanceLocked(db, owner, bot, options)
  } finally {
    advancingBots.delete(lockKey)
  }
}

async function advanceLocked(db: D1Database, owner: string, bot: Bot, options: AdvanceOptions): Promise<void> {
  // The caller's snapshot can already be a bar (or three) behind — routes load
  // bots beforeserialising their advance work. Re-read the live row so the
  // simulation and its trailing write always agree on one state.
  const freshRow = await db.prepare(`${BOT_SELECT} WHERE b.id = ? AND b.owner_sub = ?`).bind(bot.id, owner).first<Row>()
  if (!freshRow) return
  bot = mapBot(freshRow)
  if (bot.status !== 'running') return
  // Operator kill-switch: a paused environment freezes every book where it is,
  // without changing a bot's own status — so unpausing resumes exactly this.
  const controls = await environmentControlsFor(db, owner)
  if (controls.paused) return
  const strategy = strategyBy(bot.strategyKey)
  if (!strategy) {
    await write(db, bot.id, owner, [
      { sql: `UPDATE bots SET status = 'stopped', updated_at = ? WHERE id = ?`, bind: [Date.now(), bot.id] },
    ], [{ id: id(), level: 'error', message: `Unknown strategy "${bot.strategyKey}"; bot stopped.`, at: Date.now() }])
    return
  }

  const at = options.at ?? Date.now()
  const tfMs = TIMEFRAME_MS[bot.timeframe]
  // Paper bots fill against the simulated venue. Live bots resolve their
  // venue connections into adapters (see venues.ts); no usable venue pauses
  // the bot loudly instead of trading on a fake one.
  let broker: Broker
  try {
    broker =
      options.broker ??
      (bot.mode === 'live'
        ? await createVenueBroker(db, owner, bot.venueIds.length ? bot.venueIds : bot.connectionId ? [bot.connectionId] : [], options.secretsKey)
        : new PaperBroker())
  } catch (error) {
    return fail(db, owner, bot, error, [])
  }

  const lastBar = lastClosedIndex(bot.timeframe, at)
  const firstBar =
    bot.lastTickAt === null ? barIndexAt(bot.timeframe, bot.createdAt) : barIndexAt(bot.timeframe, bot.lastTickAt)
  if (lastBar < firstBar || bot.symbols.length === 0) return

  // Compare-and-set advance lease. Both the lease token and the row's last
  // processed tick are checked in the WHERE clause, so exactly one replay
  // wins when two isolates (or two requests) race the same bot: the loser's
  // UPDATE matches nothing and it skips, leaving the catch-up to a later
  // read. Stale tokens never block the next pass — it always re-reads the
  // row and swaps the lease in a single conditional write.
  const leaseToken = crypto.randomUUID()
  const claimed = await db
    .prepare(`UPDATE bots SET lease_token = ? WHERE id = ? AND owner_sub = ? AND lease_token IS ? AND last_tick_at IS ?`)
    .bind(leaseToken, bot.id, owner, (freshRow.lease_token as string | null) ?? null, bot.lastTickAt)
    .run()
  if (!claimed.meta.changes) return

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

  // Agent shell (ported from market_agent_env): one read per pass, gating new
  // entries only — exits, stops and marks are untouched, so a contagion read can
  // never trap a bot in a position. The bot's own symbol is read from the same
  // merged bars it trades; the macro breadth stays a cheap synthetic read.
  const agentAt = (lastBar + 1) * tfMs
  const focusSymbol = bot.symbols[0] ?? ''
  const focusFrom = agentAt - MACRO_BARS * tfMs
  // The persisted pins for this bot's symbol, once per pass. Every bar this
  // pass replays sees the same set, so the read costs one query per pass and a
  // pin harvested on an earlier pass keeps counting until it expires.
  const priorPins = focusSymbol ? await readRecentPins(db, owner, focusSymbol, agentAt) : []
  const agent = readEnvironment({
    at: agentAt,
    macroBars: macroBarsAt(agentAt),
    priorPins,
    ...(focusSymbol
      ? { focus: { symbol: focusSymbol, bars: (await barsForRun(db, focusSymbol, bot.timeframe, focusFrom, agentAt)) ?? barsBetween(focusSymbol, bot.timeframe, focusFrom, agentAt) } }
      : {}),
  })
  const gate = evaluateGate(agent, bot.symbols, bot.riskOffStreak)
  let blockedBuys = 0
  // The decision trace: one entry per bar this pass evaluates, with what each
  // symbol did on it. The gate, proposals and verdict above are per pass, so a
  // catch-up pass shares that one shell read across its bars — the read the bot
  // actually acted on.
  const traces: { at: number; decisions: TraceDecision[] }[] = []

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

  // Live books are marked at the venue's executable price, not the synthetic
  // feed: real fills against simulated marks would report nonsense P&L. One
  // quote per open symbol per advance keeps the request count bounded.
  const marks = new Map<string, number>()
  if (bot.mode === 'live') {
    for (const position of positions.values()) {
      if (position.qty === 0) continue
      const mark = await broker.executableQuote?.(position.symbol, 'buy').catch(() => null)
      if (mark !== null && mark !== undefined) marks.set(position.symbol, mark)
    }
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
    const decisions: TraceDecision[] = []
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
      // What the strategy is worth believing on this bar. A template states it;
      // the rules DSL cannot, so it inherits the agent verdict's conviction —
      // the read the specialists agreed on for this same bar.
      const confidence = signal.confidence ?? Math.round(agent.verdict.conviction * 100)
      // The tape's temper, from the same pattern scan the agent read uses: a
      // market chopping wider per bar than the bot tolerates is not entered.
      // Read on the bot's focus market, which is the tape the scan measured.
      const realisedVolPct = agent.pattern?.volPct ?? 0
      let orderQty: number | null = null
      let filled = false
      let reject: TraceRejectReason | null = null

      // The whole gate: one decision per signal, and the only thing it can do is
      // stop a long entry. Exits fall through untouched, and so does a short: a
      // risk-off read is exactly when the crash hedge should be allowed to open.
      const entryBlocked = gate.blocked || controls.pauseBuys
      const blockedBuy = signal.action === 'buy' && entryBlocked
      if (blockedBuy) {
        blockedBuys++
        reject = 'gate'
      } else if (confidence < bot.minConfidencePct && (signal.action === 'buy' || signal.action === 'short')) {
        // The operator's floor: a signal the strategy is not sure enough about
        // never reaches the broker. Exits are not gated — a bot must always be
        // able to close a book, whatever it now thinks of the tape.
        reject = 'confidence'
      } else if (bot.maxVolatilityPct > 0 && realisedVolPct > bot.maxVolatilityPct && (signal.action === 'buy' || signal.action === 'short')) {
        // Only the ceiling gates, never the floor: quiet tape is tradable.
        // Exits fall through — a bot must be able to close a book in a storm.
        reject = 'volatility'
      }
      else if (signal.action === 'buy' && fills < MAX_FILLS_PER_RUN) {
        const price = bar.c
        const target = equity * (bot.riskPct / 100)
        const qty = Math.floor(Math.min(target / price, cash / (price * COST_BUFFER)) * QTY_STEP) / QTY_STEP
        if (qty > 0 && qty * price >= MIN_NOTIONAL) {
          try {
            const fill = await broker.placeOrder({ symbol, side: 'buy', qty, at: barClose })
            fills++
            marks.set(symbol, fill.price)
            orderQty = fill.qty
            filled = true
            cash -= fill.price * fill.qty + fill.fee
            if (position && position.qty > 0) {
              const total = position.qty + fill.qty
              position.avgPrice = (position.avgPrice * position.qty + fill.price * fill.qty) / total
              position.qty = total
              // Keep 'insert' when the book entry was created this pass: flaging
              // it 'update' would emit an UPDATE for a row this pass never
              // INSERTed, and the position would vanish from the store.
              if (position.dirty !== 'insert') position.dirty = 'update'
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
              sql: `INSERT INTO trades (id, owner_sub, bot_id, symbol, side, qty, price, fee, pnl, confidence, created_at) VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, NULL, ?, ?)`,
              bind: [id(), owner, bot.id, symbol, fill.qty, fill.price, fill.fee, confidence, barClose],
            })
            events.push({
              id: id(),
              level: 'fill',
              message: `Bought ${trim(fill.qty)} ${symbol} @ ${trim(fill.price)} — ${signal.reason ?? 'entry'}${fill.venue ? ` via ${fill.venue}` : ''}.`,
              at: barClose,
            })
          } catch (error) {
            return fail(db, owner, bot, error, events)
          }
        } else {
          reject = 'sizing'
        }
      } else if (signal.action === 'sell' && position && position.qty > 0 && fills < MAX_FILLS_PER_RUN) {
        try {
          const fill = await broker.placeOrder({ symbol, side: 'sell', qty: position.qty, at: barClose })
          fills++
          marks.set(symbol, fill.price)
          orderQty = position.qty
          filled = true
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
            message: `Sold ${trim(fill.qty)} ${symbol} @ ${trim(fill.price)} — ${signal.reason ?? 'exit'}${fill.venue ? ` via ${fill.venue}` : ''} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}).`,
            at: barClose,
          })
          positions.set(symbol, { ...position, qty: 0, dirty: 'delete' })
        } catch (error) {
          return fail(db, owner, bot, error, events)
        }
      } else if (signal.action === 'short' && (!position || position.qty === 0) && fills < MAX_FILLS_PER_RUN) {
        // Venue adapters place long-only orders; a live short would sell shares
        // the bot does not own. Refuse loudly instead of faking a hedge.
        if (broker.mode === 'live') {
          return fail(db, owner, bot, new Error('Live venues do not support short selling — run this strategy in paper mode.'), events)
        }
        const price = bar.c
        const target = equity * (bot.riskPct / 100)
        // A short posts no cash, but sizing keeps its notional at the same risk
        // target as a long so the two directions are comparable.
        const qty = Math.floor(Math.min(target / price, equity / (price * COST_BUFFER)) * QTY_STEP) / QTY_STEP
        if (qty > 0 && qty * price >= MIN_NOTIONAL) {
          try {
            const fill = await broker.placeOrder({ symbol, side: 'sell', qty, at: barClose })
            fills++
            marks.set(symbol, fill.price)
            orderQty = qty
            filled = true
            cash += fill.price * fill.qty - fill.fee
            positions.set(symbol, {
              id: id(),
              symbol,
              qty: -fill.qty,
              avgPrice: fill.price,
              openedAt: barClose,
              dirty: 'insert',
            })
            trades.push({
              sql: `INSERT INTO trades (id, owner_sub, bot_id, symbol, side, qty, price, fee, pnl, confidence, created_at) VALUES (?, ?, ?, ?, 'short', ?, ?, ?, NULL, ?, ?)`,
              bind: [id(), owner, bot.id, symbol, fill.qty, fill.price, fill.fee, confidence, barClose],
            })
            events.push({
              id: id(),
              level: 'fill',
              message: `Shorted ${trim(fill.qty)} ${symbol} @ ${trim(fill.price)} — ${signal.reason ?? 'entry'}${fill.venue ? ` via ${fill.venue}` : ''}.`,
              at: barClose,
            })
          } catch (error) {
            return fail(db, owner, bot, error, events)
          }
        } else {
          reject = 'sizing'
        }
      } else if (signal.action === 'cover' && position && position.qty < 0 && fills < MAX_FILLS_PER_RUN) {
        const qty = -position.qty
        try {
          const fill = await broker.placeOrder({ symbol, side: 'buy', qty, at: barClose })
          fills++
          marks.set(symbol, fill.price)
          orderQty = qty
          filled = true
          const pnl = (position.avgPrice - fill.price) * qty - fill.fee
          cash -= fill.price * qty + fill.fee
          realized += pnl
          roundTrips++
          if (pnl > 0) wins++
          trades.push({
            sql: `INSERT INTO trades (id, owner_sub, bot_id, symbol, side, qty, price, fee, pnl, created_at) VALUES (?, ?, ?, ?, 'cover', ?, ?, ?, ?, ?)`,
            bind: [id(), owner, bot.id, symbol, qty, fill.price, fill.fee, pnl, barClose],
          })
          events.push({
            id: id(),
            level: 'fill',
            message: `Covered ${trim(qty)} ${symbol} @ ${trim(fill.price)} — ${signal.reason ?? 'exit'}${fill.venue ? ` via ${fill.venue}` : ''} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}).`,
            at: barClose,
          })
          positions.set(symbol, { ...position, qty: 0, dirty: 'delete' })
        } catch (error) {
          return fail(db, owner, bot, error, events)
        }
      }
      // Anything the strategy asked for that no branch filled is a typed
      // reject, never a silent no-op.
      if (!filled && reject === null && signal.action !== 'hold') {
        reject = fills >= MAX_FILLS_PER_RUN ? 'fill_cap' : 'no_position'
      }
      decisions.push({
        symbol,
        action: signal.action,
        reason: signal.reason ?? null,
        qty: orderQty,
        fill: filled,
        reject,
      })
    }
    traces.push({ at: barClose, decisions })

    equity = cash
    for (const position of positions.values()) {
      // A short carries negative qty, so its mark is a liability, not zero.
      if (position.dirty === 'delete' || position.qty === 0) continue
      const mark = bot.mode === 'live' ? (marks.get(position.symbol) ?? position.avgPrice) : broker.quote(position.symbol, barClose)
      equity += position.qty * mark
    }
    points.push({ at: barClose, value: equity })
  }

  if (blockedBuys > 0) {
    events.push({
      id: id(),
      level: 'info',
      message: `Agent shell held back ${blockedBuys} ${blockedBuys === 1 ? 'entry' : 'entries'} — ${
        controls.pauseBuys ? 'new entries paused by the operator' : (gate.reason ?? agent.regime.toLowerCase().replace(/_/g, ' '))
      }.`,
      at: (lastBar + 1) * tfMs,
    })
  }

  const statements: PendingRow[] = []
  for (const position of positions.values()) {
    if (position.dirty === 'insert') {
      // A sell→re-buy inside one pass leaves the old row in place with a new
      // entry in the map — clear the (bot_id, symbol) row first so the insert
      // never trips the unique index.
      statements.push({ sql: `DELETE FROM positions WHERE bot_id = ? AND symbol = ?`, bind: [bot.id, position.symbol] })
      const mark = marks.get(position.symbol)
      statements.push({
        sql: `INSERT INTO positions (id, owner_sub, bot_id, symbol, qty, avg_price, opened_at, mark_price, mark_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          position.id,
          owner,
          bot.id,
          position.symbol,
          position.qty,
          position.avgPrice,
          position.openedAt,
          mark ?? null,
          mark === undefined ? null : (lastBar + 1) * tfMs,
        ],
      })
    } else if (position.dirty === 'update') {
      const mark = marks.get(position.symbol)
      statements.push({
        sql: `UPDATE positions SET qty = ?, avg_price = ?, mark_price = COALESCE(?, mark_price), mark_at = COALESCE(?, mark_at) WHERE bot_id = ? AND symbol = ?`,
        bind: [position.qty, position.avgPrice, mark ?? null, mark === undefined ? null : (lastBar + 1) * tfMs, bot.id, position.symbol],
      })
    } else if (position.dirty === 'delete') {
      statements.push({ sql: `DELETE FROM positions WHERE bot_id = ? AND symbol = ?`, bind: [bot.id, position.symbol] })
    } else if (bot.mode === 'live' && position.qty > 0) {
      // Untouched by this pass: refresh its stored venue mark so the dashboard,
      // portfolio and bot page all price it from the venue, not the feed.
      const mark = marks.get(position.symbol)
      if (mark !== undefined) {
        statements.push({
          sql: `UPDATE positions SET mark_price = ?, mark_at = ? WHERE bot_id = ? AND symbol = ?`,
          bind: [mark, (lastBar + 1) * tfMs, bot.id, position.symbol],
        })
      }
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
    sql: `UPDATE bots SET cash = ?, equity = ?, realized_pnl = ?, round_trips = ?, wins = ?, risk_off_streak = ?, last_tick_at = ?, updated_at = ? WHERE id = ?`,
    bind: [cash, equity, realized, roundTrips, wins, gate.streak, (lastBar + 1) * tfMs, (lastBar + 1) * tfMs, bot.id],
  })
  // Keep the curve bounded instead of growing forever.
  statements.push({
    sql: `DELETE FROM equity_points WHERE bot_id = ? AND at < ?`,
    bind: [bot.id, (lastBar - 1000) * tfMs],
  })
  for (const trace of traces) {
    statements.push({
      sql: `INSERT OR REPLACE INTO decision_traces (bot_id, owner_sub, at, gate_blocked, gate_reason, risk_off_streak, proposals, verdict, decisions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        bot.id,
        owner,
        trace.at,
        gate.blocked ? 1 : 0,
        gate.reason,
        gate.streak,
        JSON.stringify(agent.proposals),
        JSON.stringify(agent.verdict),
        JSON.stringify(trace.decisions),
      ],
    })
  }
  statements.push({
    sql: `DELETE FROM decision_traces WHERE bot_id = ? AND at < ?`,
    bind: [bot.id, (lastBar - TRACE_BARS) * tfMs],
  })

  // Score the always-on move probability: the bar that just closed is what the
  // bar before it implied, and both are in the history this pass replayed. So
  // the row lands already resolved and the Brier score is measured rather than
  // asserted. The forecast's facts are the current read (facts move slowly),
  // which makes this a one-bar-ahead check, not a point-in-time replay.
  const focusHistory = histories.get(focusSymbol)
  const predicted = focusHistory?.find((bar) => bar.t === (lastBar - 1) * tfMs)
  const realised = focusHistory?.find((bar) => bar.t === lastBar * tfMs)
  const direction = moveDirection(agent.nextMove.move)
  const scored = predicted && realised ? scorePrediction(predicted.c, realised.c, direction) : null
  if (predicted && realised && scored) {
    statements.push({
      sql: `INSERT OR REPLACE INTO move_predictions (owner_sub, symbol, timeframe, at, move, probability, facts_available, direction, price, next_close, return_pct, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        owner,
        focusSymbol,
        bot.timeframe,
        predicted.t,
        agent.nextMove.move,
        agent.nextMove.probability,
        agent.nextMove.factsAvailable ? 1 : 0,
        direction,
        predicted.c,
        realised.c,
        scored.returnPct,
        scored.outcome ? 1 : 0,
      ],
    })
  }

  // Persist what this pass screened, in the same batch as everything else it
  // wrote, and bound the table the way the curve and traces are bounded.
  statements.push(...pinStatements(agent.pins, owner), prunePinStatements(owner, agentAt))

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
