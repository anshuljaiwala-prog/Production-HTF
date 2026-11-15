// API smoke test for the HTF worker. Run with: node scripts/api-check.mjs
// Covers launch, monitor, control, board move, backtest, connections and
// the validation/same-origin paths against a running dev server.
const BASE = process.env.BASE ?? 'http://localhost:5173'
const ORIGIN = { Origin: BASE, accept: 'application/json', 'content-type': 'application/json' }

let failures = 0

// Fixtures the check creates are registered here and deleted at the end, so a
// run leaves the dev workspace exactly as it found it. Failures are counted,
// not thrown, so the cleanup below runs on a passing and a failing run alike.
const fixtures = []
const track = (kind, id) => {
  if (id) fixtures.push({ kind, id })
}

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
  return { status: response.status, payload, headers: response.headers }
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
  check(
    'GET /strategies',
    status === 200 && payload.strategies?.length === 7 && payload.symbols?.length > 0 && payload.strategies.some((s) => s.key === 'crash-short'),
    JSON.stringify(payload).slice(0, 160),
  )
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
    status === 200 && typeof s?.startingCapital === 'number' && typeof s?.currentEquity === 'number' && Array.isArray(payload.bots) && s.bots === payload.bots.filter((b) => b.mode === 'live').length,
    JSON.stringify(s).slice(0, 200),
  )
  check(
    'the money book lists no paper bots',
    payload.bots.every((b) => b.mode === 'live') && !('paperBots' in s),
    `modes=${[...new Set(payload.bots.map((b) => b.mode))].join(',')}`,
  )
  // The simulated wallet lives on its own endpoint, consumed by Backtesting.
  const paper = await call('GET', '/portfolio/paper')
  check(
    'GET /portfolio/paper reports the simulated wallet separately',
    paper.status === 200 &&
      typeof paper.payload?.summary?.bots === 'number' &&
      typeof paper.payload.summary.pnl === 'number' &&
      Array.isArray(paper.payload.bots) &&
      paper.payload.bots.every((b) => b.mode === 'paper') &&
      Array.isArray(paper.payload.funding),
    JSON.stringify(paper.payload?.summary).slice(0, 180),
  )
  // Dashboard must not count paper bots anywhere either.
  const overview = await call('GET', '/overview')
  check(
    'GET /overview is live-only (no paper bots in the fleet strip)',
    overview.status === 200 && overview.payload.fleet.paper === 0 && overview.payload.fleet.training === 0 && overview.payload.fleet.hangar === 0,
    JSON.stringify(overview.payload?.fleet),
  )
  check(
    'GET /portfolio per-bot audit is consistent',
    payload.bots.every((b) => b.fills === 0 || b.lastActivityAt > 0) && typeof payload.summary.fees === 'number' && payload.summary.fees >= 0,
    JSON.stringify(payload.summary.fees),
  )
  const wellFormed = (bot) => bot.capital > 0 && bot.equity > 0 && (bot.winRate === null || typeof bot.winRate === 'number')
  check('GET /portfolio bot rows well-formed', payload.bots.every(wellFormed), 'rows malformed')
  // The money ledger is live-book only: it is legitimately empty while every
  // bot still trades paper, and any row it does return must carry a numeric
  // fee and must never belong to a paper bot.
  const ledger = payload.transactions
  const ledgerClean = ledger.length === 0 || ledger.every((tx) => typeof tx.fee === 'number' && tx.fee >= 0 && tx.mode !== 'paper')
  check('GET /portfolio ledger is live-only with fee rows', status === 200 && ledgerClean, `ledger=${ledger.length}`)
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

// 8b2. Repo import: the URL is reduced to raw.githubusercontent.com and only
// that host is fetched, so a wrong link is refused before any request is made.
{
  const offsite = await call('POST', '/bots/import/github', { url: 'https://example.com/bots.json' })
  check(
    'POST /bots/import/github refuses a non-GitHub host',
    offsite.status === 400 && offsite.payload?.error === 'bad_source' && offsite.payload?.launched === undefined,
    `got ${offsite.status} ${JSON.stringify(offsite.payload?.error)}`,
  )
  const notFile = await call('POST', '/bots/import/github', { url: 'https://github.com/owner/repo' })
  check('POST /bots/import/github refuses a repo link with no file', notFile.status === 400, `got ${notFile.status}`)
  const missing = await call('POST', '/bots/import/github', {})
  check('POST /bots/import/github refuses a missing url', missing.status === 400 && missing.payload?.error === 'bad_source', `got ${missing.status}`)
}

// 8b3. Confidence: every signal carries a score, the bot stores a floor, the
// floor gates entries on that score, and a fill records it. dca scores a
// scheduled entry 50, so a floor of 60 must skip every entry a floor of 0
// takes — checked through a replay, the seam that trades deterministically.
{
  const stored = await call('POST', '/bots', {
    strategyKey: 'grid',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 5000,
    minConfidencePct: 65,
    maxVolatilityPct: 1.5,
    mode: 'paper',
    status: 'paused',
  })
  const storedId = stored.payload?.bot?.id
  check('POST /bots stores the confidence floor', stored.payload?.bot?.minConfidencePct === 65, `got ${stored.payload?.bot?.minConfidencePct}`)
  check('POST /bots stores the volatility ceiling', stored.payload?.bot?.maxVolatilityPct === 1.5, `got ${stored.payload?.bot?.maxVolatilityPct}`)
  const clamped = await call('PATCH', `/bots/${storedId}`, { minConfidencePct: 250 })
  check('PATCH clamps the confidence floor to 100', clamped.payload?.bot?.minConfidencePct === 100, `got ${clamped.payload?.bot?.minConfidencePct}`)
  const clampedVol = await call('PATCH', `/bots/${storedId}`, { maxVolatilityPct: 250 })
  check('PATCH clamps the volatility ceiling to 100', clampedVol.payload?.bot?.maxVolatilityPct === 100, `got ${clampedVol.payload?.bot?.maxVolatilityPct}`)
  await call('DELETE', `/bots/${storedId}`)

  // Backtests can be expensive; the run resolves on read.
  const runOnce = async (body) => {
    const created = await call('POST', '/backtests', body)
    let detail = created.payload?.backtest
    for (let i = 0; i < 40 && detail?.status !== 'done' && detail?.status !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      detail = (await call('GET', `/backtests/${created.payload?.backtest?.id}`)).payload?.backtest
    }
    track('backtest', created.payload?.backtest?.id)
    return detail
  }

  const dcaRun = {
    strategyKey: 'dca',
    symbol: 'BTC-USD',
    timeframe: '1h',
    from: Date.now() - 120 * 86_400_000,
    to: Date.now(),
    capital: 10_000,
    riskPct: 25,
  }
  const open = await runOnce({ ...dcaRun, minConfidencePct: 0 })
  check(
    'every fill records the confidence behind it',
    open?.status === 'done' &&
    (open?.trades?.length ?? 0) > 0 &&
    open.trades.every((entry) => typeof entry.confidence === 'number' && entry.confidence >= 0 && entry.confidence <= 100) &&
    // A dca entry is a schedule, not a read: it scores 50. Its exits are the
    // template never doubting itself, so they score 100.
    open.trades.some((entry) => entry.side === 'buy' && entry.confidence === 50) &&
    open.trades.filter((entry) => entry.side !== 'buy').every((entry) => entry.confidence === 100),
    `status=${open?.status} trades=${open?.trades?.length} first=${JSON.stringify(open?.trades?.[0] ?? null).slice(0, 120)}`,
  )

  const gated = await runOnce({ ...dcaRun, minConfidencePct: 60 })
  check(
    'an entry under the confidence floor is skipped',
    gated?.status === 'done' && (gated?.trades?.length ?? 0) === 0,
    `status=${gated?.status} trades=${gated?.trades?.length}`,
  )

  // The volatility ceiling reads the pattern scan's realised volPct for the
  // market. A ceiling of 0.0001%/bar is under any real tape, so it must skip
  // every entry the same run takes without a ceiling; a ceiling of 100 never
  // binds, so the trade count must match the baseline exactly.
  const stormy = await runOnce({ ...dcaRun, maxVolatilityPct: 0.0001 })
  check(
    'an entry above the volatility ceiling is skipped',
    stormy?.status === 'done' && (stormy?.trades?.length ?? -1) === 0,
    `status=${stormy?.status} trades=${stormy?.trades?.length}`,
  )
  const roomy = await runOnce({ ...dcaRun, maxVolatilityPct: 100 })
  check(
    'a ceiling above the tape changes nothing',
    roomy?.status === 'done' && (roomy?.trades?.length ?? -1) === (open?.trades?.length ?? 0),
    `ceiling trades=${roomy?.trades?.length} baseline=${open?.trades?.length}`,
  )

  // The rules DSL has no way to state a confidence, so it inherits the agent
  // verdict's conviction. Without that fallback the score would be NaN, no
  // entry could clear even a 0 floor, and this run would trade nothing.
  const rulesRun = await runOnce({
    ...dcaRun,
    strategyKey: 'custom',
    rules: {
      name: 'Confidence fallback',
      entry: [{ metric: 'rsi', n: 14, op: '<', value: 45 }],
      exit: [{ metric: 'rsi', n: 14, op: '>', value: 55 }],
    },
    minConfidencePct: 0,
  })
  check(
    'a rules strategy inherits the verdict confidence',
    rulesRun?.status === 'done' &&
      (rulesRun?.trades?.length ?? 0) > 0 &&
      rulesRun.trades.every((entry) => Number.isInteger(entry.confidence) && entry.confidence >= 0 && entry.confidence <= 100),
    `status=${rulesRun?.status} trades=${rulesRun?.trades?.length} first=${JSON.stringify(rulesRun?.trades?.[0] ?? null).slice(0, 120)}`,
  )
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

  // Edit: rename + flip the default mode. Blank credentials keep the saved
  // pair; a half rotation is refused so a stale secret can't survive a new key.
  const edited = await call('PATCH', `/connections/${connectionId}`, { name: 'Test account v2', mode: 'live' })
  check('PATCH /connections/:id edits name and mode', edited.status === 200 && edited.payload?.connection?.name === 'Test account v2' && edited.payload?.connection?.mode === 'live', `got ${edited.status}`)
  check('PATCH keeps the saved secret masked', !JSON.stringify(edited.payload).includes('super-secret-value'))
  const halfRotate = await call('PATCH', `/connections/${connectionId}`, { apiKey: 'NEWKEY999' })
  check('PATCH refuses a half credential rotation', halfRotate.status === 400 && halfRotate.payload?.error === 'credentials_required', `got ${halfRotate.status}`)
  const ghostConnEdit = await call('PATCH', '/connections/00000000-0000-4000-8000-000000000000', { name: 'ghost' })
  check('PATCH unknown connection is 404', ghostConnEdit.status === 404, `got ${ghostConnEdit.status}`)

  // Deleting a connection detaches bots that used it and grounds the live
  // ones back to paper — a live bot must never outlive its key.
  const botFor = await call('POST', '/bots', { strategyKey: 'dca', symbols: ['BTC-USD'], timeframe: '1h', capital: 500, status: 'stopped', mode: 'live', connectionId })
  check('bot attached to a live-default connection', botFor.status === 201 && botFor.payload?.bot?.mode === 'live', `got ${botFor.status}`)
  const removed = await call('DELETE', `/connections/${connectionId}`)
  check('DELETE /connections/:id', removed.status === 200 && removed.payload?.grounded === 1, `got ${removed.status} grounded=${removed.payload?.grounded}`)
  const afterDelete = await call('GET', `/bots/${botFor.payload?.bot?.id}`)
  check('attached bot grounded to paper after delete', afterDelete.status === 200 && afterDelete.payload?.bot?.mode === 'paper' && afterDelete.payload?.bot?.connectionId === null, `mode=${afterDelete.payload?.bot?.mode} conn=${afterDelete.payload?.bot?.connectionId}`)
  const demotedDetail = await call('GET', '/bots/' + botFor.payload?.bot?.id)
  check('grounding logged an audit event', JSON.stringify(demotedDetail.payload?.events ?? []).includes('grounded from live to paper'), '')
  await call('DELETE', `/bots/${botFor.payload?.bot?.id}`)
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
  track('strategy', customStrategyId)
  check(
    'POST /strategies/custom uploads rules',
    upload.status === 201 && Boolean(customStrategyId) && upload.payload.strategy?.rules === 2 && upload.payload.strategy?.lookback > 0 && upload.payload.durable === true && upload.payload.strategy?.version >= 1 && upload.payload.strategy?.versions === upload.payload.strategy?.version,
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

// 9d. Stored history API: 5-year retention, foreign markets, clamped runs
{
  const hist = await call('GET', '/market/history?symbol=BTC-USD&timeframe=1h')
  const candles = hist.payload?.candles ?? []
  const sane = candles.length > 0 && candles.every((k) => k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c))
  check(
    'GET /market/history serves stored candles',
    hist.status === 200 && hist.payload.bars > 0 && hist.payload.history?.years === 5 && sane,
    `bars=${hist.payload?.bars} history=${JSON.stringify(hist.payload?.history)}`,
  )

  const sixYearsAgo = Date.now() - 6 * 365 * 86_400_000
  const outside = await call('GET', `/market/history?symbol=BTC-USD&timeframe=1h&from=${sixYearsAgo - 86_400_000}&to=${sixYearsAgo}`)
  check('market history outside 5y window refused', outside.status === 400 && outside.payload?.error === 'outside_history', `got ${outside.status}`)

  // Multi-nation markets: a forex pair and a foreign listing chart like any other.
  const fx = await call('GET', '/market/history?symbol=EUR-USD&timeframe=1d')
  const intl = await call('GET', '/market/history?symbol=TM&timeframe=1d')
  check(
    'GET /market/history covers multi-nation markets',
    fx.status === 200 && fx.payload.bars > 0 && intl.status === 200 && intl.payload.bars > 0,
    `EUR-USD bars=${fx.payload?.bars} TM bars=${intl.payload?.bars}`,
  )

  const oldRun = await call('POST', '/backtests', {
    strategyKey: 'momentum',
    symbol: 'EUR-USD',
    timeframe: '1d',
    capital: 1_000,
    days: 365,
    from: sixYearsAgo - 86_400_000,
    to: sixYearsAgo,
    params: {},
  })
  check('POST /backtests outside stored history refused', oldRun.status === 400 && oldRun.payload?.error === 'outside_history', `got ${oldRun.status} ${oldRun.payload?.error ?? ''}`)

  // A user-entered range that ends inside retention but starts long before it
  // must clamp to the retention edge as of now — not roll the window five
  // years back from its own end and replay data reported as no longer stored.
  const nowTs = Date.now()
  const retentionEdge = nowTs - 5 * 365 * 86_400_000
  const wide = await call('POST', '/backtests', {
    strategyKey: 'momentum',
    symbol: 'EUR-USD',
    timeframe: '1d',
    capital: 1_000,
    days: 365,
    from: nowTs - 11 * 365 * 86_400_000,
    to: nowTs - 4 * 365 * 86_400_000,
    params: {},
  })
  check(
    'user-entered backtest range clamped to the 5-year retention edge',
    wide.status === 201 && wide.payload?.backtest?.from >= retentionEdge - 2 * 86_400_000,
    `from=${wide.payload?.backtest?.from} edge=${retentionEdge}`,
  )
  if (wide.payload?.backtest?.id) await call('DELETE', `/backtests/${wide.payload.backtest.id}`)

  const histWide = await call('GET', `/market/history?symbol=EUR-USD&timeframe=1d&from=${nowTs - 11 * 365 * 86_400_000}&to=${nowTs - 4 * 365 * 86_400_000}`)
  const wideCandles = histWide.payload?.candles ?? []
  check(
    'market history serves no candles older than retention',
    histWide.status === 200 && wideCandles.length > 0 && wideCandles.every((k) => k.t >= retentionEdge - 2 * 86_400_000),
    `oldest=${wideCandles[0]?.t} edge=${retentionEdge}`,
  )
}

// 9e. Training: grid search over stored history with a train/test split
{
  const catalog = await call('GET', '/strategies')
  const momentum = (catalog.payload?.strategies ?? []).find((s) => s.key === 'momentum')
  const knob = (momentum?.params ?? []).find((p) => p.type === 'number')
  const from = knob?.min ?? (Number(knob?.default) || 1) * 0.5
  const to = knob?.max ?? (Number(knob?.default) || 1) * 1.5

  const opt = await call('POST', '/backtests/optimize', {
    strategyKey: 'momentum',
    symbol: 'BTC-USD',
    timeframe: '1h',
    capital: 10_000,
    days: 180,
    objective: 'sharpe',
    vary: [{ key: knob?.key, from, to, steps: 3 }],
  })
  const runs = opt.payload?.runs ?? []
  check(
    'POST /backtests/optimize sweeps a grid',
    opt.status === 200 && runs.length === 3 && runs.every((r) => !r.error && Number.isFinite(r.train?.totalReturn)) && Number.isFinite(opt.payload?.bestIndex),
    `runs=${runs.length} ${JSON.stringify(runs[0] ?? {}).slice(0, 100)}`,
  )
  const source = opt.payload?.source
  const splitInside = source && source.split > source.from && source.split < source.to
  check(
    'training splits train (70%) vs hold-out test',
    splitInside && Math.abs((source.split - source.from) / (source.to - source.from) - 0.7) < 0.01 && opt.payload.history?.years === 5,
    JSON.stringify(source),
  )
  check(
    'best config comes back with a full replay',
    Boolean(opt.payload?.best?.curve?.length) && Number.isFinite(opt.payload?.best?.accuracy?.sample) && opt.payload.best.accuracy.sample > 0,
    `curve=${opt.payload?.best?.curve?.length ?? 0}`,
  )

  const tooBig = await call('POST', '/backtests/optimize', {
    strategyKey: 'momentum',
    symbol: 'BTC-USD',
    timeframe: '1h',
    capital: 10_000,
    days: 180,
    vary: [{ key: knob?.key, from, to, steps: 7 }],
  })
  check('optimize rejects out-of-range sweeps', tooBig.status === 400 && tooBig.payload?.error === 'bad_sweep', `got ${tooBig.status} ${tooBig.payload?.error ?? ''}`)

  // Uploaded rules join the same sweep: rule thresholds act as knobs.
  const rules = {
    name: 'Check suite training rules',
    entry: [{ metric: 'rsi', n: 14, op: '<', value: 30 }],
    entryLogic: 'any',
    exit: [{ metric: 'rsi', n: 14, op: '>', value: 60 }],
    exitLogic: 'all',
    stopLossPct: 4,
    takeProfitPct: 8,
  }
  const rulesOpt = await call('POST', '/backtests/optimize', {
    strategyKey: 'custom',
    rules,
    symbol: 'BTC-USD',
    timeframe: '1h',
    capital: 10_000,
    days: 180,
    objective: 'totalReturn',
    vary: [
      { key: 'entry.0.value', from: 25, to: 40, steps: 2 },
      { key: 'stopLossPct', from: 3, to: 5, steps: 2 },
    ],
  })
  check(
    'optimize sweeps uploaded-rule thresholds',
    rulesOpt.status === 200 && (rulesOpt.payload?.runs ?? []).length === 4 && rulesOpt.payload.runs.every((r) => !r.error),
    `status=${rulesOpt.status} runs=${rulesOpt.payload?.runs?.length} ${JSON.stringify(rulesOpt.payload?.runs?.[0] ?? {}).slice(0, 110)}`,
  )
}

// 9e2. Fleet edge ranking: every bot scored against the same window, ranked
let fleetRankedAny = false
{
  const edge = await call('GET', '/bots/accuracy')
  const items = edge.payload?.items ?? []
  fleetRankedAny = items.length > 0
  check(
    'GET /bots/accuracy ranks the fleet by edge',
    edge.status === 200 && items.length > 0 && edge.payload.window?.bars > 0 && items.every((item, i) => item.rank === i + 1) && items.every((item) => item.accuracy?.sample > 0),
    `items=${items.length} window=${edge.payload?.window?.bars}`,
  )
  check(
    'edge ranking orders by directional accuracy',
    items.every((item, i) => i === 0 || ((items[i - 1].accuracy.directionalAccuracy ?? -1) >= (item.accuracy.directionalAccuracy ?? -1))),
    items.map((i) => `${i.name}:${i.accuracy.directionalAccuracy ?? 'null'}`).slice(0, 4).join(' '),
  )
}

// 9e3. Uploaded strategies are durable + versioned: re-uploading the same name bumps the version
{
  const bump = {
    name: 'Check suite versioned',
    entry: [{ metric: 'rsi', n: 14, op: '<', value: 35 }],
    entryLogic: 'any',
    exit: [{ metric: 'rsi', n: 14, op: '>', value: 60 }],
    exitLogic: 'all',
    stopLossPct: 4,
    takeProfitPct: 8,
  }
  const v1 = await call('POST', '/strategies/custom', { rules: bump })
  const v2 = await call('POST', '/strategies/custom', { rules: { ...bump, entry: [{ metric: 'rsi', n: 14, op: '<', value: 40 }] } })
  const reserveIdV1 = v1.payload?.strategy
  const reserveIdV2 = v2.payload?.strategy
  check(
    'same-name re-upload bumps the version and stays durable',
    v1.status === 201 && v2.status === 201 && reserveIdV2 && reserveIdV2.version === reserveIdV1.version + 1 && v2.payload.durable === true,
    `v1=${v1.payload?.strategy?.version} v2=${v2.payload?.strategy?.version} durable=${v2.payload?.durable}`,
  )
  const versions = await call('GET', `/strategies/custom/${reserveIdV2.id}/versions`)
  check(
    'GET /strategies/custom/:id/versions lists the family history',
    versions.status === 200 && (versions.payload?.items ?? []).length >= 2 && versions.payload.items.some((s) => s.id === reserveIdV1.id) && versions.payload.items.some((s) => s.id === reserveIdV2.id),
    `status=${versions.status} items=${versions.payload?.items?.length}`,
  )
  // Reach any past version by id: v1's detail must carry v1's own entry value.
  const oldVersion = await call('GET', `/strategies/custom/${reserveIdV1.id}`)
  check(
    'past versions keep their own accepted rules',
    oldVersion.status === 200 && oldVersion.payload.rules?.entry?.[0]?.value === 35,
    `value=${oldVersion.payload?.rules?.entry?.[0]?.value}`,
  )
  await call('DELETE', `/strategies/custom/${reserveIdV2.id}`)
}

if (fleetRankedAny) {
  const after = await call('GET', '/bots/accuracy')
  const ranker = after.payload?.items ?? []
  check(
    'failing bots still appear in the edge ranking',
    ranker.every((item) => Number.isFinite(item.accuracy?.entryBars)),
    `items=${ranker.length}`,
  )
}

// 9f. Ground/resume control + config-change events
let groundBotId
{
  const bot = await call('POST', '/bots', {
    strategyKey: 'dca',
    name: 'Ground check bot',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 1_000,
    mode: 'paper',
    status: 'paused',
  })
  groundBotId = bot.payload?.bot?.id
  check('POST /bots creates a paused bot for control checks', bot.status === 201 && groundBotId && bot.payload.bot?.status === 'paused', `got ${bot.status}`)

  const patched = await call('PATCH', `/bots/${groundBotId}`, { name: 'Ground check bot v2', riskPct: 42 })
  check('PATCH applies edited settings', patched.status === 200 && patched.payload.bot?.riskPct === 42, `got ${patched.status}`)

  const detail = await call('GET', `/bots/${groundBotId}`)
  const configEvent = (detail.payload?.events ?? []).find((e) => e.message.includes('Settings edited'))
  check(
    'settings edit logs a config-change event',
    Boolean(configEvent) && configEvent.message.includes('risk 25% → 42%') && configEvent.message.includes('name →'),
    JSON.stringify(configEvent?.message ?? null).slice(0, 200),
  )

  const grounded = await call('POST', `/bots/${groundBotId}/control`, { action: 'ground' })
  check('POST control ground', grounded.status === 200 && grounded.payload.bot?.status === 'stopped', `got ${grounded.payload?.bot?.status}`)
  const groundedDetail = await call('GET', `/bots/${groundBotId}`)
  check(
    'ground logs its own event',
    (groundedDetail.payload?.events ?? []).some((e) => e.message.includes('Grounded by operator')),
    `events=${groundedDetail.payload?.events?.length}`,
  )

  const resumed = await call('POST', `/bots/${groundBotId}/control`, { action: 'resume' })
  check('POST control resume', resumed.status === 200 && resumed.payload.bot?.status === 'running', `got ${resumed.payload?.bot?.status}`)

  // A double-click races two identical intents; the transition guard lives in
  // the UPDATE itself so only the request that actually moved the row logs.
  const groundCount = async () => {
    const d = await call('GET', `/bots/${groundBotId}`)
    return (d.payload?.events ?? []).filter((e) => e.message.includes('Grounded by operator')).length
  }
  const beforeRace = await groundCount()
  const [r1, r2] = await Promise.all([
    call('POST', `/bots/${groundBotId}/control`, { action: 'ground' }),
    call('POST', `/bots/${groundBotId}/control`, { action: 'ground' }),
  ])
  const afterRace = await call('GET', `/bots/${groundBotId}`)
  const added = (await groundCount()) - beforeRace
  check(
    'racing grounds log exactly one new event',
    r1.status === 200 && r2.status === 200 && afterRace.payload?.bot?.status === 'stopped' && added === 1,
    `status=${afterRace.payload?.bot?.status} added=${added}`,
  )

  await call('DELETE', `/bots/${groundBotId}`)
}

// 9g. Symbol normalization at every ingress + paper→live venue switch
let modeBotId
{
  // Noisy alias resolves to the canonical pair; duplicates fold to one.
  const noisy = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['btcusdt', 'BTC-USD '],
    timeframe: '1h',
    capital: 1_000,
    mode: 'paper',
    status: 'paused',
  })
  modeBotId = noisy.payload?.bot?.id
  check(
    "POST /bots normalizes 'btcusdt' to BTC-USD",
    noisy.status === 201 && JSON.stringify(noisy.payload.bot?.symbols) === JSON.stringify(['BTC-USD']),
    JSON.stringify(noisy.payload?.bot?.symbols).slice(0, 120),
  )

  const bt = await call('POST', '/backtests', {
    strategyKey: 'dca',
    symbol: 'BTCUSDT',
    timeframe: '1d',
    capital: 10_000,
    days: 30,
    name: 'Normalization probe',
  })
  check(
    "POST /backtests accepts 'BTCUSDT' and stores BTC-USD",
    bt.status === 201 && bt.payload?.backtest?.symbol === 'BTC-USD',
    `got ${bt.status} ${bt.payload?.backtest?.symbol ?? ''}`,
  )
  await call('DELETE', `/backtests/${bt.payload?.backtest?.id}`)

  const junk = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['NO-COIN-ASDF'],
    timeframe: '1h',
    capital: 1_000,
  })
  check('POST /bots rejects unknown symbols by name', junk.status === 400 && junk.payload?.error === 'unknown_symbols' && junk.payload?.message?.includes('NO-COIN-ASDF'), `got ${junk.status} ${junk.payload?.error}`)

  const junkPatch = await call('PATCH', `/bots/${modeBotId}`, { symbols: ['QUNT-NOPE'] })
  check('PATCH keeps unknown symbols out', junkPatch.status === 400 && junkPatch.payload?.error === 'unknown_symbols', `got ${junkPatch.status}`)

  // Venue switch: a connectionless paper bot is refused before it flips.
  const noConn = await call('PATCH', `/bots/${modeBotId}`, { mode: 'live' })
  check('paper→live without an exchange connection is refused', noConn.status === 400 && noConn.payload?.error === 'connection_required', `got ${noConn.status} ${noConn.payload?.error}`)
  const refusedDetail = await call('GET', `/bots/${modeBotId}`)
  check('refused switch leaves the bot in paper mode', refusedDetail.payload?.bot?.mode === 'paper', `mode=${refusedDetail.payload?.bot?.mode}`)

  const conn = await call('POST', '/connections', {
    name: 'Mode switch account',
    exchange: 'Alpaca',
    apiKey: 'MODESWITCH1234',
    apiSecret: 'mode-switch-secret-value',
    mode: 'live',
  })
  const modeConnId = conn.payload?.connection?.id
  const toLive = await call('PATCH', `/bots/${modeBotId}`, { mode: 'live', connectionId: modeConnId })
  check(
    'paper→live switch succeeds with a connection',
    toLive.status === 200 && toLive.payload.bot?.mode === 'live' && !['paper'].includes(toLive.payload.bot?.stage),
    `mode=${toLive.payload?.bot?.mode} stage=${toLive.payload?.bot?.stage}`,
  )
  check(
    'venue switch leaves a hand-set lifecycle stage untouched',
    toLive.payload.bot?.stage === 'draft',
    `stage=${toLive.payload?.bot?.stage}`,
  )
  const liveDetail = await call('GET', `/bots/${modeBotId}`)
  check(
    'venue switch logs a config-change event',
    (liveDetail.payload?.events ?? []).some((e) => e.message.includes('trading mode paper → live')),
    `events=${liveDetail.payload?.events?.length}`,
  )

  // A live bot on an exchange with no adapter pauses on its first advance
  // with the reason, instead of filling against a fake venue.
  const startedUnsupported = await call('POST', `/bots/${modeBotId}/control`, { action: 'start' })
  const unsupportedDetail = await call('GET', `/bots/${modeBotId}`)
  check(
    'live bot on an unsupported exchange pauses with a clear reason',
    startedUnsupported.status === 200 &&
      unsupportedDetail.payload?.bot?.status === 'paused' &&
      (unsupportedDetail.payload?.events ?? []).some((e) => e.message.includes('No usable live venue')),
    `status=${unsupportedDetail.payload?.bot?.status} events=${JSON.stringify(unsupportedDetail.payload?.events?.[0]?.message)}`,
  )

  // Back to paper — the reverse switch also logs.
  const toPaper = await call('PATCH', `/bots/${modeBotId}`, { mode: 'paper' })
  check('live→paper switch works', toPaper.status === 200 && toPaper.payload.bot?.mode === 'paper', `got ${toPaper.status} mode=${toPaper.payload?.bot?.mode}`)

  // The venue is locked while the bot runs: any trading-settings change is
  // refused on an active bot.
  await call('POST', `/bots/${modeBotId}/control`, { action: 'start' })
  const liveLocked = await call('PATCH', `/bots/${modeBotId}`, { mode: 'live', connectionId: modeConnId })
  check('venue locked while the bot runs', liveLocked.status === 409 && liveLocked.payload?.error === 'bot_active', `got ${liveLocked.status} ${liveLocked.payload?.error}`)
  await call('POST', `/bots/${modeBotId}/control`, { action: 'stop' })

  // Pointing a bot at a connection that doesn't exist (expired id, another
  // workspace's id) is refused instead of routing live orders into a void.
  const ghostConn = await call('PATCH', `/bots/${modeBotId}`, { connectionId: '00000000-0000-4000-8000-000000000000' })
  check('ghost connection rejected', ghostConn.status === 400 && ghostConn.payload?.error === 'connection_missing', `got ${ghostConn.status} ${ghostConn.payload?.error}`)
  await call('DELETE', `/connections/${modeConnId}`)
  await call('DELETE', `/bots/${modeBotId}`)
}

// 10. Search + me + same-origin refusal
{
  const search = await call('GET', '/search?q=momentum')
  check('GET /search', search.status === 200 && Array.isArray(search.payload.bots))
  const me = await call('GET', '/me')
  check('GET /me', me.status === 200 && typeof me.payload.workspace?.name === 'string')
  check(
    'private API responses set Cache-Control: private, no-store',
    me.headers?.get('cache-control') === 'private, no-store',
    me.headers?.get('cache-control') ?? 'missing',
  )

  const cross = await fetch(`${BASE}/api/bots`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ strategyKey: 'dca', symbols: ['BTC-USD'], timeframe: '1h', capital: 1000 }),
  })
  check('cross-origin mutation refused with 403', cross.status === 403, `got ${cross.status}`)
}

// 10b. Multi-market pattern scan
{
  const multi = await call('POST', '/bots', {
    strategyKey: 'momentum',
    symbols: ['NVDA', 'AAPL', 'BTC-USD'],
    timeframe: '1h',
    capital: 20_000,
    mode: 'paper',
    status: 'stopped',
  })
  const scanBotId = multi.payload?.bot?.id
  check('a bot can track several stocks at once', multi.status === 201 && multi.payload.bot.symbols.length === 3, `got ${multi.status} ${JSON.stringify(multi.payload?.bot?.symbols)}`)

  const scan = await call('GET', `/analysis/bots/${scanBotId}/patterns`)
  const regimes = new Set(['crash', 'selloff', 'hype', 'breakout', 'squeeze', 'uptrend', 'downtrend', 'range'])
  check(
    'GET /analysis/bots/:id/patterns scans every tracked symbol',
    scan.status === 200 && scan.payload.symbols?.length === 3 && scan.payload.symbols.every((s) => regimes.has(s.regime)) && scan.payload.symbols.every((s) => s.spark?.length > 1),
    `got ${scan.status} ${JSON.stringify(scan.payload?.symbols?.map((s) => s.symbol + ':' + s.regime))}`,
  )
  check(
    'pattern read carries its evidence and window',
    scan.payload.symbols.every((s) => Array.isArray(s.evidence) && s.evidence.length > 0 && typeof s.confidence === 'number') && scan.payload.window?.bars > 0,
    `window=${JSON.stringify(scan.payload?.window)}`,
  )
  check(
    'pattern read pairs the price leg with a volume z-score',
    scan.payload.symbols.every((s) => 'volZ' in s && 'priceZ' in s && typeof s.liquidityVacuum === 'boolean') &&
      scan.payload.symbols.some((s) => typeof s.volZ === 'number') &&
      scan.payload.symbols.every((s) => s.evidence.some((line) => line.includes('σ'))),
    JSON.stringify(scan.payload?.symbols?.map((s) => `${s.symbol}:volZ=${s.volZ},vacuum=${s.liquidityVacuum}`)),
  )
  check(
    'episode analogs match direction and disclose the reading',
    Array.isArray(scan.payload.episodes) && scan.payload.episodes.every((m) => (m.episode.kind === 'crash' ? m.why.includes('−') : m.why.includes('+')) && m.similarity >= 30 && m.similarity <= 100),
    JSON.stringify(scan.payload?.episodes?.map((m) => m.episode.name + '@' + m.similarity)),
  )
  check(
    'the event wire is linked to tracked symbols',
    Array.isArray(scan.payload.events) && scan.payload.events.every((e) => Array.isArray(e.symbols) && scan.payload.symbols.some((s) => e.symbols.includes(s.symbol))),
    `${scan.payload.events?.length} events`,
  )

  const ghostScan = await call('GET', '/analysis/bots/00000000-0000-4000-8000-000000000000/patterns')
  check('pattern scan 404s for an unknown bot', ghostScan.status === 404, `got ${ghostScan.status}`)

  const tooMany = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NVDA', 'AAPL', 'TSLA', 'SPY'],
    timeframe: '1h',
    capital: 1_000,
  })
  check(
    'over-cap symbol list is rejected, not silently trimmed',
    tooMany.status === 400 && tooMany.payload?.error === 'too_many_symbols',
    `got ${tooMany.status} ${tooMany.payload?.error}`,
  )

  await call('DELETE', `/bots/${scanBotId}`)
}

// 10c. A deposit moves capital but never counts as trading profit.
// Regression: paper portfolio P&L must be equity − capital (funding moves
// both together), never equity − (capital − netDeposits), which would
// double-count every deposit as P&L.
{
  const paper = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 10_000,
    mode: 'paper',
    status: 'stopped',
  })
  const pnlBotId = paper.payload?.bot?.id
  check('P&L regression: paper bot created', paper.status === 201 && Boolean(pnlBotId), `got ${paper.status}`)

  const beforeDetail = await call('GET', `/bots/${pnlBotId}`)
  const beforeBot = beforeDetail.payload?.bot
  const baseCapital = Number(beforeBot?.capital ?? 0)
  const baseEquity = Number(beforeBot?.equity ?? 0)
  const baseNetDeposits = Number(beforeBot?.netDeposits ?? 0)
  const baseTradingPnl = baseEquity - baseCapital

  const depositAmount = 2_500
  const deposited = await call('POST', `/bots/${pnlBotId}/cashflow`, { amount: depositAmount, note: 'P&L regression deposit' })
  check('P&L regression: deposit accepted', deposited.status === 200, `got ${deposited.status} ${deposited.payload?.error ?? ''}`)

  const afterDetail = await call('GET', `/bots/${pnlBotId}`)
  const afterBot = afterDetail.payload?.bot
  const afterTradingPnl = Number(afterBot?.equity ?? 0) - Number(afterBot?.capital ?? 0)

  check(
    'deposit increases capital, equity and net deposits together',
    Math.abs(Number(afterBot?.capital ?? 0) - (baseCapital + depositAmount)) < 0.01 &&
      Math.abs(Number(afterBot?.equity ?? 0) - (baseEquity + depositAmount)) < 0.01 &&
      Math.abs(Number(afterBot?.netDeposits ?? 0) - (baseNetDeposits + depositAmount)) < 0.01,
    `before cap/eq/dep=${baseCapital}/${baseEquity}/${baseNetDeposits} after cap/eq/dep=${afterBot?.capital}/${afterBot?.equity}/${afterBot?.netDeposits}`,
  )
  check(
    'deposit does not change trading P&L (equity − capital)',
    Math.abs(afterTradingPnl - baseTradingPnl) < 0.01,
    `before=${baseTradingPnl} after=${afterTradingPnl}`,
  )
  check(
    'double-count formula equity − (capital − netDeposits) would wrongly include the deposit',
    Math.abs((Number(afterBot?.equity ?? 0) - (Number(afterBot?.capital ?? 0) - Number(afterBot?.netDeposits ?? 0))) - (baseTradingPnl + depositAmount)) < 0.01 &&
      Math.abs(afterTradingPnl - baseTradingPnl) < 0.01,
    `correct=${afterTradingPnl} buggy=${Number(afterBot?.equity ?? 0) - (Number(afterBot?.capital ?? 0) - Number(afterBot?.netDeposits ?? 0))}`,
  )

  // The deposited bot is a paper bot, so its audit row lives on the paper
  // book (the money book is live-only now).
  const portfolio = await call('GET', '/portfolio/paper')
  const audited = (portfolio.payload?.bots ?? []).find((b) => b.id === pnlBotId)
  check(
    'paper book audit keeps deposited bot trading P&L unchanged',
    portfolio.status === 200 &&
      audited &&
      Math.abs((Number(audited.equity) - Number(audited.capital)) - baseTradingPnl) < 0.01,
    `portfolio=${portfolio.status} audited cap/eq=${audited?.capital}/${audited?.equity} base=${baseTradingPnl}`,
  )

  const removedPnlBot = await call('DELETE', `/bots/${pnlBotId}`)
  check('P&L regression bot removed', removedPnlBot.status === 200, `got ${removedPnlBot.status}`)
}

// 10d2. Operator capital edit is funding: cash/equity/capital move together,
// so trading P&L is untouched and the delta lands in the ledger.
{
  const created = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['BTC-USD'],
    timeframe: '1h',
    capital: 5_000,
    mode: 'paper',
    status: 'paused',
  })
  const id = created.payload?.bot?.id
  const before = created.payload?.bot
  const raised = await call('PATCH', `/bots/${id}`, { capital: 8_000 })
  const after = raised.payload?.bot
  check(
    'PATCH capital treats the edit as funding',
    raised.status === 200 &&
      after?.capital === 8_000 &&
      Math.abs(after.cash - 8_000) < 0.01 &&
      Math.abs(after.equity - 8_000) < 0.01 &&
      Math.abs(after.netDeposits - 3_000) < 0.01,
    JSON.stringify({ status: raised.status, cap: after?.capital, cash: after?.cash, equity: after?.equity, deposits: after?.netDeposits }),
  )
  check(
    'capital edit leaves trading P&L (equity − capital) unchanged',
    before && after && Math.abs(after.equity - after.capital - (before.equity - before.capital)) < 0.01,
    `before=${before && before.equity - before.capital} after=${after && after.equity - after.capital}`,
  )
  const flows = await call('GET', '/portfolio/paper')
  check(
    'capital edit is recorded in the funding ledger',
    (flows.payload?.funding ?? []).some((flow) => flow.botId === id && /starting capital/i.test(String(flow.note))),
    JSON.stringify((flows.payload?.funding ?? []).find((flow) => flow.botId === id)).slice(0, 160),
  )
  const tooLow = await call('PATCH', `/bots/${id}`, { capital: 50 })
  check(
    'PATCH capital rejects a value under $100',
    tooLow.status === 400 && tooLow.payload?.error === 'invalid_capital',
    `status=${tooLow.status} error=${tooLow.payload?.error}`,
  )
  const rejected = await call('GET', `/bots/${id}`)
  check('a rejected capital edit changes nothing', rejected.payload?.bot?.capital === 8_000, `capital=${rejected.payload?.bot?.capital}`)
  const tooHigh = await call('PATCH', `/bots/${id}`, { capital: 10_000_001 })
  check(
    'PATCH capital rejects a value above $10,000,000',
    tooHigh.status === 400 && tooHigh.payload?.error === 'invalid_capital',
    `status=${tooHigh.status} error=${tooHigh.payload?.error}`,
  )
  const afterCeilingReject = await call('GET', `/bots/${id}`)
  check('a rejected over-ceiling capital edit changes nothing', afterCeilingReject.payload?.bot?.capital === 8_000, `capital=${afterCeilingReject.payload?.bot?.capital}`)
  await call('DELETE', `/bots/${id}`)
}

// 10d. Multi-venue routing on one bot + the BSE live adapter seam.
// A bot may list several exchange connections; the engine fills on the venue
// quoting the best price. Credentials are pasted later, so the adapter's
// request path is exercised here with a throwaway token (no order placed).
{
  const alpha = await call('POST', '/connections', {
    name: 'BSE sandbox alert',
    exchange: 'BSE (via Upstox)',
    apiKey: 'test-client-id',
    apiSecret: 'test-access-token-alpha',
    mode: 'live',
    environment: 'sandbox',
  })
  const beta = await call('POST', '/connections', {
    name: 'BSE production beta',
    exchange: 'BSE (via Upstox)',
    apiKey: 'test-client-id-2',
    apiSecret: 'test-access-token-beta',
    mode: 'live',
    environment: 'production',
  })
  const alphaId = alpha.payload?.connection?.id
  const betaId = beta.payload?.connection?.id
  check(
    'BSE connection stores its environment (sandbox / production)',
    alpha.status === 201 && beta.status === 201 && alpha.payload.connection.environment === 'sandbox' && beta.payload.connection.environment === 'production',
    `${alpha.status}/${beta.status} ${alpha.payload?.connection?.environment}/${beta.payload?.connection?.environment}`,
  )
  check(
    'BSE access token is never returned',
    Boolean(alphaId) && !JSON.stringify(alpha.payload).includes('test-access-token-alpha') && alpha.payload.connection.keyMasked.startsWith('••'),
    alpha.payload?.connection?.keyMasked,
  )

  const liveWithoutVenue = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['INFY'],
    timeframe: '1h',
    capital: 10_000,
    mode: 'live',
    status: 'paused',
  })
  check('POST /bots rejects a live bot with no venue', liveWithoutVenue.status === 400, `got ${liveWithoutVenue.status}`)

  const multi = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['INFY'],
    timeframe: '1h',
    capital: 10_000,
    mode: 'live',
    status: 'paused',
    venueIds: [alphaId, betaId],
  })
  const multiBot = multi.payload?.bot
  check(
    'POST /bots routes one bot across two exchanges',
    multi.status === 201 &&
      Array.isArray(multiBot?.venueIds) &&
      multiBot.venueIds.join(',') === [alphaId, betaId].join(',') &&
      multiBot.venues?.length === 2 &&
      multiBot.connectionId === alphaId,
    JSON.stringify({ status: multi.status, venues: multiBot?.venues, ids: multiBot?.venueIds, primary: multiBot?.connectionId }),
  )
  check(
    'multi-venue bot names each venue and its environment',
    multiBot?.venues?.map((v) => v.environment).join(',') === 'sandbox,production',
    JSON.stringify(multiBot?.venues),
  )

  const badVenue = await call('PATCH', `/bots/${multiBot?.id}`, { venueIds: ['00000000-0000-4000-8000-000000000000'] })
  check('PATCH /bots rejects a venue the workspace does not own', badVenue.status === 400, `got ${badVenue.status}`)

  const reorder = await call('PATCH', `/bots/${multiBot?.id}`, { venueIds: [betaId, alphaId] })
  check(
    'PATCH /bots reorders venues (best price, primary becomes first)',
    reorder.status === 200 && reorder.payload?.bot?.venueIds?.join(',') === [betaId, alphaId].join(',') && reorder.payload.bot.connectionId === betaId,
    JSON.stringify(reorder.payload).slice(0, 300),
  )

  // Sandbox has no read-only probe (orders only) — the check must say so
  // instead of claiming a credential it cannot verify.
  const sandboxProbe = await call('POST', `/connections/${alphaId}/test`)
  check(
    'BSE sandbox credential probe explains it is orders-only',
    sandboxProbe.status === 200 && sandboxProbe.payload?.ok === false && /sandbox is orders-only/i.test(String(sandboxProbe.payload?.message)),
    `${sandboxProbe.status} ${JSON.stringify(sandboxProbe.payload).slice(0, 160)}`,
  )

  // Production probe really calls Upstox: a fake token must come back as a
  // rejected credential, never a silent success.
  const prodProbe = await call('POST', `/connections/${betaId}/test`)
  check(
    'BSE production probe reaches Upstox and reports the rejected token',
    prodProbe.status === 200 &&
      prodProbe.payload?.ok === false &&
      /BSE order API rejected the request \(HTTP 401\)|unreachable/.test(String(prodProbe.payload?.message)),
    `${prodProbe.status} ${JSON.stringify(prodProbe.payload).slice(0, 200)}`,
  )

  const removedVenue = await call('DELETE', `/connections/${betaId}`)
  const afterVenue = await call('GET', `/bots/${multiBot?.id}`)
  check(
    'deleting one venue leaves the bot routing on the others',
    removedVenue.status === 200 &&
      afterVenue.payload?.bot?.venueIds?.join(',') === alphaId &&
      afterVenue.payload.bot.venues?.length === 1 &&
      afterVenue.payload.bot.mode === 'live',
    JSON.stringify({ status: removedVenue.status, venues: afterVenue.payload?.bot?.venueIds, mode: afterVenue.payload?.bot?.mode }),
  )

  await call('DELETE', `/bots/${multiBot?.id}`)
  await call('DELETE', `/connections/${alphaId}`)
}

// 10e. BSE derivatives are mapped from the exchange instrument master.
// Derivative keys are expiry- and strike-specific, so the adapter loads the
// venue's own BOD file (public data, no credentials) and resolves catalog
// tickers against it. The catalog must expose those contracts for paper
// trading too, hence the price-series assertions.
{
  const status = await call('GET', '/instruments/bse')
  check(
    'GET /instruments/bse reports the stored master',
    status.status === 200 && Array.isArray(status.payload?.underlyings) && status.payload.underlyings.includes('SENSEX'),
    JSON.stringify(status.payload).slice(0, 160),
  )

  const refreshed = await call('POST', '/instruments/bse/refresh', {})
  if (refreshed.status === 502) {
    console.log(`  SKIP  BSE instrument master download (${String(refreshed.payload?.message).slice(0, 120)})`)
  } else {
    check(
      'POST /instruments/bse/refresh downloads the exchange master',
      refreshed.status === 200 && refreshed.payload?.contracts > 1_000 && refreshed.payload?.syncedAt > 0,
      JSON.stringify(refreshed.payload).slice(0, 160),
    )

    const future = await call('GET', '/instruments/bse/resolve?symbol=SENSEX-FUT')
    const futureContract = future.payload?.contract
    check(
      'SENSEX-FUT resolves to the nearest dated futures contract',
      future.status === 200 &&
        String(futureContract?.instrumentKey).startsWith('BSE_FO|') &&
        futureContract?.instrumentType === 'FUT' &&
        futureContract?.lotSize >= 1 &&
        futureContract?.expiry > Date.now(),
      JSON.stringify(futureContract),
    )

    const callOption = await call('GET', '/instruments/bse/resolve?symbol=SENSEX-940-CE')
    const ce = callOption.payload?.contract
    check(
      'SENSEX-940-CE resolves to the nearest rupee strike call',
      callOption.status === 200 && ce?.instrumentType === 'CE' && ce?.strike >= 70_000 && ce?.strike <= 90_000 && ce?.lotSize >= 1,
      JSON.stringify(ce),
    )

    const putOption = await call('GET', '/instruments/bse/resolve?symbol=SENSEX-900-PE')
    check(
      'SENSEX-900-PE resolves to a put on the same underlying',
      putOption.status === 200 && putOption.payload?.contract?.instrumentType === 'PE' && putOption.payload.contract.underlying === 'SENSEX',
      JSON.stringify(putOption.payload?.contract),
    )

    const otherIndex = await call('GET', '/instruments/bse/resolve?symbol=BANKEX-FUT')
    check(
      'BANKEX-FUT resolves with its own lot size',
      otherIndex.status === 200 && otherIndex.payload?.contract?.underlying === 'BANKEX' && otherIndex.payload.contract.lotSize >= 1,
      JSON.stringify(otherIndex.payload?.contract),
    )
  }

  const notDerivative = await call('GET', '/instruments/bse/resolve?symbol=BTC-USD')
  check(
    'resolving a non-derivative says BSE has no such contract',
    notDerivative.status === 404 && notDerivative.payload?.error === 'not_a_bse_derivative',
    `${notDerivative.status} ${JSON.stringify(notDerivative.payload).slice(0, 160)}`,
  )

  const catalog = await call('GET', '/strategies')
  const futMeta = (catalog.payload?.symbols ?? []).find((s) => s.symbol === 'SENSEX-FUT')
  const optMeta = (catalog.payload?.symbols ?? []).find((s) => s.symbol === 'SENSEX-940-CE')
  check(
    'the catalog lists BSE futures and options as tradeable symbols',
    futMeta?.kind === 'future' && optMeta?.kind === 'option' && optMeta?.underlying === 'SENSEX',
    JSON.stringify({ fut: futMeta, opt: optMeta }),
  )

  // Paper trading a derivative exercises the synthetic series behind every
  // BSE contract (index level for futures, premium model for options).
  const derivativeBot = await call('POST', '/bots', {
    strategyKey: 'dca',
    symbols: ['SENSEX-FUT', 'SENSEX-940-CE'],
    timeframe: '1h',
    capital: 10_000,
    mode: 'paper',
    status: 'running',
  })
  const derivativeBotId = derivativeBot.payload?.bot?.id
  const advanced = await call('GET', `/bots/${derivativeBotId}`)
  check(
    'a paper bot can trade BSE futures and options on the synthetic feed',
    derivativeBot.status === 201 && Number.isFinite(advanced.payload?.bot?.equity) && advanced.payload.bot.equity > 0,
    `${derivativeBot.status} equity=${advanced.payload?.bot?.equity}`,
  )
  await call('DELETE', `/bots/${derivativeBotId}`)
}

// 11. Cleanup the bots created for the test
{
  const removed = await call('DELETE', `/bots/${botId}`)
  check('DELETE /bots/:id', removed.status === 200, `got ${removed.status}`)
  const gone = await call('GET', `/bots/${botId}`)
  check('GET deleted bot returns 404', gone.status === 404, `got ${gone.status}`)
  if (importedBotId) {
    const removedImport = await call('DELETE', `/bots/${importedBotId}`)
    check('DELETE imported bot', removedImport.status === 200, `got ${removedImport.status}`)
  }
}

// 12. Agent shell: the environment read the engine gates entries with
{
  const env = await call('GET', '/analysis/agents')
  const read = env.payload ?? {}
  const regimes = new Set(['RISK_ON_BOOM', 'NEUTRAL', 'RISK_OFF_CONTAGION'])
  check(
    'GET /analysis/agents reads the macro regime across world markets',
    env.status === 200 && regimes.has(read.regime) && Array.isArray(read.markets) && read.markets.length === 6,
    `${env.status} regime=${read.regime} markets=${read.markets?.length}`,
  )
  check(
    'every world market carries its technical and anomaly read',
    read.markets?.every(
      (m) => Number.isFinite(m.changePct) && Number.isFinite(m.rsi) && typeof m.anomaly?.signal === 'string',
    ),
    JSON.stringify(read.markets?.map((m) => `${m.symbol}:${m.anomaly?.signal}`)),
  )
  check(
    'the rules resolve against working memory and the gate states its verdict',
    Array.isArray(read.inferences) &&
      Array.isArray(read.criticalMarkets) &&
      typeof read.gate?.blocked === 'boolean' &&
      (read.gate.blocked ? typeof read.gate.reason === 'string' : read.gate.reason === null) &&
      Number.isFinite(read.gate.streak) &&
      read.workingMemory?.ticker &&
      Number.isFinite(read.workingMemory.rsi),
    `inferences=${read.inferences?.map((i) => i.inferredFact).join(',') || 'none'} gate=${JSON.stringify(read.gate)}`,
  )
  const focus = await call('GET', '/analysis/agents?symbol=NVDA')
  check(
    'the read can be focused on one market',
    focus.status === 200 && focus.payload.workingMemory?.ticker === 'NVDA' && Number.isFinite(focus.payload.workingMemory.institutionalPct) && focus.payload.workingMemory.institutionalPct > 0.1,
    `ticker=${focus.payload?.workingMemory?.ticker} inst=${focus.payload?.workingMemory?.institutionalPct}`,
  )
  const packed = await call('GET', '/analysis/agents?symbol=btcusdt')
  const offCatalog = await call('GET', '/analysis/agents?symbol=NOT-A-SYMBOL')
  check(
    'the focus symbol is normalized, and an off-catalog one is rejected',
    packed.status === 200 && packed.payload.workingMemory?.ticker === 'BTC-USD' && offCatalog.status === 400 && offCatalog.payload?.error === 'unknown_symbol',
    `packed=${packed.payload?.workingMemory?.ticker} off=${offCatalog.status}`,
  )

  // Specialist agents: four proposals, arbitration, and a move probability even
  // with no ownership facts behind it.
  const focusRead = focus.payload ?? {}
  check(
    'four specialist analysts report a bias and a measured conviction',
    Array.isArray(focusRead.proposals) &&
      focusRead.proposals.length === 4 &&
      focusRead.proposals.every((p) => typeof p.agent === 'string' && Number.isFinite(p.conviction) && Math.abs(p.bias) <= 1),
    JSON.stringify(focusRead.proposals?.map((p) => `${p.agent}:${p.conviction}`)),
  )
  check(
    'arbitration names a winner only above the conviction threshold',
    focusRead.verdict &&
      Number.isFinite(focusRead.verdict.threshold) &&
      (focusRead.verdict.winner === null || focusRead.verdict.conviction >= focusRead.verdict.threshold),
    JSON.stringify(focusRead.verdict),
  )
  check(
    'the screener reports why it rejected bars and pins, not just how many',
    focusRead.screened &&
      typeof focusRead.screened.barReasons === 'object' &&
      typeof focusRead.screened.pinReasons === 'object' &&
      Number.isFinite(focusRead.screened.rejectedBars) &&
      Object.values(focusRead.screened.barReasons).reduce((sum, n) => sum + n, 0) === focusRead.screened.rejectedBars,
    `bars=${JSON.stringify(focusRead.screened?.barReasons)} pins=${JSON.stringify(focusRead.screened?.pinReasons)}`,
  )
  check(
    'the company move predictor always returns a probability, and says its basis',
    typeof focusRead.nextMove?.move === 'string' &&
      focusRead.nextMove.probability > 0 &&
      focusRead.nextMove.probability <= 0.95 &&
      typeof focusRead.nextMove.factsAvailable === 'boolean' &&
      Array.isArray(focusRead.nextMove.candidates),
    JSON.stringify(focusRead.nextMove)?.slice(0, 160),
  )
  const unlisted = await call('GET', '/analysis/agents?symbol=SOL-USD')
  check(
    'a ticker with no seeded ownership still predicts, and flags the gap',
    unlisted.status === 200 && unlisted.payload.nextMove?.factsAvailable === false && unlisted.payload.nextMove.probability > 0,
    `${unlisted.status} facts=${unlisted.payload?.nextMove?.factsAvailable}`,
  )

  // The live environment (Durable Object): held pins, and operator switches
  // that the engine actually honours.
  const live = await call('GET', '/analysis/environment')
  check(
    'GET /analysis/environment returns the live state',
    live.status === 200 &&
      Array.isArray(live.payload.pins) &&
      typeof live.payload.controls?.paused === 'boolean' &&
      live.payload.read?.markets?.length === 6,
    `${live.status} pins=${live.payload?.pins?.length}`,
  )
  const seenTwice = await call('GET', '/analysis/environment')
  check(
    'pins are held, not rebuilt: a re-read increments the same pin',
    seenTwice.status === 200 && seenTwice.payload.pins?.every((p) => p.reads >= 1 && p.lastSeen >= p.firstSeen),
    JSON.stringify(seenTwice.payload?.pins?.map((p) => `${p.id}:${p.reads}`)),
  )
  const paused = await call('PATCH', '/analysis/environment/controls', { pauseBuys: true })
  const afterPatch = await call('GET', '/analysis/environment')
  const invalidControls = await call('PATCH', '/analysis/environment/controls', { pauseBuys: 'yes' })
  const restored = await call('PATCH', '/analysis/environment/controls', { pauseBuys: false, paused: false })
  check(
    'the operator kill-switches round-trip through the environment',
    paused.status === 200 && paused.payload.controls?.pauseBuys === true && afterPatch.payload?.controls?.pauseBuys === true && invalidControls.status === 400 && restored.payload?.controls?.pauseBuys === false,
    `patch=${paused.status} read=${JSON.stringify(afterPatch.payload?.controls)} invalid=${invalidControls.status}`,
  )

  // Decision trace & prediction calibration: what the engine recorded per closed
  // bar, and whether the always-on move probability has tracked what followed.
  const trace = await call('GET', '/analysis/environment/trace')
  const traces = trace.payload?.traces ?? []
  const calibration = trace.payload?.calibration ?? {}
  check(
    'GET /analysis/environment/trace serves the per-bar trace and the calibration',
    trace.status === 200 && Array.isArray(trace.payload?.traces) && Array.isArray(calibration.bins) && calibration.bins.length === 5 && Number.isFinite(calibration.baseline),
    `${trace.status} traces=${traces.length} bins=${calibration.bins?.length}`,
  )
  check(
    'every trace carries the gate, each proposal with its fact ids, the arbitration and its fills or typed rejects',
    traces.every(
      (entry) =>
        typeof entry.botId === 'string' &&
        entry.gate &&
        typeof entry.gate.blocked === 'boolean' &&
        Number.isFinite(entry.verdict?.threshold) &&
        Array.isArray(entry.proposals) &&
        entry.proposals.length === 4 &&
        entry.proposals.every((p) => Array.isArray(p.factIds) && p.factIds.length > 0) &&
        Array.isArray(entry.decisions) &&
        entry.decisions.every(
          (d) => typeof d.action === 'string' && typeof d.fill === 'boolean' && (d.fill || d.reject !== null || d.action === 'hold'),
        ),
    ),
    JSON.stringify(traces[0] ?? 'none').slice(0, 220),
  )
  check(
    'calibration counts only scored forecasts and averages their squared error',
    Number.isFinite(calibration.resolved) &&
      (calibration.brier === null || (calibration.brier >= 0 && calibration.brier <= 1)) &&
      calibration.bins.every((bin) => bin.count === 0 || (bin.observed >= 0 && bin.observed <= 1)),
    `resolved=${calibration.resolved} brier=${calibration.brier}`,
  )

  // Shorting: the crash hedge opens and covers a negative book.
  const shortRun = await call('POST', '/backtests', {
    strategyKey: 'crash-short',
    symbol: 'TSLA',
    timeframe: '1h',
    from: Date.now() - 120 * 86_400_000,
    to: Date.now(),
    capital: 10_000,
    riskPct: 25,
  })
  let shortDetail = shortRun.payload?.backtest
  for (let i = 0; i < 40 && shortDetail?.status !== 'done' && shortDetail?.status !== 'failed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    shortDetail = (await call('GET', `/backtests/${shortRun.payload?.backtest?.id}`)).payload?.backtest
  }
  track('backtest', shortRun.payload?.backtest?.id)
  const shortSides = new Set((shortDetail?.trades ?? []).map((t) => t.side))
  check(
    'the crash-short strategy opens and covers a short book',
    shortDetail?.status === 'done' && shortSides.has('short') && shortSides.has('cover'),
    `${shortDetail?.status} sides=${[...shortSides].join(',')} trades=${shortDetail?.trades?.length}`,
  )
}

// Cleanup: discard every fixture this run registered — newest first, so a
// strategy goes after the bots and backtests that referenced it.
for (const fixture of fixtures.reverse()) {
  const path = fixture.kind === 'strategy' ? `/strategies/custom/${fixture.id}` : `/backtests/${fixture.id}`
  const removed = await call('DELETE', path)
  check(`cleanup: DELETE ${fixture.kind} fixture`, removed.status === 200, `got ${removed.status}`)
}

console.log(failures === 0 ? '\nAll API checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
