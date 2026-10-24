// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object, the plate as it sits: which objects come closer than the clearance radius, which tall ones the
// gantry or the lid would hit, and each object's clearance zone (its footprint grown by half the radius, so two zones
// overlap exactly when the objects are too close). It is the by-object clearance check the reference slicers run
// before a slice, as heimdall reads it: a pair inside the radius blocks the slice when the printer's head is estimated
// or its body would meet the earlier object, and is a close call otherwise. Pure and shared, so the app's warning and
// zones and the MCP server's read-back say the same.
import type { SettingValue } from '@slicerx/contracts'
import { clearanceRadius } from './arrange-room'
import { marginNumber as num } from './print-margins'
import headShapes from '../head-shapes.json'

export type Pt = [number, number]

/** The outer nozzle diameter assumed for the head, mm. */
const OUTER_NOZZLE_MM = 4

/** An object on the plate seen from above: its footprint (a convex hull, bed mm) and its top. */
export interface ByObjectShape {
  id: string
  name: string
  hull: Pt[]
  top: number
}

export interface ByObjectPair {
  a: { id: string; name: string }
  b: { id: string; name: string }
  /** Distance between their footprints, mm. */
  gapMm: number
  /** Whether heimdall refuses the slice for it ('block') or slices it as a close call ('soft'): pairSeverity. */
  severity: 'block' | 'soft'
}

/** A box of the head around its nozzle tip, mm: x from, x to, y from, y to, then its underside and top over the tip. */
export type HeadColumn = readonly [number, number, number, number, number, number]

/**
 * The head heimdall moves over the plate: the boxes of every head the printer has, and whether they are estimated
 * from photos (then only the nozzle is known, and the clearance radius blocks instead of warning).
 */
export interface ByObjectHead {
  estimated: boolean
  columns: readonly HeadColumn[]
}

/** head-shapes.json: the heads Preview draws, by printer profile id and by printer model. */
export interface HeadShapes {
  estimated: readonly string[]
  heads: Readonly<Record<string, readonly HeadColumn[]>>
  printers: Readonly<Record<string, { heads: readonly string[] }>>
  models: Readonly<Record<string, string>>
}

const HEADS = headShapes as unknown as HeadShapes

export interface ByObjectTall {
  id: string
  name: string
  topMm: number
  /** What it would hit printing before another object, and how high that clears, mm. */
  what: 'gantry' | 'lid'
  limitMm: number
}

export interface ByObjectPlan {
  /** How far apart objects stay, mm: the clearance radius, or the nozzle's own width when every object is shorter than the nozzle. */
  needMm: number
  /** Pairs closer than needMm, in print order (first object, then second), each blocking or a close call. */
  pairs: ByObjectPair[]
  tall: ByObjectTall[]
  /** The gantry: the rod's height over the bed, and how far it reaches either side of the nozzle in y, mm. */
  gantry: { rodMm: number; reachMm: number }
  /** Per object in print order: its footprint, its clearance zone (the footprint grown by needMm / 2), its top. */
  zones: { id: string; name: string; hull: Pt[]; zone: Pt[]; topMm: number }[]
}

/** The convex hull, counterclockwise, of `pts` (monotone chain). */
export function convexHull(pts: readonly Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** A convex footprint grown by `d` all round: the hull of a 24 point circle at each corner. */
export function grownHull(hull: readonly Pt[], d: number): Pt[] {
  if (d <= 0 || hull.length === 0) return [...hull]
  const pts: Pt[] = []
  for (const p of hull) for (let k = 0; k < 24; k++) pts.push([p[0] + d * Math.cos((k * Math.PI) / 12), p[1] + d * Math.sin((k * Math.PI) / 12)])
  return convexHull(pts)
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function contains(poly: readonly Pt[], p: Pt): boolean {
  let [pos, neg] = [false, false]
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!
    const b = poly[(k + 1) % poly.length]!
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if (c > 0) pos = true
    if (c < 0) neg = true
  }
  return !(pos && neg)
}

/** Whether an edge of one polygon crosses an edge of the other (they can overlap with no corner inside). */
function crosses(a: readonly Pt[], b: readonly Pt[]): boolean {
  const orient = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  for (let i = 0; i < a.length; i++) {
    const [p1, p2] = [a[i]!, a[(i + 1) % a.length]!]
    for (let j = 0; j < b.length; j++) {
      const [q1, q2] = [b[j]!, b[(j + 1) % b.length]!]
      if (orient(p1, p2, q1) * orient(p1, p2, q2) < 0 && orient(q1, q2, p1) * orient(q1, q2, p2) < 0) return true
    }
  }
  return false
}

/** Distance between two convex polygons, 0 when they touch or overlap. */
export function hullDistance(a: readonly Pt[], b: readonly Pt[]): number {
  if (a.length === 0 || b.length === 0) return Infinity
  if (a.some((p) => contains(b, p)) || b.some((p) => contains(a, p)) || crosses(a, b)) return 0
  let best = Infinity
  for (const [from, to] of [[a, b], [b, a]] as const) {
    for (const p of from) for (let k = 0; k < to.length; k++) best = Math.min(best, segmentDistance(p, to[k]!, to[(k + 1) % to.length]!))
  }
  return best
}

/**
 * The head of the printer profile `printerId`, else of `cfg`'s printer model, else the generic head Preview draws,
 * as heimdall picks it for a slice.
 */
export function byObjectHead(cfg: Record<string, SettingValue>, printerId?: string, file: HeadShapes = HEADS): ByObjectHead {
  const model = cfg['printer_model']
  const byModel = typeof model === 'string' ? file.models[model] : undefined
  const printer = (printerId ? file.printers[printerId] : undefined) ?? (byModel ? file.printers[byModel] : undefined)
  if (!printer) return { estimated: false, columns: file.heads['generic'] ?? [] }
  return { estimated: printer.heads.some((k) => file.estimated.includes(k)), columns: printer.heads.flatMap((k) => file.heads[k] ?? []) }
}

/** The ground a head box covers while the nozzle goes anywhere over `hull`. */
function swept(hull: readonly Pt[], c: HeadColumn): Pt[] {
  return convexHull(hull.flatMap(([x, y]): Pt[] => [[x + c[0], y + c[2]], [x + c[1], y + c[2]], [x + c[1], y + c[3]], [x + c[0], y + c[3]]]))
}

/**
 * Whether the head, printing `later` after `earlier`, meets `earlier` with a box: one whose underside is below the
 * earlier object's top while the nozzle prints the later one's first layer, over ground the earlier one stands on.
 */
export function headMeets(earlier: ByObjectShape, later: ByObjectShape, head: ByObjectHead): boolean {
  return head.columns.some((c) => c[4] < earlier.top && hullDistance(earlier.hull, swept(later.hull, c)) === 0)
}

/**
 * A pair inside the clearance radius: heimdall refuses it when the head is estimated (the radius stands in for the
 * head it does not know) or when the head's body meets the earlier object; otherwise it slices it as a close call.
 */
export function pairSeverity(earlier: ByObjectShape, later: ByObjectShape, head: ByObjectHead): 'block' | 'soft' {
  return head.estimated || headMeets(earlier, later, head) ? 'block' : 'soft'
}

/** The plate `shapes` printed one after the other in this order with `cfg`, on the printer whose head is `head`. */
export function byObjectPlan(shapes: readonly ByObjectShape[], cfg: Record<string, SettingValue>, head: ByObjectHead = byObjectHead(cfg)): ByObjectPlan {
  const rod = num(cfg['extruder_clearance_height_to_rod'], 40)
  const lid = num(cfg['extruder_clearance_height_to_lid'], 120)
  const toRod = num(cfg['extruder_clearance_dist_to_rod'], 40)
  // Objects under the nozzle height never meet the hotend, only the nozzle.
  const short = shapes.every((o) => o.top < num(cfg['nozzle_height'], 2.5))
  const need = short ? 2 * (0.5 * OUTER_NOZZLE_MM - 0.1) : clearanceRadius(cfg)
  const pairs: ByObjectPair[] = []
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [a, b] = [shapes[i]!, shapes[j]!]
      const gap = hullDistance(a.hull, b.hull)
      if (gap < need) pairs.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, gapMm: gap, severity: pairSeverity(a, b, head) })
    }
  }
  // The gantry passes over an earlier object while a later one prints in a band of y around it.
  const band = (h: readonly Pt[]): [number, number] => [Math.min(...h.map((p) => p[1])) - 0.5 * toRod, Math.max(...h.map((p) => p[1])) + 0.5 * toRod]
  const tall: ByObjectTall[] = []
  shapes.slice(0, -1).forEach((o, i) => {
    const [lo, hi] = band(o.hull)
    const under = shapes.slice(i + 1).some((later) => {
      const [l, u] = band(later.hull)
      return Math.min(hi, u) - Math.max(lo, l) > 0
    })
    const limit = under ? rod : lid
    if (o.top > limit) tall.push({ id: o.id, name: o.name, topMm: o.top, what: under ? 'gantry' : 'lid', limitMm: limit })
  })
  return {
    needMm: need,
    pairs,
    tall,
    gantry: { rodMm: rod, reachMm: 0.5 * toRod },
    zones: shapes.map((o) => ({ id: o.id, name: o.name, hull: o.hull, zone: grownHull(o.hull, need / 2), topMm: o.top })),
  }
}

/** The plan as the app's ui.get and the MCP server's project read-back give it: mm to 0.1, outlines in bed mm. */
export interface ByObjectReadback {
  needMm: number
  pairs: { a: { id: string; name: string }; b: { id: string; name: string }; gapMm: number; severity: 'block' | 'soft' }[]
  tall: ByObjectTall[]
  gantry: { rodMm: number; reachMm: number }
  /** Per object in print order: its footprint and its clearance zone; zones that overlap are objects too close. */
  outlines: { id: string; name: string; footprint: Pt[]; zone: Pt[] }[]
}

export function byObjectReadback(plan: ByObjectPlan): ByObjectReadback {
  const r = (v: number) => Math.round(v * 10) / 10
  const ring = (pts: readonly Pt[]): Pt[] => pts.map(([x, y]) => [r(x), r(y)])
  return {
    needMm: r(plan.needMm),
    pairs: plan.pairs.map((p) => ({ a: p.a, b: p.b, gapMm: r(p.gapMm), severity: p.severity })),
    tall: plan.tall.map((t) => ({ ...t, topMm: r(t.topMm), limitMm: r(t.limitMm) })),
    gantry: { rodMm: r(plan.gantry.rodMm), reachMm: r(plan.gantry.reachMm) },
    outlines: plan.zones.map((z) => ({ id: z.id, name: z.name, footprint: ring(z.hull), zone: ring(z.zone) })),
  }
}

/** The shape of an object placed by `m` (column-major 4x4) from its vertex lists: the convex hull of its points and its top. */
export function placedShape(id: string, name: string, lists: readonly ArrayLike<number>[], m: readonly number[]): ByObjectShape {
  const pts: Pt[] = []
  let top = 0
  for (const p of lists) {
    for (let i = 0; i + 2 < p.length; i += 3) {
      const [x, y, z] = [p[i]!, p[i + 1]!, p[i + 2]!]
      pts.push([m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!])
      top = Math.max(top, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!)
    }
  }
  return { id, name, hull: convexHull(pts), top }
}
