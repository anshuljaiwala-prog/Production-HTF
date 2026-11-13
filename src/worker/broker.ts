import type { Timeframe } from '../shared/types'
import { barsBetween, quote } from './market'

// The execution seam. Everything above this file talks to the Broker
// interface, so paper fills and real exchange adapters (see venues.ts) share
// one code path. Order accounting (cash, positions, realised P&L) lives in
// engine.ts because it has to survive between requests in D1; a broker only
// prices and fills.

export interface OrderRequest {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  at: number
}

export interface Fill {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  fee: number
  at: number
  /** Venue that actually filled the order, when it can say. */
  venue?: string
}

export interface Broker {
  readonly mode: 'paper' | 'live'
  readonly label: string
  quote(symbol: string, at: number): number
  bars(symbol: string, tf: Timeframe, from: number, to: number): ReturnType<typeof barsBetween>
  /** Live venues can quote the price an order would execute near; the router
   * uses it to pick the best venue. Null means "no quote right now". */
  executableQuote?(symbol: string, side: 'buy' | 'sell'): Promise<number | null>
  /** Paper fills synchronously; live adapters return a promise. Callers that
   * need both use `await` — awaiting a plain value is a no-op. */
  placeOrder(order: OrderRequest): Fill | Promise<Fill>
}

export interface PaperOptions {
  feeBps?: number
  slippageBps?: number
}

/** Simulated venue: fills market orders against the synthetic feed. */
export class PaperBroker implements Broker {
  readonly mode = 'paper' as const
  readonly label = 'Paper trading (simulated venue)'

  constructor(private options: PaperOptions = {}) {}

  quote(symbol: string, at: number): number {
    return quote(symbol, at)
  }

  bars(symbol: string, tf: Timeframe, from: number, to: number) {
    return barsBetween(symbol, tf, from, to)
  }

  placeOrder(order: OrderRequest): Fill {
    const slip = (this.options.slippageBps ?? 5) / 10_000
    const feeBps = this.options.feeBps ?? 8
    const mid = quote(order.symbol, order.at)
    const price = order.side === 'buy' ? mid * (1 + slip) : mid * (1 - slip)
    const fee = price * order.qty * (feeBps / 10_000)
    return { symbol: order.symbol, side: order.side, qty: order.qty, price, fee, at: order.at, venue: 'Paper' }
  }
}

export class LiveBrokerError extends Error {}
