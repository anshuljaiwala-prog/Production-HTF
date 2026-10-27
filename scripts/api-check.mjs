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

// 2b. Portfolio audit
{
  const { status, payload } = await call('GET', '/portfolio')
  const s = payload?.summary
  check(
    'GET /portfolio',
    status === 200 && typeof s?.startingCapital === 'number' && typeof s?.currentEquity === 'number' && Array.isArray(payload.bots) && s.bots === payload.bots.length,
    JSON.stringify(s).slice(0, 200),
  )
  check(
    'GET /portfolio per-bot audit is consistent',
    payload.bots.every((b) => b.fills === 0 || b.lastActivityAt > 0) && typeof payload.summary.fees === 'number' && payload.summary.fees >= 0,
    JSON.stringify(payload.summary.fees),
  )
  const wellFormed = (bot) => bot.capital > 0 && bot.equity > 0 && (bot.winRate === null || typeof bot.winRate === 'number')
  check('GET /portfolio bot rows well-formed', payload.bots.every(wellFormed), 'rows malformed')
  const ledger = payload.transactions
  check('GET /portfolio ledger includes fees', status === 200 && ledger.length > 0 && ledger.every((tx) => typeof tx.fee === 'number' && tx.fee >= 0), `ledger=${ledger.length}`)
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
  check(
    'POST /backtests run',
    status === 201 && Boolean(backtestId) && payload.backtest?.status === 'running' && payload.backtest.metrics === null,
    JSON.stringify(payload?.backtest?.status).slice(0, 160),
  )

  const resolved = await call('GET', `/backtests/${backtestId}`)
  const metrics = resolved.payload?.backtest?.metrics
  check(
    'GET /backtests/:id resolves a running run',
    resolved.status === 200 && resolved.payload.backtest.status === 'done' && typeof metrics?.totalReturn === 'number' && resolved.payload.backtest.curve?.length > 0,
    JSON.stringify(resolved.payload?.backtest?.status).slice(0, 160),
  )

  const bad = await call('POST', '/backtests', { strategyKey: 'momentum', symbol: 'BTC-USD', timeframe: '1h', capital: 10000, from: Date.now() + 30 * 86_400_000, to: Date.now() })
  if (bad.status === 201 && bad.payload?.backtest?.id) {
    const resolved = await call('GET', `/backtests/${bad.payload?.backtest?.id}`)
    check('POST /backtests handles impossible range', resolved.payload?.backtest?.status === 'failed' && Boolean(resolved.payload?.backtest?.error), JSON.stringify(resolved.payload?.backtest?.error).slice(0, 120))
    await call('DELETE', `/backtests/${bad.payload?.backtest?.id}`)
  } else {
    check('POST /backtests handles impossible range', bad.status === 422, `got ${bad.status}`)
  }

  const list = await call('GET', '/backtests')
  check('GET /backtests', list.status === 200 && list.payload.items?.some((b) => b.id === backtestId), `items=${list.payload?.items?.length}`)
  const sim = list.payload?.sim
  check(
    'GET /backtests reports the simulation pot',
    sim?.total === 1_000_000 && Number.isFinite(sim?.used) && Math.abs((sim?.used ?? 0) + (sim?.available ?? 0) - (sim?.total ?? 0)) < 0.01,
    JSON.stringify(sim),
  )

  const tooBig = await call('POST', '/backtests', { strategyKey: 'momentum', symbol: 'ETH-USD', timeframe: '1h', capital: 2_000_000, days: 30, params: {} })
  check('POST /backtests refuses capital beyond the sim pot', tooBig.status === 400 && tooBig.payload?.error === 'sim_budget_exhausted', `got ${tooBig.status} ${tooBig.payload?.error ?? ''}`)

  const detail = await call('GET', `/backtests/${backtestId}`)
  check('GET /backtests/:id', detail.status === 200 && detail.payload.backtest?.trades?.length >= 0 && detail.payload.backtest.strategyName === 'EMA Momentum')

  const market = await call('GET', `/backtests/${backtestId}/market`)
  const candles = market.payload?.candles ?? []
  const ohlcSane = candles.length > 0 && candles.every((k) => k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c) && k.h >= k.l)
  check(
    'GET /backtests/:id/market',
    market.status === 200 && market.payload.symbol === 'ETH-USD' && market.payload.bars > 0 && ohlcSane,
    `bars=${market.payload?.bars} candles=${candles.length}`,
  )

  const removed = await call('DELETE', `/backtests/${backtestId}`)
  check('DELETE /backtests/:id', removed.status === 200, `got ${removed.status}`)
}

// 8b. Bulk import: one good config launches (paused), one bad is reported
let importedBotId
{
  const { status, payload } = await call('POST', '/bots/import', {
    items: [
      { name: 'Import test grid', strategyKey: 'grid', symbols: ['BTC-USD'], capital: 5000, mode: 'paper' },
      { name: 'Import test bad', strategyKey: 'nope', symbols: ['ETH-USD'], capital: 5000, mode: 'paper' },
    ],
  })
  importedBotId = payload?.launched?.[0]?.id
  check(
    'POST /bots/import',
    status === 200 && payload.launched?.length === 1 && payload.failed?.length === 1 && payload.launched[0]?.status === 'paused' && payload.launched[0]?.connectionId === null,
    `launched=${payload?.launched?.length} failed=${JSON.stringify(payload?.failed)}`.slice(0, 160),
  )
  check(
    'POST /bots/import reports the bad row',
    payload.failed?.[0]?.name === 'Import test bad' && Boolean(payload.failed?.[0]?.error),
    JSON.stringify(payload?.failed?.[0]).slice(0, 120),
  )
  const empty = await call('POST', '/bots/import', { items: [] })
  check('POST /bots/import rejects empty payload', empty.status === 400, `got ${empty.status}`)
}

// 8c. Bot PATCH: trading settings only change while the bot is not active
{
  const activePatch = await call('PATCH', `/bots/${botId}`, { riskPct: 55 })
  check('PATCH a running bot is refused with 409', activePatch.status === 409 && activePatch.payload?.error === 'bot_active', `got ${activePatch.status}`)

  const paused = importedBotId ? await call('PATCH', `/bots/${importedBotId}`, { name: 'Import test grid · tuned', riskPct: 40 }) : { status: 404, payload: {} }
  check(
    'PATCH a paused bot applies trading settings',
    paused.status === 200 && paused.payload?.bot?.name === 'Import test grid · tuned' && paused.payload?.bot?.riskPct === 40,
    JSON.stringify(paused.payload?.bot?.name).slice(0, 120),
  )
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

// 9b. Uploaded rules strategy: POST -> list -> GET detail -> backtest with
// inline rules -> bot accuracy on the created bot; then discard.
let customStrategyId
{
  const rules = {
    name: 'Check suite rules',
    entry: [{ metric: 'rsi', n: 14, op: '<', value: 35 }],
    entryLogic: 'any',
    exit: [{ metric: 'rsi', n: 14, op: '>', value: 60 }],
    exitLogic: 'all',
    stopLossPct: 4,
    takeProfitPct: 8,
  }
  const bad = await call('POST', '/strategies/custom', { rules: { name: 'broken', entry: 'no' } })
  check('POST /strategies/custom rejects a malformed payload', bad.status === 400 && bad.payload?.error === 'invalid_rules', `got ${bad.status}`)

  const upload = await call('POST', '/strategies/custom', { rules })
  customStrategyId = upload.payload?.strategy?.id
  check(
    'POST /strategies/custom uploads rules',
    upload.status === 201 && Boolean(customStrategyId) && upload.payload.strategy?.rules === 2 && upload.payload.strategy?.lookback > 0 && upload.payload.durable === false,
    JSON.stringify(upload.payload?.strategy).slice(0, 160),
  )

  const list = await call('GET', '/strategies/custom')
  check(
    'GET /strategies/custom lists the upload',
    list.status === 200 && list.payload.items?.some((s) => s.id === customStrategyId && s.name === 'Check suite rules'),
    `items=${list.payload?.items?.length}`,
  )

  const detail = await call('GET', `/strategies/custom/${customStrategyId}`)
  check(
    'GET /strategies/custom/:id returns the accepted rules',
    detail.status === 200 && detail.payload.rules?.entry?.[0]?.metric === 'rsi' && detail.payload.rules?.takeProfitPct === 8,
    JSON.stringify(detail.payload?.rules).slice(0, 140),
  )

  // Rule-driven backtest: strategyKey 'custom' + inline rules runs the
  // uploaded strategist over real history.
  const run = await call('POST', '/backtests', {
    strategyKey: 'custom',
    rules,
    symbol: 'BTC-USD',
    timeframe: '1h',
    capital: 10_000,
    days: 30,
    name: 'Check suite rules backtest',
  })
  const rulesBacktestId = run.payload?.backtest?.id
  check(
    'POST /backtests with inline rules runs the uploaded strategist',
    run.status === 201 && Boolean(rulesBacktestId) && run.payload.backtest?.strategyName === 'Check suite rules',
    JSON.stringify(run.payload?.backtest?.strategyName).slice(0, 140),
  )

  let rulesDone = null
  for (let i = 0; i < 20 && !rulesDone; i++) {
    const poll = await call('GET', `/backtests/${rulesBacktestId}`)
    if (poll.payload?.backtest?.status !== 'running') rulesDone = poll.payload.backtest
    else await new Promise((r) => setTimeout(r, 250))
  }
  check(
    'rules backtest resolves with metrics + accuracy',
    rulesDone?.status === 'done' && rulesDone?.metrics?.trades >= 0 && Number.isFinite(rulesDone?.accuracy?.sample) && rulesDone.accuracy.sample > 0,
    JSON.stringify(rulesDone?.metrics ?? rulesDone?.status ?? 'stuck running').slice(0, 160),
  )
  check(
    'accuracy sample covers the market window',
    rulesDone?.accuracy?.sample > 0 && rulesDone.accuracy.sample <= 2000 && (rulesDone.accuracy.directionalAccuracy === null || (rulesDone.accuracy.directionalAccuracy >= 0 && rulesDone.accuracy.directionalAccuracy <= 100)),
    JSON.stringify(rulesDone?.accuracy?.sample).slice(0, 120),
  )
  await call('DELETE', `/backtests/${rulesBacktestId}`)

  // A bot created with inline rules carries the uploaded name and runs on
  // the custom strategist; its accuracy endpoint reports a scored window.
  const bot = await call('POST', '/bots', {
    strategyKey: 'custom',
    rules,
    name: 'Check suite rules bot',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 10_000,
    mode: 'paper',
  })
  const rulesBotId = bot.payload?.bot?.id
  check(
    'POST /bots with inline rules creates a custom bot',
    bot.status === 201 && bot.payload.bot?.strategyName === 'Check suite rules' && rulesBotId,
    JSON.stringify(bot.payload?.bot?.strategyName).slice(0, 140),
  )

  const accuracy = await call('GET', `/bots/${rulesBotId}/accuracy`)
  check(
    'GET /bots/:id/accuracy scores prediction quality',
    accuracy.status === 200 && accuracy.payload.accuracy?.sample > 0 && Number.isFinite(accuracy.payload.accuracy?.entryBars) && accuracy.payload.live?.roundTrips >= 0,
    JSON.stringify(accuracy.payload?.window).slice(0, 160),
  )

  const removedRulesBot = await call('DELETE', `/bots/${rulesBotId}`)
  check('DELETE the rules bot', removedRulesBot.status === 200, `got ${removedRulesBot.status}`)
}

// 9c. Bulk connections upload: two good rows + one bad; per-row result
{
  const upload = await call('POST', '/connections/bulk', {
    items: [
      { name: 'Bulk Alpaca test', exchange: 'Alpaca', apiKey: 'BULKALPACA0001', apiSecret: 'bulk-secret-not-real', mode: 'paper' },
      { name: 'Bulk Kraken test', exchange: 'Kraken', apiKey: 'BULKKRAKEN001', apiSecret: 'bulk-secret-not-real', mode: 'live' },
      { name: '', exchange: 'Coinbase', apiKey: '' },
    ],  })
  const createdNames = (upload.payload?.created ?? []).map((r) => r.name)
  const serialized = JSON.stringify(upload.payload)
  check(
    'POST /connections/bulk creates good rows',
    upload.status === 201 && createdNames.includes('Bulk Alpaca test') && createdNames.includes('Bulk Kraken test') && upload.payload.created?.find((c) => c.name === 'Bulk Alpaca test')?.mode === 'paper' && upload.payload.created?.find((c) => c.name === 'Bulk Kraken test')?.mode === 'live',
    JSON.stringify(createdNames).slice(0, 160),
  )
  check(
    'bulk upload reports the bad row without leaking secrets',
    upload.payload.failed?.[0]?.error && !serialized.includes('bulk-secret-not-real') && serialized.includes('••••'),
    JSON.stringify(upload.payload?.failed).slice(0, 140),
  )
  for (const conn of upload.payload?.created ?? []) await call('DELETE', `/connections/${conn.id}`)
  const afterBulk = await call('GET', '/connections')
  check('bulk-created connections deleted', afterBulk.status === 200 && !JSON.stringify(afterBulk.payload?.items ?? []).includes('Bulk Alpaca test'))
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

// 11. Cleanup the bots created for the test
{
  const removed = await call('DELETE', `/bots/${botId}`)
  check('DELETE /bots/:id', removed.status === 200, `got ${removed.status}`)
  if (importedBotId) {
    const removedImport = await call('DELETE', `/bots/${importedBotId}`)
    check('DELETE imported bot', removedImport.status === 200, `got ${removedImport.status}`)
  }
}

console.log(failures === 0 ? '\nAll API checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
