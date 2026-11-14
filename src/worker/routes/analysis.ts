import { Hono } from 'hono'

import { privateJson } from '../auth'
import { BOT_SELECT, loadBots, mapBot, now } from '../db'
import type { AppContext } from '../env'
import { analyseBotPatterns, rankFleetPatterns } from '../patterns'
import { evaluateGate, readEnvironment } from '../agents/environment'
import { readEnvironmentState, writeEnvironmentControls } from '../agents/environment-do'
import { MACRO_BARS, MACRO_TIMEFRAME, macroBarsAt } from '../agents/harvester'
import { readCalibration, readDecisionTraces } from '../agents/trace'
import { TIMEFRAME_MS, barsBetween, normalizeSymbol } from '../market'
import { barsForRun } from '../marketstore'
import type { BotPatterns, EnvironmentTrace, FleetPatternRanking } from '../../shared/types'

type Row = Record<string, unknown>

export const analysis = new Hono<AppContext>()

/**
 * The agent shell's environment read (ported from market_agent_env): macro
 * breadth across the tracked world markets, the tape events pinned as news, the
 * forward-chaining inferences they fire, and the gate's verdict for the macro
 * view. Read-only and deterministic for a given clock; the engine calls the
 * same functions before each pass, so this is the read that gated it.
 * `?symbol=` focuses the advisory half and is validated like every other
 * symbol ingress — off-catalog values are rejected, not read as fiction.
 *
 * GET /api/analysis/agents?symbol=NVDA
 */
analysis.get('/agents', async (c) => {
  const requested = c.req.query('symbol')
  const focus = requested ? normalizeSymbol(requested) : null
  if (requested && !focus) {
    return c.json({ error: 'unknown_symbol', message: `"${requested}" does not resolve to a catalog symbol.` }, 400)
  }

  const at = now()
  const read = readEnvironment({
    at,
    macroBars: macroBarsAt(at),
    ...(focus
      ? {
          focus: {
            symbol: focus,
            bars:
              (await barsForRun(c.get('db'), focus, MACRO_TIMEFRAME, at - MACRO_BARS * TIMEFRAME_MS[MACRO_TIMEFRAME], at)) ??
              barsBetween(focus, MACRO_TIMEFRAME, at - MACRO_BARS * TIMEFRAME_MS[MACRO_TIMEFRAME], at),
          },
        }
      : {}),
  })
  return privateJson(c, { ...read, gate: evaluateGate(read, focus ? [focus] : []) })
})

/**
 * The live environment: the Durable Object's held state — pins with when they
 * were first and last seen, the operator's kill-switches, and the last read.
 * `?symbol=` focuses the company half (ownership, specialists, next move) and
 * is validated like every other symbol ingress.
 *
 * GET /api/analysis/environment?symbol=NVDA
 */
analysis.get('/environment', async (c) => {
  const requested = c.req.query('symbol')
  const focus = requested ? normalizeSymbol(requested) : null
  if (requested && !focus) {
    return c.json({ error: 'unknown_symbol', message: `"${requested}" does not resolve to a catalog symbol.` }, 400)
  }
  const state = await readEnvironmentState(c.env, c.get('user').sub, focus)
  if (!state) {
    return c.json(
      { error: 'environment_unavailable', message: 'The live environment is not provisioned on this deployment.' },
      503,
    )
  }
  return privateJson(c, state)
})

/**
 * What the engine recorded per closed bar, and how the move probability has
 * scored so far. `?bot=` narrows the timeline to one bot; `?symbol=` narrows
 * the calibration to one ticker.
 *
 * GET /api/analysis/environment/trace?bot=&symbol=
 */
analysis.get('/environment/trace', async (c) => {
  const requested = c.req.query('symbol')
  const symbol = requested ? normalizeSymbol(requested) : null
  if (requested && !symbol) {
    return c.json({ error: 'unknown_symbol', message: `"${requested}" does not resolve to a catalog symbol.` }, 400)
  }
  const db = c.get('db')
  const owner = c.get('user').sub
  const botId = c.req.query('bot') || null
  const payload: EnvironmentTrace = {
    traces: await readDecisionTraces(db, owner, botId),
    calibration: await readCalibration(db, owner, symbol),
  }
  return privateJson(c, payload)
})

/**
 * Operator kill-switches, held by the environment and mirrored to the engine's
 * projection. `paused` freezes every book where it stands; `pauseBuys` stops
 * new entries only, so exits and stops still run.
 *
 * PATCH /api/analysis/environment/controls
 */
analysis.patch('/environment/controls', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || (typeof body.paused !== 'boolean' && typeof body.pauseBuys !== 'boolean')) {
    return c.json({ error: 'invalid_controls', message: 'Send `paused` and/or `pauseBuys` as booleans.' }, 400)
  }
  const controls = await writeEnvironmentControls(c.env, c.get('db'), c.get('user').sub, {
    ...(typeof body.paused === 'boolean' ? { paused: body.paused } : {}),
    ...(typeof body.pauseBuys === 'boolean' ? { pauseBuys: body.pauseBuys } : {}),
  })
  return privateJson(c, { controls })
})

/**
 * Fleet-wide pattern ranking: every bot scored on the strongest crash, hype or
 * squeeze read among the markets it tracks, strongest first. Same classifier
 * as the per-bot scan, one shared bar read per symbol+timeframe, so the
 * ranking compares bots on identical data.
 *
 * GET /api/analysis/patterns
 */
analysis.get('/patterns', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const bots = await loadBots(db, owner)
  const ranking: FleetPatternRanking = await rankFleetPatterns(db, bots, now())
  return privateJson(c, ranking)
})

/**
 * Pattern scan for one bot: every symbol it tracks read as a regime (crash,
 * hype, breakout, squeeze…) with the numbers behind the call, scored against
 * the largest historic crashes and hypes, and linked to what the market is
 * doing right now. All of it comes from the same stored feed the engine
 * replays, so the scan describes the bars the bot actually traded.
 *
 * GET /api/analysis/bots/:id/patterns
 */
analysis.get('/bots/:id/patterns', async (c) => {
  const botId = c.req.param('id')
  const db = c.get('db')
  const owner = c.get('user').sub
  const row = await db
    .prepare(`${BOT_SELECT} WHERE b.id = ? AND b.owner_sub = ?`)
    .bind(botId, owner)
    .first<Row>()
  if (!row) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404)

  const bot = mapBot(row)
  const patterns: BotPatterns = await analyseBotPatterns(db, bot, now())
  return privateJson(c, patterns)
})
