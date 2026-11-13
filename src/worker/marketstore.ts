import type { Timeframe } from '../shared/types'
import type { Bar } from './market'
import { TIMEFRAME_MS, barsBetween, historyStart, normalizeSymbol } from './market'

// The imported-data store: backtests, training sweeps and the history API
// read this instead of the synthetic feed wherever an operator has imported
// real bars for a (symbol, timeframe). Everything here screens and dedupes —
// the store is keyed by the exact bar slot, so replaying the same feed never
// duplicates rows and later uploads win as upserts.

export interface ImportRow {
  symbol?: unknown
  timeframe?: unknown
  t?: unknown
  /** Some feeds write `ts` instead of `t`; accepted as an alias. */
  ts?: unknown
  o?: unknown
  h?: unknown
  l?: unknown
  c?: unknown
  v?: unknown
}

const MAX_IMPORT_ROWS = 5_000
const CHUNK = 300

export type ImportRowStatus =
  | { status: 'ok'; symbol: string; timeframe: Timeframe; bar: Bar }
  | { status: 'invalid'; reason: string }
  | { status: 'duplicate'; reason: string }

/** Screen one uploaded row. Noisy payloads fail loudly here so none of them
 * can reach the store: every reject carries the offending row's index. */
export function screenRow(raw: ImportRow, clock: number): ImportRowStatus {
  const symbol = normalizeSymbol(String(raw.symbol ?? '').trim())
  if (!symbol) return { status: 'invalid', reason: `unknown symbol "${String(raw.symbol ?? '').trim() || '(empty)'}"` }
  const timeframe = String(raw.timeframe ?? '') as Timeframe
  if (!TIMEFRAME_MS[timeframe]) return { status: 'invalid', reason: `unsupported timeframe "${String(raw.timeframe ?? '')}"` }

  const t = Math.round(Number(raw.t ?? raw.ts))
  if (!Number.isFinite(t) || t <= 0) return { status: 'invalid', reason: 'missing or non-numeric bar time .t' }
  if (t < historyStart(clock)) return { status: 'invalid', reason: `outside stored history (older than ${new Date(historyStart(clock)).toISOString().slice(0, 10)})` }
  if (t > clock + 2 * TIMEFRAME_MS[timeframe]) return { status: 'invalid', reason: 'future timestamp' }

  const nums = [raw.o, raw.h, raw.l, raw.c].map((v) => Number(v))
  const [o, h, l, c] = nums
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return { status: 'invalid', reason: 'OHLC must be positive finite numbers' }
  // Broken range: the high must cover both extremes and the low sit below.
  const eps = o * 1e-9
  if (h + eps < Math.max(o, c)) return { status: 'invalid', reason: `high ${h} < max(open, close)` }
  if (l - eps > Math.min(o, c)) return { status: 'invalid', reason: `low ${l} > min(open, close)` }

  const v = Number.isFinite(Number(raw.v)) && Number(raw.v) >= 0 ? Number(raw.v) : 0
  return { status: 'ok', symbol, timeframe, bar: { t, o, h, l, c, v } }
}

export interface ImportReport {
  keys: Set<string>
  rows: { status: 'ok'; symbol: string; timeframe: Timeframe; bar: Bar }[]
  invalid: { index: number; reason: string }[]
}

/** Bulk-screen a payload: later rows for the same slot replace earlier ones
 * (repeated data inside one upload collapses), everything else is classified
 * invalid with a reason. The returned report carries upsert rows and the
 * slot keys already known to the store, so the caller can count duplicates
 * vs fresh without a second query round-trip. */
export function screenPayload(raw: unknown, clock: number): ImportReport {
  const items = Array.isArray(raw) ? raw : (raw as { items?: unknown[] } | null)?.items ?? []
  if (items.length > MAX_IMPORT_ROWS) throw new Error(`Too many rows (${items.length}) — import up to ${MAX_IMPORT_ROWS} per call.`)
  const keys = new Set<string>()
  const rows: ImportReport['rows'] = []
  const invalid: ImportReport['invalid'] = []
  // Same slot repeated inside the payload: the latest row wins, the earlier
  // ones are dropped as duplicates (the caller reports the count).
  const byKey = new Map<string, number>()
  for (let i = 0; i < items.length; i++) {
    const verdict = screenRow(items[i] as ImportRow, clock)
    if (verdict.status === 'ok') {
      const key = `${verdict.symbol}|${verdict.timeframe}|${verdict.bar.t}`
      const seenAt = byKey.get(key)
      if (seenAt !== undefined) {
        invalid.push({ index: i, reason: `repeated bar slot — same as row ${seenAt}` })
        continue
      }
      byKey.set(key, i)
      rows.push({ status: verdict.status, symbol: verdict.symbol, timeframe: verdict.timeframe, bar: verdict.bar })
      keys.add(key)
    } else {
      invalid.push({ index: i, reason: verdict.reason })
    }
  }
  return { keys, rows, invalid }
}

/** Upsert screened rows into D1 in chunks. Idempotent: a second identical
 * import updates the same primary-key rows and changes no counts. */
export async function upsertBars(
  db: D1Database,
  rows: ImportReport['rows'],
  source: string,
  clock: number,
): Promise<number> {
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await db.batch(
      chunk.map((row) =>
        db
          .prepare(
            `INSERT INTO market_bars (symbol, timeframe, t, o, h, l, c, v, source, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (symbol, timeframe, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, source = excluded.source, imported_at = excluded.imported_at`,
          )
          .bind(row.symbol, row.timeframe, row.bar.t, row.bar.o, row.bar.h, row.bar.l, row.bar.c, row.bar.v, source, clock),
      ),
    )
    written += chunk.length
  }
  return written
}

/** Which slots in [from, to] are already in the store (single window query). */
export async function storedBarMap(db: D1Database, symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Map<number, Bar>> {
  const rows = await db
    .prepare(`SELECT t, o, h, l, c, v FROM market_bars WHERE symbol = ? AND timeframe = ? AND t >= ? AND t <= ? ORDER BY t ASC`)
    .bind(symbol, timeframe, from, to)
    .all<Row>()
  const map = new Map<number, Bar>()
  for (const r of rows.results ?? []) {
    map.set(Number(r.t), { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v ?? 0) })
  }
  return map
}

/** Bars for a run window: stored imports overlay the synthetic feed, so an
 * imported range is authoritative and the feed only fills the gaps. Returns
 * null when the store has nothing for this window (cheap common path). */
export async function barsForRun(db: D1Database, symbol: string, timeframe: Timeframe, from: number, to: number): Promise<Bar[] | null> {
  const stored = await storedBarMap(db, symbol, timeframe, from, to)
  if (stored.size === 0) return null
  const synthetic = barsBetween(symbol, timeframe, from, to + 1)
  const merged: Bar[] = []
  const seen = new Set<number>()
  for (const bar of synthetic) {
    const override = stored.get(bar.t)
    merged.push(override ?? bar)
    seen.add(bar.t)
  }
  // Stored-only slots that the feed's grid doesn't contain still belong.
  for (const bar of stored.values()) {
    if (!seen.has(bar.t)) merged.push(bar)
  }
  merged.sort((a, b) => a.t - b.t)
  return merged
}

type Row = Record<string, unknown>

/** Per-bucket summary of what the store holds, newest first. */
export async function storedSummary(db: D1Database, limit = 40) {
  const rows = await db
    .prepare(
      `SELECT symbol, timeframe, COUNT(*) AS bars, MIN(t) AS first, MAX(t) AS last, imported_at
       FROM market_bars GROUP BY symbol, timeframe ORDER BY imported_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Row>()
  return rows.results ?? []
}
