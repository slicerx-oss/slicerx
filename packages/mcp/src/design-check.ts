// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A built part checked against its plan: the overall size, each named hole, the feature count, a closed body and the
// thinnest wall the nozzle can print. The comparison is pure; the facts about the body come from body-facts.ts. Plans
// wait in a registry under their planId until design.check reads them. Only zod here, so any package can import the
// plan and result shapes.
import { SIZE_KINDS } from '@slicerx/contracts/size-kind'
import { z } from 'zod'

/** The largest size a plan takes, in its own units. */
export const PLAN_SIZE_MAX = 10_000
const size = z.number().finite().positive().max(PLAN_SIZE_MAX)
const text = (max: number) => z.string().trim().min(1).max(max)

/** A planned feature: its name, its operation (kind), its sizes, and what each size measures (kinds) when it says. */
const feature = z
  .object({ name: text(60), kind: text(40).optional(), sizes: z.record(text(40), size), kinds: z.record(text(40), z.enum(SIZE_KINDS)).optional() })
  .superRefine((f, ctx) => {
    const sizes = Object.keys(f.sizes)
    for (const k of Object.keys(f.kinds ?? {}))
      if (!sizes.includes(k)) ctx.addIssue({ code: 'custom', path: ['kinds', k], message: `kinds names ${k}, which is not a size of ${f.name}; ${sizes.length ? `its sizes are ${sizes.join(', ')}` : 'it has no sizes'}` })
  })

/**
 * A part as planned before it is built. Every size is in `units`, except a count or an angle among a feature's sizes
 * (the kind its kinds entry states, else kindOf in @slicerx/contracts/size-kind), which no inch plan converts. The
 * app's plan card (design.plan), design.put_plan and design.check share this one shape; the card also needs at least
 * one feature.
 */
export const partPlanSchema = z.object({
  planId: text(64),
  part: text(80),
  units: z.enum(['mm', 'in']),
  /**
   * `kinds` says what a size measures (count, angle or length); a size it leaves out is read by its name (kindOf). Each
   * of its keys names one of the feature's sizes. An empty map is taken and dropped (tidyPlan).
   */
  features: z.array(feature).max(30),
  overall: z.object({ x: size, y: size, z: size }).optional(),
  /** Each row is `count` holes of one diameter (default 1), such as four 3.4 mm motor screw holes. */
  holes: z.array(z.object({ name: text(60), diameter: size, count: z.number().int().positive().max(60).optional().describe('How many holes of this diameter the row stands for; default 1') })).max(60).optional(),
  assumptions: z.array(text(200)).max(12),
  questions: z.array(text(200)).max(6),
})
export type PartPlan = z.infer<typeof partPlanSchema>

/** The plan with each empty kinds map left out, so a plan that says nothing about kinds is kept the same as one without them. */
export function tidyPlan<P extends PartPlan>(plan: P): P {
  if (!plan.features.some((f) => f.kinds && !Object.keys(f.kinds).length)) return plan
  return { ...plan, features: plan.features.map(({ kinds, ...f }) => (kinds && Object.keys(kinds).length ? { ...f, kinds } : f)) }
}

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
  /** Those steps' names, in order, when known: with no step tagged, a planned feature is matched to the steps named for it. */
  steps?: string[] | undefined
  /** For each of those steps, the planned feature it was tagged with when it was built (the tools' feature), or null. */
  tags?: (string | null)[] | undefined
  /** Those steps' ids, in order (slicerx_design_edit_step takes a step by id; an index counts paint and suppressed steps too). */
  stepIds?: string[] | undefined
  /** The size of each part's bounds, when the design has more than one (a lid laid flat beside its base). */
  parts?: { x: number; y: number; z: number }[] | undefined
  /** True when every part is closed. */
  watertight: boolean
  /** What keeps it from being closed, when it is not: "5 edges where more than two faces meet". */
  openWhy?: string | undefined
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

/** Whether a size matches axis by axis, x and y swapped passing (turned on the bed), with a note on a swap. */
function sizeMatch(got: number[], want: number[]): { pass: boolean; note: string } {
  if (want.every((w, k) => sizeOk(got[k]!, w))) return { pass: true, note: '' }
  if (sizeOk(got[1]!, want[0]!) && sizeOk(got[0]!, want[1]!) && sizeOk(got[2]!, want[2]!)) return { pass: true, note: ' (x and y swapped: turned on the bed, it prints the same)' }
  const [gs, ws] = [[...got].sort((a, b) => a - b), [...want].sort((a, b) => a - b)]
  return { pass: false, note: ws.every((w, k) => sizeOk(gs[k]!, w)) ? ' (same size, axes swapped: rotate it)' : '' }
}

// words a step's own name carries whatever it builds ("Sketch extrude 5 mm"), which say nothing about the feature
const STEP_WORDS = new Set(['sketch', 'extrude', 'revolve', 'pull', 'push', 'step', 'copies', 'shape', 'new', 'join', 'the', 'and', 'for', 'with', 'four', 'two', 'three', 'six', 'eight', 'all', 'each'])

/** Plurals the rules below get wrong: an f that turns to ves, and axes, the plural of axis. */
const PLURALS: Record<string, string> = { shelves: 'shelf', halves: 'half', axes: 'axis' }

/** A word made single: "holes" is "hole", "boxes" is "box", "assemblies" is "assembly", "shelves" is "shelf"; "glass", "axis" and "chassis" stay. */
function single(w: string): string {
  const odd = PLURALS[w]
  if (odd) return odd
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2)
  return w.length > 3 && w.endsWith('s') && !/(?:ss|is)$/.test(w) ? w.slice(0, -1) : w
}

/** The words of a name that tell features apart: lower case, three letters or more, no numbers, plurals made single. */
function nameWords(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d/.test(w) && !STEP_WORDS.has(w)).map(single))
}

/** A feature name or tag as compared: lower case, words only, plurals made single ("Snap-fit lids" is "snap fit lid"). */
function nameKey(name: string): string {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(single).join(' ')
}

const steps = (n: number): string => `${n} step${n === 1 ? '' : 's'}`

/**
 * The planned features against the steps that built them. Each modeling tool takes the planned feature its step builds
 * (feature), recorded on the step as its tag. A feature may take several steps (four standoffs, five port cutouts), so
 * more steps than features is fine as long as each feature has a step tagged with its name (case, punctuation and
 * plurals aside). A step with no tag is finishing work, such as a fillet, and never stands in for a missing feature. A
 * history with no tag at all (a client that does not pass feature) is matched by step names instead: a step goes to the
 * feature its name shares the most words with (on a tie, the feature with fewer words left over), and a step whose name
 * matches no feature stands for none. Fewer steps than features, or a feature left with none, fails by name.
 */
function featureItem(features: string[], body: BodyFacts): CheckItem {
  const n = features.length
  const m = body.features
  if (m < n) return { name: 'feature count', want: String(n), got: `${steps(m)} for ${n} planned features`, pass: false }
  // nothing known about the steps but their count
  if (!body.steps) return { name: 'feature count', want: String(n), got: String(m), pass: true }
  const per = features.map(() => 0)
  const tagged = (body.tags ?? []).some((t) => typeof t === 'string' && t.trim() !== '')
  const loose: string[] = []
  let untagged = 0
  // untagged steps by their place in the history (1 based), for the hint to tag one rather than build it again
  const bare: number[] = []
  if (tagged) {
    const keys = features.map(nameKey)
    body.steps.forEach((_, i) => {
      const t = body.tags?.[i]
      if (typeof t !== 'string' || !t.trim()) bare.push(i + 1)
    })
    ;(body.tags ?? []).slice(0, body.steps.length).forEach((t) => {
      if (typeof t !== 'string' || !t.trim()) return void untagged++
      const key = nameKey(t)
      let hit = false
      keys.forEach((k, j) => {
        if (k !== key) return
        per[j]!++
        hit = true
      })
      if (!hit && !loose.includes(t)) loose.push(t)
    })
    untagged += Math.max(0, body.steps.length - (body.tags?.length ?? 0))
  } else {
    const fw = features.map(nameWords)
    for (const step of body.steps) {
      const sw = nameWords(step)
      let best = -1
      let bestShared = 0
      let bestLeft = Infinity
      fw.forEach((w, k) => {
        const shared = [...sw].filter((x) => w.has(x)).length
        const left = w.size - shared
        if (shared > bestShared || (shared > 0 && shared === bestShared && left < bestLeft)) [best, bestShared, bestLeft] = [k, shared, left]
      })
      if (best >= 0) per[best]!++
      else loose.push(step)
    }
  }
  const missing = features.filter((_, k) => per[k] === 0)
  const groups = per.map((c, k) => (c > 1 ? `${features[k]} ${c}` : '')).filter(Boolean)
  const want = tagged ? `${n} features, each built by a step tagged with its name` : `${n} features, each built by one or more steps`
  if (!missing.length) return { name: 'feature count', want, got: `${m} steps for ${n} features${groups.length ? ` (${groups.join(', ')})` : ''}`, pass: true }
  const quoted = loose.map((s) => `"${s}"`).join(', ')
  // an untagged step whose name shares a word with a missing feature is likely that feature: say to tag it
  // an untagged step named like a missing feature is likely that feature: one hint per step, naming the feature it
  // shares the most words with, or each of those that tie, and the step by id (an index would count paint and
  // suppressed steps, which the shaping steps here leave out)
  const hints = tagged
    ? bare.flatMap((i) => {
        const sw = nameWords(body.steps![i - 1]!)
        const shared = missing.map((f) => [...nameWords(f)].filter((w) => sw.has(w)).length)
        const most = Math.max(0, ...shared)
        if (!most) return []
        const best = missing.filter((_, k) => shared[k] === most)
        const id = body.stepIds?.[i - 1]
        const which = best.length === 1 ? `"${best[0]}"` : `one of ${best.map((f) => `"${f}"`).join(', ')}`
        return [`step ${id ? `"${id}"` : i} ("${body.steps![i - 1]}") is untagged: set its feature to ${which} with slicerx_design_edit_step`]
      })
    : []
  const got = tagged
    ? `${m} steps, none tagged for ${missing.join(', ')}${loose.length ? `; tagged for ${quoted}, which the plan does not have` : ''}${untagged ? `; ${untagged} untagged ${untagged === 1 ? 'step is' : 'steps are'} finishing work` : ''}${hints.length ? `; ${hints.join('; ')}` : ''}`
    : `${m} steps, none for ${missing.join(', ')}${loose.length ? `; ${quoted} match${loose.length === 1 ? 'es' : ''} no planned feature` : ''}; pass feature on each step to tie it to the plan`
  return { name: 'feature count', want, got, pass: false }
}

/**
 * Checks a body against its plan. Inch plans are compared in mm; the tolerances are in mm. The overall size is
 * compared axis by axis, since z is the print height: x and y swapped passes (the part turned on the bed prints the
 * same), and other swaps fail with a note to rotate it. With `holes` in the plan, a hole the plan does not have fails.
 * A nozzle that is not a positive finite number counts as 0.4 mm. A feature's own sizes are never held to the body, so
 * a count or an angle among them (@slicerx/contracts/size-kind) never fails an item, in mm or inches.
 */
export function designCheck(plan: PartPlan, body: BodyFacts, nozzleMm: number): CheckResult {
  const scale = plan.units === 'in' ? MM_PER_IN : 1
  const nozzle = nozzleOr(nozzleMm)
  const items: CheckItem[] = []

  if (plan.overall) {
    const axes = ['x', 'y', 'z'] as const
    const want = axes.map((a) => plan.overall![a] * scale)
    const inches = plan.units === 'in' ? ` (${axes.map((a) => plan.overall![a]).join(' x ')} in)` : ''
    const whole = sizeMatch(axes.map((a) => body.size[a]), want)
    // parts laid out side by side (a lid flat beside its base) are held to the largest part, the assembled part's size
    const largest = !whole.pass && body.parts && body.parts.length > 1 ? [...body.parts].sort((a, b) => b.x * b.y * b.z - a.x * a.y * a.z)[0]! : undefined
    const part = largest ? sizeMatch(axes.map((a) => largest[a]), want) : undefined
    const got = part?.pass
      ? `${axes.map((a) => r2(largest![a])).join(' x ')} mm, the largest part, with the other ${body.parts!.length === 2 ? 'part' : `${body.parts!.length - 1} parts`} laid out beside it${part.note}`
      : `${axes.map((a) => r2(body.size[a])).join(' x ')} mm${whole.note}`
    items.push({ name: 'overall size', want: `${want.map(r2).join(' x ')} mm${inches}`, got, pass: whole.pass || part?.pass === true })
  }

  const { rows, extra } = matchHoles(plan.holes ?? [], body.holes, scale)
  for (const { hole, found, surplus } of rows) {
    const want = hole.diameter * scale
    const count = hole.count ?? 1
    const short = count - found.length
    const notes = [...(short > 0 && found.length > 0 ? [`${short} short`] : []), ...(surplus.length ? [`${surplus.length} more than planned`] : [])]
    const all = [...found, ...surplus].map((f) => f.diameterMm)
    const got = all.length ? `${holeSizes(all)} diameter${notes.length ? ` (${notes.join(', ')})` : ''}` : count === 1 ? 'no hole' : 'no holes'
    const pass = short === 0 && surplus.length === 0 && found.every((f) => Math.abs(f.diameterMm - want) <= HOLE_MM)
    items.push({ name: hole.name, want: `${count === 1 ? '' : `${count} x `}${mm(want)} diameter`, got, pass })
  }
  // a plan that lists its holes has no others; one without the list says nothing about holes
  if (plan.holes) for (const h of extra) items.push({ name: `extra hole, ${mm(h.diameterMm)}`, want: 'no hole (not in the plan)', got: `${mm(h.diameterMm)} diameter`, pass: false })

  items.push(featureItem(plan.features.map((f) => f.name), body))
  items.push({ name: 'watertight', want: 'closed', got: body.watertight ? 'closed' : openWords(body.openWhy), pass: body.watertight })
  const wall = 2 * nozzle
  const unmeasured = body.minWallWhy ? `not measured (${body.minWallWhy})` : 'not measured'
  items.push({ name: 'minimum wall', want: `at least ${mm(wall)} (twice the ${mm(nozzle)} nozzle)`, got: body.minWallMm === null ? unmeasured : mm(body.minWallMm), pass: body.minWallMm !== null && body.minWallMm >= wall - 1e-6 })

  return { pass: items.every((i) => i.pass), items }
}

/**
 * Why a body is not closed, in words that say what to do: surfaces that touch without joining leave edges where more
 * than two faces meet (repair leaves those as they are), while gaps leave open edges and faces turned the wrong way,
 * which repair can close. When both kinds are there, each gets its own advice.
 */
function openWords(why: string | undefined): string {
  if (!why) return 'open'
  if (!/more than two faces/.test(why)) return `open: ${why}; repair the part or rebuild the step that left it open`
  const closable = [/open edge/.test(why) ? 'open edges' : null, /turned opposite ways/.test(why) ? 'edges between faces turned opposite ways' : null].filter((x): x is string => x !== null)
  if (closable.length === 0) return `open: ${why} (surfaces that touch without joining, which repair leaves as they are); rebuild that join so the shapes overlap a little`
  return `open: ${why}; repair can close the ${closable.join(' and the ')}, but it leaves surfaces that touch without joining as they are, so rebuild that join so the shapes overlap a little`
}

/** Diameters as the card writes them: "4 x 3.4 mm" for repeats, sizes apart by commas, largest count first. */
function holeSizes(diameters: number[]): string {
  const counts = new Map<number, number>()
  for (const d of diameters) counts.set(r2(d), (counts.get(r2(d)) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([d, n]) => (n === 1 ? mm(d) : `${n} x ${mm(d)}`))
    .join(', ')
}

type PlannedHole = NonNullable<PartPlan['holes']>[number]
type FoundHole = BodyFacts['holes'][number]

/**
 * Each planned row with the body's holes that stand for it (up to its count), closest diameters first, so one wrong
 * hole does not shift the others. A body hole no row took goes to the row it fits within 0.1 mm as a surplus (the
 * closest such row), else to the extras.
 */
function matchHoles(planned: PlannedHole[], found: FoundHole[], scale: number): { rows: { hole: PlannedHole; found: FoundHole[]; surplus: FoundHole[] }[]; extra: FoundHole[] } {
  const taken = planned.map(() => [] as number[])
  const used = new Set<number>()
  const pairs: [number, number, number][] = []
  planned.forEach((h, k) => found.forEach((f, j) => pairs.push([Math.abs(f.diameterMm - h.diameter * scale), k, j])))
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  for (const [, k, j] of pairs) {
    if (used.has(j) || taken[k]!.length >= (planned[k]!.count ?? 1)) continue
    taken[k]!.push(j)
    used.add(j)
  }
  const surplus = planned.map(() => [] as FoundHole[])
  const extra: FoundHole[] = []
  found.forEach((f, j) => {
    if (used.has(j)) return
    let best = -1
    planned.forEach((h, k) => {
      const off = Math.abs(f.diameterMm - h.diameter * scale)
      if (off <= HOLE_MM && (best < 0 || off < Math.abs(f.diameterMm - planned[best]!.diameter * scale))) best = k
    })
    if (best >= 0) surplus[best]!.push(f)
    else extra.push(f)
  })
  return { rows: planned.map((hole, k) => ({ hole, found: taken[k]!.sort((a, b) => a - b).map((j) => found[j]!), surplus: surplus[k]! })), extra }
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
  /** How many design.check runs against this plan failed; absent for none. */
  failedChecks?: number
  /** The check that used up the fix round, once it has; later checks of the plan return it without measuring again. */
  closed?: { summary: string; output: Record<string, unknown> }
}

/**
 * Fix rounds a plan gets after a failed design.check: one. The check after it that fails too is the last; it says to
 * stop building and tell the person what is off.
 */
export const FIX_ROUNDS = 1

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
  /** Counts a design.check of a kept plan; returns how many of its checks have failed (0 when there is no such plan). */
  checked(planId: string, pass: boolean): number
  /** Keeps the check that used up a plan's fix round, for every later check of it to return. */
  close(planId: string, last: { summary: string; output: Record<string, unknown> }): void
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
      const p = tidyPlan(partPlanSchema.parse(plan))
      if (origin === 'client' && plans.get(p.planId)?.origin === 'card') throw new PlanOwnedError(p.planId)
      // the same planId put again is the same plan: its failed checks, and a used fix round, carry over
      const was = plans.get(p.planId)
      const counts = { ...(was?.failedChecks ? { failedChecks: was.failedChecks } : {}), ...(was?.closed ? { closed: was.closed } : {}) }
      plans.delete(p.planId)
      plans.set(p.planId, design ? { plan: p, origin, design, ...counts } : { plan: p, origin, ...counts })
      const mine = [...plans.entries()].filter(([, e]) => e.origin === origin)
      for (let k = 0; k < mine.length - MAX_PLANS; k++) plans.delete(mine[k]![0])
    },
    tie(planId, design) {
      const entry = plans.get(planId)
      if (!entry) return false
      entry.design = design
      return true
    },
    checked(planId, pass) {
      const entry = plans.get(planId)
      if (!entry) return 0
      if (!pass) entry.failedChecks = (entry.failedChecks ?? 0) + 1
      return entry.failedChecks ?? 0
    },
    close(planId, last) {
      const entry = plans.get(planId)
      if (entry) entry.closed = last
    },
    get: (planId) => plans.get(planId),
    latest: (origin) => [...plans.values()].filter((e) => !origin || e.origin === origin).at(-1)?.plan,
    clear: () => plans.clear(),
  }
}
