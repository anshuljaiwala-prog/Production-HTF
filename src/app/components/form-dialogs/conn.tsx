import { useEffect, useState, type FormEvent } from 'react'

import { createConnection, updateConnection, useApiMutation, useConnections } from '../../lib/api'
import { Button, Dialog, Field, useToast } from '../ui'
import { FieldInput, FieldSelect } from '../form-fields'
import type { Connection } from '../../../shared/types'

type FormState = {
  name: string
  exchange: string
  apiKey: string
  apiSecret: string
  mode: 'paper' | 'live'
  environment: 'sandbox' | 'production'
}

export function ConnectionForm({ open, onClose, connection = null }: { open: boolean; onClose: () => void; connection?: Connection | null }) {
  const toast = useToast()
  const { data: catalog } = useConnections()
  const editing = connection !== null
  const [form, setForm] = useState<FormState>({ name: '', exchange: 'Alpaca', apiKey: '', apiSecret: '', mode: 'paper', environment: 'production' })

  // Create starts blank; edit starts from the stored (masked-only) row — the
  // key/secret fields stay empty and mean "keep the saved credential".
  useEffect(() => {
    if (!open) return
    if (connection) {
      setForm({
        name: connection.name,
        exchange: connection.exchange,
        apiKey: '',
        apiSecret: '',
        mode: connection.mode,
        environment: connection.environment ?? 'production',
      })
    } else {
      setForm({ name: '', exchange: catalog?.exchanges[1] ?? 'Alpaca', apiKey: '', apiSecret: '', mode: 'paper', environment: 'production' })
    }
  }, [open, connection, catalog])

  const save = useApiMutation((input: typeof form) => (editing ? updateConnection(connection.id, input) : createConnection(input)), ['connections', 'bots'], {
    onSuccess: () => {
      toast(editing ? 'Connection updated' : 'Connection saved')
      onClose()
    },
  })

  // Credential rotation on edit is optional; the server refuses a half
  // rotation (one field filled) so a stale secret can't survive a new key,
  // and coalesces blank fields to "keep the stored pair".
  function submit(e: FormEvent) {
    e.preventDefault()
    save.mutate(form)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${connection.name}` : 'Add exchange connection'}
      description="Credentials are stored per workspace, masked after save, and never returned by the API."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="connection-form" loading={save.isPending}>
            {editing ? 'Save changes' : 'Save connection'}
          </Button>
        </>
      }
    >
      <form id="connection-form" onSubmit={submit} className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <FieldInput required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Alpaca paper account" />
          </Field>
          <Field label="Exchange">
            <FieldSelect value={form.exchange} onChange={(e) => setForm({ ...form, exchange: e.target.value })}>
              {(catalog?.exchanges ?? ['Alpaca']).map((exchange) => (
                <option key={exchange} value={exchange}>
                  {exchange}
                </option>
              ))}
            </FieldSelect>
          </Field>
        </div>
        <Field
          label={editing ? 'API key (leave blank to keep the saved key)' : 'API key'}
          hint={editing ? 'Rotating requires the matching API secret — both are replaced together.' : undefined}
        >
          <FieldInput
            required={!editing}
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder={editing ? connection.keyMasked : undefined}
          />
        </Field>
        <Field
          label={editing ? 'API secret (leave blank to keep the saved secret)' : 'API secret'}
          hint="BSE connections: paste the Upstox access token here. Production tokens rotate daily; sandbox tokens last 30 days."
        >
          <FieldInput
            required={!editing}
            type="password"
            autoComplete="new-password"
            value={form.apiSecret}
            onChange={(e) => setForm({ ...form, apiSecret: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default mode" hint="What bots on this account start as.">
            <FieldSelect value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'paper' | 'live' })}>
              <option value="paper">Paper</option>
              <option value="live">Live</option>
            </FieldSelect>
          </Field>
          <Field label="Environment" hint="Sandbox rehearses against the venue's test API; production places real orders.">
            <FieldSelect value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value as 'sandbox' | 'production' })}>
              <option value="production">Production</option>
              <option value="sandbox">Sandbox / testnet</option>
            </FieldSelect>
          </Field>
        </div>
        {save.error && <p className="text-[13px] text-danger">{save.error.message}</p>}
      </form>
    </Dialog>
  )
}
