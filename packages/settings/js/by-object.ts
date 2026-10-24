// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object, the plate as it sits: which objects come closer than the clearance radius, which tall ones the
// gantry or the lid would hit, and each object's clearance zone (its footprint grown by half the radius, so two zones
// overlap exactly when the objects are too close). It is the by-object clearance check the reference slicers run
// before a slice, as heimdall reads it: a pair inside the radius blocks the slice when the printer's head is estimated
// or its body would meet the earlier object, and is a close call otherwise. Pure and shared, so the app's warning and
// zones and the MCP server's read-back say the same.
import type { SettingValue } from '@slicerx/contracts'
import { clearanceRadius, type Rect } from './arrange-room'
import { marginNumber as num, marginText, printedGrowth, supportReach, widthMm } from './print-margins'
import headShapes from '../head-shapes.json'

export type Pt = [number, number]

/** The engine's lattice cell, mm: its height grids and the gantry beam count the bed in these. */
export const CELL_MM = 1

/**
 * What arrange keeps past the rod's reach, mm. The engine rounds an object's rows out to whole cells before it looks
 * under the beam (underBeam), so one cell past the reach clears it, and anything less can meet it. Arrange keeps a
 * second cell: it sets objects right on a lane's edge, where an outline a hair short of the cell meets the beam.
 */
export const LANE_SAFETY_MM = 2 * CELL_MM

/** A y span, mm: from, to. */
export type Span = readonly [number, number]

const cellOf = (v: number): number => Math.floor(v / CELL_MM)

/** How many whole cells the gantry beam reaches either way of the nozzle in y: the rod's reach rounded up to the cell. */
export function beamCells(toRod: number): number {
  return Math.max(0, Math.ceil(toRod / CELL_MM))
}

/**
 * Whether moves spanning `area` in y can bring the beam over an object whose mesh spans `object`: the object's rows in
 * whole cells against the moves' span grown by the rod's reach. The engine skips the beam for the layer when not.
 */
export function underBeam(object: Span, area: Span, toRod: number): boolean {
  const [lo, hi] = [cellOf(object[0]) * CELL_MM, (cellOf(object[1]) + 1) * CELL_MM]
  return lo < area[1] + toRod && hi > area[0] - toRod
}

/**
 * Whether the gantry beam, with the nozzle anywhere in `later` (the y span of an object printed after, mm), passes over
 * a finished object spanning `earlier` in y: the rows of cells the object stands on, grown by beamCells either way,
 * where underBeam lets the engine look.
 */
export function gantryMeets(earlier: Span, later: Span, toRod: number): boolean {
  const k = beamCells(toRod)
  return underBeam(earlier, later, toRod) && cellOf(later[1]) >= cellOf(earlier[0]) - k && cellOf(later[0]) <= cellOf(earlier[1]) + k
}

/** Whether the printer is a delta, which has no gantry beam: printer_structure says so, or a FLSun profile or model. */
export function isDelta(cfg: Record<string, SettingValue>, printerId?: string): boolean {
  const m = cfg['printer_model']
  const model = Array.isArray(m) ? m[0] : m
  return cfg['printer_structure'] === 'delta' || [printerId, model].some((id) => typeof id === 'string' && id.toLowerCase().startsWith('flsun'))
}

/**
 * How a move `d` mm from a finished object counts against the clearance `radius`: null at or past it; inside it, it
 * blocks when the head is estimated, and is a close call the head's own shape decides otherwise.
 */
export function radiusHit(d: number, radius: number, estimated: boolean): 'block' | 'soft' | null {
  return d < radius ? (estimated ? 'block' : 'soft') : null
}

/**
 * How far an object's own first layer prints past its footprint, mm, as the engine counts it: its brim (`brimMm`, past
 * the footprint), its support's pad and brim, and a skirt of its own round those.
 */
export function byObjectReach(cfg: Record<string, SettingValue>, brimMm: number): number {
  const nozzle = num(cfg['nozzle_diameter'], 0.4)
  const under = Math.max(Math.max(0, brimMm), supportReach(cfg, widthMm(cfg['support_line_width'], nozzle, nozzle)))
  const loops = Math.max(0, Math.floor(num(cfg['skirt_loops'], 0)))
  if (marginText(cfg['skirt_type']) !== 'perobject' || loops === 0 || num(cfg['skirt_height'], 1) === 0) return under
  const line = widthMm(cfg['line_width'], nozzle, nozzle * 1.125)
  const first = num(cfg['initial_layer_print_height'], 0.2)
  const spacing = Math.max(line - first * (1 - Math.PI / 4), line * 0.5)
  return under + Math.max(0, num(cfg['skirt_distance'], 2)) + loops * spacing
}

/** The outer nozzle diameter assumed for the head, mm. */
const OUTER_NOZZLE_MM = 4

/** An object on the plate seen from above: its footprint (a convex hull, bed mm) and its top. */
export interface ByObjectShape {
  id: string
  name: string
  hull: Pt[]
  top: number
  /** How far its own first layer prints past the footprint (byObjectReach), mm; unset, what every part prints with the config. */
  reachMm?: number
}

export interface ByObjectPair {
  a: { id: string; name: string }
  b: { id: string; name: string }
  /** Distance from the first one's footprint to the outermost thing the second prints round itself (reachMm), mm. */
  gapMm: number
  /** How far the second one's brim, skirt or support pad prints past its footprint, mm. */
  reachMm: number
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
  /** A delta: no gantry beam over the bed (isDelta). */
  delta?: boolean
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
  const delta = isDelta(cfg, printerId)
  if (!printer) return { estimated: false, columns: file.heads['generic'] ?? [], delta }
  return { estimated: printer.heads.some((k) => file.estimated.includes(k)), columns: printer.heads.flatMap((k) => file.heads[k] ?? []), delta }
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

/**
 * The gantry rule's numbers, mm: the rod's height over the bed (none on a delta), how far it reaches in y from the
 * nozzle, the lid.
 */
function gantryOf(cfg: Record<string, SettingValue>, head?: ByObjectHead) {
  const delta = head ? head.delta === true : isDelta(cfg)
  return { rod: delta ? Infinity : num(cfg['extruder_clearance_height_to_rod'], 40), toRod: num(cfg['extruder_clearance_dist_to_rod'], 40), lid: num(cfg['extruder_clearance_height_to_lid'], 120) }
}

/** The y span of a footprint, mm. */
const ySpan = (h: readonly Pt[]): [number, number] => [Math.min(...h.map((p) => p[1])), Math.max(...h.map((p) => p[1]))]

/**
 * How far `o`'s own first layer prints past its footprint, mm: its reachMm, else what prints round every part with
 * `cfg` (its brim as printed, a raft, a skirt of its own; printedGrowth). Support counts only in the slice, which knows
 * whether the part prints any.
 */
function reachOf(o: ByObjectShape, cfg: Record<string, SettingValue>): number {
  if (o.reachMm !== undefined) return o.reachMm
  const xs = o.hull.map((p) => p[0])
  const [y0, y1] = ySpan(o.hull)
  return byObjectReach({ ...cfg, enable_support: false }, printedGrowth(cfg, { w: Math.max(...xs) - Math.min(...xs), h: y1 - y0, height: o.top }))
}

/** The y span of everything `o` prints, mm: its footprint and what prints round it. */
function printSpan(o: ByObjectShape, cfg: Record<string, SettingValue>): Span {
  const [lo, hi] = ySpan(o.hull)
  const reach = reachOf(o, cfg)
  return [lo - reach, hi + reach]
}

/** True when the gantry, printing `later` after `earlier`, passes over it (gantryMeets). */
function inLane(earlier: ByObjectShape, later: ByObjectShape, cfg: Record<string, SettingValue>, toRod: number): boolean {
  return gantryMeets(ySpan(earlier.hull), printSpan(later, cfg), toRod)
}

/** True when an object `topMm` tall is taller than the gantry rod clears: nothing in its lane may print after it. */
export function overRod(topMm: number, cfg: Record<string, SettingValue>, head?: ByObjectHead): boolean {
  return topMm > gantryOf(cfg, head).rod
}

/**
 * A print order for `shapes` the gantry rule accepts where any order can, as ids: the objects the gantry clears
 * first, in the order they had, then the tall ones. Of those, each goes after the others in its lane where it can; the
 * ones that cannot (two tall objects side by side) print before the rest, which still clears every one it can. An
 * object taller than the lid goes last. The clearance between objects does not depend on the order.
 */
export function byObjectOrder(shapes: readonly ByObjectShape[], cfg: Record<string, SettingValue>, head?: ByObjectHead): string[] {
  const { rod, toRod, lid } = gantryOf(cfg, head)
  const low = shapes.filter((o) => o.top <= rod)
  const rest = shapes.filter((o) => o.top > rod)
  const back: ByObjectShape[] = []
  while (rest.length > 0) {
    // The last place still open takes an object that has nothing after it in its lane.
    const free = rest.filter((o) => !back.some((later) => inLane(o, later, cfg, toRod)))
    if (free.length === 0) break
    const meets = (o: ByObjectShape) => rest.filter((x) => x !== o && (inLane(o, x, cfg, toRod) || inLane(x, o, cfg, toRod))).length
    const pick = free.reduce((best, o) => {
      const key = (x: ByObjectShape) => [x.top > lid ? 0 : 1, meets(x), -x.top]
      const [k, b] = [key(o), key(best)]
      for (let i = 0; i < k.length; i++) if (k[i] !== b[i]) return k[i]! < b[i]! ? o : best
      return best
    })
    back.unshift(pick)
    rest.splice(rest.indexOf(pick), 1)
  }
  return [...low, ...rest, ...back].map((o) => o.id)
}

/**
 * The rules arrange holds a by-object plate to: the check's, with the rod reaching LANE_SAFETY_MM further, since
 * heimdall counts the bed in 1 mm cells and a footprint can reach a cell further either way.
 */
export function arrangeRules(cfg: Record<string, SettingValue>): Record<string, SettingValue> {
  return { ...cfg, extruder_clearance_dist_to_rod: gantryOf(cfg).toRod + LANE_SAFETY_MM }
}

/**
 * The zone that keeps the next tall object out of a tall object's lane, across the bed (`x0` to `x0 + widthMm`): the
 * footprint's y span grown by the rod's reach, less `keep`, how far the arrange keeps an outline from a zone anyway
 * (arrange-room zoneKeep). An object whose outline keeps `keep` from it can print after the tall one.
 */
export function gantryLane(hull: readonly Pt[], cfg: Record<string, SettingValue>, x0: number, widthMm: number, keep = 0): Rect {
  const { toRod } = gantryOf(cfg)
  const [lo, hi] = ySpan(hull)
  // Past half the span the zone is a line across the middle, which the keep holds off alone.
  const cut = Math.min(keep - toRod, (hi - lo) / 2 - 0.05)
  return { x: x0, y: lo + cut, w: widthMm, h: hi - lo - 2 * cut }
}

/** The plate `shapes` printed one after the other in this order with `cfg`, on the printer whose head is `head`. */
export function byObjectPlan(shapes: readonly ByObjectShape[], cfg: Record<string, SettingValue>, head: ByObjectHead = byObjectHead(cfg)): ByObjectPlan {
  const { rod, lid, toRod } = gantryOf(cfg, head)
  // Objects under the nozzle height never meet the hotend, only the nozzle.
  const short = shapes.every((o) => o.top < num(cfg['nozzle_height'], 2.5))
  const need = short ? 2 * (0.5 * OUTER_NOZZLE_MM - 0.1) : clearanceRadius(cfg)
  const pairs: ByObjectPair[] = []
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [a, b] = [shapes[i]!, shapes[j]!]
      // The later one's brim, skirt and support pad are moves too, held to the radius like its walls.
      const reach = reachOf(b, cfg)
      const gap = Math.max(0, hullDistance(a.hull, b.hull) - reach)
      const hit = radiusHit(gap, need, head.estimated)
      if (hit) pairs.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, gapMm: gap, reachMm: reach, severity: hit === 'block' ? 'block' : pairSeverity(a, b, head) })
    }
  }
  // The gantry passes over an earlier object while a later one prints in its lane.
  const tall: ByObjectTall[] = []
  shapes.slice(0, -1).forEach((o, i) => {
    const under = shapes.slice(i + 1).some((later) => inLane(o, later, cfg, toRod))
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
  pairs: { a: { id: string; name: string }; b: { id: string; name: string }; gapMm: number; reachMm: number; severity: 'block' | 'soft' }[]
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
    pairs: plan.pairs.map((p) => ({ a: p.a, b: p.b, gapMm: r(p.gapMm), reachMm: r(p.reachMm), severity: p.severity })),
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
