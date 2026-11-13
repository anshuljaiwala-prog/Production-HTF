import type { FreebuffUser } from '@freebuff/auth'

export interface Env {
  ASSETS: Fetcher
  // Attached by Freebuff Sites once provisioned (sites_add_storage). Optional so
  // the app can explain what is missing instead of crashing.
  DB?: D1Database
  FILES?: R2Bucket
  /** The live environment (see agents/environment-do.ts): pins, controls and
   * the last world snapshot. Optional so a deployment without Durable Object
   * support still runs everything else. */
  ENVIRONMENT?: DurableObjectNamespace
  // Injected on deploy once Sign in with Freebuff is enabled (sites_enable_auth).
  FREEBUFF_CLIENT_ID?: string
  FREEBUFF_ISSUER?: string
  APP_ORIGIN?: string
  // Deployment secret (Sites → Secrets, or development.variables locally):
  // base64 of 32 random bytes — the AES-GCM key for encrypting stored
  // connection API secrets at rest. When unset, each workspace lazily gets a
  // random key stored beside its own data instead (see src/worker/secrets.ts).
  SECRETS_KEY?: string
}

export type Variables = {
  user: FreebuffUser
  db: D1Database
}

export type AppContext = { Bindings: Env; Variables: Variables }
