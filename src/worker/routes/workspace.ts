import { Hono } from 'hono'

import { authMode, privateJson } from '../auth'
import { BOT_SELECT, mapBot, mapEvent, now } from '../db'
import type { AppContext } from '../env'
import { advanceBot } from '../engine'
import { quote } from '../market'
import { STRATEGIES, strategyBy } from '../strategies'
import { clearWorkspace, seedWorkspace } from '../seed'
import type { Bot, Dashboard, Me, SearchResults } from '../../shared/types'

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

export async function loadBots(db: D1Database, owner: string): Promise<Bot[]> {
  const result = await db
    .prepare(`${BOT_SELECT} WHERE b.owner_sub = ? ORDER BY b.position DESC, b.created_at DESC`)
    .bind(owner)
    .all<Row>()
  return (result.results ?? []).map(mapBot)
}

workspace.get('/overview', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const t = now()
  const startOfDay = new Date(t)
  startOfDay.setHours(0, 0, 0, 0)
  const dayStart = startOfDay.getTime()

  let bots = await loadBots(db, owner)
  const running = bots.filter((b) => b.status === 'running').slice(0, 12)
  for (const bot of running) await advanceBot(db, owner, bot)
  if (running.length) bots = await loadBots(db, owner)

  const windowStart = startOfDay.getTime() - (EQUITY_WINDOW_DAYS - 1) * DAY
  const [today, positions, stages, events, points] = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(pnl), 0) AS v FROM trades WHERE owner_sub = ? AND pnl IS NOT NULL AND created_at >= ?`).bind(owner, dayStart),
    db.prepare(`SELECT symbol, qty, avg_price FROM positions WHERE owner_sub = ?`).bind(owner),
    db.prepare(`SELECT stage, COUNT(*) AS n FROM bots WHERE owner_sub = ? GROUP BY stage`).bind(owner),
    db
      .prepare(
        `SELECT e.*, b.name AS bot_name FROM bot_events e JOIN bots b ON b.id = e.bot_id
         WHERE e.owner_sub = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 12`,
      )
      .bind(owner),
    db.prepare(`SELECT bot_id, at, value FROM equity_points WHERE owner_sub = ? AND at >= ? ORDER BY at ASC LIMIT 4000`).bind(owner, windowStart),
  ])

  const positionRows = (positions.results ?? []) as Row[]
  // Day P&L: fills closed today plus what open positions are worth right now.
  const unrealized = positionRows.reduce(
    (sum, row) => sum + (quote(String(row.symbol), t) - Number(row.avg_price)) * Number(row.qty),
    0,
  )
  const realizedToday = Number((today.results[0] as { v: number }).v ?? 0)

  const capitalDeployed = bots.reduce((sum, b) => sum + b.equity, 0)
  const wins = bots.reduce((sum, b) => sum + b.wins, 0)
  const roundTrips = bots.reduce((sum, b) => sum + b.roundTrips, 0)
  const stageRows = stages.results as { stage: Dashboard['stageTotals'][number]['stage']; n: number }[]

  const body: Dashboard = {
    kpis: {
      capitalDeployed,
      activeBots: bots.filter((b) => b.status === 'running').length,
      todayPnl: realizedToday + unrealized,
      winRate: roundTrips > 0 ? (wins / roundTrips) * 100 : null,
      openPositions: positionRows.length,
    },
    equity: buildEquitySeries(bots, points.results as Row[], windowStart, t),
    stageTotals: (['draft', 'backtest', 'paper', 'live'] as const).map((stage) => ({
      stage,
      count: stageRows.find((r) => r.stage === stage)?.n ?? 0,
    })),
    attention: bots
      .filter((b) => b.status === 'paused' || (b.status === 'running' && b.initialEquity > 0 && b.equity < b.initialEquity * 0.92))
      .slice(0, 5),
    events: ((events.results ?? []) as Row[]).map(mapEvent),
  }
  return privateJson(c, body)
})

/** Daily closing equity per bot, carried forward, summed across the fleet. */
export function buildEquitySeries(bots: Bot[], rows: Row[], windowStart: number, t: number): { label: string; value: number }[] {
  const days = Math.max(1, Math.floor((t - windowStart) / DAY) + 1)
  const byBot = new Map<string, { at: number; value: number }[]>()
  for (const row of rows) {
    const key = String(row.bot_id)
    const list = byBot.get(key) ?? []
    list.push({ at: Number(row.at), value: Number(row.value) })
    byBot.set(key, list)
  }

  const series: { label: string; value: number }[] = []
  for (let d = 0; d < days; d++) {
    const dayEnd = windowStart + (d + 1) * DAY
    let total = 0
    for (const bot of bots) {
      const points = byBot.get(bot.id) ?? []
      let value: number | undefined
      for (const point of points) {
        if (point.at >= dayEnd) break
        value = point.value
      }
      total += value ?? (bot.createdAt < dayEnd ? bot.equity : bot.initialEquity)
    }
    if (total === 0 && bots.length === 0) continue
    const date = new Date(dayEnd - DAY)
    series.push({ label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: total })
  }
  return series
}

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
