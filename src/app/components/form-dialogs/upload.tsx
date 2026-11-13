import { useEffect, useState } from 'react'

import { capture } from '../../lib/analytics'
import { uploadCustomStrategy, useApiMutation } from '../../lib/api'
import { Button, Dialog, Field, Textarea, useToast } from '../ui'

const RULES_SKELETON = `{
  "name": "Mean-reversion pullback",
  "entry": [
    { "metric": "rsi", "n": 14, "op": "<", "value": 30 }
  ],
  "entryLogic": "any",
  "exit": [
    { "metric": "rsi", "n": 14, "op": ">", "value": 55 }
  ],
  "exitLogic": "all",
  "stopLossPct": 3,
  "takeProfitPct": 6
}`

function ruleText(rule: unknown): string {
  const r = rule as { metric?: string; n?: number; op?: string; value?: number } | null
  if (!r || typeof r !== 'object') return String(rule)
  return `${String(r.metric ?? '?')}(${Number(r.n ?? 0)}) ${String(r.op ?? '')} ${Number(r.value ?? 0)}`
}

export function UploadStrategyDialog({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean
  onClose: () => void
  onUploaded?: (id: string) => void
}) {
  const toast = useToast()
  const [payload, setPayload] = useState('')

  useEffect(() => {
    if (open) {
      setPayload('')
    }
  }, [open])

  let parseProblem = ''
  let rules: Record<string, unknown> | null = null
  const payloadTrim = payload.trim()
  if (payloadTrim) {
    try {
      const parsed = JSON.parse(payloadTrim) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rules = parsed as Record<string, unknown>
      } else {
        parseProblem = 'The payload must be a JSON object with name/entry/exit fields.'
      }
    } catch {
      parseProblem = 'Not valid JSON yet — fix the syntax to see the preview.'
    }
  }
  const entryList = Array.isArray(rules?.entry) ? (rules!.entry as unknown[]) : []
  const exitList = Array.isArray(rules?.exit) ? (rules!.exit as unknown[]) : []
  const name = typeof rules?.name === 'string' ? (rules!.name as string) : rules ? 'Unnamed strategy' : ''

  const upload = useApiMutation((rulesPayload: unknown) => uploadCustomStrategy(rulesPayload), ['custom-strategies', 'strategies'], {
    onSuccess: (result) => {
      // Adoption of user-authored rules: size and version, never the rules' content.
      capture('strategy_uploaded', {
        rules: result.strategy.rules,
        version: result.strategy.version,
        versions: result.strategy.versions,
        lookback: result.strategy.lookback,
      })
      toast(`Uploaded "${result.strategy.name}" · saved to D1, version ${result.strategy.version} of ${result.strategy.versions} (${result.strategy.rules} rules, lookback ${result.strategy.lookback})`)
      onClose()
      onUploaded?.(result.strategy.id)
    },
  })

  function submit() {
    if (!rules || entryList.length === 0 || exitList.length === 0) return
    upload.mutate(rules)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title="Upload a strategy (JSON payload)"
      description="Entry/exit conditions on rsi, ema, zscore, donchian and momentum metrics. Stored in D1 with version history — re-uploading the same name keeps the earlier versions."
      footer={
        <>
          <Button type="button" onClick={() => setPayload(RULES_SKELETON)}>Load a working skeleton</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="button"
            loading={upload.isPending}
            disabled={!rules || entryList.length === 0 || exitList.length === 0}
            onClick={submit}
          >
            Upload strategy
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Rules payload">
          <Textarea
            rows={10}
            spellCheck={false}
            className="font-mono text-[12.5px] leading-relaxed"
            placeholder={RULES_SKELETON}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </Field>

        {rules && !parseProblem ? (
          <div className="rounded-card border border-line">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[12.5px]">
              <span className="truncate font-medium">{name}</span>
              <span className="tabular-nums text-faint">{entryList.length} entry · {exitList.length} exit</span>
            </div>
            <ul className="divide-y divide-line px-4 py-2 text-[13px]">
              <li className="grid gap-1 py-1.5">
                <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">Enter when ({String(rules.entryLogic ?? 'all')})</span>
                {entryList.length ? entryList.map((rule, i) => <span key={i}>{ruleText(rule)}</span>) : <span className="text-warning">empty — the upload will be rejected</span>}
              </li>
              <li className="grid gap-1 py-1.5">
                <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">Exit when ({String(rules.exitLogic ?? 'all')})</span>
                {exitList.length ? exitList.map((rule, i) => <span key={i}>{ruleText(rule)}</span>) : <span className="text-warning">empty — the upload will be rejected</span>}
              </li>
              <li className="flex gap-4 py-1.5 text-[12.5px] text-muted">
                <span>Stop {Number(rules.stopLossPct ?? 0) || 'off'}{rules.stopLossPct ? '%' : ''}</span>
                <span>Target {Number(rules.takeProfitPct ?? 0) || 'off'}{rules.takeProfitPct ? '%' : ''}</span>
              </li>
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
