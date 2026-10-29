import { Info, Pencil, Plug, Plus, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { BulkConnectionsDialog, ConnectionForm } from '../components/forms'
import { Badge, Button, Card, ConfirmDialog, DataTable, type DataColumn, EmptyState, PageHeader, Skeleton, useToast } from '../components/ui'
import { addDemoConnections, deleteConnection, useApiMutation, useBots, useConnections } from '../lib/api'
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

  const items = data?.items ?? []
  const botsUsing = new Map<string, number>()
  for (const bot of botList?.items ?? []) {
    if (bot.connectionId) botsUsing.set(bot.connectionId, (botsUsing.get(bot.connectionId) ?? 0) + 1)
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
              added {shortDate(connection.createdAt)} · {connection.exchange === 'Paper (simulated)' ? 'simulated venue' : connection.exchange}
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
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${connection.name}`} title="Edit name, mode or credentials" onClick={() => setEditing(connection)}>
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
          Keys are stored per workspace and <span className="font-medium text-fg">masked after save</span> — the API never returns them again.
          Deleting a connection detaches every bot that used it and grounds live bots back to paper mode. v1 fills every order against the
          simulated venue; there is no live order router yet, so a live-mode bot pauses before its first fill instead of pretending to trade.
        </p>
      </Card>

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
            description="Add an exchange account so bots have somewhere to route orders once a live adapter ships."
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
