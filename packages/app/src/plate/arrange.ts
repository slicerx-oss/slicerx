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
import { bounds, compose, decompose, multiply, type Box, type Mat4 } from './transform'

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
}

/** The size of an object's bounds, mm. */
export interface PrintSize {
  w: number
  h: number
  height: number
}

/** What the printer lays down beyond an object's outline. */
export interface PrintMargins {
  /** How far the first layer of the object itself reaches past its outline (brim, raft, support pad), mm. */
  grow(size: PrintSize): number
  /** How far the outermost thing printed for the object reaches, skirt included, mm. At least `grow`. */
  reach(size: PrintSize): number
  /** True when a skirt or draft shield runs around the whole print, which can cross an excluded area between objects. */
  skirt: boolean
  /** More places nothing may be printed on (the prime tower), as boxes. */
  keepOut: readonly Rect[]
  /** Printing by object: how far apart objects stay so the toolhead clears the finished ones (the extruder clearance radius), mm. */
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

/** Room kept between two printed things beyond what is computed, mm: the engine rounds a brim up to whole lines. */
export const MARGIN_SAFETY_MM = 1

export const printSizeOf = (b: Box): PrintSize => ({ w: b.max[0] - b.min[0], h: b.max[1] - b.min[1], height: b.max[2] - b.min[2] })

export const ARRANGE_DEFAULTS: ArrangeOptions = { gapMm: 6, rotate: false }

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

let avoid: Rect[] = []

/** Parts of the bed nothing may be placed on (the printer's `bed_exclude_area`, as boxes). Arrange keeps clear of them. */
export function setAvoidAreas(areas: readonly Rect[]): void {
  avoid = areas.map((r) => ({ ...r }))
}

export function avoidAreas(): readonly Rect[] {
  return avoid
}

/** The box around each polygon of a `bed_exclude_area` value (a flat list of points, one polygon). */
export function excludeBoxes(points: unknown): Rect[] {
  const pts = Array.isArray(points) ? (points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number')) : []
  if (pts.length < 3) return []
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [{ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }]
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

/** An object (or fixed thing) already on the bed: its bounds, how far its brim and the like reach, and how far its print reaches. */
interface Placed {
  r: Rect
  grow: number
  reach: number
}

/** Convex hull of points, counterclockwise (Andrew's monotone chain). */
export function hullOf(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: [number, number][]) => {
    const out: [number, number][] = []
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

/** True when a convex polygon and a box share more than an edge. */
export function hullHitsRect(hull: [number, number][], r: Rect): boolean {
  if (hull.length < 3) return false
  const corners: [number, number][] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
  const apart = (axis: [number, number]) => {
    const proj = (pts: [number, number][]) => pts.map((q) => q[0] * axis[0] + q[1] * axis[1])
    const a = proj(hull)
    const b = proj(corners)
    return Math.max(...a) <= Math.min(...b) + 1e-6 || Math.max(...b) <= Math.min(...a) + 1e-6
  }
  if (apart([1, 0]) || apart([0, 1])) return false
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!
    const b = hull[(i + 1) % hull.length]!
    if (apart([b[1] - a[1], a[0] - b[0]])) return false
  }
  return true
}

/** The room kept between a bed edge or an excluded area and what an object prints: its reach, and the gap when that is more. */
const edgeOf = (reach: number, gap: number) => Math.max(gap, reach > 0 ? reach + MARGIN_SAFETY_MM : 0)

/** The bare distance two objects keep: the gap, or their brims and a little more when that is larger. */
const sepOf = (a: number, b: number, gap: number) => Math.max(gap, a + b > 0 ? a + b + MARGIN_SAFETY_MM : 0)

interface Want {
  w: number
  h: number
  grow: number
  reach: number
}

/**
 * First free spot for a w x h rectangle, scanning rows from the front left along the free edges. The
 * rectangle keeps its brim clear of the other objects' brims, and everything it prints (skirt included)
 * inside the bed and off the excluded areas. With a skirt around the whole print, the hull of all that
 * is printed must not cross an excluded area either.
 */
function findSpot(want: Want, placed: readonly Placed[], zones: readonly Rect[], bed: Bed, gap: number, skirt: boolean, apart = 0): { x: number; y: number } | null {
  const { w, h } = want
  const edge = edgeOf(want.reach, gap)
  const xs = new Set<number>([edge])
  const ys = new Set<number>([edge])
  for (const p of placed) {
    const sep = Math.max(sepOf(want.grow, p.grow, gap), apart)
    xs.add(p.r.x + p.r.w + sep)
    ys.add(p.r.y + p.r.h + sep)
  }
  for (const z of zones) {
    xs.add(z.x + z.w + edge)
    ys.add(z.y + z.h + edge)
  }
  const sortedY = [...ys].sort((a, b) => a - b)
  const sortedX = [...xs].sort((a, b) => a - b)
  const grown = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by })
  for (const y of sortedY) {
    if (y + h > bed.depthMm - edge + 1e-6) continue
    for (const x of sortedX) {
      if (x + w > bed.widthMm - edge + 1e-6) continue
      const me: Rect = { x, y, w, h }
      if (placed.some((p) => {
        const sep = Math.max(sepOf(want.grow, p.grow, gap), apart)
        return !(x >= p.r.x + p.r.w + sep - 1e-6 || x + w <= p.r.x - sep + 1e-6 || y >= p.r.y + p.r.h + sep - 1e-6 || y + h <= p.r.y - sep + 1e-6)
      })) continue
      if (zones.some((z) => !(x >= z.x + z.w + edge - 1e-6 || x + w <= z.x - edge + 1e-6 || y >= z.y + z.h + edge - 1e-6 || y + h <= z.y - edge + 1e-6))) continue
      if (skirt && zones.length > 0) {
        const hull = hullOf([...placed.map((p) => grown(p.r, p.reach)), grown(me, want.reach)].flatMap((r): [number, number][] => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]))
        if (zones.some((z) => hullHitsRect(hull, z))) continue
      }
      return { x, y }
    }
  }
  return null
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
  const zones: Rect[] = [...avoid, ...margins.keepOut].map((r) => ({ ...r }))
  const placed: Placed[] = []
  for (const f of fixed) {
    const b = bounds(f.parts, f.transform)
    if (b) {
      const size = printSizeOf(b)
      placed.push({ r: { x: b.min[0], y: b.min[1], w: size.w, h: size.h }, grow: margins.grow(size), reach: margins.reach(size) })
    }
  }
  const items = moving
    .map((it) => ({ it, b: bounds(it.parts, it.transform) }))
    .filter((x): x is { it: ArrangeItem; b: Box } => x.b !== null)
    .sort((a, c) => (c.b.max[0] - c.b.min[0]) * (c.b.max[1] - c.b.min[1]) - (a.b.max[0] - a.b.min[0]) * (a.b.max[1] - a.b.min[1]) || a.it.id.localeCompare(c.it.id))
  const transforms: Record<string, Mat4> = {}
  const leftOver: string[] = []
  const tooLarge: ArrangeResult['tooLarge'] = []
  const fitsAlone = (w: number, h: number, edge: number) => w + 2 * edge <= bed.widthMm + 1e-6 && h + 2 * edge <= bed.depthMm + 1e-6
  for (const { it, b } of items) {
    const size = printSizeOf(b)
    const { w, h } = size
    const wantOf = (sz: PrintSize): Want => ({ w: sz.w, h: sz.h, grow: margins.grow(sz), reach: margins.reach(sz) })
    const straight = wantOf(size)
    const turnedSize: PrintSize = { w: h, h: w, height: size.height }
    const turnedWant = wantOf(turnedSize)
    let spot = findSpot(straight, placed, zones, bed, opts.gapMm, margins.skirt, margins.apart)
    let m = it.transform
    let want = straight
    let box = b
    if (opts.rotate && Math.abs(w - h) > 0.5) {
      const turned = findSpot(turnedWant, placed, zones, bed, opts.gapMm, margins.skirt, margins.apart)
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
    placed.push({ r: { x: spot.x, y: spot.y, w: want.w, h: want.h }, grow: want.grow, reach: want.reach })
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
