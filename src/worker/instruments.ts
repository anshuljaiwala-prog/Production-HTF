import { DAY, INR_PER_APP_UNIT, parseBseContractSymbol } from './market'
import type { InstrumentMasterStatus } from '../shared/types'

// Exchange instrument masters.
//
// A derivative order cannot be placed from a ticker: BSE identifies every
// futures and options contract by segment|token, and the token changes with
// each expiry and strike. Upstox publishes the exchange's beginning-of-day
// instrument file as gzipped JSON; this module downloads it, keeps the BSE_FO
// derivatives in D1, and resolves a catalog ticker (`SENSEX-FUT`,
// `SENSEX-940-CE`) to the live contract nearest expiry / nearest rupee strike.
//
// The file is public reference data — no API key is involved — so loading it
// works before the operator has pasted any credentials. It is the same data
// the venue itself uses, not a hardcoded list that rots every Thursday.

export const BSE_MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz'

/** The master is published once per trading day; reloading more often only
 * costs bandwidth, so a few hours of staleness is harmless. */
export const BSE_MASTER_TTL_MS = 6 * 60 * 60 * 1000

/** BSE lists derivatives on these four underlyings only. */
export const BSE_FO_UNDERLYINGS = ['SENSEX', 'BANKEX', 'SENSEX50', 'FOCIT']

export interface BseContract {
  /** Venue identifier used in order and quote calls, e.g. BSE_FO|1101628. */
  instrumentKey: string
  underlying: string
  instrumentType: 'FUT' | 'CE' | 'PE'
  /** Expiry, epoch ms (as the master publishes it). */
  expiry: number
  /** Rupee strike; 0 for futures. */
  strike: number
  lotSize: number
  tickSize: number | null
  /** Exchange trading symbol, e.g. "SENSEX 71700 CE 26 NOV 26". */
  tradingSymbol: string
}

interface MasterRow {
  segment?: string
  underlying_symbol?: string
  instrument_type?: string
  expiry?: number
  strike_price?: number
  lot_size?: number
  tick_size?: number
  instrument_key?: string
  trading_symbol?: string
}

const shapeOf = (row: MasterRow): BseContract | null => {
  const type = row.instrument_type
  if (type !== 'FUT' && type !== 'CE' && type !== 'PE') return null
  const underlying = String(row.underlying_symbol ?? '').toUpperCase()
  if (!BSE_FO_UNDERLYINGS.includes(underlying)) return null
  const expiry = Number(row.expiry)
  const key = String(row.instrument_key ?? '')
  if (!key.startsWith('BSE_FO|') || !Number.isFinite(expiry) || expiry <= 0) return null
  return {
    instrumentKey: key,
    underlying,
    instrumentType: type,
    expiry,
    strike: Number(row.strike_price) || 0,
    lotSize: Math.max(1, Math.floor(Number(row.lot_size) || 1)),
    tickSize: Number.isFinite(Number(row.tick_size)) ? Number(row.tick_size) : null,
    tradingSymbol: String(row.trading_symbol ?? ''),
  }
}

/** Download and parse the BSE instrument file. Network + gunzip only; storing
 * is loadBseMaster's job. */
export async function fetchBseMaster(): Promise<BseContract[]> {
  let response: Response
  try {
    // The CDN in front of the file rejects requests with no User-Agent (403),
    // and a Worker fetch sends none by default — so identify ourselves.
    response = await fetch(BSE_MASTER_URL, {
      headers: { accept: 'application/gzip', 'user-agent': 'htf-platform/1.0 instrument-master-sync' },
    })
  } catch (error) {
    throw new Error(`BSE instrument master unreachable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 160).replace(/\s+/g, ' ').trim()
    throw new Error(`BSE instrument master returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  const compressed = await response.arrayBuffer()
  if (compressed.byteLength === 0) throw new Error('BSE instrument master returned an empty body.')

  // The file is served as application/gzip without a Content-Encoding header,
  // so fetch hands back the raw bytes. Decompress explicitly (workerd and Node
  // both provide DecompressionStream); a server that does decompress for us
  // is handled by the plain-text fallback.
  let text: string
  try {
    const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream('gzip'))
    text = await new Response(stream).text()
  } catch {
    text = new TextDecoder().decode(compressed)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('BSE instrument master was not valid JSON — the download may have been truncated.')
  }
  if (!Array.isArray(parsed)) throw new Error('BSE instrument master had an unexpected shape (expected an array of instruments).')

  const cutoff = Date.now() - 2 * DAY
  const contracts: BseContract[] = []
  for (const row of parsed as MasterRow[]) {
    if (row.segment !== 'BSE_FO') continue
    const contract = shapeOf(row)
    // Expired contracts stay in the file for a couple of days; drop them so
    // the book only ever routes to something still trading.
    if (contract && contract.expiry >= cutoff) contracts.push(contract)
  }
  if (contracts.length === 0) throw new Error('BSE instrument master had no derivatives for SENSEX, BANKEX, SENSEX50 or FOCIT.')
  return contracts
}

/** Per-isolate memo so concurrent orders share one download. */
let inflight: Promise<InstrumentMasterStatus> | null = null

/** Download the master and replace the stored contracts. */
export async function loadBseMaster(db: D1Database): Promise<InstrumentMasterStatus> {
  const contracts = await fetchBseMaster()
  const stamp = Date.now()
  const statements: D1PreparedStatement[] = [
    // Anything that has since expired leaves the book; the rest is upserted so
    // a re-run is idempotent even if two isolates refresh at once.
    db.prepare(`DELETE FROM bse_contracts WHERE expiry < ?`).bind(stamp - 2 * DAY),
  ]
  for (const contract of contracts) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO bse_contracts (instrument_key, underlying, instrument_type, expiry, strike, lot_size, tick_size, trading_symbol, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          contract.instrumentKey,
          contract.underlying,
          contract.instrumentType,
          contract.expiry,
          contract.strike,
          contract.lotSize,
          contract.tickSize,
          contract.tradingSymbol,
          stamp,
        ),
    )
  }
  // D1 batches are capped, so writes go in chunks rather than one huge batch.
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90))
  resolved.clear()
  return bseMasterStatus(db)
}

export async function bseMasterStatus(db: D1Database): Promise<InstrumentMasterStatus> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS contracts, MAX(updated_at) AS synced_at FROM bse_contracts`)
    .first<{ contracts?: number; synced_at?: number | null }>()
  return {
    contracts: Number(row?.contracts ?? 0),
    syncedAt: row?.synced_at === null || row?.synced_at === undefined ? null : Number(row.synced_at),
    ttlMs: BSE_MASTER_TTL_MS,
    underlyings: [...BSE_FO_UNDERLYINGS],
  }
}

/** Load the master if the workspace has none, or if the cached copy is stale.
 * A stale copy is still served when the venue is unreachable — routing against
 * yesterday's contracts beats refusing to trade at all. */
async function ensureBseMaster(db: D1Database): Promise<void> {
  const status = await bseMasterStatus(db)
  if (status.contracts > 0 && status.syncedAt !== null && Date.now() - status.syncedAt < BSE_MASTER_TTL_MS) return
  inflight ??= loadBseMaster(db).finally(() => {
    inflight = null
  })
  try {
    await inflight
  } catch (error) {
    if (status.contracts === 0) throw error
    console.warn(`BSE instrument refresh failed, keeping ${status.contracts} cached contracts: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const resolved = new Map<string, { contract: BseContract; at: number }>()
const RESOLVE_TTL_MS = 5 * 60 * 1000

const mapContract = (row: Record<string, unknown>): BseContract => ({
  instrumentKey: String(row.instrument_key),
  underlying: String(row.underlying),
  instrumentType: String(row.instrument_type) as BseContract['instrumentType'],
  expiry: Number(row.expiry),
  strike: Number(row.strike),
  lotSize: Number(row.lot_size) || 1,
  tickSize: row.tick_size === null || row.tick_size === undefined ? null : Number(row.tick_size),
  tradingSymbol: String(row.trading_symbol ?? ''),
})

/**
 * Resolve a catalog BSE derivative ticker to a live contract.
 *
 * Futures resolve to the nearest expiry. Options resolve to the nearest expiry
 * of that type and then the strike nearest the requested one — the catalog
 * quotes strikes in app units, the master in rupees, so the request is scaled
 * before matching. Returns null when the ticker is not a BSE derivative; throws
 * when the master is needed but cannot be loaded.
 */
export async function resolveBseContract(db: D1Database, symbol: string): Promise<BseContract | null> {
  const ref = parseBseContractSymbol(symbol)
  if (!ref) return null

  const memo = resolved.get(symbol)
  if (memo && Date.now() - memo.at < RESOLVE_TTL_MS) return memo.contract

  await ensureBseMaster(db)

  let row: Record<string, unknown> | null
  if (ref.type === 'FUT') {
    row = await db
      .prepare(
        `SELECT * FROM bse_contracts WHERE underlying = ? AND instrument_type = 'FUT' AND expiry >= ? ORDER BY expiry LIMIT 1`,
      )
      .bind(ref.underlying, Date.now())
      .first<Record<string, unknown>>()
  } else {
    const nearest = await db
      .prepare(
        `SELECT MIN(expiry) AS expiry FROM bse_contracts WHERE underlying = ? AND instrument_type = ? AND expiry >= ?`,
      )
      .bind(ref.underlying, ref.type, Date.now())
      .first<{ expiry?: number | null }>()
    const expiry = Number(nearest?.expiry)
    if (!nearest || !Number.isFinite(expiry)) return null
    row = await db
      .prepare(
        `SELECT * FROM bse_contracts WHERE underlying = ? AND instrument_type = ? AND expiry = ? ORDER BY ABS(strike - ?) LIMIT 1`,
      )
      .bind(ref.underlying, ref.type, expiry, (ref.strike ?? 0) * INR_PER_APP_UNIT)
      .first<Record<string, unknown>>()
  }
  if (!row) return null
  const contract = mapContract(row)
  resolved.set(symbol, { contract, at: Date.now() })
  return contract
}
