import { Hono } from 'hono'

import { privateJson } from '../auth'
import type { AppContext } from '../env'
import { SYMBOL_LIST } from '../market'
import { STRATEGIES } from '../strategies'
import { TIMEFRAMES } from '../../shared/types'

export const strategies = new Hono<AppContext>()

/** The catalog is code-defined in v1; no database table is needed. */
strategies.get('/', async (c) => {
  return privateJson(c, { strategies: STRATEGIES, symbols: SYMBOL_LIST, timeframes: TIMEFRAMES })
})
