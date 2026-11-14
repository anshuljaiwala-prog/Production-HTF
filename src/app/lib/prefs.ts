// Display preferences, shared app-wide. Both stores persist to localStorage
// and expose tiny external stores so any component can read them through
// hooks. Amounts are formatted during render, so a changed preference only
// reaches the page if it re-renders: Shell keys its routed outlet on the
// currency for exactly that reason.

import { useSyncExternalStore } from 'react'

// ---------- Currency ----------

export type Currency = 'USD' | 'EUR' | 'GBP' | 'INR'

export const CURRENCIES: { key: Currency; label: string }[] = [
  { key: 'USD', label: 'USD' },
  { key: 'EUR', label: 'EUR' },
  { key: 'GBP', label: 'GBP' },
  { key: 'INR', label: 'INR' },
]

/**
 * Display-only conversion rates. The ledger, engine and every stored number
 * are USD paper dollars; the toggle re-formats for reading. Static rates are
 * deliberate — the simulated venue has no FX feed to quote against.
 */
export const CURRENCY_RATES: Record<Currency, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  INR: 83.1,
}

export function convert(value: number, currency: Currency): number {
  return value * CURRENCY_RATES[currency]
}

/** The inverse, for inputs that show a converted amount but submit USD. */
export function unconvert(value: number, currency: Currency): number {
  return value / CURRENCY_RATES[currency]
}

const listeners = new Set<() => void>()
let currency: Currency = 'USD'

if (typeof window !== 'undefined') {
  const stored = window.localStorage.getItem('htf.currency')
  if (stored === 'USD' || stored === 'EUR' || stored === 'GBP' || stored === 'INR') currency = stored
}

export const getCurrency = () => currency

export function setCurrency(next: Currency) {
  if (next === currency) return
  currency = next
  try {
    window.localStorage.setItem('htf.currency', next)
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useCurrency(): Currency {
  return useSyncExternalStore(subscribe, getCurrency)
}

// ---------- Theme ----------

export type Theme = 'light' | 'dark'

const themeListeners = new Set<() => void>()
let theme: Theme = 'light'

if (typeof window !== 'undefined') {
  const stored = window.localStorage.getItem('htf.theme')
  if (stored === 'light' || stored === 'dark') theme = stored
  // Applied here (module load, before first paint of the app) so toggling
  // doesn't flash; index.html's inline script already covers the pre-React gap.
  document.documentElement.dataset.theme = theme
}

export const getTheme = () => theme

export function setTheme(next: Theme) {
  theme = next
  document.documentElement.dataset.theme = next
  try {
    window.localStorage.setItem('htf.theme', next)
  } catch {
    /* storage unavailable */
  }
  themeListeners.forEach((fn) => fn())
}

function subscribeTheme(fn: () => void) {
  themeListeners.add(fn)
  return () => themeListeners.delete(fn)
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme)
}
