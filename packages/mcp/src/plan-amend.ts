// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A build that finds a planned size it cannot keep asks to change the approved plan: design.plan with amends shows
// the person the plan with the changed sizes, the old value beside each, and the build's reason, and waits for Go, as
// a new plan does; design.put_plan with amends changes a client's own plan. An amend changes sizes only, once per fix
// round, never after the round is over, and never buys a second round: the plan keeps its failed checks under the same
// planId, and its revision goes up by one.
import type { PartPlan, PlanEntry, PlanOrigin } from './design-check'

/** The longest reason an amend takes. */
export const AMEND_REASON_MAX = 200

/** A size an amend changes, in the plan's units. */
export interface AmendChange {
  where: 'feature' | 'overall' | 'hole'
  /** The feature it belongs to; null for the overall size or a row of holes. */
  feature: string | null
  /** The size's key, x, y or z for the overall size, or the hole row's name for a row of holes. */
  size: string
  from: number
  to: number
}

type Sized = Pick<PartPlan, 'part' | 'units' | 'features' | 'overall' | 'holes' | 'openFaces'>

const sameKeys = (a: object, b: object): boolean => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i])
}

/**
 * What keeps `next` from being an amend of `old`, or null: an amend keeps the part, its units, each feature (name,
 * kind, the sizes it has and what each measures, in order), whether it has an overall size, and each row of holes
 * (name and count), and its open faces. Only the numbers change.
 */
export function amendShapeProblem(old: Sized, next: Sized): string | null {
  const only = 'an amend changes sizes only'
  if (next.part !== old.part) return `part: ${only}; the part stays "${old.part}"`
  if (next.units !== old.units) return `units: ${only}; the plan stays in ${old.units}`
  if (next.features.length !== old.features.length) return `features: ${only}; the plan has ${old.features.length} features`
  for (const [i, f] of next.features.entries()) {
    const o = old.features[i]!
    if (f.name !== o.name || (f.kind ?? '') !== (o.kind ?? '')) return `features: ${only}; feature ${i + 1} stays "${o.name}"`
    if (!sameKeys(f.sizes, o.sizes)) return `features: ${only}; ${o.name} keeps the sizes ${Object.keys(o.sizes).join(', ') || 'it has (none)'}`
    if (JSON.stringify(Object.entries(f.kinds ?? {}).sort()) !== JSON.stringify(Object.entries(o.kinds ?? {}).sort())) return `features: ${only}; ${o.name} keeps its kinds`
  }
  if (Boolean(next.overall) !== Boolean(old.overall)) return `overall: ${only}; ${old.overall ? 'keep' : 'leave out'} the overall size`
  const nh = next.holes ?? []
  const oh = old.holes ?? []
  if (nh.length !== oh.length || nh.some((h, i) => h.name !== oh[i]!.name || (h.count ?? 1) !== (oh[i]!.count ?? 1))) return `holes: ${only}; the plan keeps its rows of holes, by name and count`
  if (JSON.stringify(next.openFaces ?? null) !== JSON.stringify(old.openFaces ?? null)) return `openFaces: ${only}; ${old.openFaces ? 'the plan keeps its openFaces as they are' : 'leave out openFaces'}`
  return null
}

/** `old` with the sizes of `next` (amendShapeProblem says they match): its assumptions and questions stay as they are. */
export function amendedSizes<P extends PartPlan>(old: P, next: Sized): P {
  const out = structuredClone(old)
  out.features = out.features.map((f, i) => ({ ...f, sizes: { ...next.features[i]!.sizes } }))
  if (out.overall && next.overall) out.overall = { ...next.overall }
  if (out.holes && next.holes) out.holes = out.holes.map((h, i) => ({ ...h, diameter: next.holes![i]!.diameter }))
  return out
}

/** Each size that differs between two plans of one shape. */
export function amendChanges(old: Sized, next: Sized): AmendChange[] {
  const out: AmendChange[] = []
  for (const [i, f] of old.features.entries())
    for (const [k, v] of Object.entries(f.sizes)) {
      const to = next.features[i]!.sizes[k]!
      if (to !== v) out.push({ where: 'feature', feature: f.name, size: k, from: v, to })
    }
  if (old.overall && next.overall) for (const a of ['x', 'y', 'z'] as const) if (old.overall[a] !== next.overall[a]) out.push({ where: 'overall', feature: null, size: a, from: old.overall[a], to: next.overall[a] })
  for (const [i, h] of (old.holes ?? []).entries()) {
    const to = next.holes![i]!.diameter
    if (to !== h.diameter) out.push({ where: 'hole', feature: null, size: h.name, from: h.diameter, to })
  }
  return out
}

/**
 * Why the plan kept as `entry` cannot be amended now by a plan of `origin`, or null: there is no such plan of that
 * origin; it was set aside (the person changed sizes on a sheet since it was approved); its part is not built yet (no
 * design is tied to it); its fix round is over (closed); or it was amended once already in this fix round (no check
 * has failed since).
 */
export function amendProblem(planId: string, entry: PlanEntry | undefined, origin: PlanOrigin): string | null {
  if (!entry || entry.origin !== origin) return `amends: there is no ${origin === 'card' ? 'plan the person approved' : 'plan of yours'} with planId ${planId}`
  if (entry.stale || entry.superseded) return 'amends: the person changed sizes since that plan was approved; make a new plan with the sizes they set'
  if (!entry.design) return `amends: the plan's part is not built yet; build to the plan, or ${origin === 'card' ? 'make a new plan' : 'put the plan again'}`
  if (entry.closed) return 'amends: the plan has used its fix round; stop and tell the person exactly what is off'
  if (entry.amendedAt === (entry.failedChecks ?? 0)) return 'amends: the plan was changed once already since its last failed check; build to it as changed'
  return null
}

/** The reason an amend gives, trimmed; a ToolInputError message when it is missing or empty. */
export function amendReason(reason: string | undefined): { why: string } | { problem: string } {
  const why = reason?.trim() ?? ''
  if (!why) return { problem: 'reason: say why the build changes the plan, in a sentence the person reads on the card' }
  if (why.length > AMEND_REASON_MAX) return { problem: `reason: at most ${AMEND_REASON_MAX} characters` }
  return { why }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000
const AXIS_WORD = { x: 'width', y: 'depth', z: 'height' } as const

/** A changed size in plain words: "Hinge clearance 0.3 mm to 0.4 mm", "Overall height 30 mm to 34 mm", "Vent diameter 3 mm to 3.4 mm". */
export function changeText(c: AmendChange, units: 'mm' | 'in'): string {
  const words = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').toLowerCase()
  const name = c.where === 'overall' ? `Overall ${AXIS_WORD[c.size as 'x']}` : c.where === 'hole' ? `${c.size} diameter` : `${c.feature} ${words(c.size)}`
  return `${name} ${r3(c.from)} ${units} to ${r3(c.to)} ${units}`
}
