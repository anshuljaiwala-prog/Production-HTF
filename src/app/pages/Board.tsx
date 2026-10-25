import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Layers, Plus, Rocket } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { Badge, Button, EmptyState, Skeleton } from '../components/ui'
import { patchBot, useApiMutation, useBots } from '../lib/api'
import { cx } from '../lib/cx'
import { money, moneyCompact } from '../lib/format'
import { BOT_STAGES, type Bot, type BotStage } from '../../shared/types'

const stageDot: Record<BotStage, string> = {
  draft: 'bg-line-strong',
  backtest: 'bg-[#9d99f0]',
  paper: 'bg-info',
  live: 'bg-success',
}

/** The bot lifecycle kanban (draft → backtest → paper → live). Rendered as a
 * tab inside the Bots page; no own page chrome. */
export function BoardPanel() {
  const { data, isLoading } = useBots()
  const navigate = useNavigate()
  const [local, setLocal] = useState<Bot[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => setLocal(data?.items ?? []), [data])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const move = useApiMutation((input: { id: string; stage: BotStage; position: number }) => patchBot(input.id, input), [
    'bots',
    'bot',
    'dashboard',
  ])

  const columns = useMemo(
    () =>
      BOT_STAGES.map((stage) => ({
        ...stage,
        bots: local.filter((bot) => bot.stage === stage.key).sort((a, b) => a.position - b.position),
      })),
    [local],
  )
  const byId = useMemo(() => new Map(local.map((bot) => [bot.id, bot])), [local])

  function findStage(id: string): BotStage | undefined {
    if (BOT_STAGES.some((stage) => stage.key === id)) return id as BotStage
    return byId.get(id)?.stage
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over) return
    const from = findStage(String(active.id))
    const to = findStage(String(over.id))
    if (!from || !to || from === to) return
    // Move the card into the hovered column so the layout previews the drop.
    setLocal((prev) => {
      const target = prev.filter((bot) => bot.stage === to).sort((a, b) => a.position - b.position)
      const overIndex = target.findIndex((bot) => bot.id === over.id)
      const before = overIndex >= 0 ? target[overIndex] : undefined
      const after = overIndex >= 0 ? target[overIndex - 1] : target[target.length - 1]
      return prev.map((bot) => (bot.id === active.id ? { ...bot, stage: to, position: positionBetween(after?.position, before?.position) } : bot))
    })
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)
    if (!over) return
    const dragged = byId.get(String(active.id))
    if (!dragged) return
    const stage = findStage(String(over.id)) ?? dragged.stage
    const column = local.filter((bot) => bot.stage === stage && bot.id !== dragged.id).sort((a, b) => a.position - b.position)
    let position = dragged.position
    if (over.id !== active.id && over.id !== stage) {
      const overIndex = column.findIndex((bot) => bot.id === over.id)
      const original = data?.items.find((bot) => bot.id === dragged.id)
      const movingDown = original?.stage === stage && (original.position ?? 0) < (column[overIndex]?.position ?? 0)
      const before = movingDown ? column[overIndex + 1] : column[overIndex]
      const after = movingDown ? column[overIndex] : column[overIndex - 1]
      position = positionBetween(after?.position, before?.position)
    } else if (over.id === stage) {
      position = positionBetween(column[column.length - 1]?.position, undefined)
    }
    const next = local.map((bot) => (bot.id === dragged.id ? { ...bot, stage, position } : bot))
    setLocal(next)
    const original = data?.items.find((bot) => bot.id === dragged.id)
    if (original && original.stage === stage && original.position === position) return
    move.mutate({ id: dragged.id, stage, position })
  }

  const active = activeId ? byId.get(activeId) : undefined

  if (isLoading) {
    return (
      <div className="grid gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[300px] rounded-card" />
        ))}
      </div>
    )
  }

  return (
    <div className="min-h-[480px]">
      {local.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="The board is empty"
          description="Launch a strategy and its bot lands here, ready to move through the lifecycle."
          action={
            <Button variant="primary" onClick={() => navigate('/strategies')}>
              <Rocket />
              Launch a bot
            </Button>
          }
        />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => (setActiveId(null), setLocal(data?.items ?? []))}>
          <div className="scrollbar-thin flex-1 overflow-x-auto pb-6">
            <div className="grid min-w-[880px] gap-3 lg:grid-cols-4">
              {columns.map((column) => (
                <Column
                  key={column.key}
                  stage={column.key}
                  label={column.label}
                  bots={column.bots}
                  onOpen={(botId) => navigate(`/bots/${botId}`)}
                  onAdd={() => navigate('/strategies')}
                />
              ))}
            </div>
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }}>
            {active && <BotCard bot={active} overlay />}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  )
}

function positionBetween(after: number | undefined, before: number | undefined): number {
  if (after === undefined && before === undefined) return 0
  if (after === undefined) return (before as number) - 1
  if (before === undefined) return after + 1
  return (after + before) / 2
}

function Column({
  stage,
  label,
  bots,
  onOpen,
  onAdd,
}: {
  stage: BotStage
  label: string
  bots: Bot[]
  onOpen: (botId: string) => void
  onAdd: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage })
  const equity = bots.reduce((sum, bot) => sum + bot.equity, 0)
  return (
    <section className="flex min-h-0 flex-col">
      <header className="flex h-9 items-center gap-2 px-1">
        <span className={cx('round size-2', stageDot[stage])} />
        <h2 className="text-[13px] font-semibold">{label}</h2>
        <span className="text-[12.5px] tabular-nums text-faint">{bots.length}</span>
        <span className="ml-auto text-[12.5px] tabular-nums text-muted">{moneyCompact(equity)}</span>
      </header>
      <div
        ref={setNodeRef}
        className={cx(
          'flex min-h-[160px] flex-1 flex-col gap-2 rounded-card border border-dashed p-2 transition-colors',
          isOver ? 'border-accent/50 bg-accent-soft/40' : 'border-transparent bg-bg/70',
        )}
      >
        <SortableContext items={bots.map((bot) => bot.id)} strategy={verticalListSortingStrategy}>
          {bots.map((bot) => (
            <SortableCard key={bot.id} bot={bot} onOpen={() => onOpen(bot.id)} />
          ))}
        </SortableContext>
        <button
          type="button"
          onClick={onAdd}
          className="flex h-9 items-center justify-center gap-1.5 rounded-control text-[12.5px] text-faint transition-colors hover:bg-surface hover:text-fg"
        >
          <Plus className="size-3.5" />
          Launch bot
        </button>
      </div>
    </section>
  )
}

function SortableCard({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bot.id })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} {...attributes} {...listeners} className={cx(isDragging && 'opacity-30')}>
      <BotCard bot={bot} onOpen={onOpen} />
    </div>
  )
}

function BotCard({ bot, onOpen, overlay }: { bot: Bot; onOpen?: () => void; overlay?: boolean }) {
  const pnl = bot.initialEquity > 0 ? ((bot.equity - bot.initialEquity) / bot.initialEquity) * 100 : 0
  return (
    <article
      onClick={onOpen}
      className={cx(
        'cursor-grab rounded-[14px] border border-line bg-surface p-3 text-left shadow-card transition-[box-shadow,border-color] hover:border-line-strong active:cursor-grabbing',
        overlay && 'rotate-[1.5deg] cursor-grabbing shadow-pop',
      )}
    >
      <p className="line-clamp-2 text-[13.5px] font-medium leading-snug">{bot.name}</p>
      <p className="mt-0.5 truncate text-[12.5px] text-muted">
        {bot.strategyName} · {bot.symbols.join(', ')}
      </p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[13px] font-semibold tabular-nums">{money(bot.equity)}</span>
        <div className="flex items-center gap-2">
          <span className={cx('text-[12.5px] tabular-nums', pnl >= 0 ? 'text-success' : 'text-danger')}>
            {pnl >= 0 ? '+' : ''}
            {pnl.toFixed(1)}%
          </span>
          <Badge tone={bot.mode === 'live' ? 'success' : 'neutral'}>{bot.mode}</Badge>
          <span
            className={cx('round size-2', bot.status === 'running' ? 'bg-success' : bot.status === 'paused' ? 'bg-warning' : 'bg-line-strong')}
            aria-label={bot.status}
          />
        </div>
      </div>
    </article>
  )
}
