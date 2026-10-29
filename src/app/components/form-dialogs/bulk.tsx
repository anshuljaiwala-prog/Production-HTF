// --- Bulk exchange-API (connections) upload ---------------------------------

const CONNECTIONS_SKELETON = `[
  { "name": "My Alpaca paper", "exchange": "Alpaca", "apiKey": "AK123...", "apiSecret": "s3cr3t...", "mode": "paper" },
  { "name": "My Binance paper", "exchange": "Binance", "apiKey": "BNB432...", "apiSecret": "hush...", "mode": "paper" }
]`

interface ConnectionRowPreview {
  name: string
  exchange: string
  mode: 'paper' | 'live'
  problem: string | null
}

/** Paste many exchange-API credential sets from one JSON array; each row is
 * previewed with the exact problem the server would reject it for, and
 * upload validates the same way row-by-row before storing anything. */

import { useEffect, useState } from 'react'

import { uploadConnections, useApiMutation } from '../../lib/api'
import { Badge, Button, Dialog, Field, Textarea, useToast } from '../ui'

export function BulkConnectionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [payload, setPayload] = useState('')

  useEffect(() => {
    if (open) setPayload('')
  }, [open])

  let parseProblem = ''
  let rawRows: unknown[] = []
  const payloadTrim = payload.trim()
  if (payloadTrim) {
    try {
      const parsed = JSON.parse(payloadTrim) as unknown
      const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : []
      if (list.length === 0) parseProblem = 'No rows found — expected a JSON array of connection objects.'
      else if (list.length > 20) parseProblem = `${list.length} rows — at most 20 can be uploaded at once.`
      else rawRows = list
    } catch {
      parseProblem = 'Not valid JSON yet — fix the syntax to see the preview.'
    }
  }

  const rows: ConnectionRowPreview[] = rawRows.map((raw) => {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 60) : ''
    const exchange = typeof row.exchange === 'string' && row.exchange.trim() ? row.exchange.trim() : 'Alpaca'
    const apiKey = typeof row.apiKey === 'string' ? row.apiKey.trim() : ''
    const apiSecret = typeof row.apiSecret === 'string' ? row.apiSecret.trim() : ''
    return {
      name: name || '—',
      exchange,
      mode: row.mode === 'live' ? 'live' : 'paper',
      problem: !name ? 'Missing a name.' : !apiKey || !apiSecret ? 'Missing the API key or secret.' : null,
    }
  })
  const ready = rows.filter((row) => row.problem === null).length

  const upload = useApiMutation((items: { name: string; exchange: string; apiKey: string; apiSecret: string; mode: 'paper' | 'live' }[]) => uploadConnections(items), ['connections'], {
    onSuccess: (result) => {
      const failed = result.failed.length
      toast(`${result.created.length} connection${result.created.length === 1 ? '' : 's'} saved${failed ? ` · ${failed} rejected` : ''}`)
      onClose()
    },
  })

  function submit() {
    if (ready === 0) return
    const items: { name: string; exchange: string; apiKey: string; apiSecret: string; mode: 'paper' | 'live' }[] = []
    for (const raw of rawRows) {
      const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 60) : ''
      const apiKey = typeof rec.apiKey === 'string' ? rec.apiKey.trim() : ''
      const apiSecret = typeof rec.apiSecret === 'string' ? rec.apiSecret.trim() : ''
      if (!name || !apiKey || !apiSecret) continue
      items.push({
        name,
        exchange: typeof rec.exchange === 'string' && rec.exchange.trim() ? rec.exchange.trim().slice(0, 40) : 'Alpaca',
        apiKey,
        apiSecret,
        mode: rec.mode === 'live' ? 'live' : 'paper',
      })
    }
    upload.mutate(items)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title="Upload exchange APIs (JSON)"
      description="Paste a JSON array of credential sets. Rows are validated one by one — previewed here before anything is stored."
      footer={
        <>
          <Button type="button" onClick={() => setPayload(CONNECTIONS_SKELETON)}>Load a skeleton</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="button" loading={upload.isPending} disabled={ready === 0} onClick={submit}>
            Save {ready || ''} connection{ready === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Connections payload">
          <Textarea
            rows={8}
            spellCheck={false}
            className="font-mono text-[12.5px] leading-relaxed"
            placeholder={CONNECTIONS_SKELETON}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </Field>
        {rows.length > 0 ? (
          <div className="rounded-card border border-line">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[12.5px]">
              <span className="font-medium">Preview</span>
              <span className="tabular-nums text-faint">{ready} ready · {rows.length - ready} rejected</span>
            </div>
            <ul className="max-h-[220px] divide-y divide-line overflow-y-auto">
              {rows.map((row, index) => (
                <li key={index} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                  {row.problem ? <Badge tone="danger" dot>{row.problem}</Badge> : <Badge tone="success" dot>ready {row.mode}</Badge>}
                  <span className="min-w-0 flex-1 truncate">
                    {row.name}
                    <span className="ml-1.5 text-[12px] text-faint">{row.exchange}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          parseProblem && <p className="text-[13px] text-warning">{parseProblem}</p>
        )}
        {upload.error && <p className="text-[13px] text-danger">{upload.error.message}</p>}
      </div>
    </Dialog>
  )
}

