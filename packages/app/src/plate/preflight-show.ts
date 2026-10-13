// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Show me for a check that blocks a print: Slice with the toolpaths, at the first layer where it goes wrong, and for
// a collision the moment and the spot it happens, as heimdall's own list jumps there. A slice the safety check
// refused has no toolpaths to show, so its Show me turns the camera to the spot it names and picks the object.
import { resolveConfig } from '../adapters/config'
import { get, set, showSliced, type AppState } from '../state/store'
import { excludedPolygons } from '../viewport/bed-exclude'
import { areaOrigin, polygonsToPlate } from './bed-origin'
import { collisionsOf } from './heimdall'
import type { PreflightSpot } from './preflight'
import { cameraBus } from './tools'

export async function showSpot(spot: PreflightSpot): Promise<void> {
  showSliced()
  if (spot.kind === 'collision') {
    const { jumpTo } = await import('./heimdall-jump')
    jumpTo(spot.index)
    return
  }
  const n = get().preview?.layerCount ?? 0
  if (n > 0) set({ layerLo: 1, layerHi: Math.min(n, spot.layer + 1), moveCut: 1 })
}

/** The first strike that holds a print back, by its place in the slice's collisions; null when none does. */
export function firstHit(s: Pick<AppState, 'slice'>): number | null {
  const i = collisionsOf(s).findIndex((c) => c.severity === 'hit')
  return i < 0 ? null : i
}

/** Where a refused slice first goes wrong: its layer (0 based), the machine X and Y, and the object it names. */
export interface RefusalSpot {
  layer: number
  x: number
  y: number
  object?: string
  /** The refusal is for toolpaths that enter an excluded bed area. */
  excluded?: boolean
}

// "from layer 3 (X-4.2 Y120.0, brim of "cube")": the engine's words for toolpaths off the bed, past an extruder's
// reach or into an excluded area. A print over the height names no X and Y, so it has no spot.
const AT = /from layer (\d+) \(X(-?\d+(?:\.\d+)?) Y(-?\d+(?:\.\d+)?)(?:, [^"()]*?"([^"]+)")?/

/** The first spot a refused slice names, or null when its message names none. */
export function refusalSpot(message: string): RefusalSpot | null {
  const m = AT.exec(message)
  if (!m) return null
  return { layer: Number(m[1]) - 1, x: Number(m[2]), y: Number(m[3]), ...(m[4] ? { object: m[4] } : {}), ...(/\bexcluded bed area\b/.test(message) ? { excluded: true } : {}) }
}

function inside(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as readonly [number, number]
    const [xj, yj] = poly[j] as readonly [number, number]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/**
 * What Show me marks on the plate for a refusal: the spot (plate frame, mm) and, when the refusal is for entering an
 * excluded bed area, that area's outline. The engine speaks in machine coordinates; the plate counts from the printable
 * area's front left corner. The area is the one the spot lies in, else the nearest by its center.
 */
export function refusalMark(spot: RefusalSpot, cfg: Record<string, unknown>): { x: number; y: number; area: [number, number][] | null } {
  const origin = areaOrigin(cfg['printable_area'])
  let area: [number, number][] | null = null
  if (spot.excluded) {
    const polys = excludedPolygons(cfg['bed_exclude_area'])
    const centerDist = (p: [number, number][]) => Math.hypot(p.reduce((a, q) => a + q[0], 0) / p.length - spot.x, p.reduce((a, q) => a + q[1], 0) / p.length - spot.y)
    const hit = polys.find((p) => inside(p, spot.x, spot.y)) ?? [...polys].sort((a, b) => centerDist(a) - centerDist(b))[0]
    if (hit) area = polygonsToPlate([hit], origin)[0] ?? null
  }
  return { x: spot.x - origin[0], y: spot.y - origin[1], area }
}

/** Turns the camera to a refused slice's spot, at about its layer's height, and picks the object it names. */
export function showRefusal(spot: RefusalSpot): void {
  const s = get()
  const cfg = resolveConfig(s.easy, s.overrides)
  const mark = refusalMark(spot, cfg)
  const first = Number(cfg['initial_layer_print_height']) || 0.2
  const step = Number(cfg['layer_height']) || 0.2
  const z = spot.layer > 0 ? first + spot.layer * step : 0
  const obj = spot.object ? s.plate.find((p) => p.name === spot.object) : undefined
  if (obj) set({ selection: obj.id, selectedIds: [obj.id] })
  // The camera turn alone does not say "here": the spot gets the strike mark, and an excluded area its outline.
  set({ refusalSpot: { x: mark.x, y: mark.y, z, area: mark.area, slice: s.slice } })
  cameraBus()?.focusBedPoint?.(mark.x, mark.y, z, { animate: true })
}
