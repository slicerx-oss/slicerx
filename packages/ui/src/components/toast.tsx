'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FocusEvent, type HTMLAttributes, type ReactNode } from 'react'
import { Icon } from '../icons/icon'
import { Button } from './button'
import type { IconName } from '../icons/icon-paths'

export type ToastTone = 'plain' | 'ok' | 'info' | 'warn' | 'error'

export interface ToastOptions {
  tone?: ToastTone
  /** Milliseconds before it goes away, at least its reading time (readingTime). */
  duration?: number
  /** A button on the toast, for example an undo. */
  action?: { label: string; run: () => void }
}

interface ToastRecord {
  id: number
  message: ReactNode
  tone: ToastTone
  action?: { label: string; run: () => void }
}

const ToastContext = createContext<((message: ReactNode, options?: ToastOptions) => void) | null>(null)

/** Keeps the toasts out of sight, with their time stopped, while something holds them (for example the plate grid). */
export interface ToastHold {
  hold(why: string): void
  release(why: string): void
}
const ToastHoldContext = createContext<ToastHold | null>(null)

const TONE_ICON: Record<Exclude<ToastTone, 'plain'>, IconName> = { ok: 'check', info: 'thinking', warn: 'alert', error: 'alert' }

/** The text a toast reads out, from a string or the strings inside its elements. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/**
 * How long a toast stays up so it can be read: 2.6 s, and 60 ms more for each character past 40; a warning or an error
 * at least 6 s. A longer duration a caller asks for wins.
 */
export function readingTime(message: ReactNode, tone: ToastTone = 'plain', asked?: number): number {
  const read = 2600 + Math.max(0, textOf(message).length - 40) * 60
  const least = tone === 'warn' || tone === 'error' ? Math.max(read, 6000) : read
  return Math.max(least, asked ?? 0)
}

/**
 * A toast's time on screen that can stop: `hold` while the pointer is over it or it has focus, `release` when both
 * are gone, and the time left runs on from where it stopped. It can start held (`unseen` until it is drawn).
 */
export class ToastClock {
  private left: number
  private at = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private holds = new Set<string>()

  constructor(
    ms: number,
    private readonly done: () => void,
    holds: readonly string[] = [],
  ) {
    this.left = ms
    for (const h of holds) this.holds.add(h)
    if (this.holds.size === 0) this.run()
  }

  hold(why: string): void {
    this.holds.add(why)
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    this.left -= Date.now() - this.at
  }

  release(why: string): void {
    this.holds.delete(why)
    if (this.holds.size === 0 && !this.timer) this.run()
  }

  /** Makes the time left at least `ms`, for a line that joins the card later and needs its own reading time. */
  extend(ms: number): void {
    const running = this.timer !== null
    if (running) this.hold('extend')
    this.left = Math.max(this.left, ms)
    if (running) this.release('extend')
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private run(): void {
    this.at = Date.now()
    this.timer = setTimeout(this.done, Math.max(0, this.left))
  }
}

/**
 * Mount once near the root. Toasts render bottom center, as one card with a line each, and announce through role
 * status. The card has one time: it starts once the card is on screen, so a page busy when a line was posted does not
 * eat into it, it lasts as long as its longest line takes to read (readingTime), and a line that joins later gets its
 * own reading time. It waits while the card is hovered or focused, so nobody has to beat its timer to read it, open
 * Details or press a button (WCAG 2.2.1).
 */
export function ToastProvider({ children, max = 3 }: { children?: ReactNode; max?: number }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const [held, setHeld] = useState(false)
  // While a toast shows its details, the card keeps its top edge where it was, so it grows down and nothing above moves.
  const [anchor, setAnchor] = useState<number | null>(null)
  const next = useRef(1)
  const card = useRef<ToastClock | null>(null)
  const holds = useRef(new Set<string>())
  const stack = useRef<HTMLDivElement>(null)
  const clear = useCallback(() => {
    card.current?.stop()
    card.current = null
    setToasts([])
    setOpen(new Set())
  }, [])
  const drop = useCallback((id: number) => {
    setToasts((list) => {
      const left = list.filter((t) => t.id !== id)
      if (left.length === 0) {
        card.current?.stop()
        card.current = null
      }
      return left
    })
    setOpen((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : o))
  }, [])
  const toast = useCallback(
    (message: ReactNode, options?: ToastOptions) => {
      const id = next.current++
      const tone = options?.tone ?? 'plain'
      setToasts((list) => [...list, { id, message, tone, ...(options?.action ? { action: options.action } : {}) }].slice(-max))
      const ms = readingTime(message, tone, options?.duration)
      if (card.current) card.current.extend(ms)
      else card.current = new ToastClock(ms, clear, ['unseen', ...[...holds.current].map((h) => `away:${h}`)])
    },
    [max, clear],
  )
  const hide = useMemo<ToastHold>(
    () => ({
      hold(why) {
        if (holds.current.has(why)) return
        holds.current.add(why)
        card.current?.hold(`away:${why}`)
        setHeld(true)
      },
      release(why) {
        if (!holds.current.delete(why)) return
        card.current?.release(`away:${why}`)
        setHeld(holds.current.size > 0)
      },
    }),
    [],
  )
  const details = useCallback((id: number) => {
    const top = stack.current?.getBoundingClientRect().top
    setAnchor((a) => a ?? (top === undefined ? null : Math.round(top)))
    setOpen((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])))
  }, [])
  // The card lets go of its top edge once no toast shows its details.
  useEffect(() => {
    if (open.size === 0) setAnchor(null)
  }, [open])
  useEffect(() => () => card.current?.stop(), [])
  const value = useMemo(() => toast, [toast])
  return (
    <ToastContext.Provider value={value}>
      <ToastHoldContext.Provider value={hide}>
        {children}
        <div
          ref={stack}
          className="sx-toasts"
          role="status"
          aria-live="polite"
          data-held={held ? '' : undefined}
          data-testid="toasts"
          style={anchor === null ? undefined : { top: anchor, bottom: 'auto' }}
          onPointerEnter={() => card.current?.hold('pointer')}
          onPointerLeave={() => card.current?.release('pointer')}
          onFocus={() => card.current?.hold('focus')}
          onBlur={(e: FocusEvent<HTMLDivElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) card.current?.release('focus')
          }}
        >
          {toasts.map((t) => (
            <ToastItem
              key={t.id}
              clock={card.current ?? undefined}
              className="sx-toast"
              data-testid="toast"
              data-tone={t.tone === 'plain' ? undefined : t.tone}
              data-expanded={open.has(t.id) ? '' : undefined}
            >
              {t.tone === 'plain' ? null : <Icon name={TONE_ICON[t.tone]} />}
              <ToastText message={t.message} expanded={open.has(t.id)} onDetails={() => details(t.id)} />
              {t.action ? (
                <Button size="sm" className="sx-toast-action" data-testid="toast-action" onClick={() => { t.action?.run(); drop(t.id) }}>
                  {t.action.label}
                </Button>
              ) : null}
            </ToastItem>
          ))}
        </div>
      </ToastHoldContext.Provider>
    </ToastContext.Provider>
  )
}

/**
 * The first sentence of a string message, and the rest. A toast shows only its first sentence on one line; the rest
 * stays in the text (and the announcement) and shows in place under Details.
 */
export function splitLead(message: ReactNode): { lead: ReactNode; rest: string } {
  if (typeof message !== 'string') return { lead: message, rest: '' }
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(message)
  return m ? { lead: m[1], rest: m[2] ?? '' } : { lead: message, rest: '' }
}

function ToastText({ message, expanded, onDetails }: { message: ReactNode; expanded: boolean; onDetails: () => void }) {
  const { lead, rest } = splitLead(message)
  return (
    <>
      <span className="sx-toast-text">
        <span className="sx-toast-lead">{lead}</span>
        {rest ? <span className="sx-toast-more"> {rest}</span> : null}
      </span>
      {rest ? (
        // The label is drawn from data-label, so a toast's text (what it announces, and what a client reads) stays its
        // message.
        <Button size="sm" variant="ghost" className="sx-toast-details" data-testid="toast-details" data-label={expanded ? 'Less' : 'Details'} aria-label={expanded ? 'Less' : 'Details'} aria-expanded={expanded} onClick={onDetails} />
      ) : null}
    </>
  )
}

/** One toast: its clock lets go of `unseen` on the first frame after it mounts. */
function ToastItem({ clock, children, ...rest }: { clock: ToastClock | undefined; children?: ReactNode } & HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => clock?.release('unseen'))
    return () => cancelAnimationFrame(frame)
  }, [clock])
  return <div {...rest}>{children}</div>
}

/** Returns toast(message, { tone, duration }). Throws outside a ToastProvider, which is a bug. */
export function useToast(): (message: ReactNode, options?: ToastOptions) => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast needs a ToastProvider above it')
  return ctx
}

/**
 * Keeps the toasts hidden while `active`, their time stopped, and brings them back with the time they had left when it
 * ends. Does nothing outside a ToastProvider.
 */
export function useHideToasts(active: boolean, why: string): void {
  const hold = useContext(ToastHoldContext)
  useEffect(() => {
    if (!hold || !active) return
    hold.hold(why)
    return () => hold.release(why)
  }, [hold, active, why])
}
