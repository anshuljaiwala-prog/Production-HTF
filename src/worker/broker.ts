import type { Timeframe } from '../shared/types'
import { barsBetween, quote } from './market'

// The execution seam. Everything above this file talks to the Broker
// interface, so swapping PaperBroker for a real exchange adapter (Alpaca,
// Binance, ...) is the only change needed to trade live. Order accounting
// (cash, positions, realised P&L) lives in engine.ts because it has to
// survive between requests in D1; a broker only prices and fills.

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
}

export interface Broker {
  readonly mode: 'paper' | 'live'
  readonly label: string
  quote(symbol: string, at: number): number
  bars(symbol: string, tf: Timeframe, from: number, to: number): ReturnType<typeof barsBetween>
  placeOrder(order: OrderRequest): Fill
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
    return { symbol: order.symbol, side: order.side, qty: order.qty, price, fee, at: order.at }
  }
}

export class LiveBrokerError extends Error {}

/**
 * Live adapters are not implemented in v1: this placeholder keeps the seam
 * honest — a live bot fails loudly instead of silently pretending to trade.
 */
export class UnsupportedLiveBroker implements Broker {
  readonly mode = 'live' as const
  readonly label: string

  constructor(exchange: string) {
    this.label = `${exchange} (live)`
  }

  quote(symbol: string, at: number): number {
    return quote(symbol, at)
  }

  bars(symbol: string, tf: Timeframe, from: number, to: number) {
    return barsBetween(symbol, tf, from, to)
  }

  placeOrder(): Fill {
    throw new LiveBrokerError(`No live adapter for this exchange yet — the bot needs to run in paper mode.`)
  }
}

export function createBroker(mode: 'paper' | 'live', exchange = 'paper'): Broker {
  return mode === 'live' ? new UnsupportedLiveBroker(exchange) : new PaperBroker()
}
