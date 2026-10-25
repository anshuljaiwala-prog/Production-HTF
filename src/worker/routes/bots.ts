import { Hono } from 'hono'

import { privateJson } from '../auth'
import { BOT_SELECT, id, mapBot, mapEvent, mapPosition, mapTrade, now } from '../db'
import type { AppContext } from '../env'
import { advanceBot } from '../engine'
import { quote } from '../market'
import { STRATEGIES, sanitizeParams, strategyBy } from '../strategies'
import type { Bot, BotStage, BotStatus, Timeframe } from '../../shared/types'

type Row = Record<string, unknown>

export const bots = new Hono<AppContext>()

/** Running bots are fast-forwarded on read; cap the work per request. */
const MAX_ADVANCE_PER_REQUEST = 12
const MAX_SYMBOLS = 6

function withStrategy(bot: Bot): Bot {
  return { ...bot, strategyName: strategyBy(bot.strategyKey)?.name ?? bot.strategyKey }
}

async function loadBots(db: D1Database, owner: string): Promise<Bot[]> {
  const result = await db
    .prepare(`${BOT_SELECT} WHERE b.owner_sub = ? ORDER BY b.position DESC, b.created_at DESC`)
    .bind(owner)
    .all<Row>()
  return (result.results ?? []).map(mapBot)
}

async function loadBot(db: D1Database, owner: string, botId: string): Promise<Bot | null> {
  const row = await db.prepare(`${BOT_SELECT} WHERE b.id = ? AND b.owner_sub = ?`).bind(botId, owner).first<Row>()
  return row ? mapBot(row) : null
}

async function advanceRunning(db: D1Database, owner: string, items: Bot[]): Promise<boolean> {
  const running = items.filter((b) => b.status === 'running').slice(0, MAX_ADVANCE_PER_REQUEST)
  for (const bot of running) await advanceBot(db, owner, bot)
  return running.length > 0
}

async function logEvent(db: D1Database, owner: string, botId: string, level: string, message: string) {
  await db
    .prepare(`INSERT INTO bot_events (id, owner_sub, bot_id, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id(), owner, botId, level, message, now())
    .run()
}

bots.get('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  let items = await loadBots(db, owner)
  if (await advanceRunning(db, owner, items)) items = await loadBots(db, owner)
  return privateJson(c, { items: items.map(withStrategy), strategies: STRATEGIES })
})

interface CreateBody {
  strategyKey?: string
  name?: string
  symbols?: string[]
  timeframe?: Timeframe
  params?: Record<string, unknown>
  capital?: number
  riskPct?: number
  mode?: 'paper' | 'live'
  connectionId?: string | null
  stage?: BotStage
  status?: BotStatus
}

bots.post('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<CreateBody>()

  const strategy = strategyBy(String(body.strategyKey ?? ''))
  if (!strategy) return c.json({ error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }, 400)

  const symbols = [...new Set((body.symbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))].slice(
    0,
    MAX_SYMBOLS,
  )
  if (symbols.length === 0) return c.json({ error: 'symbols_required', message: 'Choose at least one symbol.' }, 400)

  const timeframe = (body.timeframe ?? strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]) as Timeframe
  if (!strategy.timeframes.includes(timeframe)) {
    return c.json({ error: 'timeframe_unsupported', message: `${strategy.name} does not run on the ${timeframe} timeframe.` }, 400)
  }

  const capital = Number(body.capital)
  if (!Number.isFinite(capital) || capital < 100) {
    return c.json({ error: 'invalid_capital', message: 'Starting capital must be at least $100.' }, 400)
  }
  const riskPct = Math.min(100, Math.max(1, Number(body.riskPct) || 25))
  const mode: 'paper' | 'live' = body.mode === 'live' ? 'live' : 'paper'

  let connectionId: string | null = null
  if (body.connectionId) {
    const connection = await db
      .prepare(`SELECT id FROM connections WHERE id = ? AND owner_sub = ?`)
      .bind(String(body.connectionId), owner)
      .first<{ id: string }>()
    if (!connection) return c.json({ error: 'connection_not_found', message: 'That connection no longer exists.' }, 400)
    connectionId = connection.id
  } else if (mode === 'live') {
    return c.json({ error: 'connection_required', message: 'A live bot needs an exchange connection.' }, 400)
  }

  const status: BotStatus = body.status === 'stopped' || body.status === 'paused' ? body.status : 'running'
  const stage: BotStage = body.stage ?? (status === 'running' ? (mode === 'live' ? 'live' : 'paper') : 'draft')
  const name = (body.name?.trim() || `${strategy.name} · ${symbols.join(' / ')}`).slice(0, 90)
  const t = now()
  const botId = id()

  await db
    .prepare(
      `INSERT INTO bots (id, owner_sub, name, strategy_key, symbols, timeframe, params, capital, risk_pct, mode, stage, status,
        position, connection_id, cash, equity, initial_equity, realized_pnl, round_trips, wins, created_at, started_at, last_tick_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)`,
    )
    .bind(
      botId,
      owner,
      name,
      strategy.key,
      JSON.stringify(symbols),
      timeframe,
      JSON.stringify(sanitizeParams(strategy.key, body.params)),
      capital,
      riskPct,
      mode,
      stage,
      status,
      connectionId,
      capital,
      capital,
      capital,
      t,
      status === 'running' ? t : null,
      t,
      t,
    )
    .run()

  await logEvent(
    db,
    owner,
    botId,
    'info',
    `Launched in ${mode} mode with ${capital.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} on ${symbols.join(', ')} (${timeframe}).`,
  )

  const bot = await loadBot(db, owner, botId)
  return privateJson(c, { bot: bot ? withStrategy(bot) : null }, 201)
})

bots.get('/:id', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const botId = c.req.param('id')
  let bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)

  if (bot.status === 'running') {
    await advanceBot(db, owner, bot)
    bot = (await loadBot(db, owner, botId)) ?? bot
  }

  const at = now()
  const [positions, trades, events, equity] = await Promise.all([
    db.prepare(`SELECT * FROM positions WHERE bot_id = ? ORDER BY opened_at`).bind(botId).all<Row>(),
    db.prepare(`SELECT * FROM trades WHERE bot_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).bind(botId).all<Row>(),
    db
      .prepare(`SELECT * FROM bot_events WHERE bot_id = ? ORDER BY created_at DESC, id DESC LIMIT 60`)
      .bind(botId)
      .all<Row>(),
    db.prepare(`SELECT at, value FROM equity_points WHERE bot_id = ? ORDER BY at ASC LIMIT 1200`).bind(botId).all<Row>(),
  ])

  // Positions are already marked against the current clock. When the bot is
  // running, extend that marking to the whole book: compute a live equity
  // (cash + marked positions) and append one provisional equity point for
  // "now". Both are response-only — nothing is written back, so the stored
  // curve stays exactly the closed-bar record the engine produced.
  const marks = new Map<string, number>()
  const positionRows = (positions.results ?? []).map((row) => {
    const mark = quote(String(row.symbol), at)
    marks.set(String(row.symbol), mark)
    return { ...mapPosition(row), markPrice: mark, unrealizedPnl: (mark - Number(row.avg_price)) * Number(row.qty) }
  })
  const mappedEquity = (equity.results ?? []).map((row) => ({ t: Number(row.at), value: Number(row.value) }))

  let responseBot = withStrategy(bot)
  if (bot.status === 'running') {
    const unrealized = positionRows.reduce((sum, pos) => sum + pos.qty * pos.markPrice, 0)
    const liveEquity = bot.cash + unrealized
    responseBot = { ...responseBot, equity: liveEquity }
    const last = mappedEquity.at(-1)
    if (!last || last.t < at) mappedEquity.push({ t: at, value: liveEquity })
  }

  return privateJson(c, {
    bot: responseBot,
    positions: positionRows,
    trades: (trades.results ?? []).map(mapTrade),
    events: (events.results ?? []).map(mapEvent),
    equity: mappedEquity,
  })
})

bots.patch('/:id', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const botId = c.req.param('id')
  const body = await c.req.json<{ name?: string; stage?: BotStage; position?: number }>()
  const bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)

  const stage = body.stage && ['draft', 'backtest', 'paper', 'live'].includes(body.stage) ? body.stage : bot.stage
  const name = body.name ? body.name.trim().slice(0, 90) || bot.name : bot.name
  const position = Number.isFinite(body.position) ? Number(body.position) : bot.position

  await db
    .prepare(`UPDATE bots SET name = ?, stage = ?, position = ?, updated_at = ? WHERE id = ? AND owner_sub = ?`)
    .bind(name, stage, position, now(), botId, owner)
    .run()

  const updated = await loadBot(db, owner, botId)
  return privateJson(c, { bot: updated ? withStrategy(updated) : null })
})

bots.post('/:id/control', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const botId = c.req.param('id')
  const { action } = await c.req.json<{ action?: string }>()
  const bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)
  if (!['start', 'pause', 'stop'].includes(String(action))) {
    return c.json({ error: 'unknown_action', message: 'Use start, pause or stop.' }, 400)
  }

  const t = now()
  const status: BotStatus = action === 'start' ? 'running' : action === 'pause' ? 'paused' : 'stopped'
  await db
    .prepare(`UPDATE bots SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND owner_sub = ?`)
    .bind(status, t, t, botId, owner)
    .run()
  await logEvent(db, owner, botId, 'info', `${status === 'running' ? 'Started' : status === 'paused' ? 'Paused' : 'Stopped'} by operator.`)

  let updated = (await loadBot(db, owner, botId)) ?? bot
  if (status === 'running') {
    await advanceBot(db, owner, updated)
    updated = (await loadBot(db, owner, botId)) ?? updated
  }
  return privateJson(c, { bot: withStrategy(updated) })
})

bots.delete('/:id', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const botId = c.req.param('id')
  const bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)
  await db.batch([
    db.prepare(`DELETE FROM bots WHERE id = ? AND owner_sub = ?`).bind(botId, owner),
    db.prepare(`DELETE FROM positions WHERE bot_id = ?`).bind(botId),
    db.prepare(`DELETE FROM trades WHERE bot_id = ?`).bind(botId),
    db.prepare(`DELETE FROM bot_events WHERE bot_id = ?`).bind(botId),
    db.prepare(`DELETE FROM equity_points WHERE bot_id = ?`).bind(botId),
  ])
  return privateJson(c, { ok: true })
})
