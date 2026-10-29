import { Database, HardDriveDownload, KeyRound, Palette, ShieldCheck, Trash2 } from 'lucide-react'

import { useState } from 'react'

import { Avatar, Badge, Button, Checkbox, ConfirmDialog, Field, Input, PageHeader, useToast, DataTable, type DataColumn } from '../components/ui'
import { analyticsConfigured, setAnalyticsConsent, useAnalyticsConsent } from '../lib/analytics'
import { api, useApiMutation, useBots, useConnections, useMe } from '../lib/api'

type Row = { label: string; ok: boolean; detail: string }

export function Settings() {
  const { data: me } = useMe()
  const { data: botList } = useBots()
  const { data: connections } = useConnections()
  const toast = useToast()
  const analyticsConsent = useAnalyticsConsent()
  const [name, setName] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'reset' | 'clear' | null>(null)

  const rename = useApiMutation((value: string) => api('/workspace', { method: 'PATCH', json: { name: value } }), ['me'], {
    onSuccess: () => toast('Workspace renamed'),
  })
  const reset = useApiMutation(() => api('/workspace/reset', { method: 'POST' }), ['me', 'dashboard', 'bots', 'bot', 'backtests', 'connections', 'portfolio', 'search'], {
    onSuccess: () => {
      setConfirm(null)
      toast('Sample bots restored')
    },
  })
  const clear = useApiMutation(() => api('/workspace/data', { method: 'DELETE' }), ['me', 'dashboard', 'bots', 'bot', 'backtests', 'connections', 'portfolio', 'search'], {
    onSuccess: () => {
      setConfirm(null)
      toast('Workspace cleared')
    },
  })

  if (!me) return null
  const value = name ?? me.workspace.name

  const systems: Row[] = [
    { label: 'Database (D1)', ok: me.capabilities.database, detail: 'every bot, trade, event and backtest is stored here' },
    { label: 'Object storage (R2)', ok: me.capabilities.files, detail: 'bulk uploads land here before worker validation' },
    { label: 'Sign in with Freebuff', ok: me.capabilities.auth === 'freebuff', detail: me.capabilities.auth === 'freebuff' ? 'FREEBUFF_CLIENT_ID configured' : 'not configured — run the app with FREEBUFF_CLIENT_ID for real accounts' },
  ]

  const columns: DataColumn<Row>[] = [
    {
      key: 'system',
      header: 'System',
      width: 'w-[38%]',
      cell: (row) => (
        <span className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-muted [&_svg]:size-3.5">
            {row.label.startsWith('Object') ? <HardDriveDownload /> : row.label.startsWith('Sign in') ? <KeyRound /> : <Database />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium">{row.label}</span>
            <span className="block truncate text-[12px] text-faint">{row.detail}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[62%]',
      align: 'right',
      cell: (row) => (row.ok ? <Badge tone="success" dot>Connected</Badge> : <Badge tone="neutral" dot>Not connected</Badge>),
    },
  ]

  return (
    <div className="mx-auto max-w-[860px] p-5 sm:p-8">
      <PageHeader title="Settings" subtitle="Workspace identity, platform capabilities and the data the platform holds." />

      {/* Identity ------------------------------------------------------------------ */}
      <section className="mt-6">
        <h2 className="text-[14px] font-semibold">Account</h2>
        <div className="mt-3 flex items-center gap-4 rounded-card border border-line p-4">
          <Avatar name={me.user.name ?? me.user.email ?? 'You'} hue={210} src={me.user.picture} size={48} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium">{me.user.name ?? 'Signed in'}</p>
            {me.user.email && <p className="truncate text-[13px] text-muted">{me.user.email}</p>}
          </div>
          {me.capabilities.auth === 'freebuff' ? (
            <form method="post" action="/auth/freebuff/signout">
              <input type="hidden" name="returnTo" value="/" />
              <Button type="submit">Sign out</Button>
            </form>
          ) : (
            <Badge tone="warning">Development user</Badge>
          )}
        </div>
      </section>

      {/* Workspace ------------------------------------------------------------------ */}
      <section className="mt-8">
        <h2 className="text-[14px] font-semibold">Workspace</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim() && value !== me.workspace.name) rename.mutate(value.trim())
          }}
          className="mt-3 flex items-end gap-2"
        >
          <Field label="Name" className="flex-1" hint="Shown across the app and in searches">
            <Input value={value} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Button variant="primary" type="submit" loading={rename.isPending} disabled={!value.trim() || value === me.workspace.name}>
            Save
          </Button>
        </form>
        <p className="mt-1.5 text-[12.5px] text-faint">
          Seeded {me.workspace.seededAt ? new Date(me.workspace.seededAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'at first run'} ·
          currently holding {(botList?.items ?? []).length} bot{(botList?.items?.length ?? 0) === 1 ? '' : 's'} and {(connections?.items ?? []).length} exchange
          connection{(connections?.items?.length ?? 0) === 1 ? '' : 's'}.
        </p>
      </section>

      {/* Capabilities ---------------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-[14px] font-semibold">Capabilities</h2>
        <div className="mt-3">
          <DataTable columns={columns} rows={systems} rowKey={(row) => row.label} />
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-faint">
          <Palette className="size-3.5" />
          Display preferences (currency, dark/light theme) live on the sidebar, below the navigation.
        </p>
      </section>

      {/* Privacy --------------------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-[14px] font-semibold">Privacy</h2>
        <div className="mt-3 flex items-center gap-3 rounded-card border border-line p-4">
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium">Product analytics</span>
            <span className="block text-[12.5px] text-muted">
              {analyticsConfigured
                ? 'PostHog records which screens and flows get used — never exchange keys, holdings or trade contents. Turning it off takes effect in this browser immediately.'
                : 'Off — this build has no PostHog project key (VITE_POSTHOG_KEY).'}
            </span>
          </span>
          <label className="flex shrink-0 items-center gap-2 text-[13px] text-muted">
            <Checkbox
              checked={analyticsConfigured && analyticsConsent}
              disabled={!analyticsConfigured}
              onChange={(e) => {
                setAnalyticsConsent(e.target.checked)
                toast(e.target.checked ? 'Product analytics on' : 'Product analytics off — nothing is sent')
              }}
            />
            {analyticsConfigured && analyticsConsent ? 'On' : 'Off'}
          </label>
        </div>
      </section>

      {/* Data ------------------------------------------------------------------------ */}
      <section className="mt-8">
        <h2 className="text-[14px] font-semibold">Data</h2>
        <div className="mt-3 divide-y divide-line rounded-card border border-line">
          <div className="flex items-center gap-3 p-4">
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium">Restore sample bots</span>
              <span className="block text-[12.5px] text-muted">Replaces everything with the starter bots, backtests and demo connections.</span>
            </span>
            <Button onClick={() => setConfirm('reset')}>Restore</Button>
          </div>
          <div className="flex items-center gap-3 p-4">
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium">Clear workspace</span>
              <span className="block text-[12.5px] text-muted">Deletes every bot, trade, event, backtest and connection. This cannot be undone.</span>
            </span>
            <Button variant="danger" onClick={() => setConfirm('clear')}>
              <Trash2 className="size-3.5" />
              Clear
            </Button>
          </div>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-faint">
          <ShieldCheck className="size-3.5" />
          Both actions invalidate every cached view — dashboards, ledgers and boards refill from the fresh state on the next load.
        </p>
      </section>

      <ConfirmDialog
        open={confirm === 'reset'}
        onClose={() => setConfirm(null)}
        onConfirm={() => reset.mutate(undefined)}
        loading={reset.isPending}
        title="Restore sample bots?"
        description="Everything in the workspace is replaced with the starter bots and backtests."
        confirmLabel="Restore"
      />
      <ConfirmDialog
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        onConfirm={() => clear.mutate(undefined)}
        loading={clear.isPending}
        title="Clear the workspace?"
        description="Every bot, trade, event, backtest and connection is deleted."
        confirmLabel="Clear everything"
      />
    </div>
  )
}
