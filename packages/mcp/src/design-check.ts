// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A built part checked against its plan: the overall size, each named hole, the feature count, a closed body, the
// thinnest wall the nozzle can print and, for a planned hook with a lip, a tip that rises. The comparison is pure; the facts about the body come from body-facts.ts. Plans
// wait in a registry under their planId until design.check reads them. Only zod and hook-lip.ts (which imports nothing)
// here, so any package can import the
// plan and result shapes.
import { SIZE_KINDS } from '@slicerx/contracts/size-kind'
import { z } from 'zod'
import { LIP_RISE_MM } from './hook-lip'

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

/** The assumptions a plan is given with; the card keeps one more, its own line for pieces that print together (PRINTS_TOGETHER). */
export const ASSUMPTIONS_MAX = 12
export const assumptionsInput = z.array(text(200)).max(ASSUMPTIONS_MAX)

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
  assumptions: z.array(text(200)).max(ASSUMPTIONS_MAX + 1),
  questions: z.array(text(200)).max(6),
  /**
   * Marks a print-in-place part: design.check then measures its pieces and the gaps between them. false says the pieces
   * print separately, so the card never reads the plan as print-in-place (printsTogether).
   */
  printInPlace: z
    .union([z.array(text(60)).min(2).max(30), z.literal(false)])
    .optional()
    .describe('Pieces that print assembled and move, by name (such as Lid and Tray, Sun and Planet 1, or Segment 1 to Segment 8); false if they print separately'),
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
  /** The pieces and the gaps between them, read only for a print-in-place plan. */
  fit?: FitFacts | undefined
  /** Why the gaps were not measured, when the fit check failed. */
  fitWhy?: string | undefined
  /**
   * Read only for a plan with a hook and a lip (hasHookLip), from the part's upright stem (hook-lip.ts): how far the
   * hook's tip rises above the hook's lowest point toward its end, in mm, or null when nothing reaches out past the
   * stem. Absent when it was not read, or when the part has no upright round stem to read a hook from.
   */
  hookTipRiseMm?: number | null | undefined
}

type V3 = [number, number, number]

/** The smallest gaps moving pieces keep, per side, from the fit rule for this printer and material. */
export interface FitLimits {
  /** Between side walls. */
  sideMm: number
  /** Between a face and the one printed over it. */
  verticalMm: number
  material: string
  nozzleMm: number
  layerHeightMm: number
}

/** A gap between two bodies, as the engine's fit check (fit.check) finds it. */
export interface FitGap {
  /** The two bodies, by index into FitFacts.bodies. */
  bodies: [number, number]
  /** fused: they touch or overlap; apart: a gap at least the limit, the closest of two pieces. */
  kind: 'horizontal' | 'vertical' | 'fused' | 'apart'
  gapMm: number
  limitMm: number
  from: V3
  to: V3
  /** Where a touch is, in words, such as "on the top face of Tray". */
  where?: string | undefined
  /** Which way the gap runs: xy between side walls, z above and below. */
  direction: 'xy' | 'z'
  /** A gap above or below under a flat bottom face, over a level top face (one as narrow as a rail counts): no facet allowance. */
  flat?: true | undefined
}

/** The bodies of a design and the gaps between them. */
export interface FitFacts {
  limits: FitLimits
  /**
   * Each body, with the part it is in, the name it goes by and its part's name; `array` when an array of separate
   * copies made its part (n 2 and up) or copied it (n 1), with the name of the part copied.
   */
  bodies: { part: number; name: string; partName?: string | undefined; array?: { of: string; n: number } | undefined }[]
  /** Bodies that touch print as one piece: how many separate pieces print. */
  pieces: number
  /** Touches and gaps under the limits, then the closest gap of each two pieces within NEAR_MM. */
  gaps: FitGap[]
}

/** Pieces of a print-in-place part this far apart or more do not meet: it is a kit of parts, not one assembly. */
export const NEAR_MM = 2

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

/** The thinnest wall a nozzle prints reliably: two lines side by side. design.check holds the body to it, and a plan's walls and pins are raised to it (plan-floors.ts). */
export const minWallFor = (nozzleMm: number): number => 2 * nozzleMm

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

/** The words of a plan's feature names, kinds and size names: "Soft lip", "lip_height" and "curved hook" give soft, lip, height, curved and hook. */
function planWords(plan: PartPlan): Set<string> {
  const words = plan.features.flatMap((f) => [f.name, f.kind ?? '', ...Object.keys(f.sizes)])
  return new Set(words.flatMap((w) => w.toLowerCase().split(/[^a-z]+/)).filter(Boolean).map(single))
}

/** Whether a plan has a hook with a lip: a hook in its features and a lip in their names, kinds or sizes. */
export function hasHookLip(plan: PartPlan): boolean {
  const words = planWords(plan)
  return words.has('hook') && words.has('lip')
}

/**
 * Checks a body against its plan. Inch plans are compared in mm; the tolerances are in mm. The overall size is
 * compared axis by axis, since z is the print height: x and y swapped passes (the part turned on the bed prints the
 * same), and other swaps fail with a note to rotate it. With `holes` in the plan, a hole the plan does not have fails.
 * A nozzle that is not a positive finite number counts as 0.4 mm. A feature's own sizes are never held to the body, so
 * a count or an angle among them (@slicerx/contracts/size-kind) never fails an item, in mm or inches. `together` marks a
 * plan whose pieces print together without printInPlace naming them (printsTogether): its planned gaps are held to
 * `limits` too.
 * A plan with a hook and a lip (hasHookLip) holds the hook's tip to a rise of LIP_RISE_MM when the body's hook was read.
 */
export function designCheck(plan: PartPlan, body: BodyFacts, nozzleMm: number, limits?: FitLimits, together = false): CheckResult {
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
  const wall = minWallFor(nozzle)
  const unmeasured = body.minWallWhy ? `not measured (${body.minWallWhy})` : 'not measured'
  items.push({ name: 'minimum wall', want: `at least ${mm(wall)} (twice the ${mm(nozzle)} nozzle)`, got: body.minWallMm === null ? unmeasured : mm(body.minWallMm), pass: body.minWallMm !== null && body.minWallMm >= wall - 1e-6 })
  if (plan.printInPlace) items.push(...fitItems(plan.printInPlace, body))
  // the gaps the plan sets, held to the same limits as the gaps measured; a plan whose pieces print together without
  // naming them (printsTogether) gets this item alone, as it names no pieces to measure
  const gapLimits = limits ?? body.fit?.limits
  if ((plan.printInPlace || together) && gapLimits) {
    const gaps = plannedGaps(plan, gapLimits)
    const under = gaps.filter((g) => !g.pass)
    if (gaps.length) items.push({ name: 'planned gaps', want: `every gap the plan sets ${gapLimitsText(gapLimits)}`, got: under.length ? under.map((g) => g.text).join('; ') : gaps.map((g) => g.text).join(', '), pass: !under.length })
  }
  // a hook with a lip ends in a tip that rises, so what hangs on it does not slide off the end
  if (hasHookLip(plan) && body.hookTipRiseMm !== undefined) {
    const rise = body.hookTipRiseMm
    items.push({
      name: 'hook lip',
      want: `the hook's tip rises at least ${mm(LIP_RISE_MM)} above the hook's lowest point toward its end`,
      got: rise === null ? 'no hook reaches out past the stem' : `rises ${mm(Math.max(0, rise))}`,
      pass: rise !== null && rise >= LIP_RISE_MM,
    })
  }

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

/** A gap as a reply writes it: 0.0, 0.2, 0.25 mm. */
export const gapMm = (v: number): string => {
  const c = Math.round(v * 100)
  return `${(c / 100).toFixed(c % 10 === 0 ? 1 : 2)} mm`
}
const listAnd = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)
const at = (p: V3): string => `(${p.map((c) => Math.round(c * 10) / 10).join(', ')})`
/** Tight gaps a reply names one by one; the rest are counted. */
const NAMED_GAPS = 3

/** A touch or tight gap in plain words: "Lid and Tray touch on the top face of Tray, 0.0 mm; <needs> 0.6 mm or more". */
export function gapSentence(fit: FitFacts, g: FitGap, needs: string): string {
  const name = (b: number): string => fit.bodies[b]?.name ?? `body ${b + 1}`
  // the limit fitFacts held this gap to, for its direction
  const need = g.limitMm
  const where = g.where ? ` ${g.where}` : g.kind === 'fused' ? '' : ` ${g.direction === 'z' ? 'above and below' : 'side by side'} at ${at(g.from)}`
  const what = g.kind === 'fused' ? `touch${where}, ${gapMm(0)}` : `are ${gapMm(g.gapMm)} apart${where}`
  return `${name(g.bodies[0])} and ${name(g.bodies[1])} ${what}; ${needs} ${mm(need)} or more`
}

/** A size key's words: print_gap, printGap and print-gap all read print, gap. */
export const keyWords = (key: string): string[] => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/**
 * The words that say which way a gap runs (a gap named neither way is on every face), and those that make a size with
 * gap or clearance in its name no gap: a screw's clearance hole, a bore, a count. The long way words also count inside
 * a word run together, such as verticalgap.
 */
const UP_WORDS: ReadonlySet<string> = new Set(['vertical', 'z', 'above', 'below', 'top', 'bottom', 'under', 'over', 'cap'])
const SIDE_WORDS: ReadonlySet<string> = new Set(['side', 'sides', 'xy', 'horizontal', 'radial', 'lateral'])
const NOT_GAP_WORDS: ReadonlySet<string> = new Set(['hole', 'holes', 'diameter', 'dia', 'bore', 'count'])

/**
 * Which way a planned size named as a gap runs, by its name: xy side by side, z above or below, both when the name
 * says neither (such a gap is on every face where pieces meet, so print_gap and joint_gap are held to the larger gap),
 * or null for a size that is no gap. A size is a gap when its key has gap or clearance in it (print_gap, jointGap,
 * hinge_clearance), unless a word of it says it is a hole, bore or count (hole_clearance is a screw's hole). The
 * sheet's gap rows' keys read as they mean: clearance side by side, clearance_vertical above or below.
 */
export function gapWay(key: string): 'xy' | 'z' | 'both' | null {
  const flat = key.trim().toLowerCase()
  const words = keyWords(key)
  if (!/gap|clearance/.test(flat) || words.some((w) => NOT_GAP_WORDS.has(w))) return null
  if (words.some((w) => UP_WORDS.has(w)) || /vertical|above|below/.test(flat)) return 'z'
  if (words.some((w) => SIDE_WORDS.has(w)) || /horizontal|radial|lateral/.test(flat) || flat === 'clearance') return 'xy'
  return 'both'
}

/** The line the card puts first among the assumptions of a plan whose pieces print together without printInPlace. */
export const PRINTS_TOGETHER = 'These pieces print together, so their gaps follow the fit rule'

/** The words that name pieces, and those that count them. */
const PIECE_WORDS: ReadonlySet<string> = new Set(['segment', 'segments', 'link', 'links', 'piece', 'pieces', 'part', 'parts', 'body', 'bodies', 'planet', 'planets', 'gear', 'gears'])
const COUNT_WORDS: ReadonlySet<string> = new Set(['count', 'number', 'num'])

/**
 * How many pieces a planned size counts: its value, a whole number of 2 or more, when its key names pieces and counts
 * them (segment_count, number_of_links, planet_count) or names them in the plural as its last word (tail_segments,
 * links); else 0. A count of anything else on one piece (count, fin_count, slot_count, teeth) counts no pieces.
 */
export function pieceCount(key: string, value: number): number {
  if (!Number.isInteger(value) || value < 2) return 0
  const words = keyWords(key)
  if (!words.some((w) => PIECE_WORDS.has(w))) return 0
  const last = words[words.length - 1]!
  return words.some((w) => COUNT_WORDS.has(w)) || (PIECE_WORDS.has(last) && last.endsWith('s')) ? value : 0
}

/** Printing the pieces separately, as a plan says it: printed separately, print them separately, printed as separate pieces. */
const SEPARATELY = /\b(?:print|prints|printed|printing)\s+(them\s+)?(?:separately|as\s+separate\s+(?:pieces|parts|bodies))\b/g
/** Words before it that make it the pieces': they, each, all, the pieces. */
const MANY_WORDS: ReadonlySet<string> = new Set([...[...PIECE_WORDS].filter((w) => w.endsWith('s')), 'they', 'them', 'all', 'each', 'every', 'both'])
/** Words just before it that make it no statement: not printed separately, could be printed separately. */
export const HEDGE_WORDS: ReadonlySet<string> = new Set(['not', 'never', 'no', 'without', 'cannot', 'can', 'could', 'may', 'might', 'or', 'if', 'whether', 'instead'])

/**
 * True when a plan's text says its pieces print separately: "The links are printed separately", "Each segment is
 * printed separately", "Print them separately", "All pieces print as separate pieces". Read in its own clause: one of
 * they, them, each, all, every, both or a plural piece word (links, segments) comes before it, and none of not, never,
 * no, without, can, could, may, might, or, if, whether or a word ending in n't is among the three words just before
 * it. So "the end cap is printed separately", "the links are not printed separately", "could be printed separately"
 * and "each segment is a separate piece" say nothing of the kind.
 */
export function saysSeparately(text: string): boolean {
  const t = text.toLowerCase()
  for (const m of t.matchAll(SEPARATELY)) {
    const before = (t.slice(0, m.index).split(/[.;:,!?()]/).pop() ?? '').split(/\s+/).filter(Boolean)
    if (before.slice(-3).some((w) => HEDGE_WORDS.has(w) || /n['\u2019]t$/.test(w))) continue
    if (m[1] || before.some((w) => MANY_WORDS.has(w))) return true
  }
  return false
}

/**
 * Whether a plan's pieces print together though printInPlace does not name them, read from the plan's fields: two or
 * more pieces, counted by a size (pieceCount), and a size that is a gap (gapWay). A plan with printInPlace false, or
 * whose part name or an assumption says the pieces print separately (saysSeparately), is not; its questions are not
 * read, since a question says nothing yet. A plan whose printInPlace names its pieces prints in place anyway.
 */
export function printsTogether(plan: Pick<PartPlan, 'part' | 'features' | 'assumptions' | 'printInPlace'>): boolean {
  if (plan.printInPlace !== undefined) return false
  const sizes = plan.features.flatMap((f) => Object.entries(f.sizes))
  if (!sizes.some(([k, v]) => pieceCount(k, v) >= 2) || !sizes.some(([k]) => gapWay(k))) return false
  return ![plan.part, ...plan.assumptions].some(saysSeparately)
}

/** The limits in words: "at least 0.3 mm side by side and 0.4 mm above or below (PLA, 0.4 mm nozzle, 0.2 mm layers)". */
export const gapLimitsText = (l: FitLimits): string => `at least ${mm(l.sideMm)} side by side and ${mm(l.verticalMm)} above or below (${l.material.toUpperCase()}, ${mm(l.nozzleMm)} nozzle, ${mm(l.layerHeightMm)} layers)`

/**
 * Each size a plan names as a gap, held to the fit rule's limit for its way (the larger for a gap on every face), in
 * words: "print_gap of Spinner: gap 0.3 mm (vertical) is under the 0.4 mm this printer needs between moving parts; use
 * 0.4 mm", or "clearance 0.3 mm (side)" when it clears. Inch sizes are held in mm.
 */
export function plannedGaps(plan: PartPlan, limits: FitLimits): { pass: boolean; text: string }[] {
  const scale = plan.units === 'in' ? MM_PER_IN : 1
  const out: { pass: boolean; text: string }[] = []
  for (const f of plan.features) {
    for (const [key, v] of Object.entries(f.sizes)) {
      const way = gapWay(key)
      if (!way) continue
      const z = way === 'z' || (way === 'both' && limits.verticalMm >= limits.sideMm)
      const need = z ? limits.verticalMm : limits.sideMm
      const got = v * scale
      const dir = z ? 'vertical' : 'side'
      const pass = got >= need - 1e-6
      out.push({ pass, text: pass ? `${key} ${gapMm(got)} (${dir})` : `${key} of ${f.name}: gap ${gapMm(got)} (${dir}) is under the ${mm(need)} this printer needs between moving parts; use ${mm(need)}` })
    }
  }
  return out
}

/** Pieces items that failed only on how a part holding several pieces is named (fitItems): a miss that is not the part's fault. */
const NAMING_MISS = new WeakSet<CheckItem>()

/** Whether a failed item failed only on a part's name, which a model can fix by naming it, not by changing the part. */
export const isNamingMiss = (item: CheckItem): boolean => NAMING_MISS.has(item)

/**
 * The print-in-place items: pieces (as many separate bodies as the plan names, none fused or merged into another)
 * and gaps (every gap between moving pieces at least the fit rule's limit, and every piece near another).
 */
export function fitItems(pieces: readonly string[], body: BodyFacts): CheckItem[] {
  const want = `${pieces.length} separate pieces (${pieces.join(', ')})`
  const fit = body.fit
  if (!fit) {
    // the engine's or the link's own words stay in body.fitWhy, for logs; the item says it plainly
    const got = 'not measured (the gap check could not run)'
    return [
      { name: 'pieces', want, got, pass: false },
      { name: 'gaps', want: 'the gaps between moving pieces measured', got, pass: false },
    ]
  }
  const { limits } = fit
  const name = (b: number): string => fit.bodies[b]?.name ?? `body ${b + 1}`
  const pair = (g: FitGap): string => `${name(g.bodies[0])} and ${name(g.bodies[1])}`
  const fused = fit.gaps.filter((g) => g.kind === 'fused')

  // pieces: the plan's count, each a body of its own, by the plan's names
  const { missing, free, answered, copied, answeredBy } = unmatched(pieces, fit.bodies)
  // bodies of one part (a mirrored leaf, an arrayed link) go by their part's name with a number, and no tool names a
  // body on its own: with the count right, names left over are read as such bodies, one each, when every body left over
  // is one and its part answers no other name (else a piece merged into another would pass as a mirrored body)
  const bodiesIn = new Map<number, number>()
  for (const b of fit.bodies) bodiesIn.set(b.part, (bodiesIn.get(b.part) ?? 0) + 1)
  const shared = missing.length > 0 && free.length === missing.length && free.every((b) => (bodiesIn.get(fit.bodies[b]!.part) ?? 0) > 1 && !answered.has(fit.bodies[b]!.part))
  const named = fit.pieces === pieces.length && (!missing.length || shared)
  // the same bodies with their part answering a name too: a mirrored leaf whose part is named for one leaf, or a piece
  // merged into another beside a mirrored part. The names cannot tell them apart, so it fails, saying how to name it
  const standIn = fit.pieces === pieces.length && !shared && missing.length > 0 && free.length === missing.length && free.every((b) => (bodiesIn.get(fit.bodies[b]!.part) ?? 0) > 1 && answered.has(fit.bodies[b]!.part))
  // every body left over a part of its own, as many as the names left over, with the count right: only the names are
  // off, which the model fixes by naming the parts, not by rebuilding them
  const renameOnly = fit.pieces === pieces.length && !shared && !standIn && missing.length > 0 && free.length === missing.length && free.every((b) => bodiesIn.get(fit.bodies[b]!.part) === 1)
  let got: string
  // names an array copy answers by its place in the row, said so, as the bodies of one part are
  const sources = [...new Set(copied.map(([, b]) => fit.bodies[b]!.array!.of))]
  const byCopy = copied.length ? `${listAnd(copied.map(([p]) => p))} ${copied.length === 1 ? 'is' : 'are'} ${listAnd(copied.map(([, b]) => name(b)))}, in the array of ${listAnd(sources)}` : ''
  if (fit.pieces === pieces.length && shared) {
    const of = new Set(free.map((b) => fit.bodies[b]!.part)).size === 1 ? 'bodies of one part' : 'bodies of parts that hold several'
    got = `${fit.pieces} pieces (${byCopy ? `${byCopy}; ` : ''}${listAnd(missing)} ${missing.length === 1 ? 'is' : 'are'} ${listAnd(free.map(name))}, ${of})`
  } else if (standIn) {
    const parts = [...new Set(free.map((b) => fit.bodies[b]!.part))]
    const whose = parts.map((k) => `${fit.bodies.find((b) => b.part === k)!.partName ?? `part ${k + 1}`} (${listAnd(answeredBy.get(k) ?? [])})`)
    got = `${fit.pieces} pieces, but ${listAnd(missing)} ${missing.length === 1 ? 'is' : 'are'} not among them: ${listAnd(free.map(name))} ${free.length === 1 ? 'is another body' : 'are other bodies'} of ${listAnd(whose)}, which already ${parts.length === 1 ? 'answers' : 'answer'} a piece's name. Bodies of one part take the plan's names only when the part's own name is none of them: build that part under a name that is no piece's and check again, or make each piece a part of its own`
  } else if (renameOnly) {
    const pairs = renames(missing, free.map(name))
    const off = pairs.map(([p, b]) => `${b} is not named ${p}`)
    const rest = free.map(name).filter((b) => !pairs.some(([, x]) => x === b))
    if (rest.length) off.push(`${pairs.length ? 'the other pieces left over are' : rest.length === 1 ? 'the piece left over is' : 'the pieces left over are'} ${listAnd(rest)}`)
    const one = missing.length === 1
    got = `${fit.pieces} pieces, but ${listAnd(missing)} ${one ? 'is' : 'are'} not among them: ${off.join('; ')}. ${one ? 'It is a piece' : 'Each is a piece'} of its own, so only the ${one ? 'name is' : 'names are'} off: give ${one ? 'the part its plan name' : rest.length ? "each part one of the plan's names" : 'each part its plan name'} and check again, without changing its shape`
  } else if (fit.pieces === pieces.length && missing.length) got = `${fit.pieces} pieces, but ${listAnd(missing)} ${missing.length === 1 ? 'is' : 'are'} not among them (the bodies are ${listAnd(fit.bodies.map((b) => b.name))}); name each piece as the plan does`
  else if (fit.pieces === pieces.length) got = `${fit.pieces} pieces${byCopy ? ` (${byCopy})` : ''}`
  else if (fit.pieces < pieces.length) {
    const known = new Set(fit.bodies.flatMap((b) => [b.name, ...(b.array ? [copyName(b.array)] : [])]).map((n) => n.trim().toLowerCase()))
    const merged = pieces.filter((p) => !known.has(p.trim().toLowerCase()))
    const told = fused.map((g) => `${pair(g)} touch${g.where ? ` ${g.where}` : ''}, so they print as one piece; leave the planned gap between them`)
    if (merged.length && fit.pieces === 1) told.push(`${listAnd([...merged, ...pieces.filter((p) => !merged.includes(p))])} are one piece; keep them as separate bodies`)
    else if (merged.length) told.push(`${listAnd(merged)} ${merged.length === 1 ? 'is' : 'are'} not a body of its own; keep each piece as a separate body`)
    got = `${fit.pieces} ${fit.pieces === 1 ? 'piece' : 'pieces'}${told.length ? `: ${told.join('; ')}` : `; keep each piece as a separate body`}`
  } else {
    const planned = new Set(pieces.map((p) => p.trim().toLowerCase()))
    const extra = fit.bodies.filter((b) => !planned.has(b.name.trim().toLowerCase()) && !(b.array && planned.has(copyName(b.array).toLowerCase()))).map((b) => b.name)
    got = `${fit.pieces} pieces, ${fit.pieces - pieces.length} more than planned${extra.length ? ` (${listAnd(extra)})` : ''}; join each loose body to the piece it belongs to`
  }
  const items: CheckItem[] = [{ name: 'pieces', want, got, pass: named }]
  if (standIn || renameOnly) NAMING_MISS.add(items[0]!)

  // gaps: every touch and tight gap, then pieces that meet no other piece
  const gapsWant = `at least ${mm(limits.sideMm)} side by side and ${mm(limits.verticalMm)} above or below between moving pieces (${limits.material.toUpperCase()}, ${mm(limits.nozzleMm)} nozzle, ${mm(limits.layerHeightMm)} layers)`
  const tight = fit.gaps.filter((g) => g.kind !== 'apart')
  const sentence = (g: FitGap): string => gapSentence(fit, g, 'this print-in-place plan needs')
  if (tight.length) {
    const more = tight.length - NAMED_GAPS
    items.push({ name: 'gaps', want: gapsWant, got: `${tight.slice(0, NAMED_GAPS).map(sentence).join('; ')}${more > 0 ? `; and ${more} more ${more === 1 ? 'gap' : 'gaps'} under the limit` : ''}`, pass: false })
    return items
  }
  if (fit.bodies.length < 2) {
    items.push({ name: 'gaps', want: gapsWant, got: 'no gaps: the part is one piece', pass: false })
    return items
  }
  // a piece no other comes near is not part of the assembly
  const near = new Set<number>()
  for (const g of fit.gaps) for (const b of g.bodies) near.add(b)
  const alone = fit.bodies.map((_, b) => b).filter((b) => !near.has(b))
  if (alone.length) {
    items.push({ name: 'gaps', want: gapsWant, got: `${listAnd(alone.map(name))} ${alone.length === 1 ? 'is' : 'are'} ${NEAR_MM} mm or more from every other piece; print-in-place pieces print assembled, ${mm(limits.sideMm)} apart where they meet`, pass: false })
    return items
  }
  const least = fit.gaps.reduce((a, g) => (g.gapMm < a.gapMm ? g : a))
  items.push({ name: 'gaps', want: gapsWant, got: `smallest gap ${gapMm(least.gapMm)}, between ${pair(least)}`, pass: true })
  return items
}

/**
 * Which body left over each missing plan name most likely is, for saying what to rename: a body whose name starts with
 * the plan name as whole words (Segment 1 head for Segment 1) when only one does, then the last name with the last body.
 * Matching stays exact; this only words the miss.
 */
function renames(missing: readonly string[], left: readonly string[]): [string, string][] {
  const key = (v: string): string => v.trim().toLowerCase()
  const out: [string, string][] = []
  const names = [...missing]
  const bodies = [...left]
  for (const p of missing) {
    const starts = bodies.filter((b) => key(b).startsWith(`${key(p)} `))
    if (starts.length !== 1 || missing.filter((q) => key(starts[0]!).startsWith(`${key(q)} `)).length !== 1) continue
    out.push([p, starts[0]!])
    names.splice(names.indexOf(p), 1)
    bodies.splice(bodies.indexOf(starts[0]!), 1)
  }
  if (names.length === 1 && bodies.length === 1) out.push([names[0]!, bodies[0]!])
  return missing.flatMap((p) => out.filter(([q]) => q === p))
}

/**
 * The name an array copy answers by its place in the row: the part copied ends in a number (Segment 1, Planet 1), so
 * its copy n is that number plus n - 1 (Segment 2, Planet 3); else the part's name and n (Foot 1 for the part itself,
 * Foot 2 for the copy geom.array named so).
 */
export function copyName(a: { of: string; n: number }): string {
  const m = /^(.*\S)\s+(\d+)$/.exec(a.of.trim())
  return m ? `${m[1]} ${Number(m[2]) + a.n - 1}` : `${a.of.trim()} ${a.n}`
}

/**
 * The plan's piece names no body answers to, one body per name: a body's own name ("Pin 2", "Pin (part 3)") first, then
 * its part's name, then the name its place in an array gives it (copyName), without regard to case; the bodies no name
 * took; the parts whose bodies took a name; and the names taken by place in an array, with their bodies.
 */
function unmatched(pieces: readonly string[], bodies: FitFacts['bodies']): { missing: string[]; free: number[]; answered: Set<number>; copied: [string, number][]; answeredBy: Map<number, string[]> } {
  const key = (v: string): string => v.trim().toLowerCase()
  const free = new Set(bodies.map((_, b) => b))
  const answered = new Set<number>()
  const answeredBy = new Map<number, string[]>()
  const take = (p: string, of: (b: FitFacts['bodies'][number]) => string | undefined): number | undefined => {
    const b = [...free].find((k) => of(bodies[k]!) !== undefined && key(of(bodies[k]!)!) === key(p))
    if (b === undefined) return undefined
    free.delete(b)
    answered.add(bodies[b]!.part)
    answeredBy.set(bodies[b]!.part, [...(answeredBy.get(bodies[b]!.part) ?? []), p])
    return b
  }
  const left = pieces.filter((p) => take(p, (b) => b.name) === undefined).filter((p) => take(p, (b) => b.partName) === undefined)
  const copied: [string, number][] = []
  const missing = left.filter((p) => {
    const b = take(p, (x) => (x.array ? copyName(x.array) : undefined))
    if (b !== undefined) copied.push([p, b])
    return b === undefined
  })
  return { missing, free: [...free], answered, copied, answeredBy }
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
  /** Its last check failed and its part has not been rebuilt as a new design since: the next check may follow one. */
  replaceable?: true
  /** The designs open when its last check failed: a rebuild to fix that check is a design none of these. */
  openAtFail?: string[]
  /** A check failed only on how a part was named, once, without using the fix round (waiveNaming). */
  namingWaived?: true

  /** The check that used up the fix round, once it has; later checks of the plan return it without measuring again. */
  closed?: { summary: string; output: Record<string, unknown> }

  /**
   * The person changed sizes on a sheet after the plan was approved and before its part was built, so the plan no
   * longer says what to build: design.check refuses it and it ties to no design, until a new design.plan is answered.
   */
  stale?: true

  /**
   * A stale plan after a later design.plan was answered, approved or declined: its part no longer waits for it, and
   * design.check refuses it for good, since the person confirmed other sizes than it holds. It ties to no design.
   */
  superseded?: true

  /**
   * The design the mimir tab's chat started for the plan's part, which its build waits on while the plan is stale. Kept
   * apart from `design` (a stale plan ties to none), and design.check does not read it.
   */
  claimed?: string

  /** Its last design.check passed; a whole new design of its part is then refused (design.new). */
  passed?: true

  /** How many times the build changed the plan with an amend (plan-amend.ts), plus one: absent for the plan as first approved. */
  revision?: number
  /** The failed check count when it was last amended: one amend per fix round. */
  amendedAt?: number
  /** Why it was last amended, as the build said it. */
  amendWhy?: string
}

/**
 * The fit check (geom.fit_check) last run on a design: the design as it was then (designStamp) and the parts it
 * measured, every part or these. A print-in-place plan is checked only after one on the design as built.
 */
export interface FitCheckRun {
  stamp: string
  parts: 'all' | readonly number[]
}

/** design.check's answer for a stale plan a later plan's answer superseded (PlanEntry.superseded), naming no id or tool. */
export const supersededPlanNote = (part: string): string =>
  `Nothing was checked. The person changed sizes after the plan for ${part} was approved, and a newer plan has been answered since, so this plan no longer says what to build and is not checked. Check the part against the newer plan, or if the person turned it down, make a new plan with the confirmed sizes first.`

/**
 * design.check's answer for a plan whose sizes changed after it was approved (PlanEntry.stale), naming no id. On the
 * card's side (`card`, the mimir card's step row) it names no tool or plan field either.
 */
export const stalePlanNote = (part: string, card = false): string =>
  `Nothing was checked. The person changed sizes after the plan for ${part} was approved, so the part is not checked against it. ${card ? 'Make the plan again with the confirmed sizes and the same moving pieces' : 'Call design.plan again with the confirmed sizes and the same printInPlace'}, build from that plan and check against it.`

/**
 * Fix rounds a plan gets after a failed design.check: one. The check after it that fails too is the last; it says to
 * stop building and tell the person what is off.
 */
export const FIX_ROUNDS = 1

/**
 * What a failed check says while its plan's fix round is open: that this check is not the last, what to change and to
 * check again, so a reply does not stop on the first miss. It names no tool, as the mimir card's step row shows it too.
 */
export const fixRoundOpen = (planId: string): string =>
  `This is not the last check: the plan has one fix round, and it is open. Fix each failed item now (change the part until it has what the plan wants, or, for a planned size the build cannot keep, change the plan with amends), then check plan ${planId} again. Do not stop or ask the person yet; only a second failed check ends the building.`

/** Plans kept at most for each origin; putting one more drops the one of that origin put longest ago. */
export const MAX_PLANS = 50

/** Where plans wait for design.check, by planId. The plan card and design.put_plan put them here; tests and scripts may too. */
export interface PlanRegistry {
  /**
   * Keeps a plan (checked against the schema), replacing one with the same planId; `design` ties it to a design.
   * `origin` defaults to 'client'. A client plan whose planId belongs to a card plan is refused (throws).
   */
  put(plan: PartPlan, design?: string, origin?: PlanOrigin): void
  /**
   * Ties a kept plan to the design it was built in, for a plan made before the design; false when there is no such
   * plan, or it is stale (its part waits for a new plan) or superseded.
   */
  tie(planId: string, design: string): boolean
  /**
   * Ties a plan whose last check failed to the new design its part was rebuilt in, once: the next replacement waits for
   * another failed check. False when there is no such plan or it has no replacement left.
   */
  replace(planId: string, design: string): boolean
  /** The planIds of the kept plans tied to a design. */
  tiedTo(design: string): string[]
  /**
   * Counts a design.check of a kept plan; returns how many of its checks have failed (0 when there is no such plan). A
   * failed check lets the part be rebuilt as a new design once (replace), started after it: `open` is the designs open
   * then, which a rebuild is none of. A pass ends that.
   */
  checked(planId: string, pass: boolean, open?: readonly string[]): number
  /**
   * A check that failed only on how a part holding several pieces is named: the first one per plan leaves the fix round
   * alone and lets the part be rebuilt as a new design started after it (as a failed check does), and returns true.
   * False when there is no such plan or it had its one.
   */
  waiveNaming(planId: string, open: readonly string[]): boolean
  /** Keeps the check that used up a plan's fix round, for every later check of it to return. */
  close(planId: string, last: { summary: string; output: Record<string, unknown> }): void
  /** Marks a kept plan stale: sizes changed after it was approved. False when there is no such plan. */
  stale(planId: string): boolean
  /**
   * Turns a stale plan's mark into superseded, once a new plan for its part was answered (approved or declined): design.check
   * keeps refusing it. A plan that is not stale is left as it is.
   */
  supersede(planId: string): void
  /**
   * Counts an amend of a kept plan (plan-amend.ts), put already with its new sizes: its revision goes up by one, and no
   * other amend is taken before another check fails. Returns the new revision, or 0 for an unknown plan.
   */
  amended(planId: string, why: string): number
  /** Records the design the chat started for a kept plan's part, stale or not (PlanEntry.claimed); no-op for an unknown plan. */
  claim(planId: string, design: string): void
  /** Keeps the fit check just run on a design, replacing the one before. */
  fitChecked(design: string, run: FitCheckRun): void
  /** The fit check last run on a design, or undefined. */
  fitCheckOf(design: string): FitCheckRun | undefined
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
  const fits = new Map<string, FitCheckRun>()
  return {
    put(plan, design, origin = 'client') {
      const p = tidyPlan(partPlanSchema.parse(plan))
      if (origin === 'client' && plans.get(p.planId)?.origin === 'card') throw new PlanOwnedError(p.planId)
      // the same planId put again is the same plan: its failed checks, and a used fix round, carry over
      const was = plans.get(p.planId)
      const counts = { ...(was?.failedChecks ? { failedChecks: was.failedChecks } : {}), ...(was?.replaceable ? { replaceable: was.replaceable } : {}), ...(was?.openAtFail ? { openAtFail: was.openAtFail } : {}), ...(was?.namingWaived ? { namingWaived: was.namingWaived } : {}), ...(was?.closed ? { closed: was.closed } : {}), ...(was?.stale ? { stale: was.stale } : {}), ...(was?.superseded ? { superseded: was.superseded } : {}), ...(was?.claimed ? { claimed: was.claimed } : {}), ...(was?.revision ? { revision: was.revision } : {}), ...(was?.amendedAt !== undefined ? { amendedAt: was.amendedAt } : {}), ...(was?.amendWhy ? { amendWhy: was.amendWhy } : {}) }
      plans.delete(p.planId)
      plans.set(p.planId, design ? { plan: p, origin, design, ...counts } : { plan: p, origin, ...counts })
      const mine = [...plans.entries()].filter(([, e]) => e.origin === origin)
      for (let k = 0; k < mine.length - MAX_PLANS; k++) plans.delete(mine[k]![0])
    },
    tie(planId, design) {
      const entry = plans.get(planId)
      if (!entry || entry.stale || entry.superseded) return false
      entry.design = design
      return true
    },
    replace(planId, design) {
      const entry = plans.get(planId)
      if (!entry?.replaceable) return false
      entry.design = design
      delete entry.replaceable
      delete entry.openAtFail
      return true
    },
    tiedTo: (design) => [...plans.values()].filter((e) => e.design === design).map((e) => e.plan.planId),
    checked(planId, pass, open) {
      const entry = plans.get(planId)
      if (!entry) return 0
      if (pass) {
        delete entry.replaceable
        delete entry.openAtFail
        entry.passed = true
      } else {
        delete entry.passed
        entry.failedChecks = (entry.failedChecks ?? 0) + 1
        entry.replaceable = true
        if (open) entry.openAtFail = [...open]
        else delete entry.openAtFail
      }
      return entry.failedChecks ?? 0
    },
    waiveNaming(planId, open) {
      const entry = plans.get(planId)
      if (!entry || entry.namingWaived) return false
      entry.namingWaived = true
      entry.replaceable = true
      entry.openAtFail = [...open]
      return true
    },
    close(planId, last) {
      const entry = plans.get(planId)
      if (entry) entry.closed = last
    },
    stale(planId) {
      const entry = plans.get(planId)
      if (!entry) return false
      entry.stale = true
      return true
    },
    supersede(planId) {
      const entry = plans.get(planId)
      if (!entry?.stale) return
      delete entry.stale
      entry.superseded = true
    },
    amended(planId, why) {
      const entry = plans.get(planId)
      if (!entry) return 0
      entry.revision = (entry.revision ?? 1) + 1
      entry.amendedAt = entry.failedChecks ?? 0
      entry.amendWhy = why
      return entry.revision
    },
    claim(planId, design) {
      const entry = plans.get(planId)
      if (entry) entry.claimed = design
    },
    fitChecked: (design, run) => void fits.set(design, { stamp: run.stamp, parts: run.parts === 'all' ? 'all' : [...run.parts] }),
    fitCheckOf: (design) => fits.get(design),
    get: (planId) => plans.get(planId),
    latest: (origin) => [...plans.values()].filter((e) => !origin || e.origin === origin).at(-1)?.plan,
    clear: () => {
      plans.clear()
      fits.clear()
    },
  }
}
