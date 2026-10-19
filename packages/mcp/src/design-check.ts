// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A built part checked against its plan: the overall size, each named hole, the feature count, a closed body and the
// thinnest wall the nozzle can print. The comparison is pure; the facts about the body come from body-facts.ts. Plans
// wait in a registry under their planId until design.check reads them. Only zod here, so any package can import the
// plan and result shapes.
import { z } from 'zod'

/** A part as planned before it is built. Every size is in `units`. */
export const partPlanSchema = z.object({
  planId: z.string().min(1),
  part: z.string().min(1),
  units: z.enum(['mm', 'in']),
  features: z.array(z.object({ name: z.string().min(1), kind: z.string().min(1).optional(), sizes: z.record(z.string(), z.number().positive()) })),
  overall: z.object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() }).optional(),
  holes: z.array(z.object({ name: z.string().min(1), diameter: z.number().positive() })).optional(),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
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
  /** The round holes found in it, each once; a hole's name when something named it. */
  holes: { name?: string; diameterMm: number }[]
  /** The steps in its history that shape it (paint and suppressed steps left out). */
  features: number
  /** True when every part is closed. */
  watertight: boolean
  /** The thinnest wall, or null when none could be measured. */
  minWallMm: number | null
}

const MM_PER_IN = 25.4
/** Overall sizes pass within 0.2 mm or 1 percent, whichever is larger. */
const SIZE_MM = 0.2
const SIZE_SHARE = 0.01
/** Each named hole's diameter passes within 0.1 mm. */
const HOLE_MM = 0.1

const mm = (v: number): string => `${Math.round(v * 100) / 100} mm`

/** Checks a body against its plan. Inch plans are compared in mm; the tolerances are in mm. */
export function designCheck(plan: PartPlan, body: BodyFacts, nozzleMm: number): CheckResult {
  const scale = plan.units === 'in' ? MM_PER_IN : 1
  const items: CheckItem[] = []

  if (plan.overall) {
    const axes = ['x', 'y', 'z'] as const
    const want = axes.map((a) => plan.overall![a] * scale)
    const got = axes.map((a) => body.size[a])
    const pass = axes.every((_, k) => Math.abs(got[k]! - want[k]!) <= Math.max(SIZE_MM, SIZE_SHARE * want[k]!))
    const inches = plan.units === 'in' ? ` (${axes.map((a) => plan.overall![a]).join(' x ')} in)` : ''
    items.push({ name: 'overall size', want: `${want.map((v) => Math.round(v * 100) / 100).join(' x ')} mm${inches}`, got: `${got.map((v) => Math.round(v * 100) / 100).join(' x ')} mm`, pass })
  }

  for (const { hole, found } of matchHoles(plan.holes ?? [], body.holes, scale)) {
    const want = hole.diameter * scale
    items.push({ name: hole.name, want: `${mm(want)} diameter`, got: found ? `${mm(found.diameterMm)} diameter` : 'no hole', pass: !!found && Math.abs(found.diameterMm - want) <= HOLE_MM })
  }

  items.push({ name: 'feature count', want: String(plan.features.length), got: String(body.features), pass: body.features === plan.features.length })
  items.push({ name: 'watertight', want: 'closed', got: body.watertight ? 'closed' : 'open', pass: body.watertight })
  const wall = 2 * nozzleMm
  items.push({ name: 'minimum wall', want: `at least ${mm(wall)} (twice the ${mm(nozzleMm)} nozzle)`, got: body.minWallMm === null ? 'not measured' : mm(body.minWallMm), pass: body.minWallMm !== null && body.minWallMm >= wall - 1e-6 })

  return { pass: items.every((i) => i.pass), items }
}

/**
 * Each planned hole with the body's hole that stands for it: one of the same name first, then the closest diameters
 * of the rest, closest pair first, so one wrong hole does not shift the others.
 */
function matchHoles(planned: NonNullable<PartPlan['holes']>, found: BodyFacts['holes'], scale: number): { hole: NonNullable<PartPlan['holes']>[number]; found: BodyFacts['holes'][number] | undefined }[] {
  const out = new Map<number, number>()
  const used = new Set<number>()
  planned.forEach((h, k) => {
    const j = found.findIndex((f, i) => !used.has(i) && f.name !== undefined && f.name.trim().toLowerCase() === h.name.trim().toLowerCase())
    if (j >= 0) {
      out.set(k, j)
      used.add(j)
    }
  })
  const pairs: [number, number, number][] = []
  planned.forEach((h, k) => {
    if (out.has(k)) return
    found.forEach((f, j) => {
      if (!used.has(j)) pairs.push([Math.abs(f.diameterMm - h.diameter * scale), k, j])
    })
  })
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  for (const [, k, j] of pairs) {
    if (out.has(k) || used.has(j)) continue
    out.set(k, j)
    used.add(j)
  }
  return planned.map((hole, k) => ({ hole, found: out.has(k) ? found[out.get(k)!] : undefined }))
}

/** A plan and the design it was built in, when that is known. */
export interface PlanEntry {
  plan: PartPlan
  design?: string
}

/** Where plans wait for design.check, by planId. design.plan puts them here; tests and scripts may too. */
export interface PlanRegistry {
  /** Keeps a plan (checked against the schema), replacing one with the same planId; `design` ties it to a design. */
  put(plan: PartPlan, design?: string): void
  get(planId: string): PlanEntry | undefined
  /** The plan put last, or undefined when there is none. */
  latest(): PartPlan | undefined
}

export function createPlanRegistry(): PlanRegistry {
  const plans = new Map<string, PlanEntry>()
  return {
    put(plan, design) {
      const p = partPlanSchema.parse(plan)
      plans.delete(p.planId)
      plans.set(p.planId, design ? { plan: p, design } : { plan: p })
    },
    get: (planId) => plans.get(planId),
    latest: () => [...plans.values()].at(-1)?.plan,
  }
}
