import { AnimatePresence, motion } from 'motion/react'
import { Bot, CandlestickChart, FlaskConical, LayoutGrid, Layers, Plug, Search, Wallet } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { useSearch } from '../lib/api'
import { cx } from '../lib/cx'

type Item = { key: string; label: string; detail?: string; to: string; icon: React.ReactNode }

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const { data } = useSearch(q)

  useEffect(() => {
    if (!open) {
      setQ('')
      setActive(0)
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    if (!data) return []
    return [
      ...data.bots.map((bot) => ({
        key: `b-${bot.id}`,
        label: bot.name,
        detail: bot.strategyName,
        to: `/bots/${bot.id}`,
        icon: (
          <span className="grid size-6 place-items-center rounded-[8px] bg-surface-2 text-muted">
            <Bot className="size-3.5" />
          </span>
        ),
      })),
      ...data.strategies.map((strategy) => ({
        key: `s-${strategy.key}`,
        label: strategy.name,
        detail: `${strategy.risk} risk`,
        to: `/strategies?s=${strategy.key}`,
        icon: (
          <span className="grid size-6 place-items-center rounded-[8px] bg-surface-2 text-muted">
            <FlaskConical className="size-3.5" />
          </span>
        ),
      })),
    ]
  }, [data])

  const shortcuts: Item[] = [
    { key: 's-dashboard', label: 'Go to dashboard', to: '/', icon: <LayoutGrid className="size-4 text-muted" /> },
    { key: 's-bots', label: 'Go to bots', to: '/bots', icon: <Bot className="size-4 text-muted" /> },
    { key: 's-strategies', label: 'Go to strategies', to: '/strategies', icon: <FlaskConical className="size-4 text-muted" /> },
    { key: 's-board', label: 'Go to the board', to: '/board', icon: <Layers className="size-4 text-muted" /> },
    { key: 's-backtests', label: 'Go to backtests', to: '/backtests', icon: <CandlestickChart className="size-4 text-muted" /> },
    { key: 's-portfolio', label: 'Go to portfolio', to: '/portfolio', icon: <Wallet className="size-4 text-muted" /> },
    { key: 's-connections', label: 'Go to connections', to: '/connections', icon: <Plug className="size-4 text-muted" /> },
  ]
  const list = q.trim() ? items : shortcuts

  useEffect(() => setActive(0), [q, list.length])

  function go(item: Item) {
    onClose()
    navigate(item.to)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-fg/25 px-4 pt-[12vh] backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-label="Search"
            className="w-full max-w-[560px] overflow-hidden rounded-dialog bg-surface shadow-dialog"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex h-12 items-center gap-3 border-b border-line px-4">
              <Search className="size-4 text-faint" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, list.length - 1)))
                  if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)))
                  if (e.key === 'Enter' && list[active]) go(list[active])
                  if (e.key === 'Escape') onClose()
                }}
                placeholder="Search bots and strategies"
                className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
              />
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-1.5">
              {list.length === 0 && <li className="px-3 py-8 text-center text-[13.5px] text-muted">Nothing matches “{q}”</li>}
              {list.map((item, i) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(item)}
                    className={cx('flex h-10 w-full items-center gap-3 rounded-control px-2.5 text-left', i === active && 'bg-surface-2')}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">{item.label}</span>
                    {item.detail && <span className="truncate text-[12.5px] text-faint">{item.detail}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
