import { Hono } from 'hono'

import { privateJson } from '../auth'
import { id, logEvent, mapConnection, now } from '../db'
import type { AppContext } from '../env'
import type { Connection } from '../../shared/types'

type Row = Record<string, unknown>

export const connections = new Hono<AppContext>()

const EXCHANGES = ['Paper (simulated)', 'Alpaca', 'Binance', 'Coinbase', 'Kraken']

/** Throwaway credentials the demo venue recognises — never real market
 * access. Reused by the seeder and the POST /demo endpoint. */
export function demoConnectionRows(): { name: string; exchange: string; apiKey: string; apiSecret: string; mode: 'paper' }[] {
  return [
    { name: 'Demo · Alpaca paper', exchange: 'Alpaca', apiKey: 'HTFDEMOALPACA0001', apiSecret: 'demo-secret-not-real', mode: 'paper' },
    { name: 'Demo · Binance paper', exchange: 'Binance', apiKey: 'HTFDEMOBINANCE001', apiSecret: 'demo-secret-not-real', mode: 'paper' },
  ]
}

export async function insertConnection(db: D1Database, owner: string, spec: { name: string; exchange: string; apiKey: string; apiSecret: string; mode: string }) {
  const connId = id()
  await db
    .prepare(
      `INSERT INTO connections (id, owner_sub, name, exchange, api_key, api_secret, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(connId, owner, spec.name, spec.exchange, spec.apiKey, spec.apiSecret, spec.mode, now())
    .run()
  return db.prepare(`SELECT * FROM connections WHERE id = ?`).bind(connId).first<Row>()
}

connections.get('/', async (c) => {
  const db = c.get('db')
  const result = await db
    .prepare(`SELECT * FROM connections WHERE owner_sub = ? ORDER BY created_at DESC`)
    .bind(c.get('user').sub)
    .all<Row>()
  // A fresh workspace starts with the two demo connections so bots have
  // something to route through for testing. Only fires on an empty book.
  if ((result.results ?? []).length === 0) {
    for (const demo of demoConnectionRows()) await insertConnection(db, c.get('user').sub, demo)
    const seeded = await db
      .prepare(`SELECT * FROM connections WHERE owner_sub = ? ORDER BY created_at DESC`)
      .bind(c.get('user').sub)
      .all<Row>()
    result.results = seeded.results
  }
  return privateJson(c, { items: (result.results ?? []).map(mapConnection), exchanges: EXCHANGES })
})

/** Re-add the two demo connections, skipping names that already exist. */
connections.post('/demo', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const existing = await db.prepare(`SELECT name FROM connections WHERE owner_sub = ?`).bind(owner).all<{ name: string }>()
  const have = new Set((existing.results ?? []).map((r) => r.name))
  const added = demoConnectionRows().filter((demo) => !have.has(demo.name))
  for (const demo of added) await insertConnection(db, owner, demo)
  return privateJson(c, { added: added.length })
})

/** Bulk exchange-API upload: paste many credential sets at once. Every row
 * is validated exactly like a single create — good rows are stored, bad rows
 * come back with the reason so the caller can show a per-row preview. */
const MAX_BULK_CONNECTIONS = 20

connections.post('/bulk', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const body = await c.req.json<{ items?: unknown }>()
  const items = Array.isArray(body.items) ? (body.items as Record<string,unknown>[]).slice(0, MAX_BULK_CONNECTIONS) : []
  if (items.length === 0) {
    return c.json({ error: 'nothing_to_import', message: 'No connections found in the upload — expected an array under "items".' }, 400)
  }

  const created: Connection[] = []
  const failed: { name: string; error: string }[] = []
  for (const [index, raw] of items.entries()) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 60) : ''
    const exchange = typeof raw?.exchange === 'string' && raw.exchange.trim() ? raw.exchange.trim().slice(0, 40) : EXCHANGES[1]
    const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : ''
    const apiSecret = typeof raw?.apiSecret === 'string' ? raw.apiSecret.trim() : ''
    if (!name || !apiKey || !apiSecret) {
      failed.push({
        name: name || exchange || `row ${index + 1}`,
        error: !name ? 'Missing a name.' : 'Missing the API key or API secret.',
      })
      continue
    }
    const row = await insertConnection(db, owner, {
      name,
      exchange,
      apiKey,
      apiSecret,
      mode: raw?.mode === 'live' ? 'live' : 'paper',
    })
    if (row) created.push(mapConnection(row))
  }
  return privateJson(c, { created, failed }, created.length > 0 ? 201 : 200)
})

connections.post('/', async (c) => {
  const body = await c.req.json<{ name?: string; exchange?: string; apiKey?: string; apiSecret?: string; mode?: string }>()
  const name = body.name?.trim().slice(0, 60)
  const exchange = body.exchange?.trim().slice(0, 40) || EXCHANGES[1]
  const apiKey = body.apiKey?.trim() ?? ''
  const apiSecret = body.apiSecret?.trim() ?? ''
  if (!name) return c.json({ error: 'name_required', message: 'Give the connection a name.' }, 400)
  if (!apiKey || !apiSecret) {
    return c.json({ error: 'credentials_required', message: 'Paste both the API key and the API secret.' }, 400)
  }
  const mode = body.mode === 'live' ? 'live' : 'paper'
  const connId = id()
  await c
    .get('db')
    .prepare(
      `INSERT INTO connections (id, owner_sub, name, exchange, api_key, api_secret, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(connId, c.get('user').sub, name, exchange, apiKey, apiSecret, mode, now())
    .run()
  const row = await c.get('db').prepare(`SELECT * FROM connections WHERE id = ?`).bind(connId).first<Row>()
  return privateJson(c, { connection: row ? mapConnection(row) : null }, 201)
})

connections.patch('/:id', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const connId = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    exchange?: string
    /** Paper ↔ live default for bots that route through this account. */
    mode?: string
    /** Optional credential rotation — blank fields keep the stored pair. */
    apiKey?: string
    apiSecret?: string
  }>()

  const row = await db.prepare(`SELECT * FROM connections WHERE id = ? AND owner_sub = ?`).bind(connId, owner).first<Row>()
  if (!row) return c.json({ error: 'not_found', message: 'Connection not found.' }, 404)

  const name = body.name !== undefined ? body.name.trim().slice(0, 60) : String(row.name)
  if (!name) return c.json({ error: 'name_required', message: 'Give the connection a name.' }, 400)
  const exchange = body.exchange !== undefined ? body.exchange.trim().slice(0, 40) || String(row.exchange) : String(row.exchange)
  const mode = body.mode === 'live' || body.mode === 'paper' ? body.mode : String(row.mode)
  const apiKey = body.apiKey?.trim() || null
  const apiSecret = body.apiSecret?.trim() || null
  if ((apiKey && !apiSecret) || (!apiKey && apiSecret)) {
    return c.json({ error: 'credentials_required', message: 'Rotate both the API key and the API secret together.' }, 400)
  }

  await db
    .prepare(
      `UPDATE connections SET name = ?, exchange = ?, mode = ?, api_key = COALESCE(?, api_key), api_secret = COALESCE(?, api_secret) WHERE id = ? AND owner_sub = ?`,
    )
    .bind(name, exchange, mode, apiKey, apiSecret, connId, owner)
    .run()

  // Bots route through this account by id — renaming or re-keying keeps them
  // attached to the same connection, so no bot table churn is needed.
  const updated = await db.prepare(`SELECT * FROM connections WHERE id = ?`).bind(connId).first<Row>()
  return privateJson(c, { connection: updated ? mapConnection(updated) : null })
})

connections.delete('/:id', async (c) => {
  const db = c.get('db')
  const owner = c.get('user').sub
  const connId = c.req.param('id')

  // Bots still referencing this connection first: a live bot left attached to
  // a deleted account would hold a dangling reference and carry a mode the
  // venue no longer honors. Ground them back to paper with an audit note.
  const attached = await db
    .prepare(`SELECT id, name, mode FROM bots WHERE owner_sub = ? AND connection_id = ?`)
    .bind(owner, connId)
    .all<{ id: string; name: string; mode: string }>()
  const demoted = ((attached.results ?? []) as Row[]).filter((bot) => String(bot.mode) === 'live')

  const statements = [
    db.prepare(`DELETE FROM connections WHERE id = ? AND owner_sub = ?`).bind(connId, owner),
    db
      .prepare(
        `UPDATE bots SET connection_id = NULL, mode = 'paper', stage = CASE WHEN stage = 'live' THEN 'paper' ELSE stage END, updated_at = ?
         WHERE owner_sub = ? AND connection_id = ?`,
      )
      .bind(now(), owner, connId),
  ]
  const result = (await db.batch(statements))[0]
  if (!result.meta.changes) return c.json({ error: 'not_found', message: 'Connection not found.' }, 404)
  for (const bot of demoted) {
    await logEvent(db, owner, String(bot.id), 'warn', `Connection deleted — bot grounded from live to paper mode until a new exchange API is attached.`)
  }
  return privateJson(c, { ok: true, detached: ((attached.results ?? []) as Row[]).length, grounded: demoted.length })
})
