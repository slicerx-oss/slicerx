// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Toasts sit above whatever the viewport stacks along its bottom edge (the plate bar, the playback bar), centered on
// the viewport rather than the window, and never over a control. The studio measures the viewport's controls and
// writes --overlay-bottom (or --overlay-top), --overlay-center and --overlay-width on the document root, which the
// toast stack reads.
import { useEffect, type RefObject } from 'react'

/** Gap between a control and a toast beside it, px. */
export const OVERLAY_GAP = 8

/** Room a toast needs, px: less than this between the controls and the stack takes another place. */
export const TOAST_ROOM = 64

/** The viewport's controls, by where they sit. */
export interface OverlayBoxes {
  /** Along the bottom edge: the plate bar and the playback bar. The toast sits above them. */
  bottom: readonly DOMRectReadOnly[]
  /** Along the top edge: the toolbar and the view switch. The toast stays below them. */
  top?: readonly DOMRectReadOnly[]
  /** Down the right side (the layer slider): the toast keeps to the room left of them. */
  side?: readonly DOMRectReadOnly[]
  /** Down the left side (the color legend): the toast keeps to the room right of them. */
  left?: readonly DOMRectReadOnly[]
}

/** Where the toast stack goes, in window px. `bottom` or `top` is the stack's edge, `center` and `width` its lane. */
export type ToastPlace = { bottom: number; center: number; width?: number } | { top: number; center: number; width?: number }

const shown = (r: DOMRectReadOnly) => r.width > 0 && r.height > 0

/**
 * The toast stack's place over the viewport: above the highest bottom control and below the top ones, in the lane
 * the side controls leave. When the room between top and bottom controls is too small for a toast, it goes under the
 * top controls. Null when the viewport is scrolled off screen or the bottom controls sit at the window top (a phone
 * scrolled down to the settings): the stack keeps its default place at the window bottom then.
 */
export function toastPlace(viewport: DOMRectReadOnly, boxes: OverlayBoxes, windowHeight: number): ToastPlace | null {
  const visTop = Math.max(viewport.top, 0)
  const visBottom = Math.min(viewport.bottom, windowHeight)
  const floor = boxes.bottom.filter(shown).reduce((min, r) => Math.min(min, r.top), visBottom)
  if (floor - OVERLAY_GAP < TOAST_ROOM || visBottom - visTop < TOAST_ROOM) return null
  const ceiling = (boxes.top ?? []).filter(shown).reduce((max, r) => Math.max(max, r.bottom), visTop)
  const side = (boxes.side ?? []).filter(shown)
  const lefts = (boxes.left ?? []).filter(shown)
  const left = lefts.length ? Math.max(...lefts.map((r) => r.right)) + OVERLAY_GAP : viewport.left + OVERLAY_GAP
  const right = side.length ? Math.min(...side.map((r) => r.left)) - OVERLAY_GAP : viewport.right - OVERLAY_GAP
  // the lane always has a width: a long toast wraps inside the viewport, never past the window edge or over a pane
  const lane = { center: Math.round((left + right) / 2), width: Math.max(0, Math.round(right - left)) }
  if (floor - ceiling - 2 * OVERLAY_GAP >= TOAST_ROOM) return { bottom: Math.max(0, Math.round(windowHeight - floor + OVERLAY_GAP)), ...lane }
  return { top: Math.round(ceiling + OVERLAY_GAP), ...lane }
}

/** The bottom offset alone, for a viewport with only bottom controls. */
export function overlayBottom(viewport: DOMRectReadOnly, overlays: readonly DOMRectReadOnly[], windowHeight: number): number | null {
  const p = toastPlace(viewport, { bottom: overlays }, windowHeight)
  return p && 'bottom' in p ? p.bottom : null
}

/** Selectors for the controls `useOverlayOffset` keeps toasts off, inside the viewport. */
export interface OverlaySelectors {
  bottom: string
  top?: string
  side?: string
  /** Beside the viewport rather than in it, rising over its bottom (a phone's open sheet): the toast keeps above them. */
  cover?: string
  left?: string
}

const VARS = ['--overlay-bottom', '--overlay-top', '--overlay-center', '--overlay-width'] as const

/** Keeps the toast offsets current while `viewport` is mounted. Unmounting puts the defaults back. */
export function useOverlayOffset(viewport: RefObject<HTMLElement | null>, selectors: OverlaySelectors = { bottom: '.hud-bl, .dock' }): void {
  const { bottom, top, side, cover, left } = selectors
  useEffect(() => {
    const vp = viewport.current
    if (!vp || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const all = [bottom, top, side, left].filter(Boolean).join(', ')
    const boxes = (sel: string | undefined, within: ParentNode = vp) => (sel ? Array.from(within.querySelectorAll<HTMLElement>(sel)).map((el) => el.getBoundingClientRect()) : [])
    let frame = 0
    let last = ''
    const measure = () => {
      frame = 0
      const covers = vp.parentElement ? boxes(cover, vp.parentElement) : []
      const place = toastPlace(vp.getBoundingClientRect(), { bottom: [...boxes(bottom), ...covers], top: boxes(top), side: boxes(side), left: boxes(left) }, window.innerHeight)
      // The layer readouts change every frame while the print plays; the root's style changes only when the place does.
      const key = JSON.stringify(place)
      if (key === last) return
      last = key
      for (const v of VARS) root.style.removeProperty(v)
      if (!place) return
      if ('bottom' in place) root.style.setProperty('--overlay-bottom', `${place.bottom}px`)
      else {
        root.style.setProperty('--overlay-bottom', 'auto')
        root.style.setProperty('--overlay-top', `${place.top}px`)
      }
      root.style.setProperty('--overlay-center', `${place.center}px`)
      if (place.width !== undefined) root.style.setProperty('--overlay-width', `${place.width}px`)
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(queue)
    ro.observe(vp)
    // A side pane that opens, closes or is resized moves the viewport without always resizing it first.
    for (const el of Array.from(vp.parentElement?.children ?? [])) if (el !== vp) ro.observe(el)
    const watch = () => {
      for (const el of Array.from(vp.querySelectorAll<HTMLElement>(all))) ro.observe(el)
    }
    // Controls come and go (the playback bar shows with the toolpaths, the toolbar hides with them on a phone).
    const mo = new MutationObserver(() => {
      watch()
      queue()
    })
    mo.observe(vp, { childList: true, subtree: true })
    watch()
    // A sheet slides over the viewport without resizing anything: it is followed as it opens, shuts or is dragged.
    const studio = vp.parentElement
    const slides = new MutationObserver(queue)
    if (cover && studio) for (const el of Array.from(studio.children)) if (el !== vp) slides.observe(el, { attributes: true, attributeFilter: ['class', 'style'] })
    if (cover) studio?.addEventListener('transitionend', queue)
    window.addEventListener('resize', queue)
    // On a phone the page scrolls and the viewport with it.
    window.addEventListener('scroll', queue, { passive: true })
    queue()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      slides.disconnect()
      studio?.removeEventListener('transitionend', queue)
      window.removeEventListener('resize', queue)
      window.removeEventListener('scroll', queue)
      for (const v of VARS) root.style.removeProperty(v)
    }
  }, [viewport, bottom, top, side, cover, left])
}
