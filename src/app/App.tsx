import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'

import { Shell } from './components/Shell'
import { Button, Spinner, ToastProvider } from './components/ui'
import { capturePageview, identifyUser } from './lib/analytics'
import { ApiError, useMe } from './lib/api'

// Route components are code-split: each page ships as its own chunk and loads
// on first navigation, so the main bundle stays below a single 300 kB file.
const BotDetail = lazy(() => import('./pages/BotDetail').then((m) => ({ default: m.BotDetail })))
const Bots = lazy(() => import('./pages/Bots').then((m) => ({ default: m.Bots })))
const Connections = lazy(() => import('./pages/Connections').then((m) => ({ default: m.Connections })))
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const Environment = lazy(() => import('./pages/Environment').then((m) => ({ default: m.Environment })))
const Portfolio = lazy(() => import('./pages/Portfolio').then((m) => ({ default: m.Portfolio })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const SignIn = lazy(() => import('./pages/SignIn').then((m) => ({ default: m.SignIn })))
const SetupNeeded = lazy(() => import('./pages/SignIn').then((m) => ({ default: m.SetupNeeded })))
const Strategies = lazy(() => import('./pages/Strategies').then((m) => ({ default: m.Strategies })))
const Training = lazy(() => import('./pages/Training').then((m) => ({ default: m.Training })))

/** Reads the same spinner the Gate shows while /api/me resolves. */
function SplitFallback() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  )
}

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
})

/** Every SPA navigation is a PostHog pageview — pageviews plus the events the
 * flows capture are what make funnels and retention readable. */
function Pageviews() {
  const { pathname } = useLocation()
  useEffect(() => capturePageview(pathname), [pathname])
  return null
}

/** Backtests now live on the Training page — forward old links with
 * their drawer id intact. */
function BacktestsRedirect() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  params.set('tab', 'backtests')
  return <Navigate to={`/training?${params.toString()}`} replace />
}

/** A failed page — a stale lazily-loaded chunk after a deploy, or a render
 * bug — must not blank the whole document. The boundary keeps the shell and
 * offers a reload instead of an empty screen. */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-[16px] font-semibold">This page failed to load</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">{this.state.error.message}</p>
          <Button variant="primary" className="mt-4" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    )
  }
}

function Gate() {
  const me = useMe()
  // Once the Worker says who this is, bind every event to that person.
  useEffect(() => {
    if (me.data) identifyUser(me.data)
  }, [me.data])
  if (me.isLoading) {
    return <SplitFallback />
  }
  if (me.error instanceof ApiError) {
    if (me.error.status === 401) return <SignIn />
    if (me.error.status === 503) return <SetupNeeded message={me.error.message} />
  }
  if (me.error) return <SetupNeeded message={me.error.message} />
  // One fallback covers every lazily imported route chunk: the shell streams
  // in first, each page fills the outlet as its own file lands.
  return (
    <Suspense fallback={<SplitFallback />}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Dashboard />} />          <Route path="bots" element={<Bots />} />
          <Route path="bots/:id" element={<BotDetail />} />
          <Route path="backtests" element={<BacktestsRedirect />} />
          <Route path="board" element={<Navigate to="/bots?tab=board" replace />} />
          <Route path="strategies" element={<Strategies />} />
          <Route path="training" element={<Training />} />
          <Route path="connections" element={<Connections />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="environment" element={<Environment />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export function App() {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BrowserRouter>
          <Pageviews />
          <AppErrorBoundary>
            <Gate />
          </AppErrorBoundary>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
