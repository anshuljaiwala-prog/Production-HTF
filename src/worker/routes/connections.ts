import { Hono } from 'hono'

import { privateJson } from '../auth'
import { id, mapConnection, now } from '../db'
import type { AppContext } from '../env'

type Row = Record<string, unknown>

export const connections = new Hono<AppContext>()

const EXCHANGES = ['Paper (simulated)', 'Alpaca', 'Binance', 'Coinbase', 'Kraken']

connections.get('/', async (c) => {
  const result = await c
    .get('db')
    .prepare(`SELECT * FROM connections WHERE owner_sub = ? ORDER BY created_at DESC`)
    .bind(c.get('user').sub)
    .all<Row>()
  return privateJson(c, { items: (result.results ?? []).map(mapConnection), exchanges: EXCHANGES })
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

connections.delete('/:id', async (c) => {
  const connId = c.req.param('id')
  const result = await c
    .get('db')
    .prepare(`DELETE FROM connections WHERE id = ? AND owner_sub = ?`)
    .bind(connId, c.get('user').sub)
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found', message: 'Connection not found.' }, 404)
  return privateJson(c, { ok: true })
})
