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
import { byObjectHead, byObjectPlan, hullDistance, objectGetsSupport, type ByObjectPlan, type ByObjectShape } from '@slicerx/settings/by-object'
import type { Mat4 } from './transform'

type Pt = [number, number]

const shapes = new WeakMap<PlateEntry, { hull: Pt[]; top: number }>()

/** The object's footprint on the bed (the convex hull of its points) and its height, as the engine measures them. */
export function shapeOf(e: PlateEntry): { hull: Pt[]; top: number } {
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

/** Distance between two convex polygons, 0 when they touch or overlap (@slicerx/settings/by-object). */
export { hullDistance }

/** The radius the check holds a by-object plate to; arrange keeps the same one (@slicerx/settings/arrange-room). */
export { clearanceRadius }

/** The plate `entries` printed one after the other in this order with `cfg`, with each object's transform when measured. */
export interface ClearancePlan extends ByObjectPlan {
  transforms: Record<string, readonly number[]>
}

/** Per-object setting overrides by object id (AppState.objectSettings); an instance reads its source's. */
export type ObjectSettings = Readonly<Record<string, Record<string, SettingValue>>>

/** The settings the support rule reads, as a cache key. */
const SUPPORT_KEYS = ['enable_support', 'support_type', 'support_threshold_angle', 'support_threshold_overlap', 'enforce_support_layers', 'layer_height', 'initial_layer_print_height', 'line_width', 'outer_wall_line_width', 'nozzle_diameter'] as const

/** Answers of the support rule by the parts they read, the rotation they stand at and the settings: a move keeps them. */
const supports = new WeakMap<object, Map<string, boolean>>()

/** True when a support enforcer is on the object: a volume, or painted support (blockers count too: the paint text names neither without decoding it). */
function hasEnforcers(e: PlateEntry): boolean {
  if (e.volumes?.some((v) => v.role === 'support_enforcer')) return true
  const painted = (x?: Record<number, string>) => x !== undefined && Object.keys(x).length > 0
  return e.parts.some((p) => painted(p.paint?.support)) || Object.values(e.paint ?? {}).some((l) => painted(l?.support))
}

/** Whether the entry gets support with `own`, its object's settings: sx's rule (objectGetsSupport). */
function supportedOf(e: PlateEntry, own: Record<string, SettingValue>): boolean {
  const enforcers = hasEnforcers(e)
  const m = e.transform
  const key = JSON.stringify([enforcers, [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => Math.round((m[i] ?? 0) * 1e9)), SUPPORT_KEYS.map((k) => own[k] ?? null)])
  let kept = supports.get(e.parts)
  if (!kept) supports.set(e.parts, (kept = new Map()))
  let yes = kept.get(key)
  if (yes === undefined) {
    yes = objectGetsSupport(own, enforcers, e.parts, m)
    kept.set(key, yes)
  }
  return yes
}

/**
 * The entries as the by-object rules see them: each footprint on the bed and its top. With the plate's `cfg`, each also
 * carries its own settings and whether it gets support, so its support's pad counts in its reach only then.
 */
export function plateShapes(entries: readonly PlateEntry[], cfg?: Record<string, SettingValue>, objectSettings: ObjectSettings = {}): ByObjectShape[] {
  return entries.map((e) => {
    const shape: ByObjectShape = { id: e.id, name: e.name, ...shapeOf(e) }
    if (!cfg) return shape
    const settings = objectSettings[e.instanceOf ?? e.id]
    const own = settings ? { ...cfg, ...settings } : cfg
    return { ...shape, supported: supportedOf(e, own), ...(settings ? { settings } : {}) }
  })
}

/** `printerId` is the printer profile the slice names, whose head heimdall moves; without one, the config's printer model. */
export function clearancePlan(entries: readonly PlateEntry[], cfg: Record<string, SettingValue>, printerId?: string, objectSettings: ObjectSettings = {}): ClearancePlan {
  const plan = byObjectPlan(plateShapes(entries, cfg, objectSettings), cfg, byObjectHead(cfg, printerId))
  return { ...plan, transforms: Object.fromEntries(entries.map((e) => [e.id, e.transform])) }
}

/**
 * The problems of printing `entries` one after the other in this order with `cfg`, one sentence each, worded as the
 * engine words them. Empty when the plate prints safely by object.
 */
export function clearanceProblems(entries: readonly PlateEntry[], cfg: Record<string, SettingValue>, printerId?: string, objectSettings: ObjectSettings = {}): string[] {
  return sentences(clearancePlan(entries, cfg, printerId, objectSettings))
}

/** The plan's problems, one sentence each, worded as the engine words them. A close call is not one: heimdall slices it. */
function sentences(plan: ByObjectPlan): string[] {
  return [
    ...plan.pairs.filter((p) => p.severity === 'block').map((p) => `${p.a.name} and ${p.b.name} are ${p.gapMm.toFixed(1)} mm apart${p.reachMm > 0 ? `, counting the brim, skirt or support round ${p.b.name}` : ''}; printing by object needs ${Math.round(plan.needMm)} mm between objects so the toolhead clears them`),
    ...plan.tall.map((t) => `${t.name} is ${t.topMm.toFixed(1)} mm tall and prints before another object; the ${t.what} clears ${t.limitMm.toFixed(0)} mm, so print it last or lower it`),
  ]
}

type Inputs = Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'easy' | 'overrides' | 'profile'> & Partial<Pick<AppState, 'objectSettings'>>

let planned: { plate: unknown; plates: unknown; activePlate: unknown; easy: unknown; overrides: unknown; profile: unknown; objectSettings: unknown; plan: ClearancePlan | null } | null = null

/** The active plate's by-object plan when it prints by object with more than one printable object, else null. */
export function activeClearance(s: Inputs): ClearancePlan | null {
  if (planned && planned.plate === s.plate && planned.plates === s.plates && planned.activePlate === s.activePlate && planned.easy === s.easy && planned.overrides === s.overrides && planned.profile === s.profile && planned.objectSettings === s.objectSettings) return planned.plan
  const printable = s.plate.filter((p) => p.printable !== false)
  const cfg = printable.length > 1 ? byObjectConfig(s) : null
  const plan = cfg ? clearancePlan(printable, cfg, s.profile?.printerId, s.objectSettings) : null
  planned = { plate: s.plate, plates: s.plates, activePlate: s.activePlate, easy: s.easy, overrides: s.overrides, profile: s.profile, objectSettings: s.objectSettings, plan }
  return plan
}

/** The settings the active plate slices with when it prints by object, else null. */
export function byObjectConfig(s: Pick<AppState, 'plates' | 'activePlate' | 'easy' | 'overrides'>): Record<string, SettingValue> | null {
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const base = resolveConfig(s.easy, s.overrides)
  return plateSequence(meta, base) === 'by-object' ? ({ ...base, ...plateConfig(meta) } as unknown as Record<string, SettingValue>) : null
}

/** The active plate's plan only when something on it fails, for the warning and the read-back. */
export function clearanceTrouble(s: Inputs): ClearancePlan | null {
  const plan = activeClearance(s)
  return plan && (plan.pairs.length > 0 || plan.tall.length > 0) ? plan : null
}

/**
 * Why the active plate may collide by object as it sits, as one message, or null when it keeps the profile's clearance
 * or prints by layer.
 */
export function sequenceProblem(s: Inputs): string | null {
  const plan = clearanceTrouble(s)
  const said = plan ? sentences(plan) : []
  if (said.length === 0) return null
  return `Printing by object may collide: ${said.join('; ')}. Slice to see where heimdall finds a strike, or move the objects apart, print the tall one last, or print by layer.`
}
