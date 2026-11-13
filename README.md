# HTF — High Frequency Trading

A platform for designing, backtesting and launching algo trading bots:
strategy catalog, launch wizard, run monitoring (equity curve, positions,
trade log, events), a drag-and-drop lifecycle board (`Draft → Backtest →
Paper → Live`), deterministic backtests and exchange connections.

v1 executes everything against a **paper trading engine**: a deterministic
synthetic feed behind a `Broker` interface (`src/worker/broker.ts`), so a real
exchange adapter can be dropped in later without touching the engine or the UI.

## Run it

```sh
bun install            # or: npm install --no-package-lock
bun run dev            # http://localhost:5173 with local D1 (Miniflare)
bun run typecheck      # tsc --noEmit
bun run build          # dist/client (assets) + dist/crm/index.js (Worker)
```

Product analytics (PostHog) is off unless the build carries a project key: copy
`.env.example` to `.env` and set `VITE_POSTHOG_KEY`. The SDK is imported
lazily, identifies the signed-in operator, and records pageviews plus the
launch / backtest / training / upload events (`src/app/lib/analytics.ts`).
Settings → Privacy switches it off per browser, and no event carries exchange
credentials, holdings or trade contents.

On localhost without a `FREEBUFF_CLIENT_ID`, the app signs you in as a local
development user so everything works before auth is provisioned. A new
workspace is seeded with five live-mode (paused) demo bots, two backtests and
demo venues; Settings can restore or clear them. The Dashboard and Portfolio
report the live book only — paper trading is reviewed under Training → Paper
portfolio.

## How a bot runs

There is no long-lived process: the Worker is request-scoped, so each read of
a running bot fast-forwards it bar-by-bar from its last processed timestamp
(`src/worker/engine.ts`), applies the strategy signal, fills through the
broker, and appends trades, events and equity points to D1. Polling the UI is
what moves the fleet — honest paper-mode behaviour, documented as such.

- `src/worker/market.ts` — deterministic synthetic candles (seeded value
  noise), so backtests reproduce exactly and nothing hits the network.
- `src/worker/strategies.ts` — six templates (DCA, Grid, EMA Momentum, Mean
  Reversion, Range Breakout, Market Making) with param schemas that drive the
  launch and backtest forms from one source.
- `src/worker/venues.ts` — live venue adapters and the best-price router.
  BSE reaches the exchange through Upstox; cash equities map to fixed ISINs
  while futures and options (`SENSEX-FUT`, `SENSEX-940-CE`) resolve to dated
  contracts from the exchange instrument master.
- `src/worker/instruments.ts` — downloads the BSE instrument file
  (`BSE.json.gz`, public data, no API key), keeps its 6,000-odd `BSE_FO`
  contracts in D1 (`bse_contracts`) and resolves a catalog ticker to an
  `instrument_key`, lot size and expiry. `GET /api/instruments/bse` reports the
  cache, `POST /api/instruments/bse/refresh` reloads it and
  `GET /api/instruments/bse/resolve?symbol=SENSEX-FUT` shows what an order
  would send. The master is trusted for six hours, then reloaded on demand.
- `src/worker/agents/` — the agent shell, ported from the market_agent_env
  project. `environment.ts` assembles one immutable snapshot per pass (the
  Python app's long-lived environment hub, rebuilt on demand because a Worker
  has no process to tick); `harvester.ts` reads six macro markets from the bar
  feed and screens their tape events into news pins; `tools.ts` holds the RSI,
  Bollinger, EMA, volume-dislocation and strategic-move maths; `inference.ts`
  runs the five forward-chaining production rules and the macro-breadth regime
  (0.65× risk-off … 1.25× risk-on). The engine reads it once per pass and uses
  it to gate **new entries only** — a risk-off contagion or a severe-distress
  rule holds buys back and logs why on the bot's event stream; exits, stops and
  marks are never blocked. `GET /api/analysis/agents?symbol=NVDA` returns the
  same read for inspection.
- `src/worker/backtest.ts` — the same signal, sizing and fee model as the live
  engine, replayed over a bounded window.
- `src/worker/routes/*` — `bots`, `strategies`, `backtests`, `connections`,
  plus workspace/dashboard/search.

## Connect it to Freebuff

1. `sites_create`, then `sites_add_storage` for D1 named `DB`.
2. `sites_enable_auth` (pass `http://localhost:5173` as the local origin while
   developing). Copy the development variables into `.dev.vars` (see
   `.dev.vars.example`) to use real accounts locally.
3. `bun run build`, then `sites_deploy` with `deploy.json`. The deploy injects
   `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN`, and attaches the
   `DB` binding.

## Where things are

- `src/worker/` is the Hono API. `db.ts` owns the schema (created on first
  request), `seed.ts` the sample bots, `auth.ts` the Freebuff integration and
  the loopback-only development user, `engine.ts` the run loop.
- `src/app/` is the React app. `components/ui.tsx` holds the primitives
  (buttons, inputs, dialogs, drawer, menus, toasts), `components/forms.tsx`
  the launch wizard / backtest / connection forms, `pages/*` the screens,
  `lib/api.ts` the data hooks (TanStack Query).
- `src/shared/types.ts` is the contract between the two.
- `src/styles.css` holds the design tokens. Everything rounded is a squircle
  via `corner-shape`; true circles use the `round` class.

## Security notes

Every `/api/*` route requires a signed-in user and scopes queries by
`owner_sub`. Mutations must be same-origin (`isSameOriginRequest`).
Connection secrets are stored per workspace and masked after save — the API
never returns them again. Personalised responses are
`Cache-Control: private, no-store`.

## Not in v1

Real market data (the feed is synthetic; only BSE order placement and quotes
are live), WebSocket streaming (polling instead), and user-authored strategy
code. Live routing covers BSE through Upstox — cash equities plus SENSEX,
BANKEX, SENSEX50 and FOCIT futures and options; every other exchange still
needs an adapter.
