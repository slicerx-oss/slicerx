// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How much detail a plan carries: basic, display or fine. A model of a real thing named with no sizes ("design me a
// sailboat") is planned at display by default, and the person's words pick basic ("simple", "nothing fancy") or fine
// ("detailed", "accurate"). The rules hold to the object, never to one kind of thing: each main body says whether the
// real thing is curved or flat-sided, a curved body is built through smooth sections (a loft, a revolve or a sweep),
// the proportions come from a lookup or a stated source, and a real object's repeated detail (windows,
// slats, vents) gets a pass by pattern. A flat-sided object (a house, a bookshelf) needs no loft. Each feature says its
// color as the real thing is painted, a body painted in two colors is split at its line, and a plan has enough features
// for its level, its length and its repeated details. design.plan on the mimir tab's card refuses a display or fine plan
// that breaks them, in words that say what to plan instead. design.check then holds each curved body's sections to
// change along its length in both directions across it (sectionsProblem), so one shape stretched along a length fails.
import { z } from 'zod'

export const DETAIL_LEVELS = ['basic', 'display', 'fine'] as const
export type DetailLevel = (typeof DETAIL_LEVELS)[number]

/** The fewest smooth sections a curved body is lofted or swept through, at each level that holds the rules. */
export const SECTIONS_FLOOR: Record<Exclude<DetailLevel, 'basic'>, number> = { display: 5, fine: 8 }

/**
 * The fewest features a plan at each level has: its main bodies, a feature for each color band, the parts above them
 * and a pass for each repeated detail. Fewer reads as a block with a few parts on it, not the real thing.
 */
export const FEATURES_FLOOR: Record<Exclude<DetailLevel, 'basic'>, number> = { display: 8, fine: 12 }
/** A long object (its longest overall side at least LONG_RATIO times its next) has its detail spread along its length: LONG_EXTRA more features. */
export const LONG_RATIO = 4
export const LONG_EXTRA = 2
/** Repeated details past this many add one feature each to the floor: each is built once, then patterned. */
const REPEATS_IN_FLOOR = 3

/** The level, in plain words, as the plan card names it. */
export const DETAIL_LABEL: Record<DetailLevel, string> = { basic: 'Basic', display: 'Display model', fine: 'Fine' }
/** What each level means, in a line the plan card shows under it. */
export const DETAIL_LINE: Record<DetailLevel, string> = {
  basic: 'Simple shapes, quick to build',
  display: 'Real proportions, curved bodies through smooth sections, repeated details patterned',
  fine: 'As display, with more sections and finer details',
}

const text = (max: number) => z.string().trim().min(1).max(max)

/**
 * How far a planned size may sit from its real size at scale, as a factor either way. A display model rounds and
 * thickens small parts so they print, so a round upright or a wheel 30 percent over scale passes; twice the scale does not.
 */
export const SCALE_SLACK = 1.35

/** The plan fields the detail level adds; each is optional in the shared plan, and the card's input asks for detail. */
export const planDetailFields = {
  detail: z
    .enum(DETAIL_LEVELS)
    .optional()
    .describe("How much detail: display for a real object named without sizes (the default), basic when the person asks for simple, basic or nothing fancy, fine when they ask for detailed or accurate. A plain functional part (a bracket, a box) is basic"),
  curved: z.array(text(60)).max(8).optional().describe('Display and fine: the features that build a main body whose real thing is curved (a hull, a fuselage, a car body, a bottle)'),
  flat: z.array(text(60)).max(8).optional().describe('Display and fine: the features that build a main body whose real thing is flat-sided (a house, a bookshelf, a box)'),
  proportions: text(200).optional().describe('Display and fine: where the proportions come from, a lookup or a stated source, such as "lookup: 4.5 m long, 1.8 m wide, scaled 1:25"'),
  repeats: z.array(text(60)).max(8).optional().describe('Display and fine: the real object\'s repeated details (windows, slats, vents), each built by a pattern; an empty list when it has none'),
  colors: z
    .record(text(60), text(40))
    .optional()
    .describe('Display and fine: each feature\'s color as the real thing is painted, by feature name, such as {"Lower hull": "red"}. A body the real thing paints in two or more colors (a waterline, a stripe, a trim line) is split at its line into one feature per color'),
  scale: z
    .union([z.number().positive(), z.string().trim().regex(/^(1\s*:\s*)?\d+(\.\d+)?$/, 'scale is N of 1:N, such as 25')])
    .optional()
    .describe('Display and fine: N of the scale 1:N against the real thing, such as 25 ("1:25" is taken too)'),
  real: z
    // each field checked by the refine, so a local model's shorter list can leave the whole field out (tab-tools.ts)
    .array(z.object({ feature: text(60).optional(), size: text(40).optional(), mm: z.number().positive().optional() }).refine((r) => r.feature !== undefined && r.size !== undefined && r.mm !== undefined, 'each real size gives feature, size and mm'))
    .max(40)
    .optional()
    .describe('Display and fine: the real sizes the lookup or the stated source gives, in mm at full size, each tied to the feature size it sets, such as {"feature": "Body", "size": "length", "mm": 4200}: the main body\'s and each part\'s it gives. Each is held to scale. An empty list when it gives none'),
  tiers: z
    .record(text(60), z.array(text(60)).min(1).max(12))
    .optional()
    .describe('Display and fine: each flat-sided main body\'s levels from the bottom up, each a planned feature, such as {"Deckhouse": ["Lower deck", "Upper deck"]}: a body the real thing builds in steps or stories lists each level, a single block only itself'),
}

/**
 * The level's first fields with no descriptions, for a local model's shorter tool list: they take exactly what the full
 * ones take. colors, scale, real and tiers are left out of what a local model is shown (tab-tools.ts), to keep a build
 * turn's room; none of them has a required field or a fixed value, the tool still takes them, and a display plan without
 * them is refused with what to send.
 */
export const bareDetailFields = {
  detail: z.enum(DETAIL_LEVELS).optional(),
  curved: z.array(z.string()).optional(),
  flat: z.array(z.string()).optional(),
  proportions: z.string().optional(),
  repeats: z.array(z.string()).optional(),
}

/** A plan as the detail rules read it. */
interface DetailPlan {
  features: readonly { name: string; kind?: string | undefined; sizes: Record<string, number> }[]
  detail?: DetailLevel | undefined
  curved?: readonly string[] | undefined
  flat?: readonly string[] | undefined
  proportions?: string | undefined
  repeats?: readonly string[] | undefined
  colors?: Readonly<Record<string, string>> | undefined
  scale?: number | string | undefined
  real?: readonly { feature?: string | undefined; size?: string | undefined; mm?: number | undefined }[] | undefined
  tiers?: Readonly<Record<string, readonly string[]>> | undefined
  overall?: { x: number; y: number; z: number } | undefined
}

/** A feature kind that builds through sections: a loft, a revolve or a sweep. */
const SMOOTH = /\b(loft|revolve|sweep)/i
/** A feature kind that repeats a detail: an array, a pattern or a mirror of one. */
const PATTERN = /\b(array|pattern)/i
/** A feature kind that is a single straight extrusion. */
const EXTRUDE = /\bextrude/i
/** A size that counts a loft's or sweep's sections. */
const SECTIONS = /section/i

/** The sections a feature names in its sizes (a size whose name has "section"), or null when it names none. */
function sectionCount(f: DetailPlan['features'][number]): number | null {
  const n = Object.entries(f.sizes).find(([k]) => SECTIONS.test(k))
  return n ? n[1] : null
}

/** How to build a curved body, in the words a refusal uses. */
const CURVED_HOW = (floor: number): string =>
  `a loft through ${floor} or more smooth sections along its length (a revolve when it is round about one axis, a sweep when it follows a path), with the section count as a size named sections`

/**
 * Why a display or fine plan does not hold the detail rules, in words that say what to plan instead; null when it
 * does, or when the plan is basic or names no level.
 */
export function detailProblem(plan: DetailPlan): string | null {
  const level = plan.detail
  if (!level || level === 'basic') return null
  const floor = SECTIONS_FLOOR[level]
  const name = DETAIL_LABEL[level].toLowerCase()
  const problems: string[] = []
  if (!plan.curved?.length && !plan.flat?.length)
    problems.push(`curved, flat: a ${name} plan names the features that build each main body, in curved when the real thing is curved and in flat when it is flat-sided`)
  const feature = (n: string) => plan.features.find((x) => x.name.trim().toLowerCase() === n.trim().toLowerCase())
  for (const n of plan.flat ?? []) if (!feature(n)) problems.push(`flat: ${n} is not a planned feature; name the feature that builds the body`)
  for (const n of plan.curved ?? []) {
    const f = feature(n)
    if (!f) {
      problems.push(`curved: ${n} is not a planned feature; name the feature that builds the body`)
      continue
    }
    const kind = f.kind ?? ''
    if (!SMOOTH.test(kind)) {
      const was = EXTRUDE.test(kind) ? 'as a single extrude' : `as ${kind || 'it is'}`
      problems.push(`${f.name} builds a curved body, so do not build it ${was}: plan it as ${CURVED_HOW(floor)}`)
      continue
    }
    if (/\brevolve/i.test(kind) && !/\b(loft|sweep)/i.test(kind)) continue
    const c = sectionCount(f)
    if (c === null || c < floor) problems.push(`${f.name} goes through ${c === null ? 'no stated number of' : c} sections; a ${name} plan lofts or sweeps a curved body through at least ${floor}, given as a size named sections`)
  }
  const least = featuresFloor(plan, level)
  if (plan.features.length < least.count)
    problems.push(`features: a ${name} plan of this object has at least ${least.count} features (${least.why}); this one has ${plan.features.length}. Add the real thing's parts you left out: each color band as its own feature, the parts that stand on the main body, and its smaller details, each repeated one built once and patterned`)
  const colors = Object.entries(plan.colors ?? {})
  if (!colors.length) problems.push(`colors: give each feature's color as the real thing is painted, such as {"Lower hull": "red"}; a body painted in two colors is split at its line into two features`)
  else {
    const colored = new Set<string>()
    for (const [name, color] of colors) {
      const f = feature(name)
      if (!f) {
        problems.push(`colors: ${name} is not a planned feature; name the feature the color is on`)
        continue
      }
      colored.add(name.trim().toLowerCase())
      if (TWO_COLORS.test(color)) problems.push(`colors: ${f.name} is ${color.trim()}; split it at its color line into one feature per color, so each prints in its own filament`)
    }
    for (const n of [...(plan.curved ?? []), ...(plan.flat ?? [])])
      if (feature(n) && !colored.has(n.trim().toLowerCase())) problems.push(`colors: say what color ${n} is`)
  }
  problems.push(...scaleProblems(plan, feature), ...massProblems(plan, feature), ...tierProblems(plan, feature))
  if (!plan.proportions?.trim()) problems.push(`proportions: say where the proportions come from, a lookup (web.lookup) or a stated source, such as "lookup: 4.5 m long, 1.8 m wide, scaled 1:25"`)
  if (plan.repeats === undefined) problems.push('repeats: list the real object\'s repeated details (windows, slats, vents), or give an empty list when it has none')
  else if (plan.repeats.length && !plan.features.some((f) => PATTERN.test(f.kind ?? '') || PATTERN.test(f.name)))
    problems.push(`repeats: ${plan.repeats.join(', ')} repeat on the real object, so plan at least one detail pass that builds one and patterns it (kind array or pattern)`)
  return problems.length ? `A ${name} plan was not shown. ${problems.join('. ')}. ${DETAIL_HELP}` : null
}

/** A color that names two or more: "red and black", "red/black", "red, white". */
const TWO_COLORS = /\band\b|[/,&+]/i

type FeatureOf = (name: string) => DetailPlan['features'][number] | undefined
const r1 = (v: number): number => Math.round(v * 10) / 10

/**
 * Each real size against its planned size at scale (proportions from the source): a planned size more than SCALE_SLACK
 * times its real size at scale, either way, is refused with the size the real one gives. Real sizes need a scale, and
 * a plan whose source gave sizes lists the main body's among them, so the scale is anchored on the thing itself.
 */
function scaleProblems(plan: DetailPlan, feature: FeatureOf): string[] {
  if (plan.real === undefined) return ['real: list the real sizes the lookup or the stated source gives (the main body\'s length, and each part it gives a size for), each with the feature size it sets, so the plan is held to them at scale; an empty list when it gives none']
  if (!plan.real.length) return []
  const n = typeof plan.scale === 'string' ? Number(plan.scale.split(':').pop()) : plan.scale
  if (!n) return ['scale: give N of the scale 1:N the real sizes are held to, such as 25']
  const out: string[] = []
  const bodies = new Set([...(plan.curved ?? []), ...(plan.flat ?? [])].map((b) => b.trim().toLowerCase()))
  if (bodies.size && !plan.real.some((r) => bodies.has((r.feature ?? '').trim().toLowerCase()))) out.push('real: give a main body\'s real size too (its length), so the scale is set by the thing itself')
  for (const r of plan.real) {
    const [name, size, mm] = [r.feature ?? '', r.size ?? '', r.mm ?? 0]
    const f = feature(name)
    if (!f) {
      out.push(`real: ${name} is not a planned feature`)
      continue
    }
    const key = Object.keys(f.sizes).find((k) => k.trim().toLowerCase() === size.trim().toLowerCase())
    if (!key) {
      out.push(`real: ${f.name} has no size named ${size}; tie the real size to one of its sizes (${Object.keys(f.sizes).join(', ')})`)
      continue
    }
    const want = mm / n
    const got = f.sizes[key]!
    if (want > 0 && (got > want * SCALE_SLACK || got < want / SCALE_SLACK))
      out.push(`${f.name} ${key} is ${r1(got)} mm, ${r1(got / want)} times the ${r1(want)} mm its real ${r1(mm)} mm gives at 1:${n}; size it from the real one`)
  }
  return out
}

/** A size's name read as the main way it measures across: a width, a length or a height. */
const WIDTH = /^(width|beam|breadth|diameter|d)$/i
const LENGTH = /^(length|long)$/i
const HEIGHT = /^(height|tall|depth)$/i

/**
 * The masses against each other: no part other than a main body is wider, longer or taller than the largest main body
 * that way (a round upright as wide as the main body, a wheel taller than the car body). Read from the sizes named width (or beam,
 * breadth, diameter), length and height.
 */
function massProblems(plan: DetailPlan, feature: FeatureOf): string[] {
  const bodies = [...(plan.curved ?? []), ...(plan.flat ?? [])].map(feature).filter((f): f is NonNullable<typeof f> => !!f)
  if (!bodies.length) return []
  const largest = (re: RegExp, fs: typeof bodies): number => Math.max(0, ...fs.flatMap((f) => Object.entries(f.sizes).filter(([k]) => re.test(k.trim())).map(([, v]) => v)))
  const out: string[] = []
  for (const f of plan.features) {
    if (bodies.includes(f)) continue
    for (const [re, way] of [[WIDTH, 'wide'], [LENGTH, 'long']] as const) {
      const body = largest(re, bodies)
      const part = largest(re, [f])
      if (body > 0 && part > body) out.push(`${f.name} is ${r1(part)} mm ${way}, more than the main body's ${r1(body)} mm; a part on the body is smaller than it, so size it from the real one`)
    }
    const tall = largest(HEIGHT, [f])
    if (plan.overall && tall > plan.overall.z) out.push(`${f.name} is ${r1(tall)} mm tall, more than the whole model's ${r1(plan.overall.z)} mm height`)
  }
  return out
}

/**
 * Each flat-sided main body states its levels from the bottom up (tiers), each a planned feature, so a body the real
 * thing builds in steps or stories is planned that way and not as one slab; a single block lists only itself.
 */
function tierProblems(plan: DetailPlan, feature: FeatureOf): string[] {
  const out: string[] = []
  const tiers = Object.entries(plan.tiers ?? {})
  const stated = new Set(tiers.map(([body]) => body.trim().toLowerCase()))
  for (const b of plan.flat ?? [])
    if (feature(b) && !stated.has(b.trim().toLowerCase()))
      out.push(`tiers: give the levels of ${b} from the bottom up; a body the real thing builds in steps or stories (a deckhouse, a stepped roof, a tower) lists each level as its own feature, a single block lists only itself`)
  for (const [body, levels] of tiers) {
    if (!feature(body)) out.push(`tiers: ${body} is not a planned feature`)
    for (const l of levels) if (!feature(l)) out.push(`tiers: ${l}, a level of ${body}, is not a planned feature; plan each level as its own feature`)
  }
  return out
}

/** The fewest features a display or fine plan has, and why, from its level, its overall proportions and its repeated details. */
export function featuresFloor(plan: Pick<DetailPlan, 'overall' | 'repeats'>, level: Exclude<DetailLevel, 'basic'>): { count: number; why: string } {
  const why = [`${FEATURES_FLOOR[level]} at ${DETAIL_LABEL[level].toLowerCase()}`]
  let count = FEATURES_FLOOR[level]
  const o = plan.overall
  if (o) {
    const [a, b] = [o.x, o.y, o.z].sort((p, q) => q - p) as [number, number, number]
    if (b > 0 && a >= LONG_RATIO * b) {
      count += LONG_EXTRA
      why.push(`${LONG_EXTRA} more for a long object, ${Math.round((a / b) * 10) / 10} times as long as its next size`)
    }
  }
  const more = Math.max(0, (plan.repeats?.length ?? 0) - REPEATS_IN_FLOOR)
  if (more) {
    count += more
    why.push(`${more} more for ${plan.repeats!.length} repeated details`)
  }
  return { count, why: why.join(', ') }
}

/**
 * The method a display or fine plan follows, for any object (a car body, a plane's fuselage, a bottle): a few
 * lines in the plan tool's description and in each refusal, never a recipe for one object.
 */
export const DETAIL_HELP =
  'How a display model is built: a curved body is a table of sections, each with the same number of points, spaced evenly along its length, its lowest point at or above z 0, with upright sides for the last bit at a deck or roof edge so no knife edge is left. The sections change along the length as the real thing does, in both directions across it: narrower toward the ends, and their top and bottom rising or falling (the sheer of a deck, a keel rising toward the ends, a hood lower than a roof); one outline stretched only in width is a box, and the check fails it. Each color band of the real thing (a waterline, a stripe, a trim line) is its own part, split at its line, so paint follows the shape. Sizes of the parts on it (decks, chimneys, wheels) follow the looked-up proportions at the scale the plan gives, not a guess: give the real sizes in real, and a part more than about a third off its real size at scale is refused. A body the real thing builds in steps or stories is planned as its levels, each its own feature, smaller as it rises where the real one is. Stack each level on the one below, sunk about 0.1 mm into it. Keep repeated detail (windows) at least two nozzle widths from edges and from each other. A tapered or raked round part (a funnel, a chimney, a leg) is a loft between two ellipses, offset for the rake, then arrayed. Repeated small parts are one part, then array and mirror'

/** A loft step's sections as the check reads them: the feature it was tagged with, and each section's world bounds. */
export interface LoftSections {
  feature: string | null
  /** Each section's lowest and highest point on x, y and z, in loft order. */
  sections: { lo: [number, number, number]; hi: [number, number, number] }[]
  /** The way the loft runs: the mean of its sections' plane normals. */
  along: [number, number, number]
}

type V2 = readonly number[]
type Frame = { origin: V2; u: V2; v: V2; normal?: V2 }
const BED_FRAME: Frame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] }

/** The 2D points that outline a loop as stored in a step (points, a spline's points, a circle's four extremes, segment ends). */
function loopPoints(l: Record<string, unknown>): number[][] {
  if (Array.isArray(l['points'])) return l['points'] as number[][]
  if (l['type'] === 'circle' && Array.isArray(l['center']) && typeof l['diameterMm'] === 'number') {
    const [x, y] = l['center'] as number[]
    const r = (l['diameterMm'] as number) / 2
    return [[x! - r, y!], [x! + r, y!], [x!, y! - r], [x!, y! + r]]
  }
  if (Array.isArray(l['start']) && Array.isArray(l['segments']))
    return [l['start'] as number[], ...(l['segments'] as Record<string, unknown>[]).flatMap((g) => (Array.isArray(g['to']) ? [g['to'] as number[]] : []))]
  return []
}

/** The sections of every loft step in a design's history, each with the feature it was tagged with. */
export function loftSections(steps: readonly { params: Record<string, unknown>; feature?: string | undefined; suppressed?: boolean | undefined }[]): LoftSections[] {
  const out: LoftSections[] = []
  for (const st of steps) {
    if (st.suppressed || st.params['op'] !== 'sketch.loft' || !Array.isArray(st.params['profiles'])) continue
    const along = [0, 0, 0] as [number, number, number]
    const sections = (st.params['profiles'] as Record<string, unknown>[]).flatMap((pr) => {
      const f = (pr['frame'] as Frame | undefined) ?? BED_FRAME
      const lo = [Infinity, Infinity, Infinity] as [number, number, number]
      const hi = [-Infinity, -Infinity, -Infinity] as [number, number, number]
      for (const l of (pr['loops'] as Record<string, unknown>[] | undefined) ?? []) {
        if (l['construction']) continue
        for (const q of loopPoints(l))
          for (let k = 0; k < 3; k++) {
            const w = f.origin[k]! + f.u[k]! * q[0]! + f.v[k]! * q[1]!
            lo[k] = Math.min(lo[k]!, w)
            hi[k] = Math.max(hi[k]!, w)
          }
      }
      const n = f.normal ?? [f.u[1]! * f.v[2]! - f.u[2]! * f.v[1]!, f.u[2]! * f.v[0]! - f.u[0]! * f.v[2]!, f.u[0]! * f.v[1]! - f.u[1]! * f.v[0]!]
      for (let k = 0; k < 3; k++) along[k] = along[k]! + Math.abs(n[k]!)
      return Number.isFinite(lo[0]) ? [{ lo, hi }] : []
    })
    out.push({ feature: st.feature?.trim() || null, sections, along })
  }
  return out
}

/** A section's top, bottom or side moving less than this share of the body's largest cross size is no change. */
export const SECTION_CHANGE = 0.03

/**
 * Why a curved body lofted through these sections reads as one outline stretched along its length, or null when it does
 * not. That is a body whose sections grow or shrink across one of the two directions the loft does not run along while
 * their lowest and highest points across the other stay put (by SECTION_CHANGE of the body's largest cross size): a
 * body whose sections all stand from the same bottom to the same top, only narrower toward the ends, is a box with
 * pointed ends. A real body's bottom or top line rises toward its ends too, and a fuselage tapers both ways. Sections that
 * change both ways pass, and so do sections of one outline carried along unchanged in size (a raked round upright, a tube),
 * which a loft builds as the real thing is.
 */
export function sectionsProblem(name: string, l: LoftSections): string | null {
  if (l.sections.length < 3) return null
  const axis = l.along.indexOf(Math.max(...l.along))
  const across = [0, 1, 2].filter((k) => k !== axis)
  const span = Math.max(...l.sections.flatMap((s) => across.map((k) => s.hi[k]! - s.lo[k]!)))
  const tol = Math.max(0.1, SECTION_CHANGE * span)
  const range = (v: number[]): number => Math.max(...v) - Math.min(...v)
  const grows = (k: number): boolean => range(l.sections.map((s) => s.hi[k]! - s.lo[k]!)) > tol
  const still = (k: number): boolean => range(l.sections.map((s) => s.lo[k]!)) <= tol && range(l.sections.map((s) => s.hi[k]!)) <= tol
  const [p, q] = across as [number, number]
  const fixed = grows(p) && still(q) ? q : grows(q) && still(p) ? p : -1
  if (fixed < 0) return null
  const r = (v: number): number => Math.round(v * 100) / 100
  const other = fixed === p ? q : p
  return `${name}: all ${l.sections.length} sections span ${'xyz'[fixed]} ${r(l.sections[0]!.lo[fixed]!)} to ${r(l.sections[0]!.hi[fixed]!)} mm; only its size in ${'xyz'[other]} changes along its length, so it reads as one outline stretched out. Change the sections' top and bottom along the length as the real thing does (a deck rising toward the bow, a keel rising at the ends, a roof sloping down to a hood), then check again`
}
