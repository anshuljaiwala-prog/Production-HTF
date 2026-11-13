import { Hono } from 'hono'

import { privateJson } from '../auth'
import type { AppContext } from '../env'
import { bseMasterStatus, loadBseMaster, resolveBseContract } from '../instruments'
import { SYMBOL_LIST } from '../market'

// Exchange instrument-reference routes. The master is public exchange data:
// it needs no credentials, so it can be loaded and inspected before the
// operator has pasted a single API token.

export const instruments = new Hono<AppContext>()

instruments.get('/bse', async (c) => privateJson(c, await bseMasterStatus(c.get('db'))))

/** Force a fresh download from the venue. Idempotent; safe to retry. */
instruments.post('/bse/refresh', async (c) => {
  try {
    return privateJson(c, await loadBseMaster(c.get('db')))
  } catch (error) {
    return c.json(
      {
        error: 'master_unreachable',
        message: `Could not load the BSE instrument master: ${error instanceof Error ? error.message : String(error)}`,
      },
      502,
    )
  }
})

/** What a catalog ticker would trade live: the dated contract, its lot size and
 * expiry. 404 means BSE has no such derivative; the message says why. */
instruments.get('/bse/resolve', async (c) => {
  const symbol = String(c.req.query('symbol') ?? '').trim().toUpperCase()
  if (!symbol) return c.json({ error: 'symbol_required', message: 'Pass a symbol, e.g. ?symbol=SENSEX-FUT.' }, 400)
  if (!SYMBOL_LIST.includes(symbol)) {
    return c.json({ error: 'unknown_symbol', message: `${symbol} is not in the market catalog.` }, 404)
  }
  try {
    const contract = await resolveBseContract(c.get('db'), symbol)
    if (!contract) {
      return c.json(
        {
          error: 'not_a_bse_derivative',
          message: `${symbol} is not a BSE futures/options contract. The adapter resolves SENSEX, BANKEX, SENSEX50 and FOCIT contracts (e.g. SENSEX-FUT, SENSEX-940-CE).`,
        },
        404,
      )
    }
    return privateJson(c, { symbol, contract })
  } catch (error) {
    return c.json(
      {
        error: 'master_unreachable',
        message: `Could not load the BSE instrument master: ${error instanceof Error ? error.message : String(error)}`,
      },
      502,
    )
  }
})
