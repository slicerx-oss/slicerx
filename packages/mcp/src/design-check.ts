// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A built part checked against its plan: the overall size, each named hole, the feature count, a closed body and the
// thinnest wall the nozzle can print. The comparison is pure; the facts about the body come from body-facts.ts. Plans
// wait in a registry under their planId until design.check reads them. Only zod here, so any package can import the
// plan and result shapes.
import { z } from 'zod'

/** The largest size a plan takes, in its own units. */
export const PLAN_SIZE_MAX = 10_000
const size = z.number().finite().positive().max(PLAN_SIZE_MAX)
const text = (max: number) => z.string().trim().min(1).max(max)

/**
 * A part as planned before it is built. Every size is in `units`. The app's plan card (design.plan), design.put_plan and design.check
 * share this one shape; the card also needs at least one feature.
 */
export const partPlanSchema = z.object({
  planId: text(64),
  part: text(80),
  units: z.enum(['mm', 'in']),
  features: z.array(z.object({ name: text(60), kind: text(40).optional(), sizes: z.record(text(40), size) })).max(30),
  overall: z.object({ x: size, y: size, z: size }).optional(),
  holes: z.array(z.object({ name: text(60), diameter: size })).max(60).optional(),
  assumptions: z.array(text(200)).max(12),
  questions: z.array(text(200)).max(6),
})
export type PartPlan = z.infer<typeof partPlanSchema>

export const checkItemSchema = z.object({ name: z.string(), want: z.string(), got: z.string(), pass: z.boolean() })
export const checkResultSchema = z.object({ pass: z.boolean(), items: z.array(checkItemSchema) })
export type CheckItem = z.infer<typeof checkItemSchema>
export type CheckResult = z.infer<typeof checkResultSchema>

/** What the body is, in mm, as geom.info, geom.faces and geom.measure read it. */
export interface BodyFacts {
  /** The size of the bounds of every part together. */
  size: { x: number; y: number; z: number }
  /** The round holes found in it, each once. */
  holes: { diameterMm: number }[]
  /** The steps in its history that shape it (paint and suppressed steps left out). */
  features: number
  /** True when every part is closed. */
  watertight: boolean
  /** The thinnest wall, or null when it was not measured. */
  minWallMm: number | null
  /** Why the wall was not measured, when that was on purpose: "part too dense" past the measuring budget. */
  minWallWhy?: string | undefined
}

const MM_PER_IN = 25.4
/** Overall sizes pass within 0.2 mm or 1 percent, whichever is larger. */
const SIZE_MM = 0.2
const SIZE_SHARE = 0.01
/** Each named hole's diameter passes within 0.1 mm. */
const HOLE_MM = 0.1

/** The nozzle walls are held to when the printer's is unknown or not a size. */
export const DEFAULT_NOZZLE_MM = 0.4

const mm = (v: number): string => `${Math.round(v * 100) / 100} mm`
const r2 = (v: number): number => Math.round(v * 100) / 100

/** A nozzle diameter to hold walls to: the one given when it is a positive finite number, else 0.4 mm. */
export function nozzleOr(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_NOZZLE_MM
}

const sizeOk = (got: number, want: number): boolean => Math.abs(got - want) <= Math.max(SIZE_MM, SIZE_SHARE * want)

/**
 * Checks a body against its plan. Inch plans are compared in mm; the tolerances are in mm. The overall size is
 * compared axis by axis, since z is the print height: x and y swapped passes (the part turned on the bed prints the
 * same), and other swaps fail with a note to rotate it. With `holes` in the plan, a hole the plan does not have fails.
 * A nozzle that is not a positive finite number counts as 0.4 mm.
 */
export function designCheck(plan: PartPlan, body: BodyFacts, nozzleMm: number): CheckResult {
  const scale = plan.units === 'in' ? MM_PER_IN : 1
  const nozzle = nozzleOr(nozzleMm)
  const items: CheckItem[] = []

  if (plan.overall) {
    const axes = ['x', 'y', 'z'] as const
    const want = axes.map((a) => plan.overall![a] * scale)
    const got = axes.map((a) => body.size[a])
    const inches = plan.units === 'in' ? ` (${axes.map((a) => plan.overall![a]).join(' x ')} in)` : ''
    let note = ''
    let pass = axes.every((_, k) => sizeOk(got[k]!, want[k]!))
    if (!pass && sizeOk(got[1]!, want[0]!) && sizeOk(got[0]!, want[1]!) && sizeOk(got[2]!, want[2]!)) {
      pass = true
      note = ' (x and y swapped: turned on the bed, it prints the same)'
    } else if (!pass) {
      const [gs, ws] = [[...got].sort((a, b) => a - b), [...want].sort((a, b) => a - b)]
      if (ws.every((w, k) => sizeOk(gs[k]!, w))) note = ' (same size, axes swapped: rotate it)'
    }
    items.push({ name: 'overall size', want: `${want.map(r2).join(' x ')} mm${inches}`, got: `${got.map(r2).join(' x ')} mm${note}`, pass })
  }

  const { matched, extra } = matchHoles(plan.holes ?? [], body.holes, scale)
  for (const { hole, found } of matched) {
    const want = hole.diameter * scale
    items.push({ name: hole.name, want: `${mm(want)} diameter`, got: found ? `${mm(found.diameterMm)} diameter` : 'no hole', pass: !!found && Math.abs(found.diameterMm - want) <= HOLE_MM })
  }
  // a plan that lists its holes has no others; one without the list says nothing about holes
  if (plan.holes) for (const h of extra) items.push({ name: `extra hole, ${mm(h.diameterMm)}`, want: 'no hole (not in the plan)', got: `${mm(h.diameterMm)} diameter`, pass: false })

  items.push({ name: 'feature count', want: String(plan.features.length), got: String(body.features), pass: body.features === plan.features.length })
  items.push({ name: 'watertight', want: 'closed', got: body.watertight ? 'closed' : 'open', pass: body.watertight })
  const wall = 2 * nozzle
  const unmeasured = body.minWallWhy ? `not measured (${body.minWallWhy})` : 'not measured'
  items.push({ name: 'minimum wall', want: `at least ${mm(wall)} (twice the ${mm(nozzle)} nozzle)`, got: body.minWallMm === null ? unmeasured : mm(body.minWallMm), pass: body.minWallMm !== null && body.minWallMm >= wall - 1e-6 })

  return { pass: items.every((i) => i.pass), items }
}

/**
 * Each planned hole with the body's hole that stands for it, closest diameters first, so one wrong hole does not shift
 * the others; and the body's holes no planned hole took.
 */
function matchHoles(planned: NonNullable<PartPlan['holes']>, found: BodyFacts['holes'], scale: number): { matched: { hole: NonNullable<PartPlan['holes']>[number]; found: BodyFacts['holes'][number] | undefined }[]; extra: BodyFacts['holes'] } {
  const out = new Map<number, number>()
  const used = new Set<number>()
  const pairs: [number, number, number][] = []
  planned.forEach((h, k) => found.forEach((f, j) => pairs.push([Math.abs(f.diameterMm - h.diameter * scale), k, j])))
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  for (const [, k, j] of pairs) {
    if (out.has(k) || used.has(j)) continue
    out.set(k, j)
    used.add(j)
  }
  return { matched: planned.map((hole, k) => ({ hole, found: out.has(k) ? found[out.get(k)!] : undefined })), extra: found.filter((_, j) => !used.has(j)) }
}

/**
 * Who made a plan: the mimir tab's plan card ('card', the person's plan) or an integrator over design.put_plan
 * ('client'). A client can never replace or push out a card plan.
 */
export type PlanOrigin = 'card' | 'client'

/** A plan, who made it, and the design it was built in, when that is known. */
export interface PlanEntry {
  plan: PartPlan
  origin: PlanOrigin
  design?: string
}

/** Plans kept at most for each origin; putting one more drops the one of that origin put longest ago. */
export const MAX_PLANS = 50

/** Where plans wait for design.check, by planId. The plan card and design.put_plan put them here; tests and scripts may too. */
export interface PlanRegistry {
  /**
   * Keeps a plan (checked against the schema), replacing one with the same planId; `design` ties it to a design.
   * `origin` defaults to 'client'. A client plan whose planId belongs to a card plan is refused (throws).
   */
  put(plan: PartPlan, design?: string, origin?: PlanOrigin): void
  /** Ties a kept plan to the design it was built in, for a plan made before the design; false when there is no such plan. */
  tie(planId: string, design: string): boolean
  get(planId: string): PlanEntry | undefined
  /** The plan put last (of `origin` alone, when given), or undefined when there is none. */
  latest(origin?: PlanOrigin): PartPlan | undefined
  /** Forgets every plan. */
  clear(): void
}

/** Thrown when a client plan would replace a card plan. */
export class PlanOwnedError extends Error {
  constructor(readonly planId: string) {
    super(`planId: ${planId} is a plan the person made in the mimir tab; give your plan its own planId`)
    this.name = 'PlanOwnedError'
  }
}

/** A registry of up to MAX_PLANS card plans and MAX_PLANS client plans, the oldest of each put dropped first. */
export function createPlanRegistry(): PlanRegistry {
  const plans = new Map<string, PlanEntry>()
  return {
    put(plan, design, origin = 'client') {
      const p = partPlanSchema.parse(plan)
      if (origin === 'client' && plans.get(p.planId)?.origin === 'card') throw new PlanOwnedError(p.planId)
      plans.delete(p.planId)
      plans.set(p.planId, design ? { plan: p, origin, design } : { plan: p, origin })
      const mine = [...plans.entries()].filter(([, e]) => e.origin === origin)
      for (let k = 0; k < mine.length - MAX_PLANS; k++) plans.delete(mine[k]![0])
    },
    tie(planId, design) {
      const entry = plans.get(planId)
      if (!entry) return false
      entry.design = design
      return true
    },
    get: (planId) => plans.get(planId),
    latest: (origin) => [...plans.values()].filter((e) => !origin || e.origin === origin).at(-1)?.plan,
    clear: () => plans.clear(),
  }
}
