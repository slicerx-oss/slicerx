// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The box packer's core: the first free spot for an object's box on the bed, in rows from the front left (from the
// middle out on a round bed), keeping the room what prints around it takes from the bed edge, the other objects, the
// keep-out areas and the prime tower. The app's arrange packs with it when the geometry engine cannot run (app
// src/plate/arrange.ts), and so does the MCP server's arrange (mcp src/plate-nest.ts). Pure and deterministic.
import { MARGIN_SAFETY_MM, type Rect } from './arrange-room'

/** The bed as the packer takes it: its size, mm, and whether it is round (a delta printer's circle). */
export interface PackBed {
  widthMm: number
  depthMm: number
  round?: boolean
}

export interface Circle {
  cx: number
  cy: number
  r: number
}

/** The circle of a round bed on the plate (front left corner at 0, 0), or null for a rectangle. */
export function bedCircle(bed: PackBed): Circle | null {
  if (!bed.round) return null
  return { cx: bed.widthMm / 2, cy: bed.depthMm / 2, r: Math.min(bed.widthMm, bed.depthMm) / 2 }
}

/**
 * True when the box sits inside the bed with `inset` mm to spare. A round bed holds a box when all four corners are
 * inside the circle; a rectangle when the box is inside it.
 */
export function boxInBed(bed: PackBed, x0: number, y0: number, x1: number, y1: number, inset = 0): boolean {
  const c = bedCircle(bed)
  if (!c) return x0 >= inset && y0 >= inset && x1 <= bed.widthMm - inset && y1 <= bed.depthMm - inset
  const r = c.r - inset
  if (r < 0) return false
  const dx = Math.max(Math.abs(x0 - c.cx), Math.abs(x1 - c.cx))
  const dy = Math.max(Math.abs(y0 - c.cy), Math.abs(y1 - c.cy))
  return dx * dx + dy * dy <= r * r + 1e-9
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
export const edgeOf = (reach: number, gap: number) => Math.max(gap, reach > 0 ? reach + MARGIN_SAFETY_MM : 0)

/** The bare distance two objects keep: the gap, or their brims and a little more when that is larger. */
export const sepOf = (a: number, b: number, gap: number) => Math.max(gap, a + b > 0 ? a + b + MARGIN_SAFETY_MM : 0)

/** An object (or fixed thing) already on the bed: its box, how far its brim and the like reach, and how far its print reaches. */
export interface Placed {
  r: Rect
  grow: number
  reach: number
  /** Printing by object, its reach as the by-object check counts it (by-object.ts arrangeReach); unset, `reach`. */
  ar?: number
}

/** A box to place: its size, how far its brim and the like reach, and how far its print reaches. */
export interface Want {
  w: number
  h: number
  grow: number
  reach: number
  /** Printing by object, its reach as the by-object check counts it (by-object.ts arrangeReach); unset, `reach`. */
  ar?: number
}

/**
 * First free spot for a w x h rectangle, scanning rows from the front left along the free edges. The
 * rectangle keeps its brim clear of the other objects' brims, and everything it prints (skirt included)
 * inside the bed and off the excluded areas. With a skirt around the whole print, the hull of all that
 * is printed must not cross an excluded area (`avoid`) either. The skirt goes round the prime tower's place or room
 * (`towers`) too, so the hull takes those in, as far out as the skirt reaches past a part. Printing by object, a pair
 * keeps `apart` and the larger of its two by-object reaches between them, as the check holds it, and the zones keep
 * the edge spacing of the by-object reach, so the skirt sx prints round each object stays out of them too.
 */
export function findSpot(want: Want, placed: readonly Placed[], zones: readonly Rect[], towers: readonly Rect[], bed: PackBed, gap: number, skirt: boolean, apart = 0, avoid: readonly Rect[] = []): { x: number; y: number } | null {
  const { w, h } = want
  const edge = edgeOf(want.reach, gap)
  const arOf = (q: { reach: number; ar?: number }) => q.ar ?? q.reach
  const sepTo = (p: Placed) => (apart > 0 ? Math.max(sepOf(want.grow, p.grow, gap), apart + Math.max(arOf(want), arOf(p))) : sepOf(want.grow, p.grow, gap))
  const zoneEdge = apart > 0 ? edgeOf(Math.max(want.reach, arOf(want)), gap) : edge
  const xs = new Set<number>([edge])
  const ys = new Set<number>([edge])
  for (const p of placed) {
    const sep = sepTo(p)
    xs.add(p.r.x + p.r.w + sep)
    ys.add(p.r.y + p.r.h + sep)
  }
  for (const z of zones) {
    xs.add(z.x + z.w + zoneEdge)
    ys.add(z.y + z.h + zoneEdge)
  }
  const sortedY = [...ys].sort((a, b) => a - b)
  const sortedX = [...xs].sort((a, b) => a - b)
  const grown = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by })
  const circle = bedCircle(bed)
  // A round bed has no front left corner to start from: try the spots beside the other objects and the middle of the
  // bed, nearest the middle first, so a lone object sits in the center and a plate fills outward.
  let order: [number, number][]
  if (circle) {
    const cxs = new Set<number>([...sortedX, circle.cx - w / 2])
    const cys = new Set<number>([...sortedY, circle.cy - h / 2])
    for (const p of placed) {
      const sep = sepTo(p)
      cxs.add(p.r.x - sep - w)
      cys.add(p.r.y - sep - h)
    }
    const near = (x: number, y: number) => (x + w / 2 - circle.cx) ** 2 + (y + h / 2 - circle.cy) ** 2
    order = []
    for (const y of cys) for (const x of cxs) if (boxInBed(bed, x, y, x + w, y + h, edge - 1e-6)) order.push([x, y])
    order.sort((a, b) => near(a[0], a[1]) - near(b[0], b[1]) || a[1] - b[1] || a[0] - b[0])
  } else {
    order = []
    for (const y of sortedY) {
      if (y + h > bed.depthMm - edge + 1e-6) continue
      for (const x of sortedX) if (x + w <= bed.widthMm - edge + 1e-6) order.push([x, y])
    }
  }
  for (const [x, y] of order) {
    const me: Rect = { x, y, w, h }
    if (placed.some((p) => {
      const sep = sepTo(p)
      return !(x >= p.r.x + p.r.w + sep - 1e-6 || x + w <= p.r.x - sep + 1e-6 || y >= p.r.y + p.r.h + sep - 1e-6 || y + h <= p.r.y - sep + 1e-6)
    })) continue
    if (zones.some((z) => !(x >= z.x + z.w + zoneEdge - 1e-6 || x + w <= z.x - zoneEdge + 1e-6 || y >= z.y + z.h + zoneEdge - 1e-6 || y + h <= z.y - zoneEdge + 1e-6))) continue
    if (skirt && avoid.length > 0) {
      const out = Math.max(want.reach, ...placed.map((p) => p.reach))
      const hull = hullOf([...towers.map((t) => grown(t, out)), ...placed.map((p) => grown(p.r, p.reach)), grown(me, want.reach)].flatMap((r): [number, number][] => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]))
      if (avoid.some((z) => hullHitsRect(hull, z))) continue
    }
    return { x, y }
  }
  return null
}
