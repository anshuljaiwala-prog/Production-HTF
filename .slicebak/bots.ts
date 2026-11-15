import { Hono } from 'hono'

import { privateJson } from '../auth'
import { createBot, id, loadBot, loadBots, logEvent, mapEvent, mapPosition, mapTrade, now, validateSpec } from '../db'
import type { CreateBody } from '../db'
import type { AppContext } from '../env'
import { advanceBot, fastForwardFleet } from '../engine'
import { TIMEFRAME_MS, barsBetween, normalizeSymbol, quote } from '../market'
import { runTraining, scheduleBacktest } from '../backtest'
import { insertDemoBots } from '../seed'
import { STRATEGIES, measureAccuracy, parseRules, rulesToParams, sanitizeParams, strategyBy } from '../strategies'
import { MAX_BOT_VENUES, MAX_TRACKED_SYMBOLS } from '../../shared/types'
import type { Bot, BotStage, BotStatus, BotVenue, CustomRules, Timeframe } from '../../shared/types'

type Row = Record<string, unknown>

export const bots = new Hono<AppContext>()

const MAX_SYMBOLS = MAX_TRACKED_SYMBOLS

type VenueMap = Map<string, BotVenue>

/** Every saved venue in the workspace, so bots can name the exchanges they
 * route through without a join per bot. */
async function loadVenueMap(db: D1Database, owner: string): Promise<VenueMap> {
  const result = await db
    .prepare(`SELECT id, name, exchange, environment FROM connections WHERE owner_sub = ?`)
    .bind(owner)
    .all<Row>()
  return new Map(
    (result.results ?? []).map((row) => [
      String(row.id),
      {
        connectionId: String(row.id),
        name: String(row.name),
        exchange: String(row.exchange),
        environment: String(row.environment ?? '') === 'sandbox' ? 'sandbox' : 'production',
      },
    ]),
  )
}

/** Resolve a bot's venue ids into the display rows the UI renders. */
function withVenues(bot: Bot, map: VenueMap): Bot {
  return { ...bot, venues: bot.venueIds.map((id) => map.get(id)).filter((venue): venue is BotVenue => Boolean(venue)) }
}

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

bots.get('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const items = await fastForwardFleet(db, owner, c.env.SECRETS_KEY)
  const venues = await loadVenueMap(db, owner)
  return privateJson(c, { items: items.map((bot) => withStrategy(withVenues(bot, venues))), strategies: STRATEGIES })
})


bots.post('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<CreateBody>()
  const result = await createBot(db, owner, body)
  if (result.error) return c.json({ error: result.error, message: result.message }, 400)
  return privateJson(c, { bot: withStrategy(withVenues(result.bot!, await loadVenueMap(db, owner))) }, 201)
})

/** Bulk bot config import — the direct JSON-payload upload path. Accepts
 * `{ items: [...] }` (or `{ bots: [...] }`) where each row may carry inline
 * `rules` (uploaded strategy) and a `connectionId` (which API the bot routes
 * through), plus an intent: what the batch is for.
 *
 * Every intent — live, backtest, train — creates the bot through the same
 * `createBot` used by single live launch, so uploaded configs are validated,
 * named, evented and stored identically no matter where they are going.
 * `live` launches them paused (operator review before trading), while
 * `backtest` and `train` queue a run from the bot's exact config through the
 * same scheduling/training functions the interactive pages use. With
 * `?validate=1` nothing is created and every row's rejection reason comes
 * back for a preview. */
export type ImportIntent = 'live' | 'backtest' | 'train'
const MAX_IMPORT = 25
/** A repo file is a bot config, not a data dump; refuse the obvious mistake. */
const MAX_REPO_BYTES = 256 * 1024

interface QueueSummary {
  queued: number
  errors: string[]
  /** Train intent: per-bot sweep summaries (no curves). */
  training: { botId: string; botName: string; swept: string | null; combos: number; bestTrain: number | null; bestTest: number | null; error: string | null }[]
  /** Backtest intent: queued run names, for the success toast. */
  backtests: { id: string; name: string }[]
}

/** Queue the intent's run from a freshly created (paused) bot. Custom bots
 * pass their stored rules payload; catalog bots pass their params. */
async function queueRunForBot(db: D1Database, owner: string, intent: 'backtest' | 'train', bot: Bot, summary: QueueSummary): Promise<void> {
  let rules: CustomRules | undefined
  if (bot.strategyKey === 'custom') {
    try {
      rules = (JSON.parse(String(bot.params.rules ?? '')) as { rules: CustomRules }).rules
    } catch {
      summary.errors.push(`${bot.name}: stored rules payload is unreadable — config saved, run not queued`)
      return
    }
  }
  if (intent === 'backtest') {
    const result = await scheduleBacktest(db, owner, {
      strategyKey: bot.strategyKey,
      symbol: bot.symbols[0],
      timeframe: bot.timeframe,
      capital: bot.capital,
      name: bot.name,
      ...(rules !== undefined ? { rules } : { params: bot.params }),
    })
    if ('error' in result) {
      summary.errors.push(`${bot.name}: ${result.message}`)
      return
    }
    summary.queued++
    summary.backtests.push({ id: result.backtest.id, name: result.backtest.name })
    await logEvent(db, owner, bot.id, 'info', `Backtest queued from the uploaded config — replaying history when the batch finishes ingesting.`)
    return
  }
  const training = await runTraining(db, owner, {
    strategyKey: bot.strategyKey,
    symbol: bot.symbols[0],
    capital: bot.capital,
    autoSweep: true,
    slim: true,
    ...(rules !== undefined ? { rules } : { params: bot.params }),
  })
  if ('error' in training) {
    summary.errors.push(`${bot.name}: ${training.message}`)
    return
  }
  const best = training.runs[training.bestIndex]
  const summaryRow = {
    botId: bot.id,
    botName: bot.name,
    swept: training.knobs[0]?.label ?? null,
    combos: training.runs.length,
    bestTrain: best && !best.error && best.train ? best.train.totalReturn : null,
    bestTest: best && !best.error && best.test ? best.test.totalReturn : null,
    error: best?.error ?? null,
  }
  summary.training.push(summaryRow)
  summary.queued++
  await logEvent(
    db,
    owner,
    bot.id,
    'info',
    `Training sweep run from the uploaded config — ${summaryRow.combos} combinations on ${training.knobs[0]?.label ?? 'no knobs'}, best in-window ${Number.isFinite(summaryRow.bestTrain) ? (summaryRow.bestTrain as number).toFixed(1) : '?'}%.`,
  )
}

/** The rows an uploaded payload carries: a bare array, or `items`/`bots` on an object. */
function botRowsFrom(payload: unknown): CreateBody[] {
  if (Array.isArray(payload)) return payload as CreateBody[]
  if (payload && typeof payload === 'object') {
    const rows = payload as { items?: unknown; bots?: unknown }
    if (Array.isArray(rows.items)) return rows.items as CreateBody[]
    if (Array.isArray(rows.bots)) return rows.bots as CreateBody[]
  }
  return []
}

/** Create one bot per config, parked the way its intent asks, and queue the
 * runs that intent wants. The file upload and the repo import both land here
 * so the two entry points validate and behave alike. */
async function importRows(db: D1Database, owner: string, items: CreateBody[], intent: ImportIntent) {
  const launched: Bot[] = []
  const failed: { name: string; error: string }[] = []
  const venues = await loadVenueMap(db, owner)
  const runs: QueueSummary = { queued: 0, errors: [], training: [], backtests: [] }
  for (const [index, item] of items.entries()) {
    // Non-live intents run off simulation money, not the operator's wallet:
    // park the row as paper so a live-mode row can still be imported for
    // backtesting without pretending it will ever route to an exchange.
    const parkingMode = intent === 'live' ? item.mode : 'paper'
    const label = item.name?.trim() || item.symbols?.filter(Boolean).join(', ') || `Import ${index + 1}`
    const result = await createBot(db, owner, { ...item, mode: parkingMode, status: 'paused' })
    if (result.bot) launched.push(withStrategy(withVenues(result.bot, venues)))
    else {
      failed.push({ name: label, error: result.message ?? 'Invalid config.' })
      continue
    }
    if (intent !== 'live') await queueRunForBot(db, owner, intent, result.bot, runs)
  }
  return { launched, failed, runs }
}
bots.post('/import', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const validateOnly = c.req.query('validate') === '1'
  const body = await c.req.json<{ items?: CreateBody[]; bots?: CreateBody[]; intent?: ImportIntent }>()
  const intent = body.intent === 'backtest' || body.intent === 'train' ? body.intent : 'live'
  const rawItems = botRowsFrom(body)
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

  const { launched, failed, runs } = await importRows(db, owner, items, intent)
  return privateJson(c, { launched, failed, intent, runs })
})


/** A pasted repo link, reduced to the raw file behind it. Only github.com and
 * raw.githubusercontent.com are fetched: the operator supplies this URL, so
 * the worker must never be pointed at an arbitrary host. */
function repoFileUrl(input: string): URL | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.hostname === 'raw.githubusercontent.com') return url
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  // What the browser address bar shows is the blob page; the raw host serves
  // the same file without the HTML wrapper.
  const match = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+?)\/?$/.exec(url.pathname)
  if (!match) return null
  return new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`)
}

/** Import one file from a public repo — bot configs, or a row carrying inline
 * rules. One-shot by design: the source is not recorded and nothing re-syncs,
 * so a repo change never silently reconfigures a running bot. */
bots.post('/import/github', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req
    .json<{ url?: string; intent?: ImportIntent }>()
    .catch(() => ({}) as { url?: string; intent?: ImportIntent })
  const intent = body.intent === 'backtest' || body.intent === 'train' ? body.intent : 'live'
  const source = repoFileUrl(body.url ?? '')
  if (!source) {
    return c.json(
      { error: 'bad_source', message: 'Paste a github.com blob link or a raw.githubusercontent.com link to a bot config file.' },
      400,
    )
  }
  let response: Response
  try {
    response = await fetch(source.toString(), { signal: AbortSignal.timeout(10_000) })
  } catch {
    return c.json({ error: 'source_unreachable', message: `Could not reach ${source.hostname}.` }, 502)
  }
  if (!response.ok) {
    return c.json(
      { error: 'source_error', message: `That link returned ${response.status} — check the file exists and the repo is public.` },
      502,
    )
  }
  const text = await response.text()
  if (text.length > MAX_REPO_BYTES) {
    return c.json({ error: 'source_too_large', message: 'That file is larger than a bot config should be (256 KB).' }, 413)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return c.json({ error: 'not_json', message: 'That file is not JSON.' }, 400)
  }
  const items = botRowsFrom(payload).slice(0, MAX_IMPORT)
  if (items.length === 0) {
    return c.json(
      { error: 'nothing_to_import', message: 'No bot configs found — expected an array, or an object with an "items" array.' },
      400,
    )
  }
  const { launched, failed, runs } = await importRows(db, owner, items, intent)
  return privateJson(c, { launched, failed, intent, runs, source: source.toString() })
})
/** Replace the workspace's fleet with the five demo bots (live-mode, paused).
 * Bots and their books are deleted; connections, backtests and strategies are
 * left alone. Seeding never advances a bot, so nothing is ordered. */
bots.post('/demo', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  await db.batch([
    db.prepare(`DELETE FROM bots WHERE owner_sub = ?`).bind(owner),
    db.prepare(`DELETE FROM positions WHERE owner_sub = ?`).bind(owner),
    db.prepare(`DELETE FROM trades WHERE owner_sub = ?`).bind(owner),
    db.prepare(`DELETE FROM bot_events WHERE owner_sub = ?`).bind(owner),
    db.prepare(`DELETE FROM equity_points WHERE owner_sub = ?`).bind(owner),
    db.prepare(`DELETE FROM cashflows WHERE owner_sub = ?`).bind(owner),
  ])
  const [anyVenue, bseVenue] = await Promise.all([
    db.prepare(`SELECT id FROM connections WHERE owner_sub = ? AND exchange != ? ORDER BY created_at DESC LIMIT 1`)
      .bind(owner, 'BSE (via Upstox)')
      .first<{ id: string }>(),
    db.prepare(`SELECT id FROM connections WHERE owner_sub = ? AND exchange = ? LIMIT 1`).bind(owner, 'BSE (via Upstox)').first<{ id: string }>(),
  ])
  await insertDemoBots(db, owner, anyVenue?.id ?? null, Date.now(), bseVenue?.id ?? null)
  const items = await loadBots(db, owner)
  return privateJson(c, { bots: items.length }, 201)
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
    await advanceBot(db, owner, bot, { secretsKey: c.env.SECRETS_KEY })
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
    // Live positions carry the venue mark the engine recorded; paper ones (and
    // rows written before marks existed) fall back to the reference feed.
    const stored = row.mark_price === null || row.mark_price === undefined ? null : Number(row.mark_price)
    const mark = stored !== null && Number.isFinite(stored) && stored > 0 ? stored : quote(String(row.symbol), at)
    marks.set(String(row.symbol), mark)
    return { ...mapPosition(row), markPrice: mark, unrealizedPnl: (mark - Number(row.avg_price)) * Number(row.qty) }
  })
  const mappedEquity = (equity.results ?? []).map((row) => ({ t: Number(row.at), value: Number(row.value) }))

  let responseBot = withStrategy(withVenues(bot, await loadVenueMap(db, owner)))
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
    /** Entries the strategy is less sure about than this are skipped, 0–100. */
    minConfidencePct?: number
    /** Skip entries while the focus market's volPct is above this; 0 is none. */
    maxVolatilityPct?: number
    params?: Record<string, unknown>
    connectionId?: string | null
    /** Replace the routable venue set (primary first). */
    venueIds?: string[]
    /** Operator capital edit, treated as funding (see below). */
    capital?: number
    /** Switch execution venue: paper (simulated wallet) ↔ live (exchange APIs). */
    mode?: 'paper' | 'live'
  }>()
  const bot = await loadBot(db, owner, botId)
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)
  // Run-state belongs to the control endpoint, not PATCH: a caller sending
  // `status` here gets a clear rejection instead of a silent 200 that changed
  // nothing.
  if ('status' in body) {
    return c.json({ error: 'use_control', message: 'Start, pause, ground and stop go through POST /api/bots/:id/control.' }, 400)
  }

  // Capital is funding, not a trading setting: the delta moves cash, equity,
  // capital and net deposits together, so recorded trading P&L (equity minus
  // capital) never changes. It is handled before the active-bot gate because
  // deposits are allowed on a running bot too.
  let capitalChange: { delta: number; next: number } | null = null
  if (body.capital !== undefined) {
    const next = Math.round(Number(body.capital) * 100) / 100
    if (!Number.isFinite(next) || next < 100) {
      return c.json({ error: 'invalid_capital', message: 'Starting capital must be at least $100.' }, 400)
    }
    if (next > 10_000_000) {
      return c.json({ error: 'invalid_capital', message: 'Starting capital must be below $10,000,000.' }, 400)
    }
    const delta = Math.round((next - bot.capital) * 100) / 100
    if (Math.abs(delta) >= 0.01) {
      if (delta < 0 && -delta > bot.cash + 1e-6) {
        return c.json(
          {
            error: 'insufficient_cash',
            message: `Lowering capital by $${(-delta).toFixed(2)} needs that much idle cash — this bot holds $${bot.cash.toFixed(2)}. Close positions or withdraw less.`,
          },
          400,
        )
      }
      capitalChange = { delta, next }
    }
  }

  // Trading settings — and a paper↔live venue switch — are only editable
  // while the bot is not active: pause or stop it first so what it decides on
  // never changes mid-run and a trade is never split across venues.
  const modeChange = body.mode !== undefined && body.mode !== bot.mode ? (body.mode === 'live' ? 'live' : 'paper') : null
  const wantsTradingSettings =
    body.symbols !== undefined || body.timeframe !== undefined || body.riskPct !== undefined || body.minConfidencePct !== undefined || body.maxVolatilityPct !== undefined || body.params !== undefined || body.connectionId !== undefined || body.venueIds !== undefined || modeChange !== null
  if (wantsTradingSettings && bot.status === 'running') {
    return c.json({ error: 'bot_active', message: 'Pause or ground this bot before changing its trading settings or venue.' }, 409)
  }

  const stage =
    modeChange
      ? // A venue switch keeps the lifecycle convention: stage follows the
        // mode while it is one of the auto-assigned ones, but an operator's
        // hand-set draft/backtest stage is preserved.
        bot.stage === 'paper' || bot.stage === 'live'
        ? modeChange
        : bot.stage
      : body.stage && ['draft', 'backtest', 'paper', 'live'].includes(body.stage)
        ? body.stage
        : bot.stage
  const name = body.name ? body.name.trim().slice(0, 90) || bot.name : bot.name
  const position = Number.isFinite(body.position) ? Number(body.position) : bot.position

  // Trading settings: each falls back to the stored value when absent.
  const strategy = strategyBy(bot.strategyKey)
  // Same ingress filter as creation: normalize, then refuse a payload whose
  // symbols all fail to resolve instead of parking garbage on the bot.
  let patchedSymbols = bot.symbols
  if (body.symbols !== undefined) {
    const normalized = [...new Set((body.symbols ?? []).map((s) => normalizeSymbol(String(s))).filter((s): s is string => Boolean(s)))].slice(0, MAX_SYMBOLS)
    if (normalized.length === 0) return c.json({ error: 'unknown_symbols', message: 'None of these symbols resolve to a catalog entry — try BTC-USD or EUR-USD.' }, 400)
    patchedSymbols = normalized
  }
  const symbols = patchedSymbols
  const timeframe = body.timeframe !== undefined && strategy?.timeframes.includes(body.timeframe) ? body.timeframe : bot.timeframe
  const riskPct = Number.isFinite(Number(body.riskPct)) && body.riskPct !== undefined ? Math.min(100, Math.max(1, Number(body.riskPct))) : bot.riskPct
  // 0 is a real setting (no floor), unlike risk where the minimum is 1.
  const minConfidencePct = body.minConfidencePct !== undefined && Number.isFinite(Number(body.minConfidencePct)) ? Math.min(100, Math.max(0, Number(body.minConfidencePct))) : bot.minConfidencePct
  const maxVolatilityPct = body.maxVolatilityPct !== undefined && Number.isFinite(Number(body.maxVolatilityPct)) ? Math.min(100, Math.max(0, Number(body.maxVolatilityPct))) : bot.maxVolatilityPct
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
  // Venue set: an explicit list replaces the stored one; a bare connectionId
  // keeps its older meaning (that venue becomes the primary). Every id must
  // be a real connection this workspace owns — a bot that receives a forged
  // id must be caught here instead of routing live orders into a void.
  let venueIds = bot.venueIds
  if (body.venueIds !== undefined || body.connectionId !== undefined) {
    const requested = body.venueIds !== undefined ? body.venueIds : body.connectionId ? [String(body.connectionId)] : []
    const resolved: string[] = []
    for (const entry of requested) {
      const venueId = String(entry ?? '').trim()
      if (!venueId || resolved.includes(venueId)) continue
      const conn = await db.prepare(`SELECT id FROM connections WHERE id = ? AND owner_sub = ?`).bind(venueId, owner).first<Row>()
      if (!conn) {
        return c.json({ error: 'connection_missing', message: 'That exchange connection no longer exists in this workspace — reconnect the bot on the Connections page.' }, 400)
      }
      resolved.push(String(conn.id))
    }
    if (resolved.length > MAX_BOT_VENUES) {
      return c.json({ error: 'too_many_venues', message: `A bot routes across up to ${MAX_BOT_VENUES} exchanges — remove ${resolved.length - MAX_BOT_VENUES}.` }, 400)
    }
    venueIds = resolved
  }
  const connectionId = venueIds[0] ?? null
  const mode: 'paper' | 'live' = modeChange ?? bot.mode
  // Going live requires an exchange API: refuse to flip a venue-less bot into
  // execution where it would have nowhere to route orders.
  if (mode === 'live' && venueIds.length === 0) {
    return c.json({ error: 'connection_required', message: 'Connect an exchange API to this bot before switching it to live trading.' }, 400)
  }

  // Diff the applied settings against what was stored so the event stream
  // shows config changes — "timeframe 1h → 4h, risk 25% → 30%" — not just
  // trades. Only real changes are logged.
  const changes: string[] = []
  if (name !== bot.name) changes.push(`name → "${name}"`)
  if (stage !== bot.stage) changes.push(`stage ${bot.stage} → ${stage}`)
  if (mode !== bot.mode) changes.push(`trading mode ${bot.mode} → ${mode} — order routing now ${mode === 'live' ? 'the exchange API' : 'the simulated wallet'}`)
  if (timeframe !== bot.timeframe) changes.push(`timeframe ${bot.timeframe} → ${timeframe}`)
  if (riskPct !== bot.riskPct) changes.push(`risk ${bot.riskPct}% → ${riskPct}%`)
  if (minConfidencePct !== bot.minConfidencePct) changes.push(`confidence floor ${bot.minConfidencePct}% → ${minConfidencePct}%`)
  if (maxVolatilityPct !== bot.maxVolatilityPct) changes.push(`volatility ceiling ${bot.maxVolatilityPct}% → ${maxVolatilityPct}%`)
  if (JSON.stringify(symbols) !== JSON.stringify(bot.symbols)) changes.push(`symbols ${bot.symbols.join(', ')} → ${symbols.join(', ')}`)
  if (JSON.stringify(venueIds) !== JSON.stringify(bot.venueIds)) {
    const venues = await loadVenueMap(db, owner)
    changes.push(`venues → ${venueIds.map((id) => venues.get(id)?.name ?? id).join(', ') || 'none'}`)
  }
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
      `UPDATE bots SET name = ?, stage = ?, position = ?, symbols = ?, timeframe = ?, risk_pct = ?, min_confidence_pct = ?, max_volatility_pct = ?, params = ?, connection_id = ?, venue_ids = ?, mode = ?, updated_at = ?
       WHERE id = ? AND owner_sub = ?`,
    )
    .bind(
      name,
      stage,
      position,
      JSON.stringify(symbols),
      timeframe,
      riskPct,
      minConfidencePct,
      maxVolatilityPct,
      JSON.stringify(params),
      connectionId,
      JSON.stringify(venueIds),
      mode,
      now(),
      botId,
      owner,
    )
    .run()

  if (capitalChange) {
    const t = now()
    await db.batch([
      db
        .prepare(
          `UPDATE bots SET capital = ?, cash = cash + ?, equity = equity + ?, net_deposits = net_deposits + ?, updated_at = ?
           WHERE id = ? AND owner_sub = ?`,
        )
        .bind(capitalChange.next, capitalChange.delta, capitalChange.delta, capitalChange.delta, t, botId, owner),
      db
        .prepare(`INSERT INTO cashflows (id, owner_sub, bot_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id(), owner, botId, capitalChange.delta, `Operator set starting capital to $${capitalChange.next.toFixed(2)}`, t),
    ])
    const abs = Math.abs(capitalChange.delta).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    await logEvent(
      db,
      owner,
      botId,
      'info',
      `Starting capital set to $${capitalChange.next.toFixed(2)} — ${capitalChange.delta > 0 ? 'topped up' : 'reduced'} by ${abs} as funding, so trading P&L is unchanged.`,
    )
  }

  if (changes.length) {
    await logEvent(db, owner, botId, 'info', `Settings edited — ${changes.join('; ')}`.slice(0, 500))
  }

  const updated = await loadBot(db, owner, botId)
  return privateJson(c, { bot: updated ? withStrategy(withVenues(updated, await loadVenueMap(db, owner))) : null })
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
    await advanceBot(db, owner, updated, { secretsKey: c.env.SECRETS_KEY })
    updated = (await loadBot(db, owner, botId)) ?? updated
  }
  return privateJson(c, { bot: withStrategy(withVenues(updated, await loadVenueMap(db, owner))) })
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
  return privateJson(c, { bot: updated ? withStrategy(withVenues(updated, await loadVenueMap(db, owner))) : null })
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
