// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How much of the viewport the overlays cover (the Preview legend, the layer strip, the playback bar),
// so the camera frames the plate's content in what is left. Pure: rectangles in, pixels out.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PxInsets {
  left: number
  right: number
  top: number
  bottom: number
}

/** Space kept between an overlay and the model. */
export const OVERLAY_GAP = 12
/** Overlays smaller than this in both directions (corner buttons) do not take space from the model. */
const MIN_SIZE = 72

/**
 * Each overlay claims the side it sits against. A bar as wide as half the view or more, or one centered across the
 * view (the plate toolbar, the look switch), is a top or bottom bar; anything else is a panel on the left or right,
 * by which half of the view it sits in.
 */
export function overlayInsets(stage: Rect, overlays: readonly Rect[]): PxInsets {
  const out: PxInsets = { left: 0, right: 0, top: 0, bottom: 0 }
  const w = stage.right - stage.left
  const h = stage.bottom - stage.top
  if (w <= 0 || h <= 0) return out
  for (const o of overlays) {
    const r = { left: Math.max(o.left, stage.left), top: Math.max(o.top, stage.top), right: Math.min(o.right, stage.right), bottom: Math.min(o.bottom, stage.bottom) }
    const rw = r.right - r.left
    const rh = r.bottom - r.top
    if (rw <= 0 || rh <= 0 || (rw < MIN_SIZE && rh < MIN_SIZE)) continue
    const centered = Math.abs((r.left + r.right) / 2 - (stage.left + stage.right) / 2) < w * 0.1
    if (rw >= w * 0.5 || centered) {
      if ((r.top + r.bottom) / 2 > (stage.top + stage.bottom) / 2) out.bottom = Math.max(out.bottom, stage.bottom - r.top + OVERLAY_GAP)
      else out.top = Math.max(out.top, r.bottom - stage.top + OVERLAY_GAP)
    } else if ((r.left + r.right) / 2 < (stage.left + stage.right) / 2) out.left = Math.max(out.left, r.right - stage.left + OVERLAY_GAP)
    else out.right = Math.max(out.right, stage.right - r.left + OVERLAY_GAP)
  }
  return out
}
