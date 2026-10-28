import { Hono } from 'hono'

import { privateJson } from '../auth'
import { id, now, parseJson } from '../db'
import type { AppContext } from '../env'
import { SYMBOL_METAS } from '../market'
import { STRATEGIES, parseRules } from '../strategies'
import type { CustomRules } from '../strategies'
import { ASSET_CLASSES, TIMEFRAMES, type CustomStrategySummary } from '../../shared/types'

export const strategies = new Hono<AppContext>()

type Row = Record<string, unknown>

/**
 * Uploaded strategies are durable in D1 with versioning: every upload of a
 * name stores a new version beside its history, so re-uploading never
 * destroys the previous rules and a restart cannot lose them. A strategy is
 * its whole version family — listing shows the latest, the detail route can
 * reach any version by id, and deleting removes the family.
 */

function ruleCount(rules: unknown): number {
  const record = rules as { entry?: unknown[]; exit?: unknown[] } | null
  return (record?.entry?.length ?? 0) + (record?.exit?.length ?? 0)
}

function summaryOf(row: Row, versions: number): CustomStrategySummary {
  const rules = parseJson<CustomRules | null>(row.rules, null)
  return {
    id: String(row.id),
    name: String(row.name),
    lookback: Number(row.lookback),
    createdAt: Number(row.created_at),
    rules: ruleCount(rules),
    version: Number(row.version),
    versions,
  }
}

const findRow = (db: D1Database, owner: string, strategyId: string) =>
  db.prepare(`SELECT * FROM uploaded_strategies WHERE id = ? AND owner_sub = ?`).bind(strategyId, owner).first<Row>()

strategies.get('/', async (c) => {
  return privateJson(c, {
    strategies: STRATEGIES,
    symbols: SYMBOL_METAS,
    assetClasses: ASSET_CLASSES,
    timeframes: TIMEFRAMES,
  })
})

strategies.get('/custom', async (c) => {
  const db = c.get('db')
  const result = await db
    .prepare(`SELECT * FROM uploaded_strategies WHERE owner_sub = ? ORDER BY name COLLATE NOCASE ASC, version DESC`)
    .bind(c.get('user').sub)
    .all<Row>()
  const rows = result.results ?? []
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(String(row.name), (totals.get(String(row.name)) ?? 0) + 1)
  // Rows arrive newest-version first per name; the first row of each family
  // is the current head.
  const items: CustomStrategySummary[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const name = String(row.name)
    if (seen.has(name)) continue
    seen.add(name)
    items.push(summaryOf(row, totals.get(name) ?? 1))
  }
  return privateJson(c, { items })
})

strategies.get('/custom/:id', async (c) => {
  const row = await findRow(c.get('db'), c.get('user').sub, c.req.param('id'))
  if (!row) {
    return c.json({ error: 'not_found', message: 'No such uploaded strategy — it may have been deleted or belongs to another workspace.' }, 404)
  }
  const total = await c
    .get('db')
    .prepare(`SELECT COUNT(*) AS n FROM uploaded_strategies WHERE owner_sub = ? AND name = ?`)
    .bind(c.get('user').sub, String(row.name))
    .first<{ n: number }>()
  return privateJson(c, {
    strategy: summaryOf(row, Number(total?.n ?? 1)),
    rules: parseJson<CustomRules | null>(row.rules, null),
    durable: true,
  })
})

/** Every stored version of one strategy family, newest first. */
strategies.get('/custom/:id/versions', async (c) => {
  const row = await findRow(c.get('db'), c.get('user').sub, c.req.param('id'))
  if (!row) {
    return c.json({ error: 'not_found', message: 'No such uploaded strategy — it may have been deleted or belongs to another workspace.' }, 404)
  }
  const result = await c
    .get('db')
    .prepare(`SELECT * FROM uploaded_strategies WHERE owner_sub = ? AND name = ? ORDER BY version DESC`)
    .bind(c.get('user').sub, String(row.name))
    .all<Row>()
  return privateJson(c, {
    items: (result.results ?? []).map((versionRow) => summaryOf(versionRow, Number(versionRow.version))),
  })
})

strategies.post('/custom', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<{ rules?: unknown }>()
  let parsed: ReturnType<typeof parseRules>
  try {
    parsed = parseRules(body.rules)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid rules payload.'
    return c.json({ error: 'invalid_rules', message }, 400)
  }

  // Same name = same family: store the next version beside the history.
  const previous = await db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM uploaded_strategies WHERE owner_sub = ? AND name = ?`)
    .bind(owner, parsed.rules.name)
    .first<{ v: number }>()
  const version = Number(previous?.v ?? 0) + 1

  const entryId = id()
  const createdAt = now()
  await db
    .prepare(`INSERT INTO uploaded_strategies (id, owner_sub, name, version, rules, lookback, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(entryId, owner, parsed.rules.name, version, JSON.stringify(parsed.rules), parsed.lookback, createdAt)
    .run()

  return privateJson(
    c,
    {
      strategy: {
        id: entryId,
        name: parsed.rules.name,
        lookback: parsed.lookback,
        createdAt,
        rules: ruleCount(parsed.rules),
        version,
        versions: version,
      } satisfies CustomStrategySummary,
      /** So a preview can show the exact conditions that were accepted. */
      detail: parsed.rules,
      /** Durable in D1: the upload outlives restarts, versioned by name. */
      durable: true,
    },
    201,
  )
})

strategies.delete('/custom/:id', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const row = await findRow(db, owner, c.req.param('id'))
  if (!row) {
    return c.json({ error: 'not_found', message: 'No such uploaded strategy — it may have been deleted or belongs to another workspace.' }, 404)
  }
  // One card = one strategy family; deleting takes every stored version.
  const result = await db
    .prepare(`DELETE FROM uploaded_strategies WHERE owner_sub = ? AND name = ?`)
    .bind(owner, String(row.name))
    .run()
  return privateJson(c, { ok: true, removed: result.meta.changes })
})
