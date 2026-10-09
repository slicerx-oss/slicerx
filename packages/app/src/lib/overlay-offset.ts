// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Toasts sit above whatever the viewport stacks along its bottom edge (the plate bar, the playback bar), centered on
// the viewport rather than the window. The studio measures those and writes --overlay-bottom and --overlay-center on
// the document root, which the toast stack reads.
import { useEffect, type RefObject } from 'react'

/** Gap between a bottom overlay and a toast above it, px. */
export const OVERLAY_GAP = 8

/** Room a toast needs above the offset, px: an offset that leaves less keeps the stack's default place. */
export const TOAST_ROOM = 64

/**
 * The bottom offset for toasts: the tallest overlay's top edge above the window bottom, plus the gap. Null when that
 * edge is off screen or leaves no room for a toast (a phone scrolled down past the viewport): the stack keeps its
 * default place at the window bottom then.
 */
export function overlayBottom(viewport: DOMRectReadOnly, overlays: readonly DOMRectReadOnly[], windowHeight: number): number | null {
  const top = overlays.reduce((min, r) => (r.height > 0 && r.width > 0 ? Math.min(min, r.top) : min), Math.min(viewport.bottom, windowHeight))
  if (top - OVERLAY_GAP < TOAST_ROOM) return null
  return Math.max(0, Math.round(windowHeight - top + OVERLAY_GAP))
}

/**
 * Keeps the toast offsets current while `viewport` is mounted. `selector` picks the bottom overlays inside it.
 * Unmounting puts the defaults back.
 */
export function useOverlayOffset(viewport: RefObject<HTMLElement | null>, selector = '.hud-bl, .dock'): void {
  useEffect(() => {
    const vp = viewport.current
    if (!vp || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    let frame = 0
    const measure = () => {
      frame = 0
      const box = vp.getBoundingClientRect()
      const overlays = Array.from(vp.querySelectorAll<HTMLElement>(selector)).map((el) => el.getBoundingClientRect())
      const bottom = overlayBottom(box, overlays, window.innerHeight)
      if (bottom === null) {
        root.style.removeProperty('--overlay-bottom')
        root.style.removeProperty('--overlay-center')
        return
      }
      root.style.setProperty('--overlay-bottom', `${bottom}px`)
      root.style.setProperty('--overlay-center', `${Math.round(box.left + box.width / 2)}px`)
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(queue)
    ro.observe(vp)
    // Overlays come and go (the playback bar shows with the toolpaths); they are direct children of the viewport.
    const mo = new MutationObserver(() => {
      for (const el of Array.from(vp.querySelectorAll<HTMLElement>(selector))) ro.observe(el)
      queue()
    })
    mo.observe(vp, { childList: true })
    for (const el of Array.from(vp.querySelectorAll<HTMLElement>(selector))) ro.observe(el)
    window.addEventListener('resize', queue)
    // On a phone the page scrolls and the viewport with it.
    window.addEventListener('scroll', queue, { passive: true })
    queue()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', queue)
      window.removeEventListener('scroll', queue)
      root.style.removeProperty('--overlay-bottom')
      root.style.removeProperty('--overlay-center')
    }
  }, [viewport, selector])
}
