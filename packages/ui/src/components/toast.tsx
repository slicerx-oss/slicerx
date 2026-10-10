'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FocusEvent, type HTMLAttributes, type ReactNode } from 'react'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export type ToastTone = 'plain' | 'ok' | 'info' | 'warn' | 'error'

export interface ToastOptions {
  tone?: ToastTone
  /** Milliseconds before it goes away. */
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

const TONE_ICON: Record<Exclude<ToastTone, 'plain'>, IconName> = { ok: 'check', info: 'thinking', warn: 'alert', error: 'alert' }

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
 * Mount once near the root. Toasts render bottom center and announce through role status. A toast's time starts once
 * it is on screen, so a page busy when it was posted does not eat into it, and a toast with a button waits while it
 * is hovered or focused, so nobody has to beat its timer to press the button (WCAG 2.2.1).
 */
export function ToastProvider({ children, max = 3 }: { children?: ReactNode; max?: number }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const next = useRef(1)
  const clocks = useRef(new Map<number, ToastClock>())
  const drop = useCallback((id: number) => {
    clocks.current.get(id)?.stop()
    clocks.current.delete(id)
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])
  const toast = useCallback(
    (message: ReactNode, options?: ToastOptions) => {
      const id = next.current++
      const tone = options?.tone ?? 'plain'
      setToasts((list) => [...list, { id, message, tone, ...(options?.action ? { action: options.action } : {}) }].slice(-max))
      clocks.current.set(id, new ToastClock(options?.duration ?? 2600, () => drop(id), ['unseen']))
    },
    [max, drop],
  )
  useEffect(() => {
    const all = clocks.current
    return () => all.forEach((c) => c.stop())
  }, [])
  const value = useMemo(() => toast, [toast])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sx-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            clock={clocks.current.get(t.id)}
            className="sx-toast"
            data-testid="toast"
            data-tone={t.tone === 'plain' ? undefined : t.tone}
            {...(t.action
              ? {
                  onPointerEnter: () => clocks.current.get(t.id)?.hold('pointer'),
                  onPointerLeave: () => clocks.current.get(t.id)?.release('pointer'),
                  onFocus: () => clocks.current.get(t.id)?.hold('focus'),
                  onBlur: (e: FocusEvent<HTMLDivElement>) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clocks.current.get(t.id)?.release('focus')
                  },
                }
              : {})}
          >
            {t.tone === 'plain' ? null : <Icon name={TONE_ICON[t.tone]} />}
            <span>{t.message}</span>
            {t.action ? (
              <button type="button" className="sx-toast-action" data-testid="toast-action" onClick={() => { t.action?.run(); drop(t.id) }}>
                {t.action.label}
              </button>
            ) : null}
          </ToastItem>
        ))}
      </div>
    </ToastContext.Provider>
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
