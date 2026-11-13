import { Hono } from 'hono'

import { authMode, getAuth, requireUser } from './auth'
import { requireDb } from './db'
import type { AppContext, Env } from './env'
import { analysis } from './routes/analysis'
import { backtests } from './routes/backtests'
import { bots } from './routes/bots'
import { connections } from './routes/connections'
import { instruments } from './routes/instruments'
import { market } from './routes/market'
import { portfolio } from './routes/portfolio'
import { strategies } from './routes/strategies'
import { book, toolbox } from './routes/toolbox'
import { workspace } from './routes/workspace'

// Durable Object classes must be exported from the Worker entrypoint.
export { EnvironmentDurableObject } from './agents/environment-do'

const app = new Hono<AppContext>()

// Public: lets the app know how to sign in before any private call.
app.get('/api/auth/status', (c) => {
  const mode = authMode(c.env, c.req.raw)
  c.header('Cache-Control', 'private, no-store')
  return c.json({ mode, database: Boolean(c.env.DB), files: Boolean(c.env.FILES) })
})

app.get('/api/health', (c) => c.json({ ok: true }))

const api = new Hono<AppContext>()
api.use('*', requireUser, requireDb)
api.route('/', workspace)
api.route('/bots', bots)
api.route('/strategies', strategies)
api.route('/backtests', backtests)
api.route('/connections', connections)
api.route('/instruments', instruments)
api.route('/portfolio', portfolio)
api.route('/market', market)
api.route('/analysis', analysis)
api.route('/toolbox', toolbox)
api.route('/book', book)
app.route('/api', api)

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Something went wrong.' }, 500)
})

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found.' }, 404) : c.env.ASSETS.fetch(c.req.raw)))

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Sign in with Freebuff owns /auth/freebuff/* and keeps sessions fresh. It
    // wraps the whole app once per isolate; without a client ID the app falls
    // back to the loopback development user (see auth.ts).
    const auth = getAuth(env, request)
    const handler = (req: Request) => Promise.resolve(app.fetch(req, env, ctx))
    return auth ? auth.wrap(handler)(request) : handler(request)
  },
}
