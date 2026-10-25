// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The quick box packer: places objects on footprints (the XY bounds of each object), largest first, rows
// from the front left, a gap between objects, optional quarter turns to fit more, and fixed objects (not
// selected) left where they are. Arrange and fill the bed nest true outlines (nest.ts) and come here only
// when the geometry engine cannot run; pasting, new copies and new primitives use it to find a free spot.
// The footprint it packs is what prints around each object (brim, raft, support pad, skirt: see
// footprint.ts), not the bare outline, and it keeps clear of the printer's excluded areas and the prime
// tower. Pure and deterministic, so it runs without a GPU and is unit tested.
import type { Bed } from '@slicerx/contracts'
import type { FirstLayerShape } from '@slicerx/settings/print-margins'
import { MARGIN_SAFETY_MM, type Rect } from '@slicerx/settings/arrange-room'
import { edgeOf, findSpot, sepOf, type Placed, type Want } from '@slicerx/settings/box-pack'
import { bedCircle, boxInBed } from './bed-shape'
import { bounds, compose, decompose, fitsBed, multiply, reachFrom, type Box, type Mat4 } from './transform'

export interface ArrangeItem {
  id: string
  parts: readonly { positions: Float32Array }[]
  transform: Mat4
}

export interface ArrangeOptions {
  /** Space between objects and from the bed edge, mm. */
  gapMm: number
  /** Allow turns about Z when they pack better: any multiple of `stepDeg` on true outlines (nest.ts), quarter turns here. */
  rotate: boolean
  /** Turn step for true shape arrange, degrees. */
  stepDeg?: number
  /** How long true shape arrange searches: more layouts tried for a fuller plate. */
  effort?: 'quick' | 'normal' | 'thorough'
  /** What prints around each object. Left out, the margins of the plate in the store (none until installed). */
  margins?: PrintMargins
  /** More of the bed to keep clear of for this arrange only, boxes: a tall object's gantry lane (by-object-arrange.ts). */
  zones?: readonly Rect[]
  /** Move the layout to the middle of the bed on true outlines. Left out, it moves when nothing stays. */
  center?: boolean
  /**
   * Printing by object: each object's reach as the by-object check counts it (by-object.ts arrangeReach), so a pair
   * keeps the clearance and the reach of its own two objects. Undefined for an object, its margins' reach.
   */
  apartReach?: (e: { id: string }) => number | undefined
}

/** The size of an object's bounds, mm. */
export interface PrintSize {
  w: number
  h: number
  height: number
}

/** What the printer lays down beyond an object's outline. */
export interface PrintMargins {
  /**
   * How far the first layer of the object itself reaches past its outline (brim, raft, support pad), mm. `base` is the
   * object's first layer, cut at `firstLayerMm`, when the caller has it; an automatic brim is then sized from it as
   * the engine sizes it, else estimated from the bounds.
   */
  grow(size: PrintSize, base?: readonly FirstLayerShape[]): number
  /**
   * How far the outermost thing printed for the object reaches, skirt included, mm. At least `grow`. `hull` is the
   * footprint's convex hull, when known: a skirt of the object's own with a minimum length gets more loops round a
   * smaller outline.
   */
  reach(size: PrintSize, base?: readonly FirstLayerShape[], hull?: readonly (readonly [number, number])[]): number
  /** True when a skirt or draft shield runs around the whole print, which can cross an excluded area between objects. */
  skirt: boolean
  /** Where the engine cuts the first layer an automatic brim is sized from, mm above the bed; unset without one. */
  firstLayerMm?: number
  /** More places nothing may be printed on (a prime tower placed by hand), as boxes. */
  keepOut: readonly Rect[]
  /**
   * Room arrange keeps free for a prime tower the engine places itself, as boxes. A part that stands there still
   * prints, since the engine then puts the tower elsewhere, so only arrange and landing a new part keep off it.
   */
  towerRoom?: readonly Rect[]
  /**
   * Printing by object: how far apart objects stay so the toolhead clears the finished ones (the extruder clearance
   * radius), mm. Arrange adds the reach of what the objects print round themselves, per pair (byObjectSpacing).
   */
  apart?: number
}

export const NO_MARGINS: PrintMargins = { grow: () => 0, reach: () => 0, skirt: false, keepOut: [] }

let marginSource: () => PrintMargins = () => NO_MARGINS

/** Where arrange and the bed checks read the margins from when the caller gives none. */
export function setMarginSource(read: () => PrintMargins): void {
  marginSource = read
}

export function currentMargins(): PrintMargins {
  return marginSource()
}

export { excludeBoxes, keepOutBoxes, MARGIN_SAFETY_MM, type Rect } from '@slicerx/settings/arrange-room'
export { hullHitsRect, hullOf } from '@slicerx/settings/box-pack'

export const printSizeOf = (b: Box): PrintSize => ({ w: b.max[0] - b.min[0], h: b.max[1] - b.min[1], height: b.max[2] - b.min[2] })

export const ARRANGE_DEFAULTS: ArrangeOptions = { gapMm: 6, rotate: false }

let avoid: Rect[] = []

/** Parts of the bed nothing may be placed on (the printer's keep-out areas, keepOutBoxes, as boxes). Arrange keeps clear of them. */
export function setAvoidAreas(areas: readonly Rect[]): void {
  avoid = areas.map((r) => ({ ...r }))
}

export function avoidAreas(): readonly Rect[] {
  return avoid
}

/** What arrange keeps clear of: the excluded areas, then the prime tower's place or room (the last ones). */
export function arrangeZones(margins: PrintMargins): Rect[] {
  return [...avoid, ...margins.keepOut, ...(margins.towerRoom ?? [])].map((r) => ({ ...r }))
}

/** Turns an object by `deg` about Z around its bounds' center. */
function turnZ(m: Mat4, b: Box, deg: number): Mat4 {
  const cx = (b.min[0] + b.max[0]) / 2
  const cy = (b.min[1] + b.max[1]) / 2
  const r = compose({ position: [0, 0, 0], rotation: [0, 0, deg], scale: [1, 1, 1] })
  const to = compose({ position: [-cx, -cy, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  const back = compose({ position: [cx, cy, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  return multiply(back, multiply(r, multiply(to, m)))
}

export interface ArrangeResult {
  transforms: Record<string, Mat4>
  /** Objects that did not fit on the bed; they keep their place. */
  leftOver: string[]
  /** Objects that could not fit alone on an empty bed. `withoutMargin` is true when only their brim and skirt make it so. */
  tooLarge: { id: string; withoutMargin: boolean }[]
}

/**
 * Arranges `moving` around the objects in `fixed`, which stay put. Every placed object keeps its
 * height and rotation about X and Y.
 */
export function arrange(moving: readonly ArrangeItem[], fixed: readonly ArrangeItem[], bed: Bed, opts: ArrangeOptions = ARRANGE_DEFAULTS): ArrangeResult {
  const margins = opts.margins ?? marginSource()
  const zones = [...arrangeZones(margins), ...(opts.zones ?? [])]
  const towers = [...margins.keepOut, ...(margins.towerRoom ?? [])]
  const placed: Placed[] = []
  const arOf = (it: ArrangeItem, reach: number) => opts.apartReach?.(it) ?? reach
  for (const f of fixed) {
    const b = bounds(f.parts, f.transform)
    if (b) {
      const size = printSizeOf(b)
      const reach = margins.reach(size)
      placed.push({ r: { x: b.min[0], y: b.min[1], w: size.w, h: size.h }, grow: margins.grow(size), reach, ar: arOf(f, reach) })
    }
  }
  const items = moving
    .map((it) => ({ it, b: bounds(it.parts, it.transform) }))
    .filter((x): x is { it: ArrangeItem; b: Box } => x.b !== null)
    .sort((a, c) => (c.b.max[0] - c.b.min[0]) * (c.b.max[1] - c.b.min[1]) - (a.b.max[0] - a.b.min[0]) * (a.b.max[1] - a.b.min[1]) || a.it.id.localeCompare(c.it.id))
  const transforms: Record<string, Mat4> = {}
  const leftOver: string[] = []
  const tooLarge: ArrangeResult['tooLarge'] = []
  const circle = bedCircle(bed)
  const apart = margins.apart ?? 0
  const fitsAlone = (w: number, h: number, edge: number) => (circle ? Math.hypot(w, h) / 2 + edge <= circle.r + 1e-6 : w + 2 * edge <= bed.widthMm + 1e-6 && h + 2 * edge <= bed.depthMm + 1e-6)
  for (const { it, b } of items) {
    const size = printSizeOf(b)
    const { w, h } = size
    const wantOf = (sz: PrintSize): Want => {
      const reach = margins.reach(sz)
      return { w: sz.w, h: sz.h, grow: margins.grow(sz), reach, ar: arOf(it, reach) }
    }
    const straight = wantOf(size)
    const turnedSize: PrintSize = { w: h, h: w, height: size.height }
    const turnedWant = wantOf(turnedSize)
    let spot = findSpot(straight, placed, zones, towers, bed, opts.gapMm, margins.skirt, apart, avoid)
    let m = it.transform
    let want = straight
    let box = b
    if (opts.rotate && Math.abs(w - h) > 0.5) {
      const turned = findSpot(turnedWant, placed, zones, towers, bed, opts.gapMm, margins.skirt, apart, avoid)
      // Prefer the turn when only it fits, or when it lands nearer the front.
      if (turned && (!spot || turned.y < spot.y || (turned.y === spot.y && turned.x < spot.x))) {
        m = turnZ(it.transform, b, 90)
        box = bounds(it.parts, m) ?? b
        want = turnedWant
        spot = turned
      }
    }
    if (!spot) {
      leftOver.push(it.id)
      const alone = fitsAlone(w, h, edgeOf(straight.reach, opts.gapMm)) || (opts.rotate && fitsAlone(h, w, edgeOf(turnedWant.reach, opts.gapMm)))
      if (!alone) tooLarge.push({ id: it.id, withoutMargin: fitsAlone(w, h, opts.gapMm) || (opts.rotate && fitsAlone(h, w, opts.gapMm)) })
      continue
    }
    const t = decompose(m)
    const next = compose({ ...t, position: [t.position[0] + spot.x - box.min[0], t.position[1] + spot.y - box.min[1], t.position[2]] })
    transforms[it.id] = next
    placed.push({ r: { x: spot.x, y: spot.y, w: want.w, h: want.h }, grow: want.grow, reach: want.reach, ar: want.ar ?? want.reach })
  }
  return { transforms, leftOver, tooLarge }
}

/** How many more copies of `item` fit next to the others, with the same gap. Capped for safety. */
export function fillCount(item: ArrangeItem, others: readonly ArrangeItem[], bed: Bed, opts: ArrangeOptions = ARRANGE_DEFAULTS, cap = 200): number {
  const placed = [...others, item]
  let n = 0
  while (n < cap) {
    const copy: ArrangeItem = { ...item, id: `fill-${n}` }
    const r = arrange([copy], placed, bed, opts)
    const t = r.transforms[copy.id]
    if (!t) break
    placed.push({ ...copy, transform: t })
    n++
  }
  return n
}

/** How far past the bed edge an outline may reach and still count as on the bed, mm: STL coordinates are float32. */
const ON_BED_TOL_MM = 0.01

/**
 * True when an object stands where it can print: its footprint inside the bed (the circle of a round bed) and off the
 * printer's excluded areas. One that hangs off the bed, or sits in an excluded corner, is not placed yet.
 */
export function placedOnBed(item: Pick<ArrangeItem, 'parts' | 'transform'>, bed: Bed): boolean {
  const b = bounds(item.parts, item.transform)
  if (!b) return true
  if (!boxInBed(bed, b.min[0], b.min[1], b.max[0], b.max[1], -ON_BED_TOL_MM)) return false
  const t = ON_BED_TOL_MM
  return !avoid.some((z) => b.min[0] < z.x + z.w - t && z.x + t < b.max[0] && b.min[1] < z.y + z.h - t && z.y + t < b.max[1])
}

/** True when what prints around the object (brim, raft, support pad, skirt) goes past the bed edge or onto an excluded area. */
export function printPastBed(b: Box, bed: Bed, margins: PrintMargins, outlineReach?: number): boolean {
  const reach = margins.reach(printSizeOf(b))
  const grown: Box = { min: [b.min[0] - reach, b.min[1] - reach, b.min[2]], max: [b.max[0] + reach, b.max[1] + reach, b.max[2]] }
  // On a round bed what prints around the outline is a band of `reach` mm, so the outline plus the reach must stay inside the circle.
  if (!fitsBed(grown, bed, 0.01, outlineReach === undefined ? undefined : outlineReach + reach)) return true
  return [...avoid, ...margins.keepOut].some((z) => grown.min[0] < z.x + z.w && z.x < grown.max[0] && grown.min[1] < z.y + z.h && z.y < grown.max[1])
}

/**
 * True when an object prints where it stands: it is placed on the bed (placedOnBed), and what prints around it (brim,
 * raft, support pad, skirt, by the installed margins) stays on the bed and off the excluded areas and the prime tower.
 */
export function printsOnBed(item: Pick<ArrangeItem, 'parts' | 'transform'>, bed: Bed, margins: PrintMargins = marginSource()): boolean {
  if (!placedOnBed(item, bed)) return false
  const b = bounds(item.parts, item.transform)
  if (!b) return true
  return !printPastBed(b, bed, margins, bed.round ? reachFrom(item.parts, item.transform, bed.widthMm / 2, bed.depthMm / 2) : undefined)
}

/** The room a landed part keeps from the bed edge and excluded areas when the plate gives no brim or skirt, mm. */
export const LAND_EDGE_MM = 5

/**
 * Where an object that is not placed goes: the middle of the bed when that spot is on the bed and clear of `others`,
 * else the first free spot arrange finds around them. The middle keeps what prints around the part (brim, skirt) off
 * the edge, the excluded areas and the neighbors' brims, as arrange does, or LAND_EDGE_MM when the plate gives none.
 * Keeps its height and rotation. Null when nothing fits.
 */
export function landOnBed(item: ArrangeItem, others: readonly ArrangeItem[], bed: Bed, opts: ArrangeOptions = ARRANGE_DEFAULTS): Mat4 | null {
  const b = bounds(item.parts, item.transform)
  if (!b) return null
  const middle = [...item.transform]
  middle[12] = (middle[12] ?? 0) + bed.widthMm / 2 - (b.min[0] + b.max[0]) / 2
  middle[13] = (middle[13] ?? 0) + bed.depthMm / 2 - (b.min[1] + b.max[1]) / 2
  const m = bounds(item.parts, middle)!
  const margins = opts.margins ?? marginSource()
  const size = printSizeOf(m)
  const reach = margins.reach(size)
  const grow = margins.grow(size)
  const edge = reach > 0 ? reach + MARGIN_SAFETY_MM : LAND_EDGE_MM
  const zones = arrangeZones(margins)
  const clearOf = (r: Rect, by: number) => m.min[0] >= r.x + r.w + by || m.max[0] <= r.x - by || m.min[1] >= r.y + r.h + by || m.max[1] <= r.y - by
  const clear = others.every((o) => {
    const ob = bounds(o.parts, o.transform)
    if (!ob) return true
    const os = printSizeOf(ob)
    return clearOf({ x: ob.min[0], y: ob.min[1], w: os.w, h: os.h }, sepOf(grow, margins.grow(os), opts.gapMm))
  })
  if (clear && zones.every((z) => clearOf(z, edge)) && boxInBed(bed, m.min[0], m.min[1], m.max[0], m.max[1], edge)) return middle
  return arrange([item], others, bed, { ...opts, rotate: false }).transforms[item.id] ?? null
}
