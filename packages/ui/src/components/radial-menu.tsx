'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A ring of up to six verbs around the point a menu opened at: a right click, a touch held still, or the menu key.
// Each verb is a slice of the ring; the middle opens the full list (More). Point at a slice and click, or press and
// flick toward one and let go. Keys: arrows or Tab go round, Enter runs, Escape closes. It floats over the page, so
// nothing beside it moves, and under reduced motion it shows at once instead of growing in.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'
import { tipAttrs } from './tooltip'

export interface RingItem {
  id: string
  label: string
  icon: IconName
  disabled?: boolean
  /** Why it is off, in its tip instead of a silent gray. */
  reason?: string
  testId?: string
  run: () => void
}

export interface RadialMenuProps {
  /** The window point it opens round, or null when shut. */
  at: { x: number; y: number } | null
  onClose: () => void
  /** Accessible name, such as "Top face" or "Bracket". */
  label: string
  /** The verbs, clockwise from the top; more than six are left out. */
  items: readonly RingItem[]
  /** The middle: opens the full list at the same point. The ring stays open for the caller to swap out. */
  onMore?: () => void
  /** A test id for the open ring, and what it is for (`data-target`). */
  testId?: string
  target?: string
}

/** The ring's outer and inner radius, px, and how close it may come to the window's edge. */
export const RING_R = 92
export const RING_HOLE = 34
const EDGE = 8

/** Where the ring's center goes for a point: the point itself, moved in so the whole ring stays inside the window. */
export function ringCenter(at: { x: number; y: number }, view: { width: number; height: number }): { x: number; y: number } {
  const m = RING_R + EDGE
  return { x: Math.max(m, Math.min(at.x, view.width - m)), y: Math.max(m, Math.min(at.y, view.height - m)) }
}

/** The slot under a point `dx`, `dy` from the center: -1 for the middle, null outside the ring, else the slot index. */
export function slotAt(dx: number, dy: number, count: number): number | null {
  const d = Math.hypot(dx, dy)
  if (d < RING_HOLE) return -1
  if (d > RING_R + 6 || count === 0) return null
  // clockwise from the top, each slot centered on its direction
  const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1
  return Math.floor((turn * count + 0.5) % count)
}

export function RadialMenu({ at, onClose, label, items, onMore, testId, target }: RadialMenuProps) {
  const ring = items.slice(0, 6)
  const ref = useRef<HTMLDivElement>(null)
  const [hot, setHot] = useState<number | null>(null)
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    setCenter(at ? ringCenter(at, { width: window.innerWidth, height: window.innerHeight }) : null)
    setHot(null)
  }, [at])
  // Focus the first verb that runs, so the keys work at once.
  useEffect(() => {
    if (!center) return
    const first = ring.findIndex((it) => !it.disabled)
    const el = ref.current?.querySelector<HTMLElement>(first >= 0 ? `[data-slot="${first}"]` : '[data-slot="more"]')
    el?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center])
  // A press outside the ring closes it.
  useEffect(() => {
    if (!center) return
    const down = (e: globalThis.PointerEvent) => {
      if (!ref.current) return
      const r = ref.current.getBoundingClientRect()
      if (slotAt(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), ring.length) === null) onClose()
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [center, onClose, ring.length])
  const run = useCallback(
    (slot: number) => {
      // the middle hands over to the full list, which opens in the ring's place
      if (slot === -1) {
        if (onMore) onMore()
        else onClose()
        return
      }
      const it = ring[slot]
      if (!it || it.disabled) return
      onClose()
      it.run()
    },
    [ring, onClose, onMore],
  )
  if (!at || !center || typeof document === 'undefined') return null
  const size = 2 * RING_R + 8
  const c = size / 2
  const n = ring.length
  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current?.getBoundingClientRect()
    return r ? slotAt(e.clientX - (r.left + c), e.clientY - (r.top + c), n) : null
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = local(e)
    setHot(s === null ? null : s)
  }
  // A click runs what it is on; so does a press flicked from the middle toward a slot and let go there.
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = local(e)
    if (s !== null) run(s)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const slots = [...ring.keys(), -1]
    const cur = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['slot'] : undefined
    const i = Math.max(0, slots.indexOf(cur === 'more' ? -1 : Number(cur ?? 0)))
    const go = (step: number) => {
      const next = slots[(i + step + slots.length) % slots.length]!
      ref.current?.querySelector<HTMLElement>(`[data-slot="${next === -1 ? 'more' : next}"]`)?.focus({ preventScroll: true })
      setHot(next)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      go(1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      go(-1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      run(slots[i]!)
    }
  }
  const wedge = (k: number) => {
    const a0 = ((k - 0.5) / n) * 2 * Math.PI - Math.PI / 2 + 0.035
    const a1 = ((k + 0.5) / n) * 2 * Math.PI - Math.PI / 2 - 0.035
    const p = (r: number, a: number) => `${(c + Math.cos(a) * r).toFixed(1)} ${(c + Math.sin(a) * r).toFixed(1)}`
    const big = a1 - a0 > Math.PI ? 1 : 0
    return `M${p(RING_R, a0)}A${RING_R} ${RING_R} 0 ${big} 1 ${p(RING_R, a1)}L${p(RING_HOLE + 2, a1)}A${RING_HOLE + 2} ${RING_HOLE + 2} 0 ${big} 0 ${p(RING_HOLE + 2, a0)}Z`
  }
  return createPortal(
    <div
      ref={ref}
      className="sx-ring"
      role="menu"
      aria-label={label}
      data-testid={testId}
      data-target={target}
      style={{ left: center.x - c, top: center.y - c, width: size, height: size }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHot(null)}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="sx-ring-art" width={size} height={size} aria-hidden="true">
        {ring.map((it, k) => (
          <path key={it.id} d={wedge(k)} className="sx-ring-wedge" data-hot={hot === k || undefined} data-off={it.disabled || undefined} />
        ))}
        <circle cx={c} cy={c} r={RING_HOLE - 2} className="sx-ring-hole" data-hot={hot === -1 || undefined} />
      </svg>
      {ring.map((it, k) => {
        const a = (k / n) * 2 * Math.PI - Math.PI / 2
        const r = (RING_R + RING_HOLE) / 2
        return (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className="sx-ring-slot"
            data-slot={k}
            data-hot={hot === k || undefined}
            aria-disabled={it.disabled || undefined}
            tabIndex={-1}
            style={{ left: c + Math.cos(a) * r, top: c + Math.sin(a) * r }}
            {...(it.testId ? { 'data-testid': it.testId } : {})}
            {...(it.disabled && it.reason ? tipAttrs({ title: it.label, reason: it.reason }) : {})}
            onFocus={() => setHot(k)}
          >
            <Icon name={it.icon} size={18} />
            <span>{it.label}</span>
          </button>
        )
      })}
      <button type="button" role="menuitem" className="sx-ring-more" data-slot="more" data-hot={hot === -1 || undefined} tabIndex={-1} aria-label={`More for ${label}`} data-testid={testId ? `${testId}-more` : undefined} onFocus={() => setHot(-1)}>
        <span className="sx-ring-name">{label}</span>
        <span className="sx-ring-more-label">More</span>
      </button>
    </div>,
    document.body,
  )
}
