// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate edge drag's two distances, kept apart from the rest so the view's drag hook (hook.ts) can read them
// before the gesture code has loaded.

/** The least distance past the bed edge the whole footprint must be before a release moves it, mm. */
export const COMMIT_MM = 8
/** The same on screen, px: a zoomed out view needs the part further out than 8 mm to stay deliberate. */
export const COMMIT_PX = 24

const scale = (mmPerPx: number): number => (Number.isFinite(mmPerPx) && mmPerPx > 0 ? mmPerPx : 0)

/** The commit line's distance past the edge, mm: 8 mm or 24 screen pixels, whichever is more, at the view's scale. */
export function commitMarginMm(mmPerPx: number): number {
  return Math.max(COMMIT_MM, COMMIT_PX * scale(mmPerPx))
}

/** How far past the commit line a move may go, so a part never wanders off into the distance: 64 px or 12 mm. */
export function reachPastLineMm(mmPerPx: number): number {
  return Math.max(12, 64 * scale(mmPerPx))
}

/** Bed millimeters per screen pixel at a bed point, along a bed direction, from two projected points. */
export function mmPerPxAt(screenOf: (p: [number, number, number]) => [number, number] | null, at: readonly [number, number], dir: readonly [number, number]): number {
  const step = 10
  const a = screenOf([at[0], at[1], 0])
  const b = screenOf([at[0] + dir[0] * step, at[1] + dir[1] * step, 0])
  if (!a || !b) return 0
  const px = Math.hypot(b[0] - a[0], b[1] - a[1])
  return px > 1e-6 && Number.isFinite(px) ? step / px : 0
}
