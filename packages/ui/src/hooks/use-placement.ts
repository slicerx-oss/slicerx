'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** Space between the trigger and the floating element, px, as in styles.css. */
const GAP = 4
/** A floating element short of room still shows a little and scrolls. */
const MIN_HEIGHT = 120
/** How close a lifted-out element may come to the window's edge, px. */
const EDGE = 8

/** Where it goes: under or over its trigger, and, when a scrolling panel would cut it off, lifted out of the panel. */
export type Place = { up: boolean; max?: number; fixed?: { left: number; top?: number; bottom?: number } }

/**
 * Places a floating element (a menu, a popover) against its anchor, the element's parent. Opened near the bottom of a
 * scrolling panel or the window it opens upward when there is more room there, and scrolls itself when neither side
 * fits it. One a panel would cut off at the side is lifted out of the panel and kept inside the window.
 */
export function usePlacement(ref: RefObject<HTMLElement | null>, open: boolean, align: 'start' | 'end', inFlow = false): { place: Place; style: CSSProperties | undefined } {
  const [place, setPlace] = useState<Place>({ up: false })
  useLayoutEffect(() => {
    const el = ref.current
    const anchor = el?.parentElement
    if (!open || inFlow || !el || !anchor || place.fixed) return
    const a = anchor.getBoundingClientRect()
    let top = 0
    let bottom = window.innerHeight
    let left = 0
    let right = window.innerWidth
    for (let p = anchor.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowY === 'visible' && s.overflowX === 'visible') continue
      const r = p.getBoundingClientRect()
      top = Math.max(top, r.top)
      bottom = Math.min(bottom, r.bottom)
      left = Math.max(left, r.left)
      right = Math.min(right, r.right)
    }
    const width = el.offsetWidth
    const height = el.scrollHeight
    const start = align === 'start' ? a.left : a.right - width
    const cutAtSide = start < left - 1 || start + width > right + 1
    if (cutAtSide) {
      // lifted out: placed against the window, under the trigger or over it, wherever there is more room
      const below = window.innerHeight - a.bottom - GAP - EDGE
      const above = a.top - GAP - EDGE
      const up = height > below && above > below
      const room = Math.floor(up ? above : below)
      const x = Math.min(Math.max(EDGE, start), window.innerWidth - width - EDGE)
      setPlace({
        up,
        ...(height > room ? { max: Math.max(MIN_HEIGHT, room) } : {}),
        fixed: up ? { left: x, bottom: window.innerHeight - a.top + GAP } : { left: x, top: a.bottom + GAP },
      })
      return
    }
    const below = bottom - a.bottom - GAP
    const above = a.top - top - GAP
    const up = height > below && above > below
    const room = Math.floor(up ? above : below)
    setPlace(height > room ? { up, max: Math.max(MIN_HEIGHT, room) } : { up })
  }, [ref, open, inFlow, align, place.fixed])
  // closed, it measures again next time
  useEffect(() => {
    if (!open) setPlace({ up: false })
  }, [open])
  const style: CSSProperties | undefined = inFlow
    ? undefined
    : {
        ...(place.max !== undefined ? { maxHeight: place.max, overflowY: 'auto' } : {}),
        ...(place.fixed ? { position: 'fixed', left: place.fixed.left, right: 'auto', top: place.fixed.top ?? 'auto', bottom: place.fixed.bottom ?? 'auto' } : {}),
      }
  return { place, style: style && Object.keys(style).length ? style : undefined }
}
