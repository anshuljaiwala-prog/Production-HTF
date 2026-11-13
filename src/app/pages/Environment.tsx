import { Activity, AlertTriangle, Building2, Gauge, Globe, History, PauseCircle, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Badge, Button, Card, PageHeader, Skeleton, useToast } from '../components/ui'
import { setEnvironmentControls, useApiMutation, useEnvironment, useEnvironmentTrace } from '../lib/api'
import { cx } from '../lib/cx'
import type {
  AgentDecisionTrace,
  AgentProposal,
  NewsPin,
  PredictionCalibration,
  TraceDecision,
} from '../../shared/types'

/** The live environment, as the workspace's Durable Object holds it: the world
 * positions the bots read, the pins it keeps, the company knowledge behind the
 * focused ticker, and what the specialist analysts concluded from it. */
export function Environment() {
  const [focus, setFocus] = useState<string | undefined>(undefined)
  const { data, isLoading, error } = useEnvironment(focus)
  const trace = useEnvironmentTrace(focus)
  const toast = useToast()

  // New pins are announced once: the toast remembers ids it has already shown,
  // so a poll that re-sends the same held pin never repeats itself.
  const announced = useRef<Set<string>>(new Set())

  useEffect(() => {
    const pins = data?.pins ?? []
    for (const pin of pins) {
      if (announced.current.has(pin.id)) continue
      announced.current.add(pin.id)
      // Only events an operator must act on earn a toast; routine tape is
      // already on the page.
      if (pin.impactLevel === 'CRITICAL' || pin.impactLevel === 'HIGH') {
        toast(pin.title, pin.impactLevel === 'CRITICAL' ? 'danger' : 'neutral')
      }
    }
  }, [data?.pins, toast])

  const controls = useApiMutation(
    (patch: { paused?: boolean; pauseBuys?: boolean }) => setEnvironmentControls(patch),
    ['environment'],
    { onError: (err) => toast(err.message, 'danger') },
  )

  if (isLoading && !data) {
    return (
      <div className="flex flex-col gap-4 p-5">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-5">
        <PageHeader title="Environment" subtitle="The world the bots read." />
        <Card className="mt-4 p-5 text-[13.5px] text-muted">
          {error?.message ?? 'The live environment is not available on this deployment.'}
        </Card>
      </div>
    )
  }

  const { read, pins, controls: live } = data
  const company = read.company
  const verdict = read.verdict
  const move = read.nextMove

  return (
    <div className="flex flex-col gap-5 p-5">
      <PageHeader
        title="Environment"
        subtitle="World positions, held pins, company knowledge and the specialists' verdict — the state every bot is gated on."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={live.pauseBuys ? 'primary' : 'secondary'}
              size="sm"
              disabled={controls.isPending}
              onClick={() => controls.mutate({ pauseBuys: !live.pauseBuys })}
            >
              <PauseCircle className="size-3.5" />
              {live.pauseBuys ? 'Entries paused' : 'Pause entries'}
            </Button>
            <Button
              variant={live.paused ? 'primary' : 'secondary'}
              size="sm"
              disabled={controls.isPending}
              onClick={() => controls.mutate({ paused: !live.paused })}
            >
              <ShieldAlert className="size-3.5" />
              {live.paused ? 'Frozen' : 'Freeze all'}
            </Button>
          </div>
        }
      />

      {live.paused && (
        <div className="flex items-center gap-2 rounded-card border border-line bg-warning/10 px-4 py-2.5 text-[13px]">
          <AlertTriangle className="size-4 text-warning" />
          The environment is frozen: every bot holds its book where it stands until you unfreeze it.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <Globe className="size-4 text-muted" /> World positions
            </span>
            <Badge tone={read.regime === 'RISK_OFF_CONTAGION' ? 'danger' : read.regime === 'RISK_ON_BOOM' ? 'success' : 'neutral'}>
              {read.regime.replace(/_/g, ' ').toLowerCase()}
            </Badge>
          </div>
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {read.markets.map((market) => (
              <li key={market.symbol}>
                <button
                  type="button"
                  onClick={() => setFocus(market.symbol)}
                  className={cx(
                    'flex w-full items-center justify-between gap-3 py-2 text-left text-[13px] transition-colors hover:text-accent',
                    focus === market.symbol && 'text-accent',
                  )}
                >
                  <span className="font-medium">{market.symbol}</span>
                  <span className="flex items-center gap-3 text-[12.5px] tabular-nums">
                    <span className={market.changePct >= 0 ? 'text-success' : 'text-danger'}>
                      {market.changePct >= 0 ? '+' : ''}
                      {market.changePct.toFixed(2)}%
                    </span>
                    <span className="text-faint">rsi {market.rsi.toFixed(1)}</span>
                    {market.anomaly.signal !== 'NORMAL_VARIATION' && (
                      <Badge tone={market.anomaly.signal === 'CRASH_TRIGGER' ? 'danger' : 'info'}>{market.anomaly.signal.replace(/_/g, ' ').toLowerCase()}</Badge>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-faint">
            {read.screened.rejectedBars} bar{read.screened.rejectedBars === 1 ? '' : 's'} and {read.screened.rejectedPins} pin
            {read.screened.rejectedPins === 1 ? '' : 's'} rejected by the harvester's screener this read
            {rejectSummary(read.screened.barReasons, read.screened.pinReasons) && ` — ${rejectSummary(read.screened.barReasons, read.screened.pinReasons)}`}.
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <Activity className="size-4 text-muted" /> Pins
            </span>
            <span className="text-[12px] text-faint">{pins.length} held</span>
          </div>
          {pins.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted">No tape event has been pinned since the environment started.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {pins.slice(0, 8).map((pin) => (
                <PinRow key={pin.id} pin={pin} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <Building2 className="size-4 text-muted" /> {company.ticker}
            </span>
            {company.factsAvailable ? (
              <Badge tone="info">{(company.institutionalPct * 100).toFixed(1)}% institutional</Badge>
            ) : (
              <Badge tone="neutral">no ownership facts</Badge>
            )}
          </div>
          {company.ownership.length > 0 ? (
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {company.ownership.map((holder) => (
                <li key={holder.holder} className="flex items-center justify-between py-1.5 text-[13px]">
                  <span>{holder.holder}</span>
                  <span className="tabular-nums text-muted">
                    {(holder.percentage * 100).toFixed(1)}% · {holder.holderType.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-muted">The environment holds no ownership records for this ticker, so nothing is inferred.</p>
          )}
          {company.affiliations.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {company.affiliations.map((affiliation) => (
                <Badge key={affiliation} tone="neutral">
                  {affiliation}
                </Badge>
              ))}
            </div>
          )}
          <div className="mt-4 border-t border-line pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-faint">Next move</span>
              <span className="text-[13px] font-semibold tabular-nums">{(move.probability * 100).toFixed(0)}%</span>
            </div>
            <p className="mt-1 text-[13.5px] font-medium">{move.move}</p>
            <p className="mt-1 text-[12.5px] text-muted">{move.rationale}</p>
            {!move.factsAvailable && <p className="mt-1 text-[12px] text-faint">Probability runs on the tape-side baseline — this ticker has no seeded ownership.</p>}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold">Specialists</span>
            {verdict.winner ? (
              <Badge tone={verdict.bias >= 0 ? 'success' : 'danger'}>
                {verdict.winner} · {verdict.conviction.toFixed(2)}
              </Badge>
            ) : (
              <Badge tone="neutral">no verdict</Badge>
            )}
          </div>
          <ul className="mt-3 flex flex-col gap-2.5">
            {read.proposals.map((proposal) => (
              <ProposalRow key={proposal.agent} proposal={proposal} winner={verdict.winner === proposal.agent} threshold={verdict.threshold} />
            ))}
          </ul>
          <p className="mt-3 border-t border-line pt-2.5 text-[12px] text-faint">
            {verdict.winner ? verdict.rationale : `${verdict.rationale} Nothing is acted on this read.`}
          </p>
          {read.inferences.length > 0 && (
            <p className="mt-1 text-[12px] text-faint">
              Forward chaining fired {read.inferences.length}: {read.inferences.map((i) => i.inferredFact).join(', ')}.
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <DecisionTimeline traces={trace.data?.traces ?? []} />
        <CalibrationCard calibration={trace.data?.calibration} />
      </div>
    </div>
  )
}

function PinRow({ pin }: { pin: NewsPin & { firstSeen: number; lastSeen: number; reads: number } }) {
  const tone = pin.impactLevel === 'CRITICAL' ? 'danger' : pin.impactLevel === 'HIGH' ? 'warning' : 'neutral'
  return (
    <li className="rounded-control bg-surface-2 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-medium">{pin.title}</span>
        <Badge tone={tone}>{pin.impactLevel}</Badge>
      </div>
      <p className="mt-0.5 text-[12px] text-muted">{pin.ticker} · {pin.source}</p>
      <p className="mt-0.5 text-[11.5px] text-faint">
        first seen {new Date(pin.firstSeen).toLocaleTimeString()} · re-read {pin.reads}×
      </p>
    </li>
  )
}

function DecisionTimeline({ traces }: { traces: AgentDecisionTrace[] }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-semibold">
          <History className="size-4 text-muted" /> Decision timeline
        </span>
        <span className="text-[12px] text-faint">{traces.length} closed bars</span>
      </div>
      {traces.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">
          No bar has been traced yet — a running bot records one entry per closed bar on its next advance.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {traces.map((entry) => (
            <li key={`${entry.botId}:${entry.at}`} className="py-2.5">
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="font-medium">{entry.botName}</span>
                <span className="text-[11.5px] tabular-nums text-faint">{new Date(entry.at).toLocaleString()}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone={entry.gate.blocked ? 'danger' : 'success'}>{entry.gate.blocked ? 'gate blocked' : 'gate open'}</Badge>
                {entry.gate.reason && <span className="text-[11.5px] text-muted">{entry.gate.reason}</span>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                {entry.verdict.winner ? (
                  <Badge tone="info">
                    {entry.verdict.winner} · {(entry.verdict.conviction * 100).toFixed(0)}% ≥ {(entry.verdict.threshold * 100).toFixed(0)}%
                  </Badge>
                ) : (
                  <span className="text-faint">no winner cleared {(entry.verdict.threshold * 100).toFixed(0)}%</span>
                )}
              </div>
              <ul className="mt-1 flex flex-col gap-0.5">
                {entry.decisions.map((decision) => (
                  <DecisionRow key={decision.symbol} decision={decision} />
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-faint">
                {entry.proposals
                  .map((proposal) => `${proposal.agent} ${(proposal.conviction * 100).toFixed(0)}% [${proposal.factIds.join(', ')}]`)
                  .join(' · ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function DecisionRow({ decision }: { decision: TraceDecision }) {
  const outcome = decision.fill
    ? `filled ${decision.qty === null ? '—' : decision.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
    : decision.reject
      ? `rejected: ${decision.reject.replace(/_/g, ' ')}`
      : 'held'
  return (
    <li className="flex items-baseline justify-between gap-2 text-[12px]">
      <span className="text-muted">
        <span className="font-medium text-fg">{decision.symbol}</span> {decision.action}
        {decision.reason ? ` · ${decision.reason}` : ''}
      </span>
      <span className={cx('shrink-0 tabular-nums', decision.fill ? 'text-success' : decision.reject ? 'text-danger' : 'text-faint')}>
        {outcome}
      </span>
    </li>
  )
}

function CalibrationCard({ calibration }: { calibration?: PredictionCalibration }) {
  const brier = calibration?.brier ?? null
  const beatsCoin = brier !== null && brier < (calibration?.baseline ?? 0.25)
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-semibold">
          <Gauge className="size-4 text-muted" /> Prediction calibration
        </span>
        <Badge tone={brier === null ? 'neutral' : beatsCoin ? 'success' : 'warning'}>
          Brier {brier === null ? '—' : brier.toFixed(3)}
        </Badge>
      </div>
      <p className="mt-1.5 text-[12.5px] text-muted">
        {calibration?.resolved ?? 0} forecast{(calibration?.resolved ?? 0) === 1 ? '' : 's'} scored against the bar that followed.
        Lower is better; a constant 0.5 forecast scores {(calibration?.baseline ?? 0.25).toFixed(2)}.
      </p>
      {(calibration?.bins ?? []).some((bin) => bin.count > 0) ? (
        <table className="mt-2.5 w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-faint">
              <th className="pb-1 font-semibold">Confidence</th>
              <th className="pb-1 text-right font-semibold">n</th>
              <th className="pb-1 text-right font-semibold">Said</th>
              <th className="pb-1 text-right font-semibold">Happened</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {calibration?.bins.map((bin) => (
              <tr key={`${bin.from}-${bin.to}`} className={cx(bin.count === 0 && 'text-faint')}>
                <td className="py-1">
                  {(bin.from * 100).toFixed(0)}–{(bin.to * 100).toFixed(0)}%
                </td>
                <td className="py-1 text-right">{bin.count}</td>
                <td className="py-1 text-right">{bin.count ? `${(bin.meanPredicted * 100).toFixed(0)}%` : '—'}</td>
                <td className="py-1 text-right">{bin.count ? `${(bin.observed * 100).toFixed(0)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-[12px] text-faint">
          No forecast has been scored yet — the engine records one per closed bar, scored on the bar that follows.
        </p>
      )}
      {(calibration?.latest.length ?? 0) > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 border-t border-line pt-2">
          {calibration?.latest.slice(0, 5).map((row) => (
            <li key={`${row.symbol}:${row.at}`} className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <span className="truncate text-muted">
                {row.symbol} · {row.move}
              </span>
              <span className="shrink-0 tabular-nums text-faint">
                {(row.probability * 100).toFixed(0)}% ·{' '}
                <span className={row.outcome ? 'text-success' : row.outcome === false ? 'text-danger' : ''}>
                  {row.returnPct === null ? 'pending' : `${row.returnPct >= 0 ? '+' : ''}${row.returnPct.toFixed(2)}%`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function rejectSummary(barReasons: Record<string, number>, pinReasons: Record<string, number>): string {
  return [...Object.entries(barReasons), ...Object.entries(pinReasons)]
    .map(([reason, count]) => `${count} ${reason.replace(/_/g, ' ')}`)
    .join(', ')
}

function ProposalRow({ proposal, winner, threshold }: { proposal: AgentProposal; winner: boolean; threshold: number }) {
  const strength = Math.min(100, proposal.conviction * 100)
  const passed = proposal.conviction >= threshold && proposal.bias !== 0
  return (
    <li>
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className={cx('font-medium capitalize', winner && 'text-accent')}>
          {proposal.agent}
          {winner && ' · acting'}
        </span>
        <span className="tabular-nums text-muted">{(proposal.conviction * 100).toFixed(0)}%</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cx('h-full rounded-full', proposal.bias < 0 ? 'bg-danger' : 'bg-success', !passed && 'opacity-40')}
          style={{ width: `${strength}%` }}
        />
      </div>
      <p className="mt-1 text-[12px] text-muted">{proposal.rationale}</p>
    </li>
  )
}
