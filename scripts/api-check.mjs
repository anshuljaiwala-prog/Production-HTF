// API smoke test for the HTF worker. Run with: node scripts/api-check.mjs
// Covers launch, monitor, control, board move, backtest, connections and
// the validation/same-origin paths against a running dev server.
const BASE = process.env.BASE ?? 'http://localhost:5173'
const ORIGIN = { Origin: BASE, accept: 'application/json', 'content-type': 'application/json' }

let failures = 0

async function call(method, path, body) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...ORIGIN, ...(body === undefined ? { 'content-type': undefined } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    /* no body */
  }
  return { status: response.status, payload }
}

function check(label, ok, detail = '') {
  if (ok) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

// 1. Catalog
{
  const { status, payload } = await call('GET', '/strategies')
  check('GET /strategies', status === 200 && payload.strategies?.length === 6 && payload.symbols?.length > 0, JSON.stringify(payload).slice(0, 120))
}

// 2. Dashboard
{
  const { status, payload } = await call('GET', '/overview')
  check(
    'GET /overview',
    status === 200 && typeof payload.kpis?.capitalDeployed === 'number' && payload.equity?.length > 0 && payload.stageTotals?.length === 4,
    JSON.stringify(payload?.kpis),
  )
}

// 3. Launch a bot
let botId
{
  const { status, payload } = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 5000,
    riskPct: 20,
    mode: 'paper',
    params: {},
  })
  botId = payload?.bot?.id
  check('POST /bots launch', status === 201 && Boolean(botId) && payload.bot.status === 'running', JSON.stringify(payload).slice(0, 160))
}

// 4. Validation paths
{
  const bad = await call('POST', '/bots', { strategyKey: 'nope', symbols: ['BTC-USD'], timeframe: '1h', capital: 500 })
  check('POST /bots rejects unknown strategy', bad.status === 400, `got ${bad.status}`)
  const noSymbols = await call('POST', '/bots', { strategyKey: 'dca', symbols: [], timeframe: '1h', capital: 500 })
  check('POST /bots rejects empty symbols', noSymbols.status === 400, `got ${noSymbols.status}`)
  const badTf = await call('POST', '/bots', { strategyKey: 'dca', symbols: ['BTC-USD'], timeframe: '1m', capital: 1000 })
  check('POST /bots rejects unsupported timeframe', badTf.status === 400, `got ${badTf.status}`)
}

// 5. Detail (advances the run)
{
  const { status, payload } = await call('GET', `/bots/${botId}`)
  check(
    'GET /bots/:id',
    status === 200 && payload.bot?.id === botId && Array.isArray(payload.positions) && Array.isArray(payload.trades) && Array.isArray(payload.equity),
    `trades=${payload?.trades?.length} events=${payload?.events?.length}`,
  )
}

// 6. Control: pause then start
{
  const paused = await call('POST', `/bots/${botId}/control`, { action: 'pause' })
  check('POST /bots/:id/control pause', paused.status === 200 && paused.payload.bot.status === 'paused', JSON.stringify(paused.payload).slice(0, 120))
  const started = await call('POST', `/bots/${botId}/control`, { action: 'start' })
  check('POST /bots/:id/control start', started.status === 200 && started.payload.bot.status === 'running', JSON.stringify(started.payload).slice(0, 120))
  const bogus = await call('POST', `/bots/${botId}/control`, { action: 'explode' })
  check('POST /bots/:id/control rejects unknown action', bogus.status === 400, `got ${bogus.status}`)
}

// 7. Board move
{
  const { status, payload } = await call('PATCH', `/bots/${botId}`, { stage: 'backtest', position: 3 })
  check('PATCH /bots/:id stage move', status === 200 && payload.bot?.stage === 'backtest', JSON.stringify(payload).slice(0, 120))
}

// 8. Backtest: run, list, detail, delete
let backtestId
{
  const { status, payload } = await call('POST', '/backtests', {
    strategyKey: 'momentum',
    symbol: 'ETH-USD',
    timeframe: '1h',
    capital: 10000,
    days: 60,
    params: {},
  })
  backtestId = payload?.backtest?.id
  const metrics = payload?.backtest?.metrics
  check(
    'POST /backtests run',
    status === 201 && Boolean(backtestId) && typeof metrics?.totalReturn === 'number' && payload.backtest.curve?.length > 0,
    JSON.stringify(metrics).slice(0, 160),
  )

  const bad = await call('POST', '/backtests', { strategyKey: 'momentum', symbol: 'BTC-USD', timeframe: '1h', capital: 10000, days: 60000 })
  check('POST /backtests handles impossible range', bad.status === 422 || bad.status === 201, `got ${bad.status}`)

  const list = await call('GET', '/backtests')
  check('GET /backtests', list.status === 200 && list.payload.items?.some((b) => b.id === backtestId), `items=${list.payload?.items?.length}`)

  const detail = await call('GET', `/backtests/${backtestId}`)
  check('GET /backtests/:id', detail.status === 200 && detail.payload.backtest?.trades?.length >= 0 && detail.payload.backtest.strategyName === 'EMA Momentum')

  const removed = await call('DELETE', `/backtests/${backtestId}`)
  check('DELETE /backtests/:id', removed.status === 200, `got ${removed.status}`)
}

// 9. Connections: create (masked), list, delete; secret never returned
let connectionId
{
  const { status, payload } = await call('POST', '/connections', {
    name: 'Test account',
    exchange: 'Alpaca',
    apiKey: 'ABCDEFG123456789',
    apiSecret: 'super-secret-value',
    mode: 'paper',
  })
  connectionId = payload?.connection?.id
  const serialized = JSON.stringify(payload)
  check('POST /connections', status === 201 && Boolean(connectionId), serialized.slice(0, 160))
  check('connection response masks the key', serialized.includes('••••') && !serialized.includes('super-secret-value') && !serialized.includes('ABCDEFG'), serialized.slice(0, 200))

  const missing = await call('POST', '/connections', { name: 'x', exchange: 'Alpaca', apiKey: '', apiSecret: '' })
  check('POST /connections rejects empty credentials', missing.status === 400, `got ${missing.status}`)

  const list = await call('GET', '/connections')
  check('GET /connections never returns secrets', list.status === 200 && !JSON.stringify(list.payload).includes('super-secret-value'))

  const removed = await call('DELETE', `/connections/${connectionId}`)
  check('DELETE /connections/:id', removed.status === 200, `got ${removed.status}`)
}

// 10. Search + me + same-origin refusal
{
  const search = await call('GET', '/search?q=momentum')
  check('GET /search', search.status === 200 && Array.isArray(search.payload.bots))
  const me = await call('GET', '/me')
  check('GET /me', me.status === 200 && typeof me.payload.workspace?.name === 'string')

  const cross = await fetch(`${BASE}/api/bots`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ strategyKey: 'dca', symbols: ['BTC-USD'], timeframe: '1h', capital: 1000 }),
  })
  check('cross-origin mutation refused with 403', cross.status === 403, `got ${cross.status}`)
}

// 11. Cleanup the bot created for the test
{
  const removed = await call('DELETE', `/bots/${botId}`)
  check('DELETE /bots/:id', removed.status === 200, `got ${removed.status}`)
}

console.log(failures === 0 ? '\nAll API checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
