import { Hono } from 'hono'

import { privateJson } from '../auth'
import { id, now } from '../db'
import type { AppContext } from '../env'
import { SYMBOL_METAS } from '../market'
import { STRATEGIES, parseRules } from '../strategies'
import type { CustomRules } from '../strategies'
import { ASSET_CLASSES, TIMEFRAMES, type CustomStrategySummary } from '../../shared/types'

export const strategies = new Hono<AppContext>()

/**
 * Uploaded strategies live in worker memory (the "in-memory script upload"
 * seam of v1): data survives while the isolate is warm but is not durable
 * storage. Recreating one after a deploy/restart is a re-upload away, and the
 * responses say so. Durable strategy storage wants a versioned runner and a
 * real table — that is the next seam, not a demo feature.
 */
interface CustomStrategyStoreEntry {
  id: string
  ownerSub: string
  name: string
  /** The validated rules payload, ready to feed back into the custom strategist. */
  rules: CustomRules
  lookback: number
  createdAt: number
}

const customStore = new Map<string, CustomStrategyStoreEntry>()

function ruleCount(rules: unknown): number {
  const record = rules as { entry?: unknown[]; exit?: unknown[] } | null
  return (record?.entry?.length ?? 0) + (record?.exit?.length ?? 0)
}

strategies.get('/', async (c) => {
  return privateJson(c, {
    strategies: STRATEGIES,
    symbols: SYMBOL_METAS,
    assetClasses: ASSET_CLASSES,
    timeframes: TIMEFRAMES,
  })
})

strategies.get('/custom', async (c) => {
  const owner = c.get('user').sub
  const items: CustomStrategySummary[] = []
  for (const entry of customStore.values()) {
    if (entry.ownerSub !== owner) continue
    items.push({ id: entry.id, name: entry.name, lookback: entry.lookback, createdAt: entry.createdAt, rules: ruleCount(entry.rules) })
  }
  return privateJson(c, { items })
})

strategies.get('/custom/:id', async (c) => {
  const entry = customStore.get(c.req.param('id'))
  if (!entry || entry.ownerSub !== c.get('user').sub) {
    return c.json({ error: 'not_found', message: 'No such uploaded strategy — it may have been evicted or belongs to another workspace.' }, 404)
  }
  return privateJson(c, { strategy: { id: entry.id, name: entry.name, lookback: entry.lookback, createdAt: entry.createdAt, rules: ruleCount(entry.rules) } satisfies CustomStrategySummary, rules: entry.rules, durable: false })
})

strategies.post('/custom', async (c) => {
  const owner = c.get('user').sub
  const body = await c.req.json<{ rules?: unknown }>()
  let parsed: ReturnType<typeof parseRules>
  try {
    parsed = parseRules(body.rules)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid rules payload.'
    return c.json({ error: 'invalid_rules', message }, 400)
  }

  const entry: CustomStrategyStoreEntry = {
    id: id(),
    ownerSub: owner,
    name: parsed.rules.name,
    rules: parsed.rules,
    lookback: parsed.lookback,
    createdAt: now(),
  }
  customStore.set(entry.id, entry)

  return privateJson(
    c,
    {
      strategy: {
        id: entry.id,
        name: entry.name,
        lookback: entry.lookback,
        createdAt: entry.createdAt,
        rules: ruleCount(entry.rules),
      } satisfies CustomStrategySummary,
      /** So a preview can show the exact conditions that were accepted. */
      detail: parsed.rules,
      /** Honest note: uploads are in-memory per isolate, not durable. */
      durable: false,
    },
    201,
  )
})

strategies.delete('/custom/:id', async (c) => {
  const entryId = c.req.param('id')
  const entry = customStore.get(entryId)
  if (!entry || entry.ownerSub !== c.get('user').sub) {
    return c.json({ error: 'not_found', message: 'No such uploaded strategy — it may have been evicted or belongs to another workspace.' }, 404)
  }
  customStore.delete(entryId)
  return privateJson(c, { ok: true })
})
