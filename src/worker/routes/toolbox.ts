import { Hono } from 'hono'

import { privateJson } from '../auth'
import { id, logEvent, now } from '../db'
import type { AppContext } from '../env'
import { barsBetween, normalizeSymbol } from '../market'
import { analyseBotPatterns } from '../patterns'
import { BUILTIN_PLAYBOOK_MAP, BUILTIN_PLAYBOOKS, BOOK_REGIMES, DEFAULT_BOOK, isBookRegime, validatePlanDraft } from '../plans'
import { strategyBy } from '../strategies'
import { createBot } from './bots'
import { loadBots } from './workspace'
import type { BookEntry, BookSignal, ParamValue, PatternRegime, Playbook, ToolBox } from '../../shared/types'

type Row = Record<string, unknown>

/** The tool box (execution plans) and the strategy book (regime → plan
 * registry with live signals) share one route module: the book only makes
 * sense against plans the box holds, and executing a plan needs the book.
 *
 * GET    /api/toolbox         — builtin + custom plans
 * POST   /api/toolbox         — draft a custom plan (validated like a launch)
 * DELETE /api/toolbox/:id     — remove a custom plan (builtins are code)
 * GET    /api/book            — every regime's assigned plan, defaults stubbed in
 * PUT    /api/book            — assign a plan to a regime (upsert)
 * DELETE /api/book/:regime    — clear an assignment (regime falls back to builtin default)
 * GET    /api/book/signals    — recognised patterns that a book plan would trade, executable
 * POST   /api/book/execute    — execute a plan onto a fresh wallet or a bot's capital
 *
 * Both routers are mounted in `src/worker/index.ts` behind the same auth +
 * database gate as every other API route.
 */

export const toolbox = new Hono<AppContext>()

export function mapPlaybook(row: Row): Playbook {
  return {
    id: String(row.id),
    name: String(row.name),
    regime: String(row.regime) as PatternRegime,
    strategyKey: String(row.strategy_key),
    params: safeParams(row.params),
    timeframe: (row.timeframe as string | null) as Playbook['timeframe'],
    riskPct: Number(row.risk_pct ?? 25),
    note: String(row.note ?? ''),
    source: 'custom',
    createdAt: Number(row.created_at),
  }
}

function safeParams(value: unknown): Record<string, ParamValue> {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as Record<string, ParamValue>) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    /* fall through to the default */
  }
  return {}
}

/** Resolve one playbook id across builtin code and custom rows, scoped to
 * the owner. A deleted custom plan resolves to null instead of crashing —
 * callers fall back to the regime's builtin default when that happens. */
async function resolvePlaybook(db: D1Database, owner: string, playbookId: string): Promise<Playbook | null> {
  const builtin = BUILTIN_PLAYBOOK_MAP.get(playbookId)
  if (builtin) return builtin
  const row = await db
    .prepare(`SELECT * FROM custom_playbooks WHERE id = ? AND owner_sub = ?`)
    .bind(playbookId, owner)
    .first<Row>()
  return row ? mapPlaybook(row) : null
}

type PlanPick = { playbook: Playbook } | { error: string; message: string; status: 400 | 404 }

/** Resolve the plan to execute: an explicit `playbookId` wins (it must
 * belong to this workspace), otherwise the regime's authoritative plan from
 * the book. */
async function pickPlan(db: D1Database, owner: string, body: { playbookId?: unknown; regime?: unknown }): Promise<PlanPick> {
  if (body.playbookId !== undefined && body.playbookId !== null) {
    const playbookId = String(body.playbookId)
    const playbook = await resolvePlaybook(db, owner, playbookId)
    if (!playbook) return { error: 'unknown_plan', message: 'No such plan in the tool box.', status: 404 }
    return { playbook }
  }
  const regime = String(body.regime ?? '')
  if (!isBookRegime(regime)) {
    return { error: 'unknown_regime', message: `Pass a regime the book knows: ${BOOK_REGIMES.join(', ')}.`, status: 400 }
  }
  const stored = await db
    .prepare(`SELECT playbook_id FROM book_entries WHERE owner_sub = ? AND regime = ?`)
    .bind(owner, regime)
    .first<Row>()
  const playbook = await resolvePlaybook(db, owner, (stored?.playbook_id as string | undefined) ?? DEFAULT_BOOK[regime])
  if (!playbook) return { error: 'no_plan', message: 'That regime has no executable plan in the book — assign one on the Strategy book tab.', status: 400 }
  return { playbook }
}

toolbox.get('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const customs = await db
    .prepare(`SELECT * FROM custom_playbooks WHERE owner_sub = ? ORDER BY created_at DESC, id`)
    .bind(owner)
    .all<Row>()
  const customRows = (customs.results ?? []) as Row[]
  const assigned = await db
    .prepare(`SELECT regime, playbook_id FROM book_entries WHERE owner_sub = ?`)
    .bind(owner)
    .all<Row>()
  const overrides = new Map(((assigned.results ?? []) as Row[]).map((row) => [String(row.regime), String(row.playbook_id)]))
  // A regime counts as covered when its stored assignment (or the builtin
  // default, with no assignment) resolves to a live plan here — so the box's
  // summary always matches what the book will actually execute.
  const covered = BOOK_REGIMES.filter((regime) => {
    const playbookId = overrides.get(regime) ?? DEFAULT_BOOK[regime]
    return BUILTIN_PLAYBOOK_MAP.has(playbookId) || customRows.some((row) => String(row.id) === playbookId)
  }).length
  const body: ToolBox = { items: [...BUILTIN_PLAYBOOKS, ...customRows.map(mapPlaybook)], bookCoverage: covered }
  return privateJson(c, body)
})

toolbox.post('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<Record<string, unknown>>()
  const draft = validatePlanDraft(body)
  if ('error' in draft) return c.json(draft, 400)

  const playbookId = id()
  const plan = draft.plan
  await db
    .prepare(
      `INSERT INTO custom_playbooks (id, owner_sub, name, regime, strategy_key, params, timeframe, risk_pct, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(playbookId, owner, plan.name, plan.regime, plan.strategyKey, JSON.stringify(plan.params), plan.timeframe, plan.riskPct, plan.note, now())
    .run()

  const row = await db.prepare(`SELECT * FROM custom_playbooks WHERE id = ?`).bind(playbookId).first<Row>()
  return privateJson(c, { playbook: row ? mapPlaybook(row) : null }, 201)
})

toolbox.delete('/:id', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const playbookId = c.req.param('id')
  if (BUILTIN_PLAYBOOK_MAP.has(playbookId)) {
    return c.json(
      { error: 'builtin_plan', message: 'Builtin plans are part of the product — save a copy as a custom plan and edit that instead.' },
      400,
    )
  }
  const result = await db
    .prepare(`DELETE FROM custom_playbooks WHERE id = ? AND owner_sub = ?`)
    .bind(playbookId, owner)
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found', message: 'Plan not found.' }, 404)
  // A book assignment pointing at the deleted plan would read as the dead
  // plan forever — clear it so the regime falls back to its builtin default.
  await db.prepare(`DELETE FROM book_entries WHERE owner_sub = ? AND playbook_id = ?`).bind(owner, playbookId).run()
  return privateJson(c, { ok: true })
})

// --- Strategy book -----------------------------------------------------------

export const book = new Hono<AppContext>()

/** Every regime in the book, with its assigned plan: the stored assignment
 * when the operator set one, the builtin default otherwise — and the builtin
 * default too, as a fallback, when the stored plan no longer resolves. */
book.get('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const stored = await db
    .prepare(`SELECT regime, playbook_id FROM book_entries WHERE owner_sub = ?`)
    .bind(owner)
    .all<Row>()
  const overrides = new Map(((stored.results ?? []) as Row[]).map((row) => [String(row.regime), String(row.playbook_id)]))
  const resolved = new Map<string, Playbook>()
  for (const playbookId of new Set([...overrides.values(), ...BOOK_REGIMES.map((regime) => DEFAULT_BOOK[regime])])) {
    const playbook = await resolvePlaybook(db, owner, playbookId)
    if (playbook) resolved.set(playbook.id, playbook)
  }
  const items: BookEntry[] = BOOK_REGIMES.map((regime) => {
    const overrideId = overrides.get(regime)
    const playbook = (overrideId && resolved.get(overrideId)) || BUILTIN_PLAYBOOK_MAP.get(DEFAULT_BOOK[regime])!
    return {
      regime,
      playbook,
      strategyName: strategyBy(playbook.strategyKey)?.name ?? playbook.strategyKey,
      overridden: Boolean(overrideId && resolved.has(overrideId)),
    }
  })
  return privateJson(c, { items })
})

/** Assign a plan to a regime — upsert, one plan per regime: the row swaps to
 * the new plan. Clearing (DELETE) hands the regime back to its default. */
book.put('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<{ regime?: unknown; playbookId?: unknown }>()
  const regime = String(body.regime ?? '')
  if (!isBookRegime(regime)) return c.json({ error: 'unknown_regime', message: `Pick one of ${BOOK_REGIMES.join(', ')}.` }, 400)
  const playbookId = String(body.playbookId ?? '')
  const playbook = await resolvePlaybook(db, owner, playbookId)
  if (!playbook) return c.json({ error: 'unknown_plan', message: 'No such plan in the tool box — pick one from the tool box list.' }, 400)

  await db
    .prepare(
      `INSERT INTO book_entries (owner_sub, regime, playbook_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_sub, regime) DO UPDATE SET playbook_id = excluded.playbook_id, updated_at = excluded.updated_at`,
    )
    .bind(owner, regime, playbookId, now())
    .run()
  // No event row here: this is a workspace-level choice, not a bot's — the
  // assignment itself is the record of it.
  return privateJson(c, { ok: true, regime, playbookId })
})

/** Clear the operator's override for one regime: it reads the builtin
 * default from now on. */
book.delete('/:regime', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const regime = c.req.param('regime')
  if (!isBookRegime(regime)) return c.json({ error: 'unknown_regime', message: `Pick one of ${BOOK_REGIMES.join(', ')}.` }, 400)
  const result = await db
    .prepare(`DELETE FROM book_entries WHERE owner_sub = ? AND regime = ?`)
    .bind(owner, regime)
    .run()
  return privateJson(c, { ok: true, cleared: result.meta.changes > 0 })
})

/** Live actionable reads: for every parked bot, each tracked market that the
 * scanner classed into a regime the book answers, where the bot holds no
 * position and is not already running (a running bot executes its own
 * strategy — the book must not fight it). Strongest read first. Bars are
 * cached per symbol+timeframe so the fleet scan costs one read per market. */
book.get('/signals', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const stored = await db
    .prepare(`SELECT regime, playbook_id FROM book_entries WHERE owner_sub = ?`)
    .bind(owner)
    .all<Row>()
  const overrides = new Map(((stored.results ?? []) as Row[]).map((row) => [String(row.regime), String(row.playbook_id)]))
  const bookPlans = new Map<PatternRegime, Playbook>()
  for (const regime of BOOK_REGIMES) {
    const playbook = await resolvePlaybook(db, owner, overrides.get(regime) ?? DEFAULT_BOOK[regime])
    if (playbook) bookPlans.set(regime, playbook)
  }

  const bots = await loadBots(db, owner)
  const barCache = new Map<string, ReturnType<typeof barsBetween>>()
  const signals: BookSignal[] = []
  for (const bot of bots) {
    if (bot.status === 'running') continue
    const read = await analyseBotPatterns(db, bot, now(), barCache)
    for (const pattern of read.symbols) {
      const playbook = bookPlans.get(pattern.regime)
      // A recognized pattern the book can trade: exactly the regime call,
      // no position already held on that market by this bot.
      if (!playbook || playbook.regime !== pattern.regime) continue
      if (pattern.positionQty !== 0) continue
      signals.push({
        botId: bot.id,
        botName: bot.name,
        botStatus: bot.status,
        symbol: pattern.symbol,
        regime: pattern.regime,
        confidence: pattern.confidence,
        playbook,
        strategyName: strategyBy(playbook.strategyKey)?.name ?? playbook.strategyKey,
        botCapital: bot.capital,
        evidence: pattern.evidence,
        price: pattern.price,
        changePct: pattern.changePct,
        drawdownPct: pattern.drawdownPct,
        runupPct: pattern.runupPct,
        spark: pattern.spark,
      })
    }
  }
  signals.sort((a, b) => b.confidence - a.confidence || a.botName.localeCompare(b.botName))
  return privateJson(c, { generatedAt: now(), items: signals.slice(0, 12) })
})

interface ExecuteBody {
  playbookId?: unknown
  regime?: unknown
  symbol?: unknown
  botId?: unknown
  capital?: unknown
}

/** Execute a signal: copy a plan onto a fresh (or inherited) wallet.
 * `botId` inherits that bot's tracked capital; without one `capital` starts
 * a new paper wallet. The bot is created running in paper mode so the
 * engine trades the plan from the next closed bar — the same create path,
 * validation and event log as a manual launch, with the pattern read cited
 * in the log. */
book.post('/execute', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<ExecuteBody>()

  const symbol = normalizeSymbol(String(body.symbol ?? ''))
  if (!symbol) {
    const given = String(body.symbol ?? '').trim()
    return c.json(
      { error: 'unknown_symbols', message: given ? `"${given}" is not a tradeable symbol — try catalog entries like BTC-USD.` : 'Pass a symbol to trade.' },
      400,
    )
  }

  const pick = await pickPlan(db, owner, body)
  if ('error' in pick) return c.json({ error: pick.error, message: pick.message }, pick.status)
  const plan = pick.playbook
  // An explicit regime in the body must agree with the plan that fires —
  // executing a squeeze plan off a crash signal would defeat the book.
  if (body.regime !== undefined && body.regime !== null && String(body.regime) !== plan.regime) {
    return c.json(
      { error: 'plan_regime_mismatch', message: `"${plan.name}" answers the ${plan.regime} regime, not ${String(body.regime)}.` },
      400,
    )
  }

  let capital: number
  if (body.botId !== undefined && body.botId !== null) {
    const botRow = await db
      .prepare(`SELECT * FROM bots WHERE id = ? AND owner_sub = ?`)
      .bind(String(body.botId), owner)
      .first<Row>()
    if (!botRow) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)
    capital = Number(botRow.capital)
  } else {
    capital = Number(body.capital)
    if (!Number.isFinite(capital) || capital < 100) {
      return c.json(
        { error: 'invalid_capital', message: 'Executing a plan needs at least $100 of starting capital — pick a bot to inherit its wallet or set an amount.' },
        400,
      )
    }
  }
  capital = Math.round(capital * 100) / 100

  // One plan per market at a time: a repeated signal or a natural
  // double-click must not stack identical bots onto the same tape.
  const fleet = await loadBots(db, owner)
  const clash = fleet.find(
    (bot) =>
      bot.status === 'running' &&
      bot.symbols.includes(symbol) &&
      bot.name.startsWith(`${plan.name} ·`),
  )
  if (clash) {
    return c.json(
      { error: 'already_executing', message: `"${plan.name}" is already trading ${symbol} — ${clash.name}.` },
      409,
    )
  }

  const strategy = strategyBy(plan.strategyKey)
  const timeframe = plan.timeframe && strategy && strategy.timeframes.includes(plan.timeframe) ? plan.timeframe : undefined
  const created = await createBot(db, owner, {
    name: `${plan.name} · ${symbol}`,
    strategyKey: plan.strategyKey,
    symbols: [symbol],
    timeframe: (timeframe ?? undefined) as never,
    params: plan.params,
    capital,
    riskPct: plan.riskPct,
    mode: 'paper',
    status: 'running',
    stage: 'paper',
  })
  if (created.error) return c.json({ error: created.error, message: created.message }, 400)

  await logEvent(db, owner, created.bot!.id, 'signal', `Strategy book executed "${plan.name}" — ${plan.regime} read on ${symbol}.`)
  return privateJson(
    c,
    {
      bot: created.bot,
      executed: { playbookId: plan.id, plan: plan.name, regime: plan.regime, strategyName: strategy?.name ?? plan.strategyKey, symbol },
    },
    201,
  )
})
