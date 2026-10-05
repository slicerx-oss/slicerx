// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The X mark as geometry, with no React: nested outlines, the way a slicer offsets each wall inward.
// The same shapes as editions/slicerx/brand/geometry.mjs, which builds the brand files, on a 32 by 32 grid.

export const MARK_VIEWBOX = '0 0 32 32'

const HALF_H = 12
const HALF_W = 11.5
const r2 = (v: number) => Math.round(v * 100) / 100

/** The X outline inset by `d` units, as path data. Null when the inset leaves nothing. */
function xPath(d: number, t: number): string | null {
  const xc0 = HALF_W - t / 2
  const k = xc0 / HALF_H
  const h = HALF_H - d
  const xc = k * h
  const tt = t - 2 * d * Math.sqrt(1 + k * k)
  if (tt <= 0 || h <= 0) return null
  const n = tt / (2 * k)
  const pts = [
    [-xc - tt / 2, -h], [-xc + tt / 2, -h], [0, -n], [xc - tt / 2, -h], [xc + tt / 2, -h], [tt / 2, 0],
    [xc + tt / 2, h], [xc - tt / 2, h], [0, n], [-xc + tt / 2, h], [-xc - tt / 2, h], [-tt / 2, 0],
  ] as const
  return 'M' + pts.map(([x, y]) => `${r2(16 + x)} ${r2(16 + y)}`).join('L') + 'z'
}

/** Ring roles: o is the outer outline, m the middle one, i the inner core. */
export type MarkRole = 'o' | 'm' | 'i'

export interface MarkRing {
  path: string
  /** Line width, or null for a solid shape. */
  width: number | null
  role: MarkRole
}

interface Cut {
  t: number
  rings: readonly { d: number; w?: number; solid?: true; r: MarkRole }[]
}

/** The cuts: one design with an optical size, like a typeface. */
export const MARK_CUTS = {
  /** Two outlines around a solid core: 48 px and up. */
  full: { t: 9.6, rings: [{ d: 0.55, w: 1.1, r: 'o' }, { d: 2.35, w: 0.9, r: 'm' }, { d: 3.45, solid: true, r: 'i' }] },
  /** An outline and a solid core: 24 to 48 px. */
  small: { t: 9.6, rings: [{ d: 0.75, w: 1.5, r: 'o' }, { d: 3.0, solid: true, r: 'm' }] },
  /** The heavier outline and core that a 16 px tab can hold. */
  tab: { t: 10.5, rings: [{ d: 1.2, w: 2.4, r: 'o' }, { d: 3.9, solid: true, r: 'm' }] },
} as const satisfies Record<string, Cut>

export type MarkCut = keyof typeof MARK_CUTS

/** The outer outline of the X, for a clip or a halo. */
export const MARK_PATH = xPath(0, 9.6) as string

/** The rings of a cut, outermost first. */
export function markRings(cut: MarkCut = 'full'): MarkRing[] {
  const c: Cut = MARK_CUTS[cut]
  return c.rings.flatMap((g) => {
    const path = xPath(g.d, c.t)
    return path ? [{ path, width: g.solid ? null : (g.w as number), role: g.r }] : []
  })
}

/** The cut to use for a rendered size in pixels. */
export function markCutFor(px: number): MarkCut {
  return px >= 48 ? 'full' : px >= 20 ? 'small' : 'tab'
}

// The previous mark, eight layer bars clipped to a solid X, kept only so the rendered films keep
// their look until they are re-rendered with the new mark. Nothing else should use these.
export const LEGACY_MARK_PATH = 'M4.5 4h6.2l5.3 8.1L21.3 4h6.2l-8.3 12 8.3 12h-6.2L16 19.9 10.7 28H4.5l8.3-12z'
export const LEGACY_MARK_LAYERS = 8
export function markBars(): { x: number; y: number; width: number; height: number }[] {
  return Array.from({ length: LEGACY_MARK_LAYERS }, (_, i) => ({ x: 0, y: 4.4 + i * 3, width: 32, height: 2.3 }))
}
