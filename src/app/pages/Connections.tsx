import { Info, Plug, Plus, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'

import { BulkConnectionsDialog, ConnectionForm } from '../components/forms'
import { Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Skeleton, useToast } from '../components/ui'
import { addDemoConnections, deleteConnection, useApiMutation, useConnections } from '../lib/api'
import { shortDate } from '../lib/format'
import type { Connection } from '../../shared/types'

export function Connections() {
  const { data, isLoading } = useConnections()
  const toast = useToast()
  const [composing, setComposing] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [removing, setRemoving] = useState<Connection | null>(null)

  const remove = useApiMutation((connectionId: string) => deleteConnection(connectionId), ['connections'], {
    onSuccess: () => {
      setRemoving(null)
      toast('Connection deleted')
    },
  })

  // Demo credentials the simulated venue accepts — for testing the picker
  // and live mode without real exchange keys.
  const addDemo = useApiMutation(() => addDemoConnections(), ['connections'], {
    onSuccess: (result) => toast(result.added > 0 ? `Added ${result.added} demo connection${result.added === 1 ? '' : 's'}` : 'Demo connections already present'),
  })

  return (
    <div className="mx-auto max-w-[900px] p-5 sm:p-8">
      <PageHeader
        title="Connections"
        subtitle="Exchange credentials for when a bot moves beyond paper."
        actions={
          <>
            <Button loading={addDemo.isPending} onClick={() => addDemo.mutate(undefined)}>
              <Plus />
              Add demo connections
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

      <Card className="mt-5 flex items-start gap-3 p-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-info-soft text-info [&_svg]:size-4">
          <Info />
        </span>
        <p className="text-[13px] leading-relaxed text-muted">
          Keys are stored per workspace and <span className="font-medium text-fg">masked after save</span> — the API never returns them again.
          Version 1 fills every order against the simulated venue; there is no live order router yet, so a bot set to live mode pauses
          before its first fill instead of pretending to trade.
        </p>
      </Card>

      <div className="mt-4 overflow-hidden rounded-card border border-line">
        <ul className="divide-y divide-line">
          {(data?.items ?? []).map((connection) => (
            <li key={connection.id} className="flex h-16 items-center gap-3 px-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-muted [&_svg]:size-4">
                <Plug />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{connection.name}</span>
                <span className="block truncate text-[12.5px] text-faint">
                  {connection.exchange} · key {connection.keyMasked} · added {shortDate(connection.createdAt)}
                </span>
              </span>
              <Badge tone={connection.mode === 'live' ? 'success' : 'info'}>{connection.mode}</Badge>
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${connection.name}`} onClick={() => setRemoving(connection)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        {isLoading && (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-tile" />
            ))}
          </div>
        )}
        {!isLoading && (data?.items.length ?? 0) === 0 && (
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
                  Add demo connections
                </Button>
              </>
            }
          />
        )}
      </div>

      <ConnectionForm open={composing} onClose={() => setComposing(false)} />
      <BulkConnectionsDialog open={bulkOpen} onClose={() => setBulkOpen(false)} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => remove.mutate(removing!.id)}
        loading={remove.isPending}
        title="Delete this connection?"
        description="Bots that reference it will need a new connection before they can go live."
      />
    </div>
  )
}
