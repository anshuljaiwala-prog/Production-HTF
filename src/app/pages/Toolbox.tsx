import { Plus, Wrench, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, useToast } from '../components/ui'
import { ParamFields, paramDefaults } from '../components/form-fields'
import { assignPlan, createPlan, deletePlan, useApiMutation, useBook, useStrategies, useToolbox } from '../lib/api'
import { PATTERN_REGIMES, TIMEFRAMES } from '../../shared/types'
import type { ParamValue, PatternRegime, Playbook, Strategy } from '../../shared/types'

/** The tool box: trading execution plans — the concrete bot configuration a
 * recognised pattern calls for. Builtin plans carry the textbook response to
 * each regime; the operator can draft their own from any catalog strategy
 * and assign whichever plan answers each regime on the Strategy book tab. */

const regimeTone: Record<PatternRegime, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  crash: 'danger',
  selloff: 'warning',
  hype: 'success',
  breakout: 'success',
  squeeze: 'info',
  uptrend: 'success',
  downtrend: 'warning',
  range: 'info',
}

export function ToolboxPanel() {
  const { data, isLoading } = useToolbox()
  const { data: strategiesData } = useStrategies()
  const { data: book } = useBook()
  const toast = useToast()
  const [drafting, setDrafting] = useState(false)

  const remove = useApiMutation((id: string) => deletePlan(id), [], {
    onSuccess: () => toast('Plan deleted — if the book assigned it, that regime falls back to the builtin default.'),
  })
  const assign = useApiMutation((input: { regime: string; playbookId: string }) => assignPlan(input.regime, input.playbookId), ['book'], {
    onSuccess: () => toast('Book updated — that plan now fires when the scanner calls that regime.'),
  })

  const items = useMemo(() => data?.items ?? [], [data])
  const strategyNames = useMemo(() => new Map((strategiesData?.strategies ?? []).map((s) => [s.key, s.name])), [strategiesData])
  const assignedIds = useMemo(() => new Set(book?.items.map((entry) => entry.playbook.id) ?? []), [book])

  if (isLoading) {
    return (
      <div className="grid gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>
    )
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">
          {items.length} plans · {data?.bookCoverage ?? 0} of {PATTERN_REGIMES.length} regimes covered in the book
        </p>
        <Button onClick={() => setDrafting(true)}>
          <Plus />
          New plan
        </Button>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {items.map((plan) => (
          <PlaybookCard
            key={plan.id}
            plan={plan}
            strategyName={strategyNames.get(plan.strategyKey) ?? plan.strategyKey}
            inBook={assignedIds.has(plan.id)}
            onAssign={() => assign.mutate({ regime: plan.regime, playbookId: plan.id })}
            onDelete={plan.source === 'custom' ? () => remove.mutate(plan.id) : undefined}
            deleting={remove.isPending && remove.variables === plan.id}
          />
        ))}
      </div>

      {items.length === 0 && (
        <EmptyState icon={<Wrench />} title="No plans yet" description="Draft an execution plan: strategy, timeframe, risk and the regime that calls for it." action={<Button variant="primary" onClick={() => setDrafting(true)}><Plus />New plan</Button>} />
      )}

      <DraftPlanDialog open={drafting} onClose={() => setDrafting(false)} strategies={strategiesData?.strategies ?? []} />
    </>
  )
}

function PlaybookCard({
  plan,
  strategyName,
  inBook,
  onAssign,
  onDelete,
  deleting,
}: {
  plan: Playbook
  strategyName: string
  inBook: boolean
  onAssign: () => void
  onDelete?: () => void
  deleting: boolean
}) {
  const strategy = strategyName
  const timeframe = plan.timeframe ? `${plan.timeframe} bars` : 'follows the bot'
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[14px] font-semibold">{plan.name}</h3>
            <Badge tone={regimeTone[plan.regime]}>{PATTERN_REGIMES.find((r) => r.key === plan.regime)?.label ?? plan.regime}</Badge>
            <Badge tone={plan.source === 'builtin' ? 'neutral' : 'info'} title={plan.source === 'builtin' ? 'Shipped with the product' : 'Your own draft'}>
              {plan.source}
            </Badge>
          </div>
          <p className="mt-1 text-[12.5px] text-muted">
            {strategy} · {plan.riskPct}% per fill · {timeframe}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              title="Delete this custom plan"
              className="grid size-8 place-items-center rounded-[9px] text-faint transition-colors hover:text-danger disabled:opacity-50"
            >
              <Trash2 className="size-4" />
            </button>
          )}
          <Button variant={inBook ? 'secondary' : 'primary'} onClick={onAssign} disabled={inBook}>
            {inBook ? 'In the book' : 'Put in book'}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-[13px] text-muted">{plan.note}</p>
    </Card>
  )
}

function DraftPlanDialog({
  open,
  onClose,
  strategies,
}: {
  open: boolean
  onClose: () => void
  strategies: Strategy[]
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [regime, setRegime] = useState<PatternRegime>('crash')
  const [strategyKey, setStrategyKey] = useState('')
  const [riskPct, setRiskPct] = useState('25')
  const [timeframe, setTimeframe] = useState('')
  const [note, setNote] = useState('')
  const [params, setParams] = useState<Record<string, ParamValue>>({})

  const strategy = strategies.find((s) => s.key === strategyKey)
  const selectedTimeframes = strategy?.timeframes ?? []
  const effectiveTimeframe = selectedTimeframes.includes(timeframe as never) ? timeframe : selectedTimeframes.length > 0 ? selectedTimeframes[Math.floor(selectedTimeframes.length / 2)] : ''

  const create = useApiMutation(addPlan, ['toolbox', 'book'], {
    onSuccess: (result) => {
      toast(`Plan "${result.playbook.name}" saved to the tool box.`)
      onClose()
    },
  })

  function resetState() {
    setName('')
    setRegime('crash')
    setStrategyKey('')
    setRiskPct('25')
    setTimeframe('')
    setNote('')
    setParams({})
  }
  const ready = Boolean(name.trim() && strategyKey && strategy && note.trim() && Number(riskPct) >= 1)

  return (
    <Dialog
      open={open}
      onClose={() => {
        resetState()
        onClose()
      }}
      width={640}
      title="Draft an execution plan"
      description="The bot configuration to run when the scanner recognises a regime: a strategy with its parameters, a sizing rule, and why that answer fits that regime."
      footer={
        <>
          <Button onClick={() => { resetState(); onClose() }}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!ready}
            onClick={() =>
              create.mutate({
                name: name.trim(),
                regime,
                strategyKey,
                params: params,
                timeframe: effectiveTimeframe || null,
                riskPct: Number(riskPct) || 25,
                note: note.trim(),
              })
            }
          >
            Save plan
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plan name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Catch the Bounce v2" />
          </Field>
          <Field label="Fires on regime" hint="The pattern read that calls for this plan">
            <Select value={regime} onChange={(e) => setRegime(e.target.value as PatternRegime)}>
              {PATTERN_REGIMES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label} — {r.hint}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Strategy" hint="Any strategy from the catalog">
            <Select
              value={strategyKey}
              onChange={(e) => {
                setStrategyKey(e.target.value)
                const next = strategies.find((s) => s.key === e.target.value)
                setParams(next ? paramDefaults(next) : {})
                setTimeframe(next ? (next.timeframes.length > 0 ? next.timeframes[Math.floor(next.timeframes.length / 2)] : '') : '')
              }}
            >
              <option value="">Pick a strategy…</option>
              {strategies.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Timeframe" hint="The bars the plan reads">
            <Select value={effectiveTimeframe} onChange={(e) => setTimeframe(e.target.value)} disabled={selectedTimeframes.length === 0}>
              {selectedTimeframes.map((tf) => TIMEFRAMES.filter((t) => t.key === tf).map((t) => (
                <option key={tf} value={tf}>
                  {t.label}
                </option>
              )))}
            </Select>
          </Field>
        </div>
        <Field label="Risk per fill (%)" hint="Position sizing as a percent of equity, 1–100">
          <Input type="number" min={1} max={100} step={0.5} value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
        </Field>
        {strategy && <ParamFields params={params} defs={strategy.params} onChange={setParams} />}
        <Field label="Why this answers the regime" hint="One operator-readable line, stored with the plan">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Rationale the book shows when executing." />
        </Field>
        {create.error && <p className="text-[13px] text-danger">{create.error.message}</p>}
      </div>
    </Dialog>
  )
}

/** The dialog builds the POST body field by field; the cast lives here so
 * the component itself stays honest about its own fields. */
function addPlan(draft: {
  name: string
  regime: string
  strategyKey: string
  params?: Record<string, ParamValue>
  timeframe: string | null
  riskPct: number
  note: string
}) {
  return createPlan(draft as never)
}
