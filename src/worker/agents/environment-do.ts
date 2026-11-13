import type { AgentRead, EnvironmentPin, EnvironmentState } from '../../shared/types'
import type { Env } from '../env'
import { TIMEFRAME_MS, barsBetween } from '../market'
import { barsForRun } from '../marketstore'
import { readEnvironment } from './environment'
import { MACRO_BARS, MACRO_TIMEFRAME, macroBarsAt } from './harvester'

// The environment as a place, ported from market_agent_env's MarketEnvironment:
// one object that *holds* the world rather than recomputing it per request.
// A Durable Object gives a Worker the one thing the Python app assumed — a
// single, serialised, long-lived owner of mutable state — so pins persist
// across reads (with when they were first and last seen), and the operator's
// kill-switches live somewhere both the panel and the engine can agree on.
//
// The engine cannot RPC here: it is called from request-scoped code with only a
// D1 handle. So controls are mirrored into `environment_controls` as a
// projection, and the engine reads that row. Pins and the last snapshot stay in
// the object's own storage — they are the panel's, not the engine's.

const MAX_PINS = 50

export interface EnvironmentControls {
  paused: boolean
  pauseBuys: boolean
}

export const DEFAULT_CONTROLS: EnvironmentControls = { paused: false, pauseBuys: false }

type StoredPin = EnvironmentPin

/**
 * The live environment. One instance per workspace (`environment:<owner>`), so
 * two operators never share pins or kill-switches.
 */
export class EnvironmentDurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const owner = request.headers.get('x-environment-owner') ?? ''
    if (!owner) return json({ error: 'missing_owner' }, 400)

    if (url.pathname === '/controls') {
      if (request.method === 'PATCH') return this.patchControls(request, owner)
      return json(await this.controls())
    }
    // Any read path (`/`, `/read?symbol=…`) refreshes the world, merges its pins
    // into the store and hands back the state.
    return this.refresh(url.searchParams.get('symbol'))
  }

  private async refresh(focus: string | null): Promise<Response> {
    const read = await this.compute(focus)
    const pins = await this.mergePins(read.pins, read.generatedAt)
    await this.state.storage.put('read', read)
    await this.state.storage.put('pins', pins)
    return json(await this.snapshot(read, pins))
  }

  /** Assemble a read from the same bars the bots trade: stored rows when the
   * market has them, the synthetic feed otherwise. */
  private async compute(focus: string | null): Promise<AgentRead> {
    const at = Date.now()
    const from = at - MACRO_BARS * TIMEFRAME_MS[MACRO_TIMEFRAME]
    const focusBars = focus
      ? ((await barsForRun(requireDb(this.env), focus, MACRO_TIMEFRAME, from, at)) ?? barsBetween(focus, MACRO_TIMEFRAME, from, at))
      : null
    return readEnvironment({
      at,
      macroBars: macroBarsAt(at),
      ...(focus && focusBars ? { focus: { symbol: focus, bars: focusBars } } : {}),
    })
  }

  /** Keep every pin the environment has seen: a pin that appears again updates
   * its last-seen and read count instead of duplicating; a pin that stops
   * appearing is retained until the store is full, so the panel can show what
   * the world looked like a minute ago. */
  private async mergePins(fresh: AgentRead['pins'], at: number): Promise<StoredPin[]> {
    const stored = (await this.state.storage.get<StoredPin[]>('pins')) ?? []
    const byId = new Map(stored.map((pin) => [pin.id, pin]))
    for (const pin of fresh) {
      const existing = byId.get(pin.id)
      byId.set(
        pin.id,
        existing
          ? { ...pin, firstSeen: existing.firstSeen, lastSeen: at, reads: existing.reads + 1 }
          : { ...pin, firstSeen: at, lastSeen: at, reads: 1 },
      )
    }
    return [...byId.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_PINS)
  }

  private async controls(): Promise<EnvironmentControls> {
    return (await this.state.storage.get<EnvironmentControls>('controls')) ?? DEFAULT_CONTROLS
  }

  private async patchControls(request: Request, owner: string): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Partial<EnvironmentControls>
    const current = await this.controls()
    const next: EnvironmentControls = {
      paused: typeof body.paused === 'boolean' ? body.paused : current.paused,
      pauseBuys: typeof body.pauseBuys === 'boolean' ? body.pauseBuys : current.pauseBuys,
    }
    await this.state.storage.put('controls', next)
    // Materialise the projection the engine reads (see the header comment).
    await requireDb(this.env)
      .prepare(
        `INSERT INTO environment_controls (owner_sub, paused, pause_buys, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_sub) DO UPDATE SET paused = excluded.paused, pause_buys = excluded.pause_buys, updated_at = excluded.updated_at`,
      )
      .bind(owner, next.paused ? 1 : 0, next.pauseBuys ? 1 : 0, Date.now())
      .run()
    return json(next)
  }

  private async snapshot(read: AgentRead, pins: StoredPin[]): Promise<EnvironmentState> {
    return {
      generatedAt: read.generatedAt,
      controls: await this.controls(),
      read,
      pins,
    }
  }
}

// --- Worker-side accessors ---------------------------------------------------

/** Controls as the engine sees them: the D1 projection, so an advance pass
 * needs no RPC. Absent row means defaults. */
export async function environmentControlsFor(db: D1Database, owner: string): Promise<EnvironmentControls> {
  const row = await db
    .prepare(`SELECT paused, pause_buys FROM environment_controls WHERE owner_sub = ?`)
    .bind(owner)
    .first<{ paused: number; pause_buys: number }>()
  return row ? { paused: Boolean(row.paused), pauseBuys: Boolean(row.pause_buys) } : DEFAULT_CONTROLS
}

/** The workspace's environment object, or null when the binding is absent (a
 * deployment without Durable Object support still runs the bot engine). */
function stubFor(env: Env, owner: string): DurableObjectStub | null {
  if (!env.ENVIRONMENT) return null
  return env.ENVIRONMENT.get(env.ENVIRONMENT.idFromName(`environment:${owner}`))
}

export async function readEnvironmentState(env: Env, owner: string, focus?: string | null): Promise<EnvironmentState | null> {
  const stub = stubFor(env, owner)
  if (!stub) return null
  const url = new URL('https://environment/')
  if (focus) url.searchParams.set('symbol', focus)
  const response = await stub.fetch(new Request(url, { headers: { 'x-environment-owner': owner } }))
  if (!response.ok) return null
  return (await response.json()) as EnvironmentState
}

export async function writeEnvironmentControls(
  env: Env,
  db: D1Database,
  owner: string,
  patch: Partial<EnvironmentControls>,
): Promise<EnvironmentControls> {
  const stub = stubFor(env, owner)
  if (!stub) {
    // No object: keep the projection authoritative so the switches still work.
    const current = await environmentControlsFor(db, owner)
    const next = { ...current, ...pickBooleans(patch) }
    await db
      .prepare(
        `INSERT INTO environment_controls (owner_sub, paused, pause_buys, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_sub) DO UPDATE SET paused = excluded.paused, pause_buys = excluded.pause_buys, updated_at = excluded.updated_at`,
      )
      .bind(owner, next.paused ? 1 : 0, next.pauseBuys ? 1 : 0, Date.now())
      .run()
    return next
  }
  const response = await stub.fetch(
    new Request('https://environment/controls', {
      method: 'PATCH',
      headers: { 'x-environment-owner': owner, 'content-type': 'application/json' },
      body: JSON.stringify(pickBooleans(patch)),
    }),
  )
  if (!response.ok) throw new Error('The environment rejected the control change.')
  return (await response.json()) as EnvironmentControls
}

function pickBooleans(input: Partial<EnvironmentControls>): Partial<EnvironmentControls> {
  const out: Partial<EnvironmentControls> = {}
  if (typeof input.paused === 'boolean') out.paused = input.paused
  if (typeof input.pauseBuys === 'boolean') out.pauseBuys = input.pauseBuys
  return out
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new Error('The environment needs a database.')
  return env.DB
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
