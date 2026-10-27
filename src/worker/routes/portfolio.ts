import { Hono } from 'hono'

import { privateJson } from '../auth'
import { mapTrade, now } from '../db'
import type { AppContext } from '../env'
import { advanceBot } from '../engine'
import { quote } from '../market'
import { strategyBy } from '../strategies'
import type {
  CashFlow,
  Portfolio,
  PortfolioBotAudit,
  PortfolioPosition,
  PortfolioTransaction,
} from '../../shared/types'
import { buildEquitySeries, loadBots } from './workspace'

type Row = Record<string, unknown>

const DAY = 86_400_000
const EQUITY_WINDOW_DAYS = 30
const MAX_LEDGER_ROWS = 40

export const portfolio = new Hono<AppContext>()

portfolio.get('/', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const t = now()
  const windowStart = t - (EQUITY_WINDOW_DAYS - 1) * DAY

  // Fast-forward the fleet first so every number below reflects the latest
  // closed bar, then mark open positions against the current clock.
  let bots = await loadBots(db, owner)
  const running = bots.filter((b) => b.status === 'running').slice(0, 12)
  for (const bot of running) await advanceBot(db, owner, bot)
  if (running.length) bots = await loadBots(db, owner)

  const [perBotTrades, positions, ledger, points, fundingTotals, fundingRows] = await db.batch([
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
    db.prepare(`SELECT bot_id, symbol, qty, avg_price FROM positions WHERE owner_sub = ? ORDER BY opened_at`).bind(owner),
    db
      .prepare(
        `SELECT tr.*, b.name AS bot_name FROM trades tr LEFT JOIN bots b ON b.id = tr.bot_id
         WHERE tr.owner_sub = ? ORDER BY tr.created_at DESC, tr.id DESC LIMIT ${MAX_LEDGER_ROWS}`,
      )
      .bind(owner),
    db.prepare(`SELECT bot_id, at, value FROM equity_points WHERE owner_sub = ? AND at >= ? ORDER BY at ASC LIMIT 4000`).bind(owner, windowStart),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS deposits,
           COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS withdrawals
         FROM cashflows WHERE owner_sub = ?`,
      )
      .bind(owner),
    db
      .prepare(
        `SELECT cf.*, b.name AS bot_name FROM cashflows cf LEFT JOIN bots b ON b.id = cf.bot_id
         WHERE cf.owner_sub = ? ORDER BY cf.created_at DESC, cf.id DESC LIMIT 50`,
      )
      .bind(owner),
  ])

  const botIds = new Set(bots.map((b) => b.id))
  const tradeRows = ((perBotTrades.results ?? []) as Row[]).filter((row) => botIds.has(String(row.bot_id)))
  const feesByBot = new Map(tradeRows.map((row) => [String(row.bot_id), row]))
  const positionRows = ((positions.results ?? []) as Row[]).filter((row) => botIds.has(String(row.bot_id)))
  const positionsByBot = new Map<string, { mark: number; cost: number }>()
  const auditPositions: PortfolioPosition[] = positionRows.map((row) => {
    const mark = quote(String(row.symbol), t)
    const qty = Number(row.qty)
    const avgPrice = Number(row.avg_price)
    const unrealized = (mark - avgPrice) * qty
    const botId = String(row.bot_id)
    const entry = positionsByBot.get(botId) ?? { mark: 0, cost: 0 }
    entry.mark += qty * mark
    entry.cost += qty * avgPrice
    positionsByBot.set(botId, entry)
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

  const auditBots: PortfolioBotAudit[] = bots.map((bot) => {
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
      openPositions: positionRows.filter((row) => String(row.bot_id) === bot.id).length,
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
    return { ...trade, botName: (row.bot_name as string | null) ?? null }
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
      bots: bots.length,
      activeBots: bots.filter((b) => b.status === 'running').length,
      openPositions: auditPositions.length,
    },
    equity: buildEquitySeries(bots, points.results as Row[], windowStart, t),
    bots: auditBots,
    positions: auditPositions,
    transactions,
    funding,
  }
  return privateJson(c, body)
})
