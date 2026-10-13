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

/** The computed style properties that decide whether an element is a layer of its own. */
export type LayerStyle = Pick<CSSStyleDeclaration, 'position' | 'zIndex' | 'transform' | 'filter' | 'opacity' | 'isolation' | 'contain'> &
  Partial<Pick<CSSStyleDeclaration, 'translate' | 'scale' | 'rotate' | 'backdropFilter' | 'mixBlendMode' | 'clipPath' | 'willChange'>>

const set = (v: string | undefined) => v !== undefined && v !== '' && v !== 'none'

/**
 * Whether an element with this style is a layer of its own (a stacking context): a transform, a filter, a z-index on a
 * positioned box and the like. A z-index inside it only orders things inside it, so it can't lift a menu over the page
 * that comes after it.
 */
export function makesLayer(s: LayerStyle): boolean {
  return (
    (s.position !== 'static' && s.zIndex !== 'auto' && s.zIndex !== '') ||
    s.position === 'fixed' ||
    s.position === 'sticky' ||
    set(s.transform) ||
    set(s.translate) ||
    set(s.scale) ||
    set(s.rotate) ||
    set(s.filter) ||
    set(s.backdropFilter) ||
    set(s.clipPath) ||
    Number(s.opacity) < 1 ||
    // A regex, not the quoted word: bundle-size.mjs reads a quoted 'isolate' in a startup chunk as the late icon.
    /isolate/.test(s.isolation) ||
    (s.mixBlendMode !== undefined && s.mixBlendMode !== '' && s.mixBlendMode !== 'normal') ||
    /paint|layout|strict|content/.test(s.contain) ||
    /transform|filter|opacity/.test(s.willChange ?? '')
  )
}

type Box = { left: number; top: number; right: number; bottom: number }

/** Whether a box reaches past another anywhere, by more than a pixel. */
export function reachesPast(box: Box, layer: Box): boolean {
  return box.left < layer.left - 1 || box.top < layer.top - 1 || box.right > layer.right + 1 || box.bottom > layer.bottom + 1
}

/**
 * Whether a floating element placed at `box` would sit in a layer smaller than itself: an ancestor of its anchor that is
 * a layer of its own and that the element reaches past. Whatever the page paints after that layer then covers the part
 * outside it, whatever the element's z-index (the Filament options menu, in a header shifted with a transform, went
 * under the nozzle rows below it). Such an element is lifted out into the window's own layer instead. The search stops
 * at a dialog: a modal one paints over the whole page, a lifted element included, so lifting would hide it.
 */
export function trappedIn(anchor: HTMLElement, box: Box): boolean {
  if (typeof getComputedStyle !== 'function') return false
  for (let p: HTMLElement | null = anchor; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    // a dialog sits in the window's top layer, over anything lifted out to the page, so the element stays in it
    if (p.tagName === 'DIALOG') return false
    if (makesLayer(getComputedStyle(p)) && reachesPast(box, p.getBoundingClientRect())) return true
  }
  return false
}

/** Where it goes: under or over its trigger, and, when a scrolling panel would cut it off, lifted out of the panel. */
export type Place = { up: boolean; max?: number; fixed?: { left: number; top?: number; bottom?: number } }

/**
 * Places a floating element (a menu, a popover) against its anchor, the element's parent. Opened near the bottom of a
 * scrolling panel or the window it opens upward when there is more room there, and scrolls itself when neither side
 * fits it. One a panel would cut off at the side, or one that would reach past a layer it sits in (see trappedIn), is
 * lifted out of the panel and kept inside the window.
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
    if (cutAtSide || trappedIn(anchor, el.getBoundingClientRect())) {
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
