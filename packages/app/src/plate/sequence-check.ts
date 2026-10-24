// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object: whether the objects keep the clearance the printer profile asks for (Bambu Studio's
// sequential_print_clearance_valid), run on the plate as it sits. It is a heads-up before slicing; the slice itself runs
// heimdall's check of every move against the head's real shape (packages/core/src/collide), which decides. A slice made
// before objects moved is held to this rule until it is sliced again.
import type { SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { plateConfig } from './plates'
import { plateSequence } from './plate-sequence'
import type { AppState, PlateEntry } from '../state/store'
import { hullOf } from './arrange'
import { clearanceRadius } from '@slicerx/settings/arrange-room'
import type { Mat4 } from './transform'

type Pt = [number, number]

/** Orca's MAX_OUTER_NOZZLE_DIAMETER, mm. */
const OUTER_NOZZLE_MM = 4

function num(v: SettingValue | undefined, fallback: number): number {
  const x = Array.isArray(v) ? v[0] : v
  const n = typeof x === 'string' ? Number.parseFloat(x) : x
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

const shapes = new WeakMap<PlateEntry, { hull: Pt[]; top: number }>()

/** The object's footprint on the bed (the convex hull of its points) and its height, as the engine measures them. */
function shapeOf(e: PlateEntry): { hull: Pt[]; top: number } {
  const kept = shapes.get(e)
  if (kept) return kept
  const shape = footprint(e.parts.map((p) => p.positions), e.transform)
  shapes.set(e, shape)
  return shape
}

/** Directions the footprint's first pass finds the extreme points along, the corners of a polygon inside the hull. */
const SIDES = 32
const AX = Float64Array.from({ length: SIDES }, (_, k) => Math.cos((2 * Math.PI * k) / SIDES))
const AY = Float64Array.from({ length: SIDES }, (_, k) => Math.sin((2 * Math.PI * k) / SIDES))

/**
 * The convex hull on the bed of these vertex lists placed by `m`, and their top. A big model has millions of vertices,
 * so the points strictly inside the polygon of the extreme ones along 32 directions (which no hull can have as corners)
 * are left out before the hull is taken: the same hull, 130 ms instead of 450 for a round part of 1.57 million
 * vertices. Each pass is a function of its own with plain locals, which WebKit compiles quickly; one function with
 * every loop in it ran ten times slower on some calls.
 */
export function footprint(lists: readonly ArrayLike<number>[], m: Mat4): { hull: Pt[]; top: number } {
  let count = 0
  for (const p of lists) count += Math.floor(p.length / 3)
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  let top = 0
  let next = 0
  for (const p of lists) {
    top = Math.max(top, place(p, m, xs, ys, next))
    next += Math.floor(p.length / 3)
  }
  const ring = corners(xs, ys)
  return { hull: hullOf(outside(xs, ys, ring)), top }
}

/** Writes the vertices of `p` placed by `m` from index `from` on, and answers their top. */
function place(p: ArrayLike<number>, m: Mat4, xs: Float64Array, ys: Float64Array, from: number): number {
  const a = m[0] ?? 0
  const b = m[1] ?? 0
  const c = m[2] ?? 0
  const d = m[4] ?? 0
  const e = m[5] ?? 0
  const f = m[6] ?? 0
  const g = m[8] ?? 0
  const h = m[9] ?? 0
  const k = m[10] ?? 0
  const l = m[12] ?? 0
  const n = m[13] ?? 0
  const o = m[14] ?? 0
  let top = 0
  let at = from
  for (let i = 0; i + 2 < p.length; i += 3) {
    const px = p[i] ?? 0
    const py = p[i + 1] ?? 0
    const pz = p[i + 2] ?? 0
    xs[at] = a * px + d * py + g * pz + l
    ys[at] = b * px + e * py + h * pz + n
    const z = c * px + f * py + k * pz + o
    if (z > top) top = z
    at++
  }
  return top
}

/** The extreme point along each direction, counterclockwise, with repeats next to each other left out. */
function corners(xs: Float64Array, ys: Float64Array): number[] {
  const best = new Int32Array(SIDES)
  const score = new Float64Array(SIDES).fill(-Infinity)
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!
    const y = ys[i]!
    for (let j = 0; j < SIDES; j++) {
      const v = AX[j]! * x + AY[j]! * y
      if (v > score[j]!) {
        score[j] = v
        best[j] = i
      }
    }
  }
  return [...best].filter((v, j) => v !== best[(j + SIDES - 1) % SIDES])
}

/** The points not strictly inside the polygon through `ring`, by a margin, so rounding never drops a corner. */
function outside(xs: Float64Array, ys: Float64Array, ring: number[]): Pt[] {
  const sides = ring.length
  const ex = new Float64Array(sides)
  const ey = new Float64Array(sides)
  const ec = new Float64Array(sides)
  let span = 0
  for (let j = 0; j < sides; j++) {
    const p = ring[j]!
    const q = ring[(j + 1) % sides]!
    ex[j] = ys[p]! - ys[q]!
    ey[j] = xs[q]! - xs[p]!
    ec[j] = ex[j]! * xs[p]! + ey[j]! * ys[p]!
    span = Math.max(span, Math.abs(ex[j]!), Math.abs(ey[j]!))
  }
  const margin = 1e-9 * span * span
  const pts: Pt[] = []
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!
    const y = ys[i]!
    let j = 0
    while (j < sides && ex[j]! * x + ey[j]! * y - ec[j]! > margin) j++
    if (j < sides || sides < 3) pts.push([x, y])
  }
  return pts
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function contains(poly: Pt[], p: Pt): boolean {
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

/** Distance between two convex polygons, 0 when they touch or overlap. */
export function hullDistance(a: Pt[], b: Pt[]): number {
  if (a.length === 0 || b.length === 0) return Infinity
  if (a.some((p) => contains(b, p)) || b.some((p) => contains(a, p)) || crosses(a, b)) return 0
  let best = Infinity
  for (const [from, to] of [[a, b], [b, a]] as const) {
    for (const p of from) for (let k = 0; k < to.length; k++) best = Math.min(best, segmentDistance(p, to[k]!, to[(k + 1) % to.length]!))
  }
  return best
}

/** Whether an edge of one polygon crosses an edge of the other (they can overlap with no corner inside). */
function crosses(a: Pt[], b: Pt[]): boolean {
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

/**
 * The problems of printing `entries` one after the other in this order with `cfg`, one sentence each, worded as the
 * engine words them. Empty when the plate prints safely by object.
 */
export function clearanceProblems(entries: readonly PlateEntry[], cfg: Record<string, SettingValue>): string[] {
  const radius = clearanceRadius(cfg)
  const rod = num(cfg['extruder_clearance_height_to_rod'], 40)
  const lid = num(cfg['extruder_clearance_height_to_lid'], 120)
  const toRod = num(cfg['extruder_clearance_dist_to_rod'], 40)
  const shaped = entries.map((e) => ({ name: e.name, ...shapeOf(e) }))
  // Objects under the nozzle height never meet the hotend, only the nozzle.
  const short = shaped.every((o) => o.top < num(cfg['nozzle_height'], 2.5))
  const need = short ? 2 * (0.5 * OUTER_NOZZLE_MM - 0.1) : radius
  const out: string[] = []
  for (let i = 0; i < shaped.length; i++) {
    for (let j = i + 1; j < shaped.length; j++) {
      const gap = hullDistance(shaped[i]!.hull, shaped[j]!.hull)
      if (gap < need) out.push(`${shaped[i]!.name} and ${shaped[j]!.name} are ${gap.toFixed(1)} mm apart; printing by object needs ${Math.round(need)} mm between objects so the toolhead clears them`)
    }
  }
  // The gantry passes over an earlier object while a later one prints in a band of y around it.
  const band = (h: Pt[]): [number, number] => [Math.min(...h.map((p) => p[1])) - 0.5 * toRod, Math.max(...h.map((p) => p[1])) + 0.5 * toRod]
  shaped.slice(0, -1).forEach((o, i) => {
    const [lo, hi] = band(o.hull)
    const under = shaped.slice(i + 1).some((later) => {
      const [l, u] = band(later.hull)
      return Math.min(hi, u) - Math.max(lo, l) > 0
    })
    const [limit, what] = under ? [rod, 'the gantry'] : [lid, 'the lid']
    if (o.top > limit) out.push(`${o.name} is ${o.top.toFixed(1)} mm tall and prints before another object; ${what} clears ${limit.toFixed(0)} mm, so print it last or lower it`)
  })
  return out
}

/** The radius the check holds a by-object plate to; arrange keeps the same one (@slicerx/settings/arrange-room). */
export { clearanceRadius }

type Inputs = Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'easy' | 'overrides'>

let cached: { plate: unknown; plates: unknown; activePlate: unknown; easy: unknown; overrides: unknown; text: string | null } | null = null

/**
 * Why the active plate may collide by object as it sits, as one message, or null when it keeps the profile's clearance
 * or prints by layer.
 */
export function sequenceProblem(s: Inputs): string | null {
  if (cached && cached.plate === s.plate && cached.plates === s.plates && cached.activePlate === s.activePlate && cached.easy === s.easy && cached.overrides === s.overrides) return cached.text
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const printable = s.plate.filter((p) => p.printable !== false)
  let text: string | null = null
  const base = resolveConfig(s.easy, s.overrides)
  if (plateSequence(meta, base) === 'by-object' && printable.length > 1) {
    const cfg = { ...base, ...plateConfig(meta) } as unknown as Record<string, SettingValue>
    const problems = clearanceProblems(printable, cfg)
    if (problems.length) text = `Printing by object may collide: ${problems.join('; ')}. Slice to see where heimdall finds a strike, or move the objects apart, print the tall one last, or print by layer.`
  }
  cached = { plate: s.plate, plates: s.plates, activePlate: s.activePlate, easy: s.easy, overrides: s.overrides, text }
  return text
}
