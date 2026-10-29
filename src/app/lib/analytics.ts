// Product analytics — PostHog, config-gated and consent-controlled.
//
// The SDK is imported lazily and only when the build carries
// `VITE_POSTHOG_KEY`, so local dev, previews and CI stay silent and the
// marketing bundle never pays for analytics it cannot send. Events describe
// the product journey (pageviews, bot launches, backtests, training runs,
// strategy uploads) — never exchange credentials, holdings or trade contents.
// Settings exposes the switch: a withdrawal is remembered in this browser and
// stops capture immediately.

import { useSyncExternalStore } from 'react'

import type { PostHog } from 'posthog-js'

import type { Me } from '../../shared/types'

const KEY = (import.meta.env.VITE_POSTHOG_KEY as string | undefined)?.trim() ?? ''
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined)?.trim() || 'https://us.i.posthog.com'
const CONSENT_KEY = 'htf.analytics-consent'
/** Events fired while the SDK is still loading; enough for the first screen,
 * dropped beyond it rather than growing without bound. */
const MAX_QUEUE = 25

/** True when this build points at a PostHog project. */
export const analyticsConfigured = KEY.length > 0

type Payload = Record<string, string | number | boolean | null | undefined>
type Pending = { event: string; properties?: Payload }

let posthogClient: PostHog | null = null
let booting: Promise<PostHog | null> | null = null
let identity: { id: string; properties: Payload } | null = null
let identifiedId: string | null = null
const pending: Pending[] = []

const listeners = new Set<() => void>()

/** Analytics is on unless this browser opted out. */
let consent = true
try {
  consent = window.localStorage.getItem(CONSENT_KEY) !== 'denied'
} catch {
  /* storage unavailable — keep the default */
}

export const getAnalyticsConsent = () => consent

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The Settings switch. The choice persists and takes effect immediately. */
export function setAnalyticsConsent(next: boolean) {
  if (next === consent) return
  consent = next
  try {
    window.localStorage.setItem(CONSENT_KEY, next ? 'granted' : 'denied')
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn())
  if (!next) {
    pending.length = 0
    posthogClient?.opt_out_capturing()
    return
  }
  void load().then((sdk) => {
    sdk?.opt_in_capturing()
    flush(sdk)
  })
}

export function useAnalyticsConsent(): boolean {
  return useSyncExternalStore(subscribe, getAnalyticsConsent)
}

/** Lazily boot the SDK. Resolves to null when analytics is off or the bundle
 * cannot load — callers never have to guard for it. */
function load(): Promise<PostHog | null> {
  if (!analyticsConfigured || !consent) return Promise.resolve(null)
  booting ??= import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        api_host: HOST,
        // The router reports SPA pageviews (see capturePageview) so a soft
        // navigation doesn't land twice.
        capture_pageview: false,
        persistence: 'localStorage',
      })
      posthogClient = posthog
      // Identify before replaying the queue, so the first screen of a
      // session is attributed to the signed-in operator.
      if (identity) posthog.identify(identity.id, identity.properties)
      flush(posthog)
      return posthog
    })
    .catch(() => null)
  return booting
}

function flush(posthog: PostHog | null) {
  if (!posthog) return
  for (const item of pending.splice(0)) posthog.capture(item.event, item.properties)
}

/** Record a product event. Safe to call anywhere: it no-ops until the build
 * is configured and the operator permits analytics. */
export function capture(event: string, properties?: Payload) {
  if (!analyticsConfigured || !consent) return
  if (posthogClient) {
    posthogClient.capture(event, properties)
    return
  }
  if (pending.length < MAX_QUEUE) pending.push({ event, properties })
  void load()
}

/** Attach the signed-in operator to every event, so funnels and retention are
 * per person instead of per anonymous browser. */
export function identifyUser(me: Me) {
  if (!analyticsConfigured || !consent || identifiedId === me.user.sub) return
  identity = { id: me.user.sub, properties: { workspace: me.workspace.name, sign_in: me.capabilities.auth } }
  const person = identity
  void load().then((posthog) => {
    if (!posthog) return
    posthog.identify(person.id, person.properties)
    identifiedId = person.id
  })
}

/** SPA route change → `$pageview`, so a funnel can start on any screen. */
export function capturePageview(path: string) {
  capture('$pageview', { path, $current_url: window.location.href })
}
