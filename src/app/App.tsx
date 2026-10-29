import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'

import { Shell } from './components/Shell'
import { Spinner, ToastProvider } from './components/ui'
import { capturePageview, identifyUser } from './lib/analytics'
import { ApiError, useMe } from './lib/api'
import { BotDetail } from './pages/BotDetail'
import { Bots } from './pages/Bots'
import { Connections } from './pages/Connections'
import { Dashboard } from './pages/Dashboard'
import { Portfolio } from './pages/Portfolio'
import { Settings } from './pages/Settings'
import { SetupNeeded, SignIn } from './pages/SignIn'
import { Strategies } from './pages/Strategies'
import { Training } from './pages/Training'

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

function Gate() {
  const me = useMe()
  // Once the Worker says who this is, bind every event to that person.
  useEffect(() => {
    if (me.data) identifyUser(me.data)
  }, [me.data])
  if (me.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    )
  }
  if (me.error instanceof ApiError) {
    if (me.error.status === 401) return <SignIn />
    if (me.error.status === 503) return <SetupNeeded message={me.error.message} />
  }
  if (me.error) return <SetupNeeded message={me.error.message} />
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="bots" element={<Bots />} />
        <Route path="bots/:id" element={<BotDetail />} />
        <Route path="board" element={<Navigate to="/bots?tab=board" replace />} />
        <Route path="strategies" element={<Strategies />} />
        <Route path="training" element={<Training />} />
        <Route path="backtests" element={<BacktestsRedirect />} />
        <Route path="connections" element={<Connections />} />
        <Route path="portfolio" element={<Portfolio />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export function App() {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BrowserRouter>
          <Pageviews />
          <Gate />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
