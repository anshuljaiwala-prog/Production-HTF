import { Bot, Check, FlaskConical, Globe, GraduationCap, LayoutGrid, Menu as MenuIcon, Moon, Plug, Search, Settings, Sun, Wallet, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'

import { useMe } from '../lib/api'
import { cx } from '../lib/cx'
import { CURRENCIES, setCurrency, setTheme, useCurrency, useTheme } from '../lib/prefs'
import { CommandPalette } from './CommandPalette'
import { Avatar } from './ui'

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true },
  { to: '/bots', label: 'Bots', icon: Bot },
  { to: '/strategies', label: 'Strategies', icon: FlaskConical },
  { to: '/training', label: 'Training', icon: GraduationCap },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet },
  { to: '/environment', label: 'Environment', icon: Globe },
  { to: '/connections', label: 'Connections', icon: Plug },
]

export function Shell() {
  const { data: me } = useMe()
  const currency = useCurrency()
  const theme = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  useEffect(() => setMobileOpen(false), [location.pathname])

  // The mobile drawer is a modal surface: Escape has to close it, the same
  // way the desktop dialogs do.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

  const sidebar = (
    <div className="flex h-full flex-col px-3 py-3">
      <div className="flex h-10 items-center gap-2.5 px-2">
        <span className="grid size-7 place-items-center rounded-[9px] bg-fg text-bg">
          <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
            <rect x="3.5" y="8" width="3" height="11" rx="1.2" />
            <rect x="5" y="5" width="0.5" height="17" rx="0.25" />
            <rect x="10.5" y="10" width="3" height="7" rx="1.2" />
            <rect x="12" y="3" width="0.5" height="19" rx="0.25" />
            <rect x="17.5" y="7" width="3" height="9" rx="1.2" />
            <rect x="19" y="4" width="0.5" height="16" rx="0.25" />
          </svg>
        </span>
        <span className="truncate text-[14px] font-semibold tracking-tight">HTF</span>
        <span className="hidden truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-faint lg:block">
          High Frequency Trading
        </span>
      </div>

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="mt-3 flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-2.5 text-[13px] text-muted shadow-[0_1px_1px_rgb(20_20_24/0.04)] transition-colors hover:bg-surface-2"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded-[6px] border border-line bg-bg px-1.5 py-0.5 font-sans text-[11px] text-faint">{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>

      <nav className="mt-4 flex flex-col gap-0.5">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cx(
                'flex h-9 items-center gap-2.5 rounded-control px-2.5 text-[13.5px] font-medium transition-colors',
                isActive ? 'bg-surface text-fg shadow-card' : 'text-muted hover:bg-raised/60 hover:text-fg',
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-0.5">
        {/* Display preferences: currency + theme. Both persist to localStorage;
            the currency is a display conversion, the ledger stays in USD. */}
        <div className="mb-1 flex items-center justify-between gap-2 px-1">
          <div role="radiogroup" aria-label="Display currency" className="flex items-center gap-0.5 rounded-control bg-bg p-0.5 shadow-card">
            {CURRENCIES.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={currency === option.key}
                onClick={() => setCurrency(option.key)}
                className={cx(
                  'flex h-7 items-center gap-1 rounded-[8px] px-2 text-[11.5px] font-semibold transition-colors',
                  currency === option.key ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
                )}
              >
                {option.label}
                {currency === option.key && <Check className="size-3 text-accent" />}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-control bg-surface text-muted transition-colors hover:text-fg"
          >
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cx(
              'flex h-9 items-center gap-2.5 rounded-control px-2.5 text-[13.5px] font-medium transition-colors',
              isActive ? 'bg-surface text-fg shadow-card' : 'text-muted hover:bg-raised/60 hover:text-fg',
            )
          }
        >
          <Settings className="size-4" />
          Settings
        </NavLink>
        {me && (
          <NavLink to="/settings" className="mt-1 flex items-center gap-2.5 rounded-control px-2 py-2 transition-colors hover:bg-raised/60">
            <Avatar name={me.user.name ?? me.user.email ?? 'You'} hue={210} src={me.user.picture} size={28} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{me.user.name ?? 'Signed in'}</span>
              {me.user.email && <span className="block truncate text-[11.5px] text-faint">{me.user.email}</span>}
            </span>
          </NavLink>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full">
      {/* First tab stop: keyboard users skip the sidebar instead of tabbing
          every link on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-control focus:border focus:border-control focus:bg-surface focus:px-3.5 focus:py-2 focus:text-[13px] focus:font-medium focus:shadow-pop"
      >
        Skip to content
      </a>
      <aside className="hidden w-[236px] shrink-0 lg:block">{sidebar}</aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-bg/90 px-3 backdrop-blur lg:hidden">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          onClick={() => setMobileOpen(true)}
          className="grid size-9 place-items-center rounded-control"
        >
          <MenuIcon className="size-5" />
        </button>
        <span className="text-[14px] font-semibold">HTF</span>
        <button type="button" aria-label="Search" onClick={() => setPaletteOpen(true)} className="grid size-9 place-items-center rounded-control">
          <Search className="size-5" />
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-fg/20" />
          <aside
            id="mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 w-[280px] bg-bg shadow-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" aria-label="Close menu" onClick={() => setMobileOpen(false)} className="absolute right-3 top-3 grid size-9 place-items-center rounded-control">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main id="main" tabIndex={-1} className="min-w-0 flex-1 pt-12 focus:outline-none lg:p-2 lg:pl-0 lg:pt-2">
        <div className="scrollbar-thin h-full overflow-y-auto bg-surface lg:rounded-card lg:border lg:border-line">
          {/* Money is formatted during render, so a currency switch has to
              remount the page: keying the outlet on the currency is what makes
              every page under it re-read the new rate. */}
          <Outlet key={currency} />
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
