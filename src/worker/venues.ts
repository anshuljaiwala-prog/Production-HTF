import type { Timeframe } from '../shared/types'
import { LiveBrokerError, type Broker, type Fill, type OrderRequest } from './broker'
import { resolveBseContract, type BseContract } from './instruments'
import { barsBetween, quote } from './market'
import { decryptSecret, loadSecretKeys } from './secrets'

// Live venue adapters.
//
// BSE has no public retail order API: orders reach the exchange through a
// SEBI-registered broker. This adapter routes BSE orders through Upstox's
// trading API (BSE_EQ segment), which exposes separate sandbox and production
// hosts — so a bot can rehearse against the sandbox and then switch its venue
// to production without changing anything else.
//
// Credentials live on the connection row (api_secret = Upstox access token,
// AES-GCM encrypted at rest). Tokens are pasted by the operator later and are
// never needed at build time. Strategy signals and equity marking still read
// the synthetic feed; only the order itself and its quote come from the venue.

const UPSTOX = {
  sandbox: { orders: 'https://api-sandbox.upstox.com', quotes: 'https://api-sandbox.upstox.com' },
  production: { orders: 'https://api-hft.upstox.com', quotes: 'https://api.upstox.com' },
} as const

/** Exchanges with a working live adapter. A live bot whose venues are all
 * unsupported fails loudly instead of pretending to execute. */
export const LIVE_EXCHANGES = ['BSE (via Upstox)'] as const

/** BSE cash-equity instrument keys, keyed by the app's symbol. Derivative
 * contract keys are expiry- and strike-specific, so they are never hardcoded:
 * the adapter resolves them from the exchange instrument master (instruments.ts)
 * and an unmapped symbol is rejected with a message naming what is covered. */
export const BSE_INSTRUMENTS: Record<string, string> = {
  INFY: 'BSE_EQ|INE009A01021',
  RELIANCE: 'BSE_EQ|INE002A01018',
  TCS: 'BSE_EQ|INE467B01029',
  HDFCBANK: 'BSE_EQ|INE040A01034',
  SBIN: 'BSE_EQ|INE062A01020',
}

type UpstoxResponse = { status?: string; data?: unknown; errors?: { message?: string; errorCode?: string }[] }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class BseBroker implements Broker {
  readonly mode = 'live' as const
  readonly label: string
  private readonly hosts: { orders: string; quotes: string }

  constructor(
    private readonly accessToken: string,
    private readonly environment: 'sandbox' | 'production',
    private readonly db: D1Database,
  ) {
    this.label = `BSE (${environment})`
    this.hosts = UPSTOX[environment]
  }

  /** Reference series for signals and backtests: the synthetic feed. The
   * order and its quote come from the venue. */
  quote(symbol: string, at: number): number {
    return quote(symbol, at)
  }

  bars(symbol: string, tf: Timeframe, from: number, to: number) {
    return barsBetween(symbol, tf, from, to)
  }

  /** Cash equities map directly; derivatives (SENSEX-FUT, SENSEX-940-CE) resolve
   * to a dated contract from the instrument master, which also carries the
   * lot size the venue actually trades in. */
  private async instrument(symbol: string): Promise<{ key: string; lotSize: number; contract: BseContract | null }> {
    const key = BSE_INSTRUMENTS[symbol]
    if (key) return { key, lotSize: 1, contract: null }
    let contract: BseContract | null
    try {
      contract = await resolveBseContract(this.db, symbol)
    } catch (error) {
      throw new LiveBrokerError(`Could not load the BSE contract for ${symbol}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!contract) {
      throw new LiveBrokerError(
        `No BSE instrument for ${symbol} — live BSE trading covers cash equities ${Object.keys(BSE_INSTRUMENTS).join(', ')} and the SENSEX, BANKEX, SENSEX50 and FOCIT futures/options (e.g. SENSEX-FUT, SENSEX-940-CE).`,
      )
    }
    return { key: contract.instrumentKey, lotSize: contract.lotSize, contract }
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (!this.accessToken) throw new LiveBrokerError('This BSE connection has no access token — paste one on the Connections page.')
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      throw new LiveBrokerError(`BSE venue unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    let payload: UpstoxResponse | null = null
    try {
      payload = (await response.json()) as UpstoxResponse
    } catch {
      /* non-JSON body */
    }
    const detail = payload?.errors?.[0]?.message ?? payload?.status ?? 'no detail'
    if (!response.ok || payload?.status === 'error') {
      const hint = response.status === 401 || response.status === 403 ? ' — check the access token (it expires daily in production).' : ''
      throw new LiveBrokerError(`BSE order API rejected the request (HTTP ${response.status}): ${detail}${hint}`)
    }
    return payload as T
  }

  /** Venue last-traded price, with failures surfaced (credential probe). */
  async lastPrice(symbol: string): Promise<number> {
    const { key } = await this.instrument(symbol)
    const payload = await this.request<{ data?: Record<string, { last_price?: number }> }>(
      `${this.hosts.quotes}/v3/market-quote/ltp?instrument_key=${encodeURIComponent(key)}`,
    )
    const entry = Object.values(payload.data ?? {})[0]
    const price = Number(entry?.last_price)
    if (!Number.isFinite(price) || price <= 0) throw new LiveBrokerError(`BSE returned no ${symbol} quote (${this.label}).`)
    return price
  }

  async executableQuote(symbol: string): Promise<number | null> {
    try {
      return await this.lastPrice(symbol)
    } catch {
      // The router treats a missing quote as "this venue can't be ranked";
      // placing an order against it still fails loudly in placeOrder.
      return null
    }
  }

  async placeOrder(order: OrderRequest): Promise<Fill> {
    const { key: instrument, lotSize } = await this.instrument(order.symbol)
    // Cash equities trade in single units; derivatives trade in lots and the
    // venue rejects anything else. Rounding down keeps the order inside the
    // bot's cash budget rather than overshooting it.
    const lot = Math.max(1, lotSize)
    const quantity = Math.floor(Math.floor(order.qty) / lot) * lot
    if (quantity < 1) {
      throw new LiveBrokerError(
        lot === 1
          ? `BSE trades whole shares — ${order.symbol} sized to ${order.qty.toFixed(6)} shares is below one unit.`
          : `BSE trades ${order.symbol} in lots of ${lot} — a ${order.qty.toFixed(4)}-unit order rounds down to nothing. Size the bot larger or pick a cheaper contract.`,
      )
    }

    const placed = await this.request<{ data?: { order_ids?: string[] } | string[] }>(`${this.hosts.orders}/v3/order/place`, {
      method: 'POST',
      body: JSON.stringify({
        quantity,
        product: 'D',
        validity: 'DAY',
        price: 0,
        instrument_token: instrument,
        order_type: 'MARKET',
        transaction_type: order.side === 'buy' ? 'BUY' : 'SELL',
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
      }),
    })
    const placedData = placed.data as { order_ids?: string[] } | string[] | undefined
    const orderId = Array.isArray(placedData) ? placedData[0] : placedData?.order_ids?.[0]
    if (!orderId) throw new LiveBrokerError(`BSE accepted no order id for ${order.symbol} — nothing was filled.`)

    // Poll the order book for the execution price: a market order is not
    // filled at submit time. Bounded so a slow session cannot hang a request.
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(attempt === 0 ? 250 : 500)
      let detail: { status?: string; average_price?: number; filled_quantity?: number; status_message?: string } | undefined
      try {
        const payload = await this.request<{ data?: typeof detail }>(
          `${this.hosts.orders}/v2/order/details?order_id=${encodeURIComponent(orderId)}`,
        )
        detail = payload.data
      } catch (error) {
        // Sandbox does not expose the order book on every endpoint: fall back
        // to the venue quote rather than reporting a fill we cannot price.
        if (this.environment !== 'sandbox') throw error
        break
      }
      const status = String(detail?.status ?? '').toLowerCase()
      if (status === 'rejected' || status === 'cancelled' || status === 'cancelled after market order') {
        throw new LiveBrokerError(`BSE ${order.side} of ${order.symbol} was ${status}: ${detail?.status_message ?? 'no reason given'}.`)
      }
      const price = Number(detail?.average_price)
      if (status === 'complete' && Number.isFinite(price) && price > 0) {
        return {
          symbol: order.symbol,
          side: order.side,
          qty: Number(detail?.filled_quantity) || quantity,
          price,
          // Brokerage, STT and exchange charges are not returned by the order
          // API; recording 0 is honest, an invented rate would not be.
          fee: 0,
          at: order.at,
          venue: this.label,
        }
      }
    }

    const fallback = await this.executableQuote(order.symbol)
    if (fallback) {
      return { symbol: order.symbol, side: order.side, qty: quantity, price: fallback, fee: 0, at: order.at, venue: this.label }
    }
    if (this.environment === 'sandbox') {
      // The sandbox host exposes order placement but not market data, so a
      // rehearsal fill is priced off the same reference series the strategy
      // traded on. Production never falls back to simulated prices.
      return { symbol: order.symbol, side: order.side, qty: quantity, price: this.quote(order.symbol, order.at), fee: 0, at: order.at, venue: this.label }
    }
    throw new LiveBrokerError(`BSE order ${orderId} for ${order.symbol} was not confirmed and no quote was available to price it.`)
  }
}

/**
 * Best-price router: one bot, many venues. Every order asks each venue for an
 * executable quote, ranks them (a buy wants the lowest, a sell the highest)
 * and fills on the best one, falling back to the next venue if a venue
 * rejects or cannot be reached.
 */
export class RoutingBroker implements Broker {
  readonly mode = 'live' as const
  readonly label: string

  constructor(private readonly venues: { broker: Broker; name: string }[]) {
    if (venues.length === 0) throw new LiveBrokerError('A live bot needs at least one exchange connection.')
    this.label = `Best price across ${venues.length} venues (${venues.map((v) => v.name).join(', ')})`
  }

  get primary(): Broker {
    return this.venues[0].broker
  }

  quote(symbol: string, at: number): number {
    return this.primary.quote(symbol, at)
  }

  bars(symbol: string, tf: Timeframe, from: number, to: number) {
    return this.primary.bars(symbol, tf, from, to)
  }

  /** Best executable price across venues for a side (buy: min, sell: max). */
  async executableQuote(symbol: string, side: 'buy' | 'sell'): Promise<number | null> {
    const prices = await this.rankedPrices(symbol, side)
    return prices[0]?.price ?? null
  }

  private async rankedPrices(symbol: string, side: 'buy' | 'sell') {
    const quoted = await Promise.all(
      this.venues.map(async (venue) => {
        const price = await venue.broker.executableQuote?.(symbol, side).catch(() => null) ?? null
        return { ...venue, price }
      }),
    )
    const priced = quoted.filter((entry): entry is typeof entry & { price: number } => entry.price !== null && entry.price > 0)
    priced.sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price))
    // Venues without a quote still get a chance, last.
    return [...priced, ...quoted.filter((entry) => entry.price === null)]
  }

  async placeOrder(order: OrderRequest): Promise<Fill> {
    const ranked = await this.rankedPrices(order.symbol, order.side)
    const failures: string[] = []
    for (const venue of ranked) {
      try {
        const fill = await venue.broker.placeOrder(order)
        return { ...fill, venue: fill.venue ?? venue.name }
      } catch (error) {
        failures.push(`${venue.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new LiveBrokerError(`Every venue rejected the ${order.side} of ${order.symbol} — ${failures.join(' | ')}`)
  }
}

type ConnectionRow = Record<string, unknown>

/** Build the execution broker for one bot from its venue connections. Paper
 * bots stay simulated; live bots must resolve at least one working adapter. */
export async function createVenueBroker(
  db: D1Database,
  owner: string,
  venueIds: string[],
  secretsKey: string | undefined,
): Promise<Broker> {
  const ids = [...new Set(venueIds.filter(Boolean))]
  if (ids.length === 0) throw new LiveBrokerError('This live bot has no exchange connection to route through — attach one on the Connections page.')

  const rows = await db
    .prepare(`SELECT * FROM connections WHERE owner_sub = ? AND id IN (${ids.map(() => '?').join(', ')})`)
    .bind(owner, ...ids)
    .all<ConnectionRow>()
  const byId = new Map((rows.results ?? []).map((row) => [String(row.id), row]))
  const keys = await loadSecretKeys(db, owner, secretsKey)

  const venues: { broker: Broker; name: string }[] = []
  const problems: string[] = []
  for (const venueId of ids) {
    const row = byId.get(venueId)
    if (!row) {
      problems.push('a connection was deleted')
      continue
    }
    const exchange = String(row.exchange ?? '')
    const name = String(row.name ?? exchange)
    if (!(LIVE_EXCHANGES as readonly string[]).includes(exchange)) {
      problems.push(`${name}: no live adapter for ${exchange}`)
      continue
    }
    const token = await decryptSecret(keys, String(row.api_secret ?? ''))
    if (!token) {
      problems.push(`${name}: credentials unreadable — re-save the access token`)
      continue
    }
    const environment = String(row.environment ?? '') === 'sandbox' ? 'sandbox' : 'production'
    venues.push({ broker: new BseBroker(token, environment, db), name })
  }

  if (venues.length === 0) {
    throw new LiveBrokerError(`No usable live venue for this bot — ${problems.join('; ') || 'attach a supported exchange connection'}.`)
  }
  if (venues.length === 1) return venues[0].broker
  return new RoutingBroker(venues)
}

/** Probe one saved connection: real request to the venue with its stored
 * credentials, so "paste keys later" has a way to be confirmed. */
export async function testVenueConnection(
  db: D1Database,
  owner: string,
  row: ConnectionRow,
  secretsKey: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const exchange = String(row.exchange ?? '')
  if (!(LIVE_EXCHANGES as readonly string[]).includes(exchange)) {
    return { ok: false, message: `No live adapter for ${exchange}. Supported: ${LIVE_EXCHANGES.join(', ')}.` }
  }
  const keys = await loadSecretKeys(db, owner, secretsKey)
  const token = await decryptSecret(keys, String(row.api_secret ?? ''))
  if (!token) return { ok: false, message: 'Stored credentials are unreadable — re-save the access token.' }
  const environment = String(row.environment ?? '') === 'sandbox' ? 'sandbox' : 'production'
  const broker = new BseBroker(token, environment, db)
  const symbol = Object.keys(BSE_INSTRUMENTS)[0]
  if (environment === 'sandbox') {
    // Upstox's sandbox exposes order placement only — there is no read-only
    // call that proves the token, and placing a live test order to find out
    // is not something a health check should do.
    return {
      ok: false,
      message: 'BSE sandbox is orders-only, so there is no read-only credential probe. Verify a production connection, or let a sandbox bot place an order.',
    }
  }
  try {
    const price = await broker.lastPrice(symbol)
    return { ok: true, message: `BSE (${environment}) reachable — ${symbol} last price ${price}.` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
