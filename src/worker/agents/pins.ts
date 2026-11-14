import type { NewsPin } from '../../shared/types'
import { TIMEFRAME_MS } from '../market'
import { MACRO_TIMEFRAME } from './harvester'

// Pins the harvester screened, persisted so they outlive the request that
// produced them. The environment DO holds the panel's copy in its own storage;
// the engine has only a D1 handle, so this table is how a bot's later pass reads
// what an earlier one harvested — one query per pass, never per bar.
//
// A pin is derived from a pattern on a bar (`pin:<symbol>:<regime>` at that
// bar's time), so the row is keyed by (owner, id, at): the same bar re-derives
// the same row and the insert is idempotent, while the next bar's read of the
// same regime is its own row.

/** Macro bars a pin keeps moving sentiment for, then expires. Matches the
 * reference's tick-decay intent: a headline matters for a while, not forever. */
export const PIN_TTL_BARS = 24

/** Bars of pin history a pass reads and retains. Longer than the TTL so a
 * still-live pin is never pruned before it expires. */
export const PIN_WINDOW_BARS = 96

/** Newest live pins one pass reads for its symbol. */
const MAX_LIVE_PINS = 20

const MACRO_TF_MS = TIMEFRAME_MS[MACRO_TIMEFRAME]

/** When a pin harvested at `at` stops counting. */
export const pinExpiry = (at: number) => at + PIN_TTL_BARS * MACRO_TF_MS

/** How far back a pass looks for pins. */
export const pinWindowStart = (at: number) => at - PIN_WINDOW_BARS * MACRO_TF_MS

interface PinRow {
  id: string
  symbol: string
  at: number
  impact_level: NewsPin['impactLevel']
  sentiment: number
  title: string
  summary: string
  source: string
}

/**
 * The live pins for one symbol, newest first. One query per pass: the engine
 * hands the result to `readEnvironment`, which reuses it for every bar it
 * replays in that pass rather than re-reading per bar.
 */
export async function readRecentPins(db: D1Database, owner: string, symbol: string, at: number): Promise<NewsPin[]> {
  const rows = await db
    .prepare(
      `SELECT id, symbol, at, impact_level, sentiment, title, summary, source FROM news_pins
       WHERE owner_sub = ? AND symbol = ? AND at > ? AND expires_at > ?
       ORDER BY at DESC LIMIT ?`,
    )
    .bind(owner, symbol, pinWindowStart(at), at, MAX_LIVE_PINS)
    .all<PinRow>()

  const seen = new Set<string>()
  const pins: NewsPin[] = []
  for (const row of rows.results ?? []) {
    // Newest first, so the first row for an id is the one to keep.
    if (seen.has(row.id)) continue
    seen.add(row.id)
    pins.push({
      id: String(row.id),
      ticker: String(row.symbol),
      title: String(row.title),
      summary: String(row.summary),
      source: String(row.source),
      timestamp: Number(row.at),
      impactLevel: row.impact_level,
      sentiment: Number(row.sentiment),
    })
  }
  return pins
}

/** Rows for the pins this pass harvested. Idempotent per bar. */
export function pinStatements(pins: NewsPin[], owner: string): { sql: string; bind: unknown[] }[] {
  const createdAt = Date.now()
  return pins.map((pin) => ({
    sql: `INSERT OR REPLACE INTO news_pins (owner_sub, id, symbol, at, impact_level, sentiment, title, summary, source, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [
      owner,
      pin.id,
      pin.ticker,
      pin.timestamp,
      pin.impactLevel,
      pin.sentiment,
      pin.title,
      pin.summary,
      pin.source,
      pinExpiry(pin.timestamp),
      createdAt,
    ],
  }))
}

/** Drop pin rows older than the window. Same bounded-history rule the engine
 * applies to equity points and decision traces. */
export function prunePinStatements(owner: string, at: number): { sql: string; bind: unknown[] } {
  return { sql: `DELETE FROM news_pins WHERE owner_sub = ? AND at < ?`, bind: [owner, pinWindowStart(at)] }
}
