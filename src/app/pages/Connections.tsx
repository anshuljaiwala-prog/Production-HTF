import { FlaskConical, Info, Pencil, Plug, Plus, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { BulkConnectionsDialog, ConnectionForm } from '../components/forms'
import { Badge, Button, Card, ConfirmDialog, DataTable, type DataColumn, EmptyState, PageHeader, Skeleton, useToast } from '../components/ui'
import {
  addDemoConnections,
  deleteConnection,
  refreshInstrumentMaster,
  testConnection,
  useApiMutation,
  useBots,
  useConnections,
  useInstrumentMaster,
} from '../lib/api'
import { shortDate } from '../lib/format'
import { activityOf, type Connection } from '../../shared/types'

export function Connections() {
  const { data, isLoading } = useConnections()
  const { data: botList } = useBots()
  const toast = useToast()
  const [composing, setComposing] = useState(false)
  const [editing, setEditing] = useState<Connection | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [removing, setRemoving] = useState<Connection | null>(null)

  const remove = useApiMutation((connectionId: string) => deleteConnection(connectionId), ['connections', 'bots'], {
    onSuccess: (result) => {
      setRemoving(null)
      // Grounding happens server-side: live bots attached to the deleted
      // account are demoted to paper with an audit note.
      toast(result.grounded > 0 ? `Connection deleted — ${result.grounded} live bot${result.grounded === 1 ? '' : 's'} grounded to paper` : 'Connection deleted')
    },
  })

  // Demo credentials the simulated venue accepts — for testing the picker
  // and live mode without real exchange keys.
  const addDemo = useApiMutation(() => addDemoConnections(), ['connections'], {
    onSuccess: (result) => toast(result.added > 0 ? `Added ${result.added} demo connection${result.added === 1 ? '' : 's'}` : 'Demo connections already present'),
  })

  // Credential probe: a real request to the venue with the stored token, so
  // keys pasted later can be confirmed before a bot routes through them.
  const test = useApiMutation((connectionId: string) => testConnection(connectionId), ['connections'], {
    onSuccess: (result) => toast(result.message),
    onError: (error) => toast(error.message),
  })

  // Exchange instrument master: derivatives are keyed by expiry and strike, so
  // the adapter loads the venue's own contract list rather than guessing keys.
  const { data: master } = useInstrumentMaster()
  const refreshMaster = useApiMutation(() => refreshInstrumentMaster(), ['instruments', 'bse'], {
    onSuccess: (status) => toast(`BSE instrument master loaded — ${status.contracts.toLocaleString()} derivative contracts`),
    onError: (error) => toast(error.message),
  })

  const items = data?.items ?? []
  const botsUsing = new Map<string, number>()
  for (const bot of botList?.items ?? []) {
    for (const venueId of bot.venueIds.length ? bot.venueIds : bot.connectionId ? [bot.connectionId] : []) {
      botsUsing.set(venueId, (botsUsing.get(venueId) ?? 0) + 1)
    }
  }
  const liveCount = items.filter((c) => c.mode === 'live').length

  const columns: DataColumn<Connection>[] = [
    {
      key: 'connection',
      header: 'Connection',
      width: 'w-[34%]',
      cell: (connection) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-muted [&_svg]:size-3.5">
            <Plug />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium">{connection.name}</span>
            <span className="block truncate text-[12px] text-faint">
              added {shortDate(connection.createdAt)} · {connection.exchange === 'Paper (simulated)' ? 'simulated venue' : connection.exchange} · {connection.environment}
            </span>
          </span>
        </span>
      ),
    },
    { key: 'mode', header: 'Default mode', width: 'w-[14%]', cell: (connection) => <Badge tone={connection.mode === 'live' ? 'success' : 'info'}>{connection.mode}</Badge> },
    {
      key: 'key',
      header: 'API key',
      width: 'w-[16%]',
      numeric: true,
      cell: (connection) => <span className="tabular-nums text-muted">{connection.keyMasked}</span>,
    },
    {
      key: 'bots',
      header: 'Used by bots',
      width: 'w-[12%]',
      align: 'right',
      numeric: true,
      cell: (connection) => {
        const count = botsUsing.get(connection.id) ?? 0
        return count === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <Link to="/bots" className="text-accent hover:underline" title={`${count} bot${count === 1 ? '' : 's'} route through this connection`}>
            {count}
          </Link>
        )
      },
    },
    {
      key: 'actions',
      header: '',
      width: 'w-[16%]',
      align: 'right',
      cell: (connection) => (
        <span className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Test ${connection.name}`}
            title="Test the saved credentials against the venue"
            loading={test.isPending && test.variables === connection.id}
            onClick={() => test.mutate(connection.id)}
          >
            <FlaskConical className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${connection.name}`} title="Edit name, environment or credentials" onClick={() => setEditing(connection)}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${connection.name}`} title="Delete connection" onClick={() => setRemoving(connection)}>
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      ),
    },
  ]

  return (
    <div className="mx-auto max-w-[980px] p-5 sm:p-8">
      <PageHeader
        title="Connections"
        subtitle="Exchange API accounts a bot can route through when it leaves the paper wallet."
        actions={
          <>
            <Button loading={addDemo.isPending} onClick={() => addDemo.mutate(undefined)}>
              <Plus />
              Demo accounts
            </Button>
            <Button onClick={() => setBulkOpen(true)}>
              <Upload />
              Upload APIs (JSON)
            </Button>
            <Button variant="primary" onClick={() => setComposing(true)}>
              <Plus />
              Add connection
            </Button>
          </>
        }
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        {(
          [
            { label: 'Connections', value: String(items.length) },
            { label: 'Live default', value: String(liveCount) },
            { label: 'With bots attached', value: String(items.filter((c) => (botsUsing.get(c.id) ?? 0) > 0).length) },
            { label: 'Bots needing keys', value: String((botList?.items ?? []).filter((b) => b.mode === 'paper' && !b.connectionId && activityOf(b) === 'hangar').length) },
          ] as const
        ).map((tile) => (
          <div key={tile.label} className="rounded-card border border-line p-3">
            <p className="text-[12px] text-muted">{tile.label}</p>
            <p className="mt-0.5 text-[18px] font-semibold tabular-nums">{tile.value}</p>
          </div>
        ))}
      </div>

      <Card className="mt-3 flex items-start gap-3 p-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-info-soft text-info [&_svg]:size-4">
          <Info />
        </span>
        <p className="text-[13px] leading-relaxed text-muted">
          Keys are stored per workspace and <span className="font-medium text-fg">masked after save</span> — the API never returns them again, and
          one bot can route across up to four connections, filling on whichever venue quotes the best price. BSE is live through Upstox (cash
          equities plus SENSEX, BANKEX, SENSEX50 and FOCIT futures and options, mapped from the exchange instrument master); every other exchange
          still needs an adapter and a live bot on one pauses with a clear error instead of pretending to trade.
          Deleting a connection detaches every bot that used it and grounds live bots left with no venue back to paper mode.
        </p>
      </Card>

      {items.some((connection) => connection.exchange === 'BSE (via Upstox)') ? (
        <Card className="mt-3 flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">BSE instrument master</p>
            <p className="mt-0.5 text-[12.5px] text-muted">
              {master && master.contracts > 0
                ? `${master.contracts.toLocaleString()} live derivative contracts (${master.underlyings.join(', ')}) · loaded ${master.syncedAt ? shortDate(master.syncedAt) : 'never'}`
                : 'Not loaded yet — download the exchange contract list so futures and options can route live.'}
            </p>
          </div>
          <Button loading={refreshMaster.isPending} onClick={() => refreshMaster.mutate(undefined)}>
            Refresh contracts
          </Button>
        </Card>
      ) : null}

      <div className="mt-4">
        {isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-tile" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Plug />}
            title="No connections yet"
            description="Add an exchange account so bots have somewhere to route orders — BSE connections execute live through Upstox."
            action={
              <>
                <Button variant="primary" onClick={() => setComposing(true)}>
                  <Plus />
                  Add connection
                </Button>
                <Button loading={addDemo.isPending} onClick={() => addDemo.mutate(undefined)}>
                  <Plus />
                  Demo accounts
                </Button>
              </>
            }
          />
        ) : (
          <DataTable columns={columns} rows={items} rowKey={(row) => row.id} />
        )}
      </div>

      <ConnectionForm open={composing} onClose={() => setComposing(false)} />
      <ConnectionForm open={editing !== null} onClose={() => setEditing(null)} connection={editing} />
      <BulkConnectionsDialog open={bulkOpen} onClose={() => setBulkOpen(false)} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => remove.mutate(removing!.id)}
        loading={remove.isPending}
        title="Delete this connection?"
        description={
          (botsUsing.get(removing?.id ?? '') ?? 0) > 0
            ? `${botsUsing.get(removing?.id ?? '')} bot${(botsUsing.get(removing?.id ?? '') ?? 0) === 1 ? '' : 's'} still reference it — they are detached (and grounded to paper if live).`
            : 'Nothing references it; it can be deleted safely.'
        }
      />
    </div>
  )
}
