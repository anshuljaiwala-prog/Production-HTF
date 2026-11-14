import { Hono } from 'hono'

import { authMode, privateJson } from '../auth'
import { buildEquitySeries, mapEvent, now } from '../db'
import type { AppContext } from '../env'
import { fastForwardFleet } from '../engine'
import { quote } from '../market'
import { STRATEGIES, strategyBy } from '../strategies'
import { clearWorkspace, seedWorkspace } from '../seed'
import { activityOf, type Dashboard, type Me, type SearchResults } from '../../shared/types'

type Row = Record<string, unknown>

const DAY = 86_400_000
const EQUITY_WINDOW_DAYS = 30

export const workspace = new Hono<AppContext>()

async function ensureWorkspace(db: D1Database, owner: string, name: string) {
  const row = await db.prepare(`SELECT name, seeded_at FROM workspaces WHERE owner_sub = ?`).bind(owner).first<{ name: string; seeded_at: number | null }>()
  if (row) return row
  await db.prepare(`INSERT INTO workspaces (owner_sub, name, created_at) VALUES (?, ?, ?)`).bind(owner, name, now()).run()
  // A brand-new workspace gets sample bots so the product is furnished on first open.
  await seedWorkspace(db, owner)
  return { name, seeded_at: now() }
}

workspace.get('/me', async (c) => {
  const user = c.get('user')
  const db = c.get('db')
  const ws = await ensureWorkspace(db, user.sub, `${user.name?.split(' ')[0] ?? 'Your'}'s desk`)
  const body: Me = {
    user: { sub: user.sub, name: user.name, email: user.email, picture: user.picture },
    workspace: { name: ws.name, seededAt: ws.seeded_at },
    capabilities: {
      database: true,
      files: Boolean(c.env.FILES),
      auth: authMode(c.env, c.req.raw) === 'freebuff' ? 'freebuff' : 'development',
    },
  }
  return privateJson(c, body)
})

workspace.patch('/workspace', async (c) => {
  const { name } = await c.req.json<{ name?: string }>()
  const clean = name?.trim().slice(0, 60)
  if (!clean) return c.json({ error: 'Name is required.' }, 400)
  await c.get('db').prepare(`UPDATE workspaces SET name = ? WHERE owner_sub = ?`).bind(clean, c.get('user').sub).run()
  return privateJson(c, { ok: true })
})

workspace.post('/workspace/reset', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  await clearWorkspace(db, owner)
  await seedWorkspace(db, owner)
  return privateJson(c, { ok: true })
})

workspace.delete('/workspace/data', async (c) => {
  await clearWorkspace(c.get('db'), c.get('user').sub)
  return privateJson(c, { ok: true })
})

workspace.get('/overview', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const t = now()
  const startOfDay = new Date(t)
  startOfDay.setHours(0, 0, 0, 0)
  const dayStart = startOfDay.getTime()
  // The equity window is client-selected: 7d / 30d / 1y. Points are stored at
  // bar cadence, so long windows need a bigger read cap to survive.
  const requested = Number(c.req.query('days') ?? EQUITY_WINDOW_DAYS)
  const windowDays = Math.min(730, Math.max(7, Math.round(Number.isFinite(requested) && requested > 0 ? requested : EQUITY_WINDOW_DAYS)))

  const bots = await fastForwardFleet(db, owner, c.env.SECRETS_KEY)

  const windowStart = startOfDay.getTime() - (windowDays - 1) * DAY
  const [today, positions, stages, events, points] = await db.batch([
    // P&L today is a money-book KPI: paper bots run in the simulated wallet
    // (reported under Backtesting) and never enter the dashboard.
    db.prepare(`SELECT COALESCE(SUM(pnl), 0) AS v FROM trades WHERE owner_sub = ? AND pnl IS NOT NULL AND created_at >= ? AND bot_id IN (SELECT id FROM bots WHERE owner_sub = ? AND mode = 'live')`).bind(owner, dayStart, owner),
    // Open-position marks feed money-book KPIs only — paper holdings stay
    // inside their bots' audit rows.
    db.prepare(`SELECT symbol, qty, avg_price, mark_price FROM positions WHERE owner_sub = ? AND bot_id IN (SELECT id FROM bots WHERE owner_sub = ? AND mode = 'live')`).bind(owner, owner),
    db.prepare(`SELECT stage, COUNT(*) AS n FROM bots WHERE owner_sub = ? AND mode = 'live' GROUP BY stage`).bind(owner),
    db
      .prepare(
        `SELECT e.*, b.name AS bot_name FROM bot_events e JOIN bots b ON b.id = e.bot_id
         WHERE e.owner_sub = ? AND b.mode = 'live' ORDER BY e.created_at DESC, e.id DESC LIMIT 12`,
      )
      .bind(owner),
    db
      .prepare(
        `SELECT bot_id, at, value FROM equity_points WHERE owner_sub = ? AND at >= ?
           AND bot_id IN (SELECT id FROM bots WHERE owner_sub = ? AND mode = 'live') ORDER BY at ASC LIMIT ${windowDays > EQUITY_WINDOW_DAYS ? 12_000 : 4_000}`,
      )
      .bind(owner, windowStart, owner),
  ])

  const positionRows = (positions.results ?? []) as Row[]
  // Day P&L: fills closed today plus what open positions are worth right now.
  // Open positions are marked at the venue price the engine stored; the feed
  // is only a fallback for rows that predate stored marks.
  const unrealized = positionRows.reduce((sum, row) => {
    const storedMark = row.mark_price === null || row.mark_price === undefined ? null : Number(row.mark_price)
    const mark = storedMark !== null && Number.isFinite(storedMark) && storedMark > 0 ? storedMark : quote(String(row.symbol), t)
    return sum + (mark - Number(row.avg_price)) * Number(row.qty)
  }, 0)
  const realizedToday = Number((today.results[0] as { v: number }).v ?? 0)

  // Deployed capital counts only live bots — paper bots and backtests play
  // with the simulation pot, not the workspace's real(ish) money.
  const liveBots = bots.filter((b) => b.mode === 'live')
  const capitalDeployed = liveBots.reduce((sum, b) => sum + b.equity, 0)
  const wins = liveBots.reduce((sum, b) => sum + b.wins, 0)
  const roundTrips = liveBots.reduce((sum, b) => sum + b.roundTrips, 0)
  const stageRows = stages.results as { stage: Dashboard['stageTotals'][number]['stage']; n: number }[]

  const body: Dashboard = {
    kpis: {
      capitalDeployed,
      liveBots: liveBots.length,
      activeBots: liveBots.filter((b) => b.status === 'running').length,
      todayPnl: realizedToday + unrealized,
      winRate: roundTrips > 0 ? (wins / roundTrips) * 100 : null,
      openPositions: positionRows.length,
    },
    equity: buildEquitySeries(liveBots, points.results as Row[], windowStart, t),
    stageTotals: (['draft', 'backtest', 'paper', 'live'] as const).map((stage) => ({
      stage,
      count: stageRows.find((r) => r.stage === stage)?.n ?? 0,
    })),
    // Operator vocabulary for the live book. Paper bots are training data and
    // are reported under Backtesting, so their hangar/training counts are 0.
    fleet: {
      running: liveBots.filter((b) => b.status === 'running').length,
      paused: liveBots.filter((b) => b.status !== 'running' && activityOf(b) === 'inactive').length,
      grounded: liveBots.filter((b) => b.status !== 'running' && activityOf(b) === 'grounded').length,
      training: 0,
      hangar: 0,
      paper: 0,
      live: liveBots.length,
      total: liveBots.length,
    },
    attention: liveBots
      .filter((b) => b.status === 'paused' || (b.status === 'running' && b.initialEquity > 0 && b.equity < b.initialEquity * 0.92))
      .slice(0, 5),
    events: ((events.results ?? []) as Row[]).map(mapEvent),
  }
  return privateJson(c, body)
})

workspace.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 1) return privateJson(c, { bots: [], strategies: [] } satisfies SearchResults)
  const db = c.get('db')
  const owner = c.get('user').sub
  const like = `%${q.replace(/[%_]/g, '')}%`
  const result = await db
    .prepare(`SELECT id, name, strategy_key FROM bots WHERE owner_sub = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT 6`)
    .bind(owner, like)
    .all<Row>()
  const bots = (result.results ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    strategyName: strategyBy(String(r.strategy_key))?.name ?? String(r.strategy_key),
  }))
  const lower = q.toLowerCase()
  const strategies = STRATEGIES.filter((s) => s.name.toLowerCase().includes(lower) || s.tags.some((tag) => tag.toLowerCase().includes(lower)))
    .slice(0, 5)
    .map((s) => ({ key: s.key, name: s.name, risk: s.risk }))
  return privateJson(c, { bots, strategies } satisfies SearchResults)
})
