import { Hono } from 'hono'

import { privateJson } from '../auth'
import { BOT_SELECT, id, mapBot, mapEvent, mapPosition, mapTrade, now } from '../db'
import type { AppContext } from '../env'
import { advanceBot } from '../engine'
import { TIMEFRAME_MS, barsBetween, quote } from '../market'
import { STRATEGIES, measureAccuracy, parseRules, rulesToParams, sanitizeParams, strategyBy } from '../strategies'
import type { Bot, BotStage, BotStatus, ParamValue, Timeframe } from '../../shared/types'

type Row = Record<string, unknown>

export const bots = new Hono<AppContext>()

/** Running bots are fast-forwarded on read; cap the work per request. */
const MAX_ADVANCE_PER_REQUEST = 12
const MAX_SYMBOLS = 6

function withStrategy(bot: Bot): Bot {
  // Uploaded (custom) strategies report their rules name, not the generic one.
  if (bot.strategyKey === 'custom' && typeof bot.params.rules === 'string') {
    try {
      const parsed = JSON.parse(bot.params.rules) as { name?: string }
      if (parsed?.name) return { ...bot, strategyName: parsed.name }
    } catch {
      /* fall through */
    }
  }
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
  /** Exchange-API binding: bots route through a saved connection. */
  connectionId?: string | null
  /** Inline uploaded strategy: validated rules routed through `custom`. */
  rules?: unknown
  stage?: BotStage
  status?: BotStatus
}

interface ValidatedSpec {
  strategyKey: string
  strategyName: string
  symbols: string[]
  timeframe: Timeframe
  params: Record<string, ParamValue> | null
  capital: number
  riskPct: number
  mode: 'paper' | 'live'
  connectionId: string | null
  status: BotStatus
  stage: BotStage
  name: string
}

/** Everything createBot needs as already-validated typed values — or the
 * reason the spec was rejected. Shared by single launch, bulk import, and
 * the import review (dry-run) mode. */
async function validateSpec(db: D1Database, owner: string, body: CreateBody): Promise<ValidatedSpec | { error: string; message: string }> {
  // Inline rules create a custom-strategy bot; the rules payload is
  // validated the same way the standalone upload path validates it.
  let isCustom = false
  let rulesForParams: Record<string, ParamValue> | null = null
  let displayName = body.strategyKey ? (strategyBy(String(body.strategyKey))?.name ?? String(body.strategyKey)) : ''
  if (body.rules !== undefined) {
    try {
      const parsed = parseRules(body.rules)
      isCustom = true
      rulesForParams = rulesToParams(parsed.rules)
      displayName = parsed.rules.name
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid rules.'
      return { error: 'invalid_rules', message }
    }
  }

  const strategy = strategyBy(isCustom ? 'custom' : String(body.strategyKey ?? ''))
  if (!strategy) return { error: 'unknown_strategy', message: 'Pick a strategy from the catalog.' }

  const symbols = [...new Set((body.symbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))].slice(
    0,
    MAX_SYMBOLS,
  )
  if (symbols.length === 0) return { error: 'symbols_required', message: 'Choose at least one symbol.' }

  const timeframe = (body.timeframe ?? strategy.timeframes[Math.floor(strategy.timeframes.length / 2)]) as Timeframe
  if (!strategy.timeframes.includes(timeframe)) {
    return { error: 'timeframe_unsupported', message: `${strategy.name} does not run on the ${timeframe} timeframe.` }
  }

  const capital = Number(body.capital)
  if (!Number.isFinite(capital) || capital < 100) {
    return { error: 'invalid_capital', message: 'Starting capital must be at least $100.' }
  }
  const riskPct = Math.min(100, Math.max(1, Number(body.riskPct) || 25))
  const mode: 'paper' | 'live' = body.mode === 'live' ? 'live' : 'paper'

  let connectionId: string | null = null
  if (body.connectionId) {
    const connection = await db
      .prepare(`SELECT id FROM connections WHERE id = ? AND owner_sub = ?`)
      .bind(String(body.connectionId), owner)
      .first<{ id: string }>()
    if (!connection) return { error: 'connection_not_found', message: 'That connection no longer exists.' }
    connectionId = connection.id
  } else if (mode === 'live') {
    return { error: 'connection_required', message: 'A live bot needs an exchange connection.' }
  }

  const status: BotStatus = body.status === 'stopped' || body.status === 'paused' ? body.status : 'running'
  const stage: BotStage = body.stage ?? (status === 'running' ? (mode === 'live' ? 'live' : 'paper') : 'draft')
  const name = (body.name?.trim() || `${displayName || strategy.name} · ${symbols.join(' / ')}`).slice(0, 90)

  return {
    strategyKey: strategy.key,
    strategyName: displayName || strategy.name,
    symbols,
    timeframe,
    params: isCustom ? rulesForParams : sanitizeParams(strategy.key, body.params),
    capital,
    riskPct,
    mode,
    connectionId,
    status,
    stage,
    name,
  }
}

/** One bot creation, shared by single launch and bulk import: validates and
 * inserts, returning either the bot or a rejection reason. */
async function createBot(db: D1Database, owner: string, body: CreateBody): Promise<{ bot?: Bot; error?: string; message?: string }> {
  const spec = await validateSpec(db, owner, body)
  if ('error' in spec) return spec

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
      spec.name,
      spec.strategyKey,
      JSON.stringify(spec.symbols),
      spec.timeframe,
      JSON.stringify(spec.params ?? {}),
      spec.capital,
      spec.riskPct,
      spec.mode,
      spec.stage,
      spec.status,
      spec.connectionId,
      spec.capital,
      spec.capital,
      spec.capital,
      t,
      spec.status === 'running' ? t : null,
      t,
      t,
    )
    .run()

  await logEvent(
    db,
    owner,
    botId,
    'info',
    `Launched in ${spec.mode} mode with ${spec.capital.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} on ${spec.symbols.join(', ')} (${spec.timeframe}).`,
  )

  const bot = await loadBot(db, owner, botId)
  return bot ? { bot } : { error: 'create_failed', message: 'Bot could not be created.' }
}

bots.post('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<CreateBody>()
  const result = await createBot(db, owner, body)
  if (result.error) return c.json({ error: result.error, message: result.message }, 400)
  return privateJson(c, { bot: withStrategy(result.bot!) }, 201)
})

/** Bulk bot config import — the direct JSON-payload upload path. Accepts
 * `{ items: [...] }` (or `{ bots: [...] }`) where each row may carry inline
 * `rules` (uploaded strategy) and a `connectionId` (which API the bot routes
 * through). With `?validate=1` nothing is created: every row is checked
 * exactly as a real import would be, and the reasons come back for a
 * preview before the operator commits. */
const MAX_IMPORT = 25

bots.post('/import', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const validateOnly = c.req.query('validate') === '1'
  const body = await c.req.json<{ items?: CreateBody[]; bots?: CreateBody[] }>()
  const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.bots) ? body.bots : []
  const items = rawItems.slice(0, MAX_IMPORT)
  if (items.length === 0) {
    return c.json({ error: 'nothing_to_import', message: 'No bot configs found in the upload — expected an array under "items".' }, 400)
  }

  const ready: ValidateRowResult[] = []
  for (const [index, item] of items.entries()) {
    const label = item.name?.trim() || item.symbols?.filter(Boolean).join(', ') || `Import ${index + 1}`
    const spec = await validateSpec(db, owner, { ...item, status: 'paused' })
    if ('error' in spec) ready.push({ label, problem: spec.message })
    else ready.push({ label, problem: null })
  }

  if (validateOnly) {
    return privateJson(c, { ready: ready.filter((r) => r.problem === null).length, rows: ready })
  }

  const launched: Bot[] = []
  const failed: { name: string; error: string }[] = []
  for (const [index, item] of items.entries()) {
    const label = item.name?.trim() || item.symbols?.filter(Boolean).join(', ') || `Import ${index + 1}`
    const result = await createBot(db, owner, { ...item, status: 'paused' })
    if (result.bot) launched.push(withStrategy(result.bot))
    else failed.push({ name: label, error: result.message ?? 'Invalid config.' })
  }
  return privateJson(c, { launched, failed })
})

interface ValidateRowResult {
  label: string
  problem: string | null
}

const ACCURACY_WINDOW_BARS = 900

/** Fleet-wide market-edge ranking: every bot scored with the same window,
 * best directional accuracy first — the comparison view behind
 * `GET /bots/accuracy`. Bars are cached per symbol+timeframe so a fleet
 * sharing markets scores every strategy against identical data. */
bots.get('/accuracy', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const fleet = await loadBots(db, owner)
  const to = now()
  const barCache = new Map<string, ReturnType<typeof barsBetween>>()
  const scored = fleet.map((bot) => {
    const tfMs = TIMEFRAME_MS[bot.timeframe]
    const symbol = bot.symbols[0] ?? 'BTC-USD'
    const cacheKey = `${symbol}|${bot.timeframe}`
    let bars = barCache.get(cacheKey)
    if (!bars) {
      bars = barsBetween(symbol, bot.timeframe, to - ACCURACY_WINDOW_BARS * tfMs, to + tfMs)
      barCache.set(cacheKey, bars)
    }
    const accuracy = measureAccuracy(bot.strategyKey, bot.params, bars, tfMs)
    return {
      botId: bot.id,
      name: bot.name,
      strategyName: withStrategy(bot).strategyName,
      symbol: bot.symbols[0] ?? null,
      timeframe: bot.timeframe,
      status: bot.status,
      stage: bot.stage,
      accuracy,
      live: {
        wins: bot.wins,
        roundTrips: bot.roundTrips,
        hitRate: bot.roundTrips > 0 ? (bot.wins / bot.roundTrips) * 100 : null,
      },
    }
  })
  // Highest directional accuracy first; bots whose rules never fire sink to
  // the bottom instead of floating on a null.
  scored.sort(
    (a, b) =>
      (b.accuracy.directionalAccuracy ?? -1) - (a.accuracy.directionalAccuracy ?? -1) ||
      (b.accuracy.edgePct ?? Number.NEGATIVE_INFINITY) - (a.accuracy.edgePct ?? Number.NEGATIVE_INFINITY),
  )
  return privateJson(c, {
    items: scored.map((row, index) => ({ ...row, rank: index + 1 })),
    window: { bars: ACCURACY_WINDOW_BARS, to },
  })
})

/** Prediction accuracy for one bot: how well its strategy's entry rules
 * forecast the next bar over a bounded recent window of the feed, plus the
 * realised hit rate of its actual round trips alongside it. Analytic and
 * deterministic — the same config always scores the same on the same clock. */
bots.get('/:id/accuracy', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const botId = c.req.param('id')
  const bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)

  const tfMs = TIMEFRAME_MS[bot.timeframe]
  const to = now()
  const bars = barsBetween(bot.symbols[0] ?? 'BTC-USD', bot.timeframe, to - ACCURACY_WINDOW_BARS * tfMs, to + tfMs)
  const accuracy = measureAccuracy(bot.strategyKey, bot.params, bars, tfMs)
  return privateJson(c, {
    botId,
    strategyKey: bot.strategyKey,
    window: { bars: bars.length, from: bars[0]?.t ?? 0, to, timeframe: bot.timeframe, symbol: bot.symbols[0] ?? null },
    accuracy,
    live: {
      wins: bot.wins,
      roundTrips: bot.roundTrips,
      hitRate: bot.roundTrips > 0 ? (bot.wins / bot.roundTrips) * 100 : null,
    },
  })
})

/** Full run detail for one bot: positions marked live, trade log, events
 * and the stored equity curve (extended by one provisional "now" point
 * while running). */
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
  const body = await c.req.json<{
    name?: string
    stage?: BotStage
    position?: number
    symbols?: string[]
    timeframe?: Timeframe
    riskPct?: number
    params?: Record<string, unknown>
    connectionId?: string | null
  }>()
  const bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)

  // Trading settings are only editable while the bot is not active — pause or
  // stop it first so what it decides on never changes mid-run.
  const wantsTradingSettings = body.symbols !== undefined || body.timeframe !== undefined || body.riskPct !== undefined || body.params !== undefined || body.connectionId !== undefined
  if (wantsTradingSettings && bot.status === 'running') {
    return c.json({ error: 'bot_active', message: 'Pause or stop this bot before editing its trading settings.' }, 409)
  }

  const stage = body.stage && ['draft', 'backtest', 'paper', 'live'].includes(body.stage) ? body.stage : bot.stage
  const name = body.name ? body.name.trim().slice(0, 90) || bot.name : bot.name
  const position = Number.isFinite(body.position) ? Number(body.position) : bot.position

  // Trading settings: each falls back to the stored value when absent.
  const strategy = strategyBy(bot.strategyKey)
  const symbols = body.symbols !== undefined ? body.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, MAX_SYMBOLS) : bot.symbols
  if (symbols.length === 0) return c.json({ error: 'invalid_symbols', message: 'Keep at least one symbol.' }, 400)
  const timeframe = body.timeframe !== undefined && strategy?.timeframes.includes(body.timeframe) ? body.timeframe : bot.timeframe
  const riskPct = Number.isFinite(Number(body.riskPct)) && body.riskPct !== undefined ? Math.min(100, Math.max(1, Number(body.riskPct))) : bot.riskPct
  // Catalog strategies sanitize against their schema; a custom bot accepts a
  // re-validated rules blob — that is how the trainer's baked thresholds land
  // on an uploaded-rules bot. The editor itself sends no params for them, so
  // an absent rules key keeps the stored blob untouched.
  let params = bot.params
  if (body.params !== undefined && bot.strategyKey !== 'custom') {
    params = sanitizeParams(bot.strategyKey, body.params)
  } else if (body.params !== undefined && body.params.rules !== undefined) {
    try {
      const raw = typeof body.params.rules === 'string' ? JSON.parse(body.params.rules) : body.params.rules
      const parsed = parseRules(raw)
      const stop = Number(body.params.stopLossPct)
      const target = Number(body.params.takeProfitPct)
      params = rulesToParams(
        parsed.rules,
        Number.isFinite(stop) ? stop : parsed.rules.stopLossPct,
        Number.isFinite(target) ? target : parsed.rules.takeProfitPct,
      )
    } catch (error) {
      return c.json({ error: 'invalid_rules', message: error instanceof Error ? error.message : 'Invalid rules payload.' }, 400)
    }
  }
  const connectionId = body.connectionId !== undefined ? (body.connectionId === null ? null : String(body.connectionId)) : bot.connectionId

  // Diff the applied settings against what was stored so the event stream
  // shows config changes — "timeframe 1h → 4h, risk 25% → 30%" — not just
  // trades. Only real changes are logged.
  const changes: string[] = []
  if (name !== bot.name) changes.push(`name → "${name}"`)
  if (stage !== bot.stage) changes.push(`stage ${bot.stage} → ${stage}`)
  if (timeframe !== bot.timeframe) changes.push(`timeframe ${bot.timeframe} → ${timeframe}`)
  if (riskPct !== bot.riskPct) changes.push(`risk ${bot.riskPct}% → ${riskPct}%`)
  if (JSON.stringify(symbols) !== JSON.stringify(bot.symbols)) changes.push(`symbols ${bot.symbols.join(', ')} → ${symbols.join(', ')}`)
  if (connectionId !== bot.connectionId) changes.push(`connection → ${connectionId ?? 'demo venue'}`)
  if (bot.strategyKey !== 'custom') {
    const paramChanges = Object.keys(params)
      .filter((key) => JSON.stringify(params[key]) !== JSON.stringify(bot.params[key]))
      .map((key) => `${key} ${bot.params[key]} → ${params[key]}`)
    if (paramChanges.length) changes.push(`params: ${paramChanges.join(', ')}`)
  } else if (JSON.stringify(params) !== JSON.stringify(bot.params)) {
    const customChanges: string[] = []
    if (params.stopLossPct !== bot.params.stopLossPct) customChanges.push(`stop ${bot.params.stopLossPct}% → ${params.stopLossPct}%`)
    if (params.takeProfitPct !== bot.params.takeProfitPct) customChanges.push(`target ${bot.params.takeProfitPct}% → ${params.takeProfitPct}%`)
    if (JSON.stringify(params.rules) !== JSON.stringify(bot.params.rules)) customChanges.push('rule thresholds retuned')
    if (customChanges.length) changes.push(`params: ${customChanges.join(', ')}`)
  }

  await db
    .prepare(
      `UPDATE bots SET name = ?, stage = ?, position = ?, symbols = ?, timeframe = ?, risk_pct = ?, params = ?, connection_id = ?, updated_at = ?
       WHERE id = ? AND owner_sub = ?`,
    )
    .bind(
      name,
      stage,
      position,
      JSON.stringify(symbols),
      timeframe,
      riskPct,
      JSON.stringify(params),
      connectionId,
      now(),
      botId,
      owner,
    )
    .run()

  if (changes.length) {
    await logEvent(db, owner, botId, 'info', `Settings edited — ${changes.join('; ')}`.slice(0, 500))
  }

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
  if (!['start', 'pause', 'stop', 'ground', 'resume'].includes(String(action))) {
    return c.json({ error: 'unknown_action', message: 'Use start, pause, stop, ground or resume.' }, 400)
  }

  const t = now()
  // Ground/resume are the operator's blunt control: grounding stops the bot
  // (it holds its book and opens nothing until resumed); resuming starts it
  // again. Aliases of stop/start with their own vocabulary in the event log.
  const status: BotStatus = action === 'start' || action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'stopped'
  // The transition guard lives in the WHERE clause, not in a comparison
  // against the row we loaded above: a double-click races two requests that
  // both read the old status, and only a conditional write tells us which
  // one actually moved the row — so exactly one of them logs the event.
  const moved = await db
    .prepare(`UPDATE bots SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND owner_sub = ? AND status != ?`)
    .bind(status, t, t, botId, owner, status)
    .run()
  if (moved.meta.changes) {
    const controlEvent =
      action === 'ground'
        ? 'Grounded by operator — no new trades until resumed.'
        : action === 'resume'
          ? 'Resumed by operator — trading again.'
          : `${status === 'running' ? 'Started' : status === 'paused' ? 'Paused' : 'Stopped'} by operator.`
    await logEvent(db, owner, botId, 'info', controlEvent)
  }

  let updated = (await loadBot(db, owner, botId)) ?? bot
  if (status === 'running') {
    await advanceBot(db, owner, updated)
    updated = (await loadBot(db, owner, botId)) ?? updated
  }
  return privateJson(c, { bot: withStrategy(updated) })
})

interface FundingBody {
  amount?: number
  note?: string
}

/** Operator cash flow: deposit (positive) or withdrawal (negative). Funding
 * moves cash, equity and capital together, so recorded trading P&L —
 * equity − capital — never changes; net_deposits carries the signed total so
 * the portfolio can reconcile equity against real-world cash movement. */
bots.post('/:id/cashflow', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const botId = c.req.param('id')
  const body = await c.req.json<FundingBody>()
  const amount = Math.round(Number(body.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10_000_000) {
    return c.json({ error: 'invalid_amount', message: 'Enter a non-zero amount below $10,000,000.' }, 400)
  }

  const bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)
  if (amount < 0 && -amount > bot.cash + 1e-6) {
    return c.json(
      { error: 'insufficient_cash', message: `Withdrawal exceeds the bot's idle cash ($${bot.cash.toFixed(2)}) — close positions first.` },
      400,
    )
  }

  const t = now()
  await db.batch([
    db
      .prepare(
        `UPDATE bots SET cash = cash + ?, equity = equity + ?, capital = capital + ?, net_deposits = net_deposits + ?, updated_at = ?
         WHERE id = ? AND owner_sub = ?`,
      )
      .bind(amount, amount, amount, amount, t, botId, owner),
    db
      .prepare(`INSERT INTO cashflows (id, owner_sub, bot_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id(), owner, botId, amount, body.note?.trim().slice(0, 120) || null, t),
  ])
  const abs = Math.abs(amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  await logEvent(db, owner, botId, 'info', amount > 0 ? `Operator deposited ${abs}.` : `Operator withdrew ${abs}.`)

  const updated = await loadBot(db, owner, botId)
  return privateJson(c, { bot: updated ? withStrategy(updated) : null })
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
    db.prepare(`DELETE FROM cashflows WHERE bot_id = ?`).bind(botId),
  ])
  return privateJson(c, { ok: true })
})
