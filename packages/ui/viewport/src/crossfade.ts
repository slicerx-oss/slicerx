// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A short crossfade between two scenes: the frame on screen is copied to a 2D canvas over the view, the new scene draws
// beneath it, and the copy fades out. Used when a newly opened model takes the place of the one before, so the view
// never shows an empty plate in between.

/** How long the old frame takes to fade. */
export const CROSSFADE_MS = 180

/**
 * Copies the WebGL canvas's frame (call right after rendering it, in the same task) onto a canvas over it and fades
 * that out. Returns the copy, or null where it can't be made (no DOM, no 2D context).
 */
export function crossfadeFrom(canvas: HTMLCanvasElement, reduced: boolean): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || !canvas.parentElement || !canvas.width || !canvas.height) return null
  const o = document.createElement('canvas')
  o.width = canvas.width
  o.height = canvas.height
  const ctx = o.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, 0, 0)
  o.setAttribute('aria-hidden', 'true')
  o.dataset['crossfade'] = ''
  o.style.cssText = `position:absolute;pointer-events:none;z-index:1;left:${canvas.offsetLeft}px;top:${canvas.offsetTop}px;width:${canvas.clientWidth}px;height:${canvas.clientHeight}px;opacity:1;transition:opacity ${reduced ? 0 : CROSSFADE_MS}ms ease-out`
  canvas.after(o)
  // the new scene draws on the next frame; the copy starts fading on the one after, then goes
  requestAnimationFrame(() => requestAnimationFrame(() => {
    o.style.opacity = '0'
    setTimeout(() => o.remove(), (reduced ? 0 : CROSSFADE_MS) + 40)
  }))
  return o
}
