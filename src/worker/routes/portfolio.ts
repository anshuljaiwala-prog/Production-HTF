import { Hono } from 'hono'

import { privateJson } from '../auth'
import { buildEquitySeries, mapTrade, now } from '../db'
import type { AppContext } from '../env'
import { fastForwardFleet } from '../engine'
import { quote } from '../market'
import { strategyBy } from '../strategies'
import type {
  CashFlow,
  Portfolio,
  PortfolioBotAudit,
  PortfolioPosition,
  PortfolioTransaction,
} from '../../shared/types'

type Row = Record<string, unknown>

const DAY = 86_400_000
const WEEK_MS = 7 * DAY
const EQUITY_WINDOW_DAYS = 30
const MAX_LEDGER_ROWS = 40

export const portfolio = new Hono<AppContext>()

/** Merge the weekly cashflow and realized-P&L buckets into one series.
 * Weeks with neither show as flat zero so the bars keep a common axis. */
function mergeWeekly(fundingRows: Row[], pnlRows: Row[]): Portfolio['weekly'] {
  const funding = new Map<number, number>()
  for (const row of fundingRows) funding.set(Number(row.wk), Number(row.v ?? 0))
  const pnl = new Map<number, number>()
  for (const row of pnlRows) pnl.set(Number(row.wk), Number(row.v ?? 0))
  if (funding.size === 0 && pnl.size === 0) return []
  const weeks = [...new Set([...funding.keys(), ...pnl.keys()])].sort((a, b) => a - b)
  const first = weeks[0]
  const last = weeks.at(-1)!
  const rows: Portfolio['weekly'] = []
  for (let wk = first; wk <= last; wk += WEEK_MS) {
    rows.push({
      label: new Date(wk).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      funding: funding.get(wk) ?? 0,
      pnl: pnl.get(wk) ?? 0,
    })
  }
  // Cap the chart: the most recent 26 weeks keep the axis readable.
  return rows.slice(-26)
}

portfolio.get('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const t = now()
  const windowStart = t - (EQUITY_WINDOW_DAYS - 1) * DAY

  // Fast-forward the fleet first so every number below reflects the latest
  // closed bar, then mark open positions against the current clock.
  const bots = await fastForwardFleet(db, owner, c.env.SECRETS_KEY)

  const [perBotTrades, positions, ledger, points, fundingTotals, fundingRows, weeklyFunding, weeklyPnl] = await db.batch([
    db
      .prepare(
        `SELECT bot_id,
           COUNT(*) AS fills,
           COALESCE(SUM(fee), 0) AS fees,
           COALESCE(SUM(CASE WHEN pnl IS NULL THEN 0 ELSE pnl END), 0) AS realized,
           COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0) AS gross_profit,
           COALESCE(SUM(CASE WHEN pnl < 0 THEN -pnl ELSE 0 END), 0) AS gross_loss,
           MAX(created_at) AS last_trade
         FROM trades WHERE owner_sub = ? GROUP BY bot_id`,
      )
      .bind(owner),
    db.prepare(`SELECT bot_id, symbol, qty, avg_price, mark_price FROM positions WHERE owner_sub = ? ORDER BY opened_at`).bind(owner),
    db
      .prepare(
        `SELECT tr.*, b.name AS bot_name, b.mode AS bot_mode FROM trades tr LEFT JOIN bots b ON b.id = tr.bot_id
         WHERE tr.owner_sub = ? AND b.mode = 'live' ORDER BY tr.created_at DESC, tr.id DESC LIMIT ${MAX_LEDGER_ROWS}`,
      )
      .bind(owner),
    db.prepare(`SELECT bot_id, at, value FROM equity_points WHERE owner_sub = ? AND at >= ? ORDER BY at ASC LIMIT 4000`).bind(owner, windowStart),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS deposits,
           COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS withdrawals
         FROM cashflows WHERE owner_sub = ? AND bot_id IN (SELECT id FROM bots WHERE owner_sub = ? AND mode = 'live')`,
      )
      .bind(owner, owner),
    db
      .prepare(
        `SELECT cf.*, b.name AS bot_name FROM cashflows cf LEFT JOIN bots b ON b.id = cf.bot_id
         WHERE cf.owner_sub = ? AND b.mode = 'live' ORDER BY cf.created_at DESC, cf.id DESC LIMIT 50`,
      )
      .bind(owner),
    // Weekly buckets for the funding-vs-P&L chart: net funding and realized
    // P&L per ISO week over everything ever recorded, oldest last.
    db
      .prepare(`SELECT (created_at / ${WEEK_MS}) * ${WEEK_MS} AS wk, COALESCE(SUM(amount), 0) AS v FROM cashflows
         WHERE owner_sub = ? AND bot_id IN (SELECT id FROM bots WHERE owner_sub = ? AND mode = 'live') GROUP BY wk ORDER BY wk`)
      .bind(owner, owner),
    db
      .prepare(
        `SELECT (created_at / ${WEEK_MS}) * ${WEEK_MS} AS wk, COALESCE(SUM(pnl), 0) AS v FROM trades
         WHERE owner_sub = ? AND pnl IS NOT NULL AND bot_id IN (SELECT id FROM bots WHERE owner_sub = ? AND mode = 'live') GROUP BY wk ORDER BY wk`,
      )
      .bind(owner, owner),
  ])

  // The actual portfolio is the live book only: paper-mode bots run in the
  // simulated wallet, so their equity/metrics are carried separately under
  // `paper*` summary fields instead of being mixed into the operator's real
  // capital. Audit rows keep every bot visible with its mode badge.
  const liveBots = bots.filter((b) => b.mode === 'live')

  const botIds = new Set(liveBots.map((b) => b.id))
  const tradeRows = ((perBotTrades.results ?? []) as Row[]).filter((row) => botIds.has(String(row.bot_id)))
  const feesByBot = new Map(tradeRows.map((row) => [String(row.bot_id), row]))
  // This book is the live book: paper bots are reported separately under
  // Backtesting (`GET /portfolio/paper`), never mixed in here.
  const positionRowsAll = ((positions.results ?? []) as Row[]).filter((row) => botIds.has(String(row.bot_id)))
  const positionRows = positionRowsAll
  const positionsByBot = new Map<string, { mark: number; cost: number }>()
  for (const row of positionRowsAll) {
    const botId = String(row.bot_id)
    const entry = positionsByBot.get(botId) ?? { mark: 0, cost: 0 }
    const storedMark = row.mark_price === null || row.mark_price === undefined ? null : Number(row.mark_price)
    const mark = storedMark !== null && Number.isFinite(storedMark) && storedMark > 0 ? storedMark : quote(String(row.symbol), t)
    entry.mark += Number(row.qty) * mark
    entry.cost += Number(row.qty) * Number(row.avg_price)
    positionsByBot.set(botId, entry)
  }
  // The exposed open-position book is the live book; paper positions stay
  // inside their bots' audit rows.
  const auditPositions: PortfolioPosition[] = positionRows.map((row) => {
    const storedMark = row.mark_price === null || row.mark_price === undefined ? null : Number(row.mark_price)
    const mark = storedMark !== null && Number.isFinite(storedMark) && storedMark > 0 ? storedMark : quote(String(row.symbol), t)
    const qty = Number(row.qty)
    const avgPrice = Number(row.avg_price)
    const unrealized = (mark - avgPrice) * qty
    const botId = String(row.bot_id)
    return {
      botId,
      botName: bots.find((b) => b.id === botId)?.name ?? 'Unknown bot',
      symbol: String(row.symbol),
      qty,
      avgPrice,
      markPrice: mark,
      costBasis: qty * avgPrice,
      unrealizedPnl: unrealized,
    }
  })

  const auditBots: PortfolioBotAudit[] = liveBots.map((bot) => {
    const stats = feesByBot.get(bot.id)
    const fills = Number(stats?.fills ?? 0)
    const fees = Number(stats?.fees ?? 0)
    // Trade-table realized is authoritative for completed buys/sells; a bot
    // row may carry the same total, but fees only live on the ledger.
    const realized = Number(stats?.realized ?? 0)
    const open = positionsByBot.get(bot.id)
    const unrealized = open ? open.mark - open.cost : 0
    return {
      id: bot.id,
      name: bot.name,
      strategyKey: bot.strategyKey,
      strategyName: strategyBy(bot.strategyKey)?.name ?? bot.strategyKey,
      status: bot.status,
      mode: bot.mode,
      timeframe: bot.timeframe,
      capital: bot.capital,
      cash: bot.cash,
      equity: bot.cash + (open?.mark ?? 0),
      netDeposits: bot.netDeposits,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      fees,
      fills,
      roundTrips: bot.roundTrips,
      wins: bot.wins,
      winRate: bot.roundTrips > 0 ? (bot.wins / bot.roundTrips) * 100 : null,
      openPositions: positionRowsAll.filter((row) => String(row.bot_id) === bot.id).length,
      lastActivityAt: Math.max(Number(stats?.last_trade ?? 0), bot.updatedAt),
    }
  })

  const funding: CashFlow[] = ((fundingRows.results ?? []) as Row[]).map((row) => ({
    id: String(row.id),
    botId: String(row.bot_id),
    botName: (row.bot_name as string | null) ?? null,
    amount: Number(row.amount ?? 0),
    note: (row.note as string | null) ?? null,
    at: Number(row.created_at),
  }))
  const deposits = Number((fundingTotals.results[0] as Row | undefined)?.deposits ?? 0)
  const withdrawals = Number((fundingTotals.results[0] as Row | undefined)?.withdrawals ?? 0)

  // Actual-portfolio totals: live bots only — the simulated wallet is
  // reported on its own under Backtesting.
  const totals = auditBots.reduce(
    (acc, bot) => {
      acc.startingCapital += bot.capital
      acc.launchCapital += bot.capital - bot.netDeposits
      acc.currentEquity += bot.equity
      acc.realizedPnl += bot.realizedPnl
      acc.unrealizedPnl += bot.unrealizedPnl
      acc.fees += bot.fees
      acc.fills += bot.fills
      acc.roundTrips += bot.roundTrips
      acc.wins += bot.wins
      acc.grossProfit += Number(feesByBot.get(bot.id)?.gross_profit ?? 0)
      acc.grossLoss += Number(feesByBot.get(bot.id)?.gross_loss ?? 0)
      return acc
    },
    {
      startingCapital: 0,
      launchCapital: 0,
      currentEquity: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      fees: 0,
      fills: 0,
      roundTrips: 0,
      wins: 0,
      grossProfit: 0,
      grossLoss: 0,
    },
  )

  const transactions: PortfolioTransaction[] = ((ledger.results ?? []) as Row[]).map((row) => {
    const trade = mapTrade(row)
    // The ledger is the live money book by construction; carrying the bot's
    // mode lets clients (and checks) verify no paper fill leaked in.
    return { ...trade, botName: (row.bot_name as string | null) ?? null, mode: (row.bot_mode as PortfolioTransaction['mode']) ?? 'live' }
  })

  // Trading P&L: funding moves equity and capital together, so the difference
  // isolates what the bots actually earned — the reconcilable quantity.
  const netPnl = totals.currentEquity - totals.startingCapital
  const body: Portfolio = {
    summary: {
      startingCapital: totals.startingCapital,
      currentEquity: totals.currentEquity,
      launchCapital: totals.launchCapital,
      netPnl,
      netPnlPct: totals.startingCapital > 0 ? (netPnl / totals.startingCapital) * 100 : 0,
      realizedPnl: totals.realizedPnl,
      unrealizedPnl: totals.unrealizedPnl,
      deposits,
      withdrawals,
      netFunding: deposits - withdrawals,
      fees: totals.fees,
      grossProfit: totals.grossProfit,
      grossLoss: totals.grossLoss,
      profitFactor: totals.grossLoss > 0 ? totals.grossProfit / totals.grossLoss : null,
      expectedWinRate: totals.roundTrips > 0 ? (totals.wins / totals.roundTrips) * 100 : null,
      roundTrips: totals.roundTrips,
      wins: totals.wins,
      fills: totals.fills,
      bots: liveBots.length,
      activeBots: liveBots.filter((b) => b.status === 'running').length,
      openPositions: auditPositions.length,
    },
    equity: buildEquitySeries(liveBots, points.results as Row[], windowStart, t),
    bots: auditBots,
    positions: auditPositions,
    transactions,
    funding,
    weekly: mergeWeekly(weeklyFunding.results as Row[], weeklyPnl.results as Row[]),
  }
  return privateJson(c, body)
})

/** The simulated wallet, reported beside the money book under Backtesting.
 * Paper bots are deliberately absent from GET /portfolio's numbers and rows;
 * this is where a training run's paper record is reviewed and promoted. */
portfolio.get('/paper', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const t = now()
  const windowStart = t - (EQUITY_WINDOW_DAYS - 1) * DAY

  const items = await fastForwardFleet(db, owner, c.env.SECRETS_KEY, 'paper')

  const paperBots = items.filter((b) => b.mode === 'paper')
  const ids = paperBots.map((bot) => bot.id)
  const placeholders = ids.map(() => '?').join(', ')
  const [perBotTrades, positions, fundingRows, points] = ids.length
    ? await db.batch([
        db
          .prepare(
            `SELECT bot_id,
               COUNT(*) AS fills,
               COALESCE(SUM(fee), 0) AS fees,
               COALESCE(SUM(CASE WHEN pnl IS NULL THEN 0 ELSE pnl END), 0) AS realized
             FROM trades WHERE owner_sub = ? AND bot_id IN (${placeholders}) GROUP BY bot_id`,
          )
          .bind(owner, ...ids),
        db
          .prepare(`SELECT bot_id, symbol, qty, avg_price FROM positions WHERE owner_sub = ? AND bot_id IN (${placeholders}) ORDER BY opened_at`)
          .bind(owner, ...ids),
        db
          .prepare(
            `SELECT * FROM cashflows WHERE owner_sub = ? AND bot_id IN (${placeholders}) ORDER BY created_at DESC, id DESC LIMIT 50`,
          )
          .bind(owner, ...ids),
        db
          .prepare(`SELECT bot_id, at, value FROM equity_points WHERE owner_sub = ? AND bot_id IN (${placeholders}) AND at >= ? ORDER BY at ASC LIMIT 4000`)
          .bind(owner, ...ids, windowStart),
      ])
    : [{ results: [] }, { results: [] }, { results: [] }, { results: [] }]

  const tradeRows = (perBotTrades.results ?? []) as Row[]
  const statsByBot = new Map(tradeRows.map((row) => [String(row.bot_id), row]))
  const positionRows = (positions.results ?? []) as Row[]
  const positionCount = new Map<string, number>()
  const marks = new Map<string, number>()
  const costs = new Map<string, number>()
  for (const row of positionRows) {
    const botId = String(row.bot_id)
    positionCount.set(botId, (positionCount.get(botId) ?? 0) + 1)
    const qty = Number(row.qty)
    marks.set(botId, (marks.get(botId) ?? 0) + qty * quote(String(row.symbol), t))
    costs.set(botId, (costs.get(botId) ?? 0) + qty * Number(row.avg_price))
  }

  const audit: PortfolioBotAudit[] = paperBots.map((bot) => {
    const stats = statsByBot.get(bot.id)
    const fills = Number(stats?.fills ?? 0)
    const open = marks.get(bot.id) ?? 0
    return {
      id: bot.id,
      name: bot.name,
      strategyKey: bot.strategyKey,
      strategyName: strategyBy(bot.strategyKey)?.name ?? bot.strategyKey,
      status: bot.status,
      mode: bot.mode,
      timeframe: bot.timeframe,
      capital: bot.capital,
      cash: bot.cash,
      equity: bot.cash + open,
      netDeposits: bot.netDeposits,
      realizedPnl: Number(stats?.realized ?? 0),
      unrealizedPnl: open - (costs.get(bot.id) ?? 0),
      fees: Number(stats?.fees ?? 0),
      fills,
      roundTrips: bot.roundTrips,
      wins: bot.wins,
      winRate: bot.roundTrips > 0 ? (bot.wins / bot.roundTrips) * 100 : null,
      openPositions: positionCount.get(bot.id) ?? 0,
      lastActivityAt: Math.max(Number(stats?.last_trade ?? 0), bot.updatedAt),
    }
  })

  const equity = audit.reduce((sum, bot) => sum + bot.equity, 0)
  const capital = audit.reduce((sum, bot) => sum + bot.capital, 0)
  const roundTrips = audit.reduce((sum, bot) => sum + bot.roundTrips, 0)
  const wins = audit.reduce((sum, bot) => sum + bot.wins, 0)
  const funding: CashFlow[] = ((fundingRows.results ?? []) as Row[]).map((row) => ({
    id: String(row.id),
    botId: String(row.bot_id),
    botName: paperBots.find((bot) => bot.id === String(row.bot_id))?.name ?? null,
    amount: Number(row.amount ?? 0),
    note: (row.note as string | null) ?? null,
    at: Number(row.created_at),
  }))

  return privateJson(c, {
    summary: {
      bots: audit.length,
      capital,
      equity,
      pnl: equity - capital,
      realizedPnl: audit.reduce((sum, bot) => sum + bot.realizedPnl, 0),
      unrealizedPnl: audit.reduce((sum, bot) => sum + bot.unrealizedPnl, 0),
      fees: audit.reduce((sum, bot) => sum + bot.fees, 0),
      fills: audit.reduce((sum, bot) => sum + bot.fills, 0),
      roundTrips,
      wins,
      winRate: roundTrips > 0 ? (wins / roundTrips) * 100 : null,
      netFunding: funding.reduce((sum, flow) => sum + flow.amount, 0),
      openPositions: positionRows.length,
    },
    equity: buildEquitySeries(paperBots, points.results as Row[], windowStart, t),
    bots: audit,
    funding,
  })
})
