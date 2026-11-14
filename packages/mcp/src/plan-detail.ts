// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How much detail a plan carries: basic, display or fine. A model of a real thing named with no sizes ("design me a
// lighthouse") is planned at display by default, and the person's words pick basic ("simple", "nothing fancy") or fine
// ("detailed", "accurate"). The rules hold to the object, never to one kind of thing: each main body says whether the
// real thing is curved or flat-sided, a curved body is built through smooth sections (a loft, a revolve or a sweep),
// the proportions come from a lookup or a stated source, and a real object's repeated detail (windows,
// slats, vents) gets a pass by pattern. A flat-sided object (a house, a bookshelf) needs no loft. A part is planned in
// one default filament unless the person asks for color (in the request or a follow-up); then each feature says its
// color, a body painted in two colors is split at its line, and a plan has enough features for its level, its length and its repeated details. design.plan on the mimir tab's card refuses a display or fine plan
// that breaks them, in words that say what to plan instead. design.check then holds each curved body's sections to
// change along its length in both directions across it (sectionsProblem), so one shape stretched along a length fails.
import { loopPoints } from '@slicerx/cad-history'
import { z } from 'zod'
import { lengthsIn, type SizeLookup } from './real-lookup'

export const DETAIL_LEVELS = ['basic', 'display', 'fine'] as const
export type DetailLevel = (typeof DETAIL_LEVELS)[number]

/** The fewest smooth sections a curved body is lofted or swept through, at each level that holds the rules. */
export const SECTIONS_FLOOR: Record<Exclude<DetailLevel, 'basic'>, number> = { display: 5, fine: 8 }

/**
 * The fewest features a plan at each level has: its main bodies, a feature for each color band when color is asked for, the parts above them
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

/** One real size as mimir gives it on the card: the feature size it sets, its mm, and its lookupId or the person's words. */
const REAL_ENTRY = z.object({
  feature: text(60).optional(),
  size: text(40).optional(),
  mm: z.number().positive().optional(),
  lookup: text(40).optional().describe('The lookupId design.lookup_sizes returned with this size'),
  stated: text(300).optional().describe("The person's own words that give this size, quoted from their message, in place of a lookup"),
})

/** A list of real sizes, each field checked by the refine, so a local model's shorter list can leave the whole field out (tab-tools.ts). */
const realList = <T extends z.ZodType<{ feature?: string | undefined; size?: string | undefined; mm?: number | undefined }>>(entry: T) =>
  z
    .array(entry.refine((r) => r.feature !== undefined && r.size !== undefined && r.mm !== undefined, 'each real size gives feature, size and mm'))
    .max(40)
    .optional()

/** The card's real sizes: the shared list without a source page, which only a client's own plan gives (design.put_plan). */
export const cardRealField = (describe: string) => realList(REAL_ENTRY).describe(describe)

/** The plan fields the detail level adds; each is optional in the shared plan, and the card's input asks for detail. */
export const planDetailFields = {
  detail: z
    .enum(DETAIL_LEVELS)
    .optional()
    .describe("How much detail: display for a real object named without sizes (the default), basic when the person asks for simple, basic or nothing fancy, fine when they ask for detailed or accurate. A plain functional part (a bracket, a box) is basic"),
  curved: z.array(text(60)).max(8).optional().describe('Display and fine: the features that build a main body whose real thing is curved (a fuselage, a car body, a bottle, a vase)'),
  flat: z.array(text(60)).max(8).optional().describe('Display and fine: the features that build a main body whose real thing is flat-sided (a house, a bookshelf, a box)'),
  proportions: text(200).optional().describe('Display and fine: where the proportions come from, a lookup or a stated source, such as "lookup: 4.5 m long, 1.8 m wide, scaled 1:25"'),
  repeats: z.array(text(60)).max(8).optional().describe('Display and fine: the real object\'s repeated details (windows, wheels, slats, vents), each built by a pattern; an empty list when it has none'),
  colors: z
    .record(text(60), text(40))
    .optional()
    .describe('Only when the person asks for color, in the request or a follow-up: each feature\'s color, by feature name, such as {"Lower body": "red"}. A body painted in two or more colors is built in its lightest large color, and each darker band (a stripe, a trim line) is its own feature with its color here and its heights as sizes, painted on by height. Left out, the part prints in one default filament'),
  scale: z
    .union([z.number().positive(), z.string().trim().regex(/^(1\s*:\s*)?\d+(\.\d+)?$/, 'scale is N of 1:N, such as 25')])
    .optional()
    .describe('Display and fine: N of the scale 1:N against the real thing, such as 25 ("1:25" is taken too)'),
  real: realList(REAL_ENTRY.extend({ source: z.object({ title: text(120), url: z.url({ protocol: /^https?$/ }) }).optional().describe("A client's plan: the page the size came from") }))
    .describe('Display and fine: the real sizes design.lookup_sizes found, in mm at full size, each tied to the feature size it sets with its lookupId, such as {"feature": "Body", "size": "length", "mm": 4200, "lookup": "lookup_1"}: the main body\'s and each part\'s; with 2 or more levels, each one\'s length; for a patterned repeat, its part\'s height and spacing. Each is held to scale against the size the lookup found. An empty list for a made-up thing'),
  tiers: z
    .record(text(60), z.array(text(60)).min(1).max(12))
    .optional()
    .describe('Display and fine: each flat-sided main body\'s levels from the bottom up, each a planned feature, such as {"Tower": ["Lower story", "Upper story"]}: a body the real thing builds in steps or stories lists each level, a single block only itself'),
}

/** A real size as the plan gives it: the feature size it sets, in mm at full size, and where it came from. */
export interface RealEntry {
  feature?: string | undefined
  size?: string | undefined
  mm?: number | undefined
  lookup?: string | undefined
  stated?: string | undefined
  source?: { title: string; url: string } | undefined
}

/**
 * Where a plan's real sizes may come from, as design.plan or design.put_plan sees it. Left out (a plan read on its own),
 * real sizes are held to scale as given.
 */
export interface RealSources {
  /** A web lookup can run where the plan is made: mimir with web search, so a size with no lookupId is refused. */
  canLookUp: boolean
  /** The lookup with this id made in this chat. */
  lookup(id: string): SizeLookup | undefined
  /** Every lookup made in this chat. */
  lookups(): readonly SizeLookup[]
  /** The person's requests in this chat, which a stated size quotes; absent where none can be read. */
  said?: readonly string[] | undefined
  /** A client's own plan (design.put_plan): a size may give its source page; one with no page or words is from memory. */
  client?: boolean
}

/** How close a real size's mm sits to the figure its lookup or the person's words give, as a share. */
export const REAL_MATCH = 0.01

/** A plan as the detail rules read it. */
interface DetailPlan {
  features: readonly { name: string; kind?: string | undefined; sizes: Record<string, number>; on?: string | undefined }[]
  detail?: DetailLevel | undefined
  curved?: readonly string[] | undefined
  flat?: readonly string[] | undefined
  proportions?: string | undefined
  repeats?: readonly string[] | undefined
  colors?: Readonly<Record<string, string>> | undefined
  scale?: number | string | undefined
  real?: readonly RealEntry[] | undefined
  tiers?: Readonly<Record<string, readonly string[]>> | undefined
  assumptions?: readonly string[] | undefined
  overall?: { x: number; y: number; z: number } | undefined
  /** The person's words gave the size: the plan keeps it, and the bed fill does not apply. */
  personSize?: boolean | undefined
}

/** The least height of one level of a stepped body (an upper block, a story), so it reads as a level. */
export const LEVEL_MIN_MM = 3

/** A printer's usable build volume, mm: the printable area on both axes and the printable height. */
export interface Bed {
  x: number
  y: number
  z: number
}
/** The build volume a plan is sized for when no printer is chosen. */
export const DEFAULT_BED: Bed = { x: 256, y: 256, z: 256 }
/** A display model the person gave no size for fills this share of the bed (its longest side, held to the other two and the height). */
export const DISPLAY_FILL = 0.85
/** How far a display model's planned size may sit from that fill, either way, as a share. */
export const DISPLAY_FILL_SLACK = 0.06

/**
 * The size a display model with no size from the person is planned at: its overall scaled so its longest side fills
 * DISPLAY_FILL of the bed's longer side, unless its other side or its height would pass that share of the bed's other
 * side or height first. Null when it already sits within DISPLAY_FILL_SLACK of that size.
 */
export function displaySize(overall: { x: number; y: number; z: number }, bed: Bed): { x: number; y: number; z: number; by: string } | null {
  const long = Math.max(overall.x, overall.y)
  const short = Math.min(overall.x, overall.y)
  const ways: [number, string][] = [
    [(DISPLAY_FILL * Math.max(bed.x, bed.y)) / long, 'its length'],
    [short > 0 ? (DISPLAY_FILL * Math.min(bed.x, bed.y)) / short : Infinity, 'its width'],
    [overall.z > 0 ? (DISPLAY_FILL * bed.z) / overall.z : Infinity, 'its height'],
  ]
  const [k, by] = ways.reduce((a, b) => (b[0] < a[0] ? b : a))
  if (!(long > 0) || Math.abs(k - 1) <= DISPLAY_FILL_SLACK) return null
  return { x: overall.x * k, y: overall.y * k, z: overall.z * k, by }
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
 * does, or when the plan is basic or names no level. A local model's plan (`local`, its form in tab-tools.ts keeps the
 * level and leaves out curved, flat, proportions, repeats, colors, scale, real, tiers and personSize) is held only to
 * what that form can say: its feature count for the level.
 */
export function detailProblem(plan: DetailPlan, bed?: { bed: Bed; printer?: string | undefined }, opts: { local?: boolean; real?: RealSources } = {}): string | null {
  const level = plan.detail
  if (!level || level === 'basic') return null
  if (opts.local) {
    const least = featuresFloor(plan, level)
    return plan.features.length < least.count ? `A ${DETAIL_LABEL[level].toLowerCase()} plan was not shown. features: it has at least ${least.count} features (${least.why}); this one has ${plan.features.length}. Add the real thing's parts you left out: the parts that stand on the main body, and its smaller details, each repeated one built once and patterned` : null
  }
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
    problems.push(`features: a ${name} plan of this object has at least ${least.count} features (${least.why}); this one has ${plan.features.length}. Add the real thing's parts you left out: ${Object.keys(plan.colors ?? {}).length ? 'each color band as its own feature, ' : ''}the parts that stand on the main body, and its smaller details, each repeated one built once and patterned`)
  const colors = Object.entries(plan.colors ?? {})
  // a part is one default filament until the person asks for color; colors given are held to the color rules
  if (colors.length) {
    const colored = new Set<string>()
    for (const [name, color] of colors) {
      const f = feature(name)
      if (!f) {
        problems.push(`colors: ${name} is not a planned feature; name the feature the color is on`)
        continue
      }
      colored.add(name.trim().toLowerCase())
      if (TWO_COLORS.test(color)) problems.push(`colors: ${f.name} is ${color.trim()}; give it its lightest large color, and each other color its own band feature with its color and its heights as sizes, painted on by height, so each prints in its own filament`)
    }
    for (const n of [...(plan.curved ?? []), ...(plan.flat ?? [])])
      if (feature(n) && !colored.has(n.trim().toLowerCase())) problems.push(`colors: say what color ${n} is`)
  }
  problems.push(...scaleProblems(plan, feature, opts.real), ...massProblems(plan, feature), ...tierProblems(plan, feature))
  // no size from the person: a display model is sized to the printer it prints on, not to a scale it picked itself
  if (bed && !plan.personSize) {
    const b = bed.bed
    const where = bed.printer ? `${bed.printer}'s usable ${r1(b.x)} x ${r1(b.y)} x ${r1(b.z)} mm` : `a ${r1(b.x)} x ${r1(b.y)} x ${r1(b.z)} mm build volume, as no printer is chosen`
    if (!plan.overall) problems.push(`overall: give the overall size; a ${name} the person gave no size for fills about ${Math.round(DISPLAY_FILL * 100)}% of ${where}`)
    else {
      const want = displaySize(plan.overall, b)
      if (want)
        problems.push(
          `overall: the person gave no size, so a ${name} is planned to fill about ${Math.round(DISPLAY_FILL * 100)}% of ${where}, set by ${want.by}: plan it ${r1(want.x)} x ${r1(want.y)} x ${r1(want.z)} mm, not ${r1(plan.overall.x)} x ${r1(plan.overall.y)} x ${r1(plan.overall.z)}, and set scale (the real length over the planned length) and every size from that. When the person gave a size, keep theirs and set personSize`,
        )
    }
  }
  if (!plan.proportions?.trim()) problems.push(`proportions: say where the proportions come from, a lookup (${opts.real && !opts.real.client ? 'design.lookup_sizes' : 'web.lookup'}) or a stated source, such as "lookup: 4.5 m long, 1.8 m wide, scaled 1:25"`)
  if (plan.repeats === undefined) problems.push('repeats: list the real object\'s repeated details (windows, wheels, slats, vents), or give an empty list when it has none')
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
 * a plan whose source gave sizes lists the main body's among them, so the scale is anchored on the thing itself. With
 * `src`, each real size is held to the figure it came from (realFigure): the size its lookup found, or the one the
 * person's words give, so a planned size times the scale cannot stand in for a real one.
 */
function scaleProblems(plan: DetailPlan, feature: FeatureOf, src?: RealSources): string[] {
  if (plan.real === undefined) return ['real: list the real sizes the lookup or the stated source gives (the main body\'s length, and each part it gives a size for), each with the feature size it sets, so the plan is held to them at scale; an empty list when it gives none']
  if (!plan.real.length) return []
  const n = typeof plan.scale === 'string' ? Number(plan.scale.split(':').pop()) : plan.scale
  if (!n) return ['scale: give N of the scale 1:N the real sizes are held to, such as 25']
  const out: string[] = []
  const bodies = new Set([...(plan.curved ?? []), ...(plan.flat ?? [])].map((b) => b.trim().toLowerCase()))
  if (bodies.size && !plan.real.some((r) => bodies.has((r.feature ?? '').trim().toLowerCase()))) out.push('real: give a main body\'s real size too (its length), so the scale is set by the thing itself')
  const unsourced: string[] = []
  for (const r of plan.real) {
    const [name, size] = [r.feature ?? '', r.size ?? '']
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
    const fig = realFigure(r, `${f.name} ${key}`, src)
    if ('problem' in fig) {
      out.push(fig.problem)
      continue
    }
    if ('unsourced' in fig) {
      unsourced.push(`${f.name} ${key}`)
      continue
    }
    const mm = fig.mm
    const want = mm / n
    const got = f.sizes[key]!
    if (want > 0 && (got > want * SCALE_SLACK || got < want / SCALE_SLACK))
      out.push(`${f.name} ${key} is ${r1(got)} mm, ${r1(got / want)} times the ${r1(want)} mm its real ${r1(mm)} mm gives at 1:${n}; size it from the real one`)
  }
  if (unsourced.length) out.push(NO_LOOKUP_ID(unsourced))
  const unheld = unheldProblem(plan, feature, src)
  if (unheld) out.push(unheld)
  return out
}

/** "A, B and C". */
const andList = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}` : xs[0]!)

/** R1: real sizes with no lookupId where a lookup can run. The owner approves this wording. */
export const NO_LOOKUP_ID = (sizes: readonly string[]): string => {
  const one = sizes.length === 1
  return `real: ${andList(sizes)} ${one ? 'has' : 'have'} no lookupId, so ${one ? 'it is' : 'they are'} not from a lookup; call design.lookup_sizes first, then give each found size with its lookupId, or name a size the lookup did not find in assumptions as "real: ${sizes.at(-1)!} not given by the source"`
}
/** R2: a lookupId that is no lookup in this chat. */
export const UNKNOWN_LOOKUP = (id: string): string => `real: ${id} is not a lookup in this chat; give the lookupId design.lookup_sizes returned`
/** The most found sizes R3 lists. */
const FOUND_LISTED = 6
/** R3: a real size its lookup found nothing within REAL_MATCH of. */
export const NOT_FOUND_IN_LOOKUP = (size: string, mm: number, l: SizeLookup): string =>
  `real: ${size} is ${r1(mm)} mm, but ${l.id} found no size within 1% of that (${l.found.length ? `it found ${l.found.slice(0, FOUND_LISTED).map((x) => `${x.size} ${r1(x.mm)} mm`).join(', ')}` : 'it found no sizes'}); give the size it found`
/** R4: a size called not given by the source that no lookup asked for. */
export const NOT_ASKED = (sizes: readonly string[]): string =>
  `real: ${andList(sizes)} ${sizes.length === 1 ? 'was' : 'were'} not asked for in any lookup, so the source has not been read for ${sizes.length === 1 ? 'it' : 'them'}; ask design.lookup_sizes for ${sizes.length === 1 ? 'it' : 'them'} first`
/** A stated size the person's words do not give. */
export const NOT_STATED = (size: string, mm: number, stated: string): string => `real: ${size} is ${r1(mm)} mm, but "${stated}" gives no size within 1% of that; give the size the person's words give, in mm`
/** Stated words that are not the person's. */
export const NOT_SAID = (stated: string): string => `real: "${stated}" is not in the person's messages in this chat; quote their own words in stated, or look the size up with design.lookup_sizes`

/** A name and a lookup's size name read as the same size: each word of one in the other, either way. */
const sameSize = (a: string, b: string): boolean => within(a, b) || within(b, a)

/** Whether a lookup in this chat asked for `size` ("Main tower height") and no source gave it. */
function askedAndMissing(src: RealSources, names: readonly string[]): boolean {
  return src.lookups().some((l) => l.missing.some((m) => names.some((n) => sameSize(m, n))))
}

/**
 * Whether a real size gives the lookupId of a lookup that read no page and asked for it: its answer cited no source, so
 * the size is from memory, as one a lookup asked for and no source gave.
 */
function fromUnreadLookup(r: RealEntry, size: string, src: RealSources): boolean {
  const l = r.lookup !== undefined && !src.client ? src.lookup(r.lookup) : undefined
  return !!l && !l.sources.length && l.missing.some((m) => sameSize(m, size))
}

/**
 * The figure a real size is held to. Without `src`, its own mm. With a lookupId, the size that lookup found within
 * REAL_MATCH of its mm (a lookup that read no page holds it to nothing: it is from memory); with stated words, the length in them within REAL_MATCH (and the words must be the person's,
 * where their messages can be read); with a source page, its mm on a client's plan (the card's form has no source). A size with none of these is
 * unsourced where a lookup can run, unless a lookup asked for it and no source gave it;
 * otherwise it is taken from memory as given (realMemoryNote says so on the plan).
 */
function realFigure(r: RealEntry, size: string, src: RealSources | undefined): { mm: number } | { problem: string } | { unsourced: true } {
  const mm = r.mm ?? 0
  if (!src) return { mm }
  if (r.lookup !== undefined) {
    const l = src.client ? undefined : src.lookup(r.lookup)
    if (!l) return { problem: UNKNOWN_LOOKUP(r.lookup) }
    if (fromUnreadLookup(r, size, src)) return { mm }
    const hit = l.found.filter((x) => Math.abs(x.mm - mm) <= mm * REAL_MATCH).sort((a, b) => Math.abs(a.mm - mm) - Math.abs(b.mm - mm))[0]
    return hit ? { mm: hit.mm } : { problem: NOT_FOUND_IN_LOOKUP(size, mm, l) }
  }
  if (r.stated !== undefined) {
    const words = r.stated.trim()
    const squash = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()
    if (src.said && !src.said.some((m) => squash(m).includes(squash(words)))) return { problem: NOT_SAID(words) }
    const hit = lengthsIn(words).find((x) => Math.abs(x.mm - mm) <= mm * REAL_MATCH)
    return hit ? { mm: hit.mm } : { problem: NOT_STATED(size, mm, words) }
  }
  // a client's size with no page or words is its own, from memory: many clients have no web search
  if (src.client) return { mm }
  if (src.canLookUp && !askedAndMissing(src, [size])) return { unsourced: true }
  return { mm }
}

/**
 * The assumption design.plan adds for real sizes taken from memory: where no lookup can run, or where a lookup asked
 * for them and no source gave them (a lookup whose answer cited no page among them). Null when every real size has a lookup, the person's words or a source.
 */
export function realMemoryNote(plan: DetailPlan, src: RealSources): string | null {
  const feature = (n: string) => plan.features.find((x) => x.name.trim().toLowerCase() === n.trim().toLowerCase())
  const memory = (plan.real ?? []).flatMap((r) => {
    if (r.stated !== undefined || r.source !== undefined) return []
    const f = feature(r.feature ?? '')
    const key = f && Object.keys(f.sizes).find((k) => k.trim().toLowerCase() === (r.size ?? '').trim().toLowerCase())
    if (!f || !key) return []
    return r.lookup === undefined || fromUnreadLookup(r, `${f.name} ${key}`, src) ? [`${f.name} ${key}`] : []
  })
  if (!memory.length) return null
  return src.client ? MEMORY_CLIENT(memory) : src.canLookUp ? MEMORY_AFTER_LOOKUP(memory) : MEMORY_NO_WEB(memory)
}

/** The Assumed line where no web lookup can run. The owner approves this wording. */
export const MEMORY_NO_WEB = (sizes: readonly string[]): string => `real: not looked up, as no web lookup can run here; ${andList(sizes)} ${sizes.length === 1 ? 'is' : 'are'} from memory`
/** The assumption design.put_plan adds for a client's real sizes with no source page or words. */
export const MEMORY_CLIENT = (sizes: readonly string[]): string => `real: no source given; ${andList(sizes)} ${sizes.length === 1 ? 'is' : 'are'} from memory`
/** The Assumed line for sizes a lookup asked for and no source gave. */
export const MEMORY_AFTER_LOOKUP = (sizes: readonly string[]): string => `real: ${andList(sizes)} ${sizes.length === 1 ? 'is' : 'are'} from memory, as the lookup found no source for ${sizes.length === 1 ? 'it' : 'them'}`

/**
 * A client plan's real sizes against its planned sizes at scale (design.put_plan): each size its source page or the
 * person's words, and the plan held to them as design.plan holds a display plan. Null when they hold.
 */
export function realSizeProblem(plan: DetailPlan, src: RealSources): string | null {
  if (!plan.real?.length) return null
  const feature = (n: string) => plan.features.find((x) => x.name.trim().toLowerCase() === n.trim().toLowerCase())
  const problems = scaleProblems(plan, feature, src)
  return problems.length ? problems.join('. ') : null
}

/** A size's name read as a repeat's spacing: how far apart its copies stand. */
const SPACING = /^(spacing|pitch|step|gap|apart)\b/i
const ROUND = /^(diameter|d)$/i
/** A repeated part's height: how tall it stands, not how deep it is. */
const TALL = /^(height|tall)$/i

/** A name as the unheld check matches it: lower case, no parentheses, no array or pattern word, each word singular. */
const stem = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !/^(array|pattern|patterned)$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ')

/** Whether each word of a's stem is a word of b's: "Posts" in "Post array", "Window" in "Window row". */
const within = (a: string, b: string): boolean => {
  const [x, y] = [stem(a).split(' ').filter(Boolean), new Set(stem(b).split(' '))]
  return x.length > 0 && x.every((w) => y.has(w))
}

/**
 * An assumption that says a size the source does not give: "real: Posts spacing not given by the source", or two
 * sizes at once ("Post height and spacing"). The name is a planned feature or a name in repeats.
 */
const NOT_GIVEN = /^\s*real\s*:\s*(.+?)\s+([a-z]+)(?:\s+and\s+([a-z]+))?\s+not given by the source\b/i

/** One size the check holds to a real one: the feature that carries it, its size key, and the names a note may use. */
interface Held {
  feature: string
  key: string
  re: RegExp
  names: string[]
}

/**
 * The sizes a source's real list leaves unheld that set how the thing reads: each level of a tier list of two or more
 * levels (its length) and each repeat built as a pattern with a spacing (its part's height, on the part built once or
 * its pattern, and the pattern's spacing). A size the
 * source does not give is named in assumptions as NOT_GIVEN says, and the check takes it. Null when each is held.
 */
function unheldProblem(plan: DetailPlan, feature: FeatureOf, src?: RealSources): string | null {
  const isPattern = (f: DetailPlan['features'][number]): boolean => PATTERN.test(f.kind ?? '') || PATTERN.test(f.name)
  const keyOf = (f: DetailPlan['features'][number], ...res: RegExp[]): [string, RegExp] | null => {
    for (const re of res) {
      const k = Object.keys(f.sizes).find((s) => re.test(s.trim()))
      if (k) return [k, re]
    }
    return null
  }
  // a main body or a level is never the part a pattern repeats
  const bodies = new Set([...(plan.curved ?? []), ...(plan.flat ?? []), ...Object.keys(plan.tiers ?? {}), ...Object.values(plan.tiers ?? {}).flat()].map((b) => b.trim().toLowerCase()))
  const want: { held: Held; group: string[]; what: 'length' | 'height' | 'spacing' }[] = []
  const seen = new Set<string>()
  const add = (f: DetailPlan['features'][number] | undefined, res: RegExp[], what: 'length' | 'height' | 'spacing', group: string[], names: string[]): void => {
    if (!f) return
    const k = keyOf(f, ...res)
    if (!k || seen.has(`${f.name.toLowerCase()}\0${what}`)) return
    seen.add(`${f.name.toLowerCase()}\0${what}`)
    want.push({ held: { feature: f.name, key: k[0], re: k[1], names: [f.name, ...names] }, group, what })
  }
  // each level of a tier list of two or more levels, keyed by a planned body or by a name over them; a single block
  // is not held, and a level that is no feature is asked for by tierProblems
  for (const levels of Object.values(plan.tiers ?? {}))
    for (const l of levels.length > 1 ? levels : []) {
      const f = feature(l)
      add(f, [LENGTH, WIDTH], 'length', f ? [f.name] : [], [])
    }
  // each repeat built as a pattern with a spacing, by the features whose names hold its name ("Posts" holds "Post"
  // and "Posts (array)"): the pattern and the part it builds once; a repeat whose name no feature holds takes the
  // patterns no repeat names, and a repeat with no pattern (a mirrored pair) is not asked for anything
  const repeats = plan.repeats ?? []
  const claimed = new Set<DetailPlan['features'][number]>()
  const groups: { label: string; matched: number; patterns: DetailPlan['features'][number][] }[] = repeats.map((r) => {
    const s = stem(r)
    const matched = plan.features.filter((f) => s && !bodies.has(f.name.trim().toLowerCase()) && within(r, f.name))
    matched.forEach((f) => claimed.add(f))
    return { label: r, matched: matched.length, patterns: matched.filter(isPattern) }
  })
  const spaced = (f: DetailPlan['features'][number]): boolean => isPattern(f) && !!keyOf(f, SPACING)
  const loose = plan.features.filter((f) => isPattern(f) && !claimed.has(f))
  const part = (f: DetailPlan['features'][number]): boolean => !isPattern(f) && !bodies.has(f.name.trim().toLowerCase())
  for (const g of groups) {
    const pats = (g.matched ? g.patterns : loose).filter(spaced)
    for (const p of pats) {
      // the part a pattern builds once: the pattern itself when it carries the part's own height (an array cut of
      // vents), else the part its name holds, else the part planned just before it
      const at = plan.features.indexOf(p)
      const once = keyOf(p, TALL, ROUND) ? p : (plan.features.find((f) => part(f) && within(f.name, p.name)) ?? plan.features.slice(0, at).reverse().find(part))
      const group = [...new Set([p, once].filter((f): f is NonNullable<typeof f> => !!f).map((f) => f.name))]
      add(once ?? p, [TALL, ROUND], 'height', group, [g.label, ...group])
      add(p, [SPACING], 'spacing', group, [g.label, ...group])
    }
  }
  if (!want.length) return null
  // a real entry for any feature of its group, the same way, holds a size: a repeat's height on its pattern counts
  const given = (w: (typeof want)[number]): boolean =>
    (plan.real ?? []).some((r) => {
      const f = feature(r.feature ?? '')
      return !!f && w.group.concat(w.held.feature).some((g) => g.trim().toLowerCase() === f.name.trim().toLowerCase()) && Object.keys(f.sizes).some((k) => k.trim().toLowerCase() === (r.size ?? '').trim().toLowerCase() && w.held.re.test(k.trim()))
    })
  const notes = (plan.assumptions ?? []).filter((a) => /^\s*real\s*:/i.test(a))
  const said = (w: (typeof want)[number], note: string): boolean => {
    const m = NOT_GIVEN.exec(note)
    if (!m) return false
    const sizes = [m[2]!, m[3]].filter((s): s is string => !!s).map((s) => s.toLowerCase())
    return w.held.names.some((n) => stem(n) === stem(m[1]!)) && sizes.some((s) => s === w.held.key.trim().toLowerCase() || w.held.re.test(s))
  }
  // where a lookup can run, "not given by the source" stands only for a size a lookup asked for and found no source for
  const unread = src?.canLookUp && !src.client ? want.filter((w) => !given(w) && notes.some((n) => said(w, n)) && !askedAndMissing(src, w.held.names.map((n) => `${n} ${w.held.key}`))) : []
  const missing = want.filter((w) => !given(w) && !notes.some((n) => said(w, n)))
  if (!missing.length) return unread.length ? NOT_ASKED(unread.map((w) => `${w.held.feature} ${w.held.key}`)) : null
  const ways = new Set(missing.map((w) => w.what))
  const rep = [ways.has('height') && 'height', ways.has('spacing') && 'spacing'].filter(Boolean).join(' and ')
  const lengths = missing.filter((w) => w.what === 'length')
  const level = lengths.every((w) => LENGTH.test(w.held.key.trim())) ? 'length' : lengths.every((w) => !LENGTH.test(w.held.key.trim())) ? 'size across' : 'length or size across'
  const held = [ways.has('length') && `a level's ${level}`, rep && `a repeated part's ${rep}`].filter(Boolean) as string[]
  const sizes = missing.map((w) => `${w.held.feature} ${w.held.key}`)
  const list = sizes.length > 1 ? `${sizes.slice(0, -1).join(', ')} and ${sizes.at(-1)!}` : sizes[0]!
  const last = missing.at(-1)!
  const example = `"real: ${last.held.feature} ${last.held.key} not given by the source"`
  const stray = notes.find((n) => !want.some((w) => said(w, n)))
  const one = missing.length === 1
  const fix = stray ? `; the assumption "${stray.trim()}" does not name ${one ? 'it' : 'one of them'} as the check reads it, so write it as ${example}` : `; for a size the source does not give, say so in assumptions as ${example}`
  const ask = `real: ${held.join(' and ')} ${held.length > 1 || rep.includes(' and ') ? 'are' : 'is'} held to scale too, so give the real ${list}, ${one ? 'tied to that size' : 'each tied to its size'}${fix}`
  return unread.length ? `${ask}. ${NOT_ASKED(unread.map((w) => `${w.held.feature} ${w.held.key}`))}` : ask
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
 * The sentence for a tier list keyed by a name that is no planned feature, over levels that all are: the levels of
 * one body keyed by the lowest, or separate bodies each with its own list; one level is keyed by itself. The list is
 * the plan's own levels in the compact JSON the tool takes. No closing period: the refusal joins its problems with one.
 */
export const TIER_GROUP_KEY = (key: string, levels: readonly string[]): string => {
  const lowest = levels[0]!
  if (levels.length === 1) return `tiers: ${key} is not a planned feature but a name over ${lowest}. Key its list by ${lowest}: tiers: ${JSON.stringify({ [lowest]: [lowest] })}, with only ${lowest} in flat`
  const names = `${levels.slice(0, -1).join(', ')} and ${levels.at(-1)!}`
  return `tiers: ${key} is not a planned feature but a name over ${names}. If they are levels of one body, key them by the lowest, the body flat lists: tiers: ${JSON.stringify({ [lowest]: levels })}, with only ${lowest} in flat. If they are separate bodies, give each its own list: ${JSON.stringify(Object.fromEntries(levels.map((l) => [l, [l]])))}`
}

/**
 * Each flat-sided main body states its levels from the bottom up (tiers), each a planned feature, so a body the real
 * thing builds in steps or stories is planned that way and not as one slab; a single block lists only itself.
 */
function tierProblems(plan: DetailPlan, feature: FeatureOf): string[] {
  const out: string[] = []
  const tiers = Object.entries(plan.tiers ?? {})
  const stated = new Set(tiers.map(([body]) => body.trim().toLowerCase()))
  // a key that is no feature over levels that all are: a name for them, answered once with both readings, so the
  // levels it lists are not each asked for their own list as well
  const group = (body: string, levels: readonly string[]): boolean => !feature(body) && levels.length > 0 && levels.every((l) => feature(l))
  const grouped = new Set(tiers.flatMap(([body, levels]) => (group(body, levels) ? levels.map((l) => l.trim().toLowerCase()) : [])))
  for (const b of plan.flat ?? [])
    if (feature(b) && !stated.has(b.trim().toLowerCase()) && !grouped.has(b.trim().toLowerCase()))
      out.push(`tiers: give the levels of ${b} from the bottom up; a body the real thing builds in steps or stories (a stepped roof, a tower, a tiered cake) lists each level as its own feature, a single block lists only itself`)
  for (const [body, levels] of tiers) {
    if (!feature(body)) out.push(group(body, levels) ? TIER_GROUP_KEY(body, levels) : `tiers: ${body} is not a planned feature`)
    for (const l of levels) {
      const f = feature(l)
      if (!f) {
        out.push(`tiers: ${l}, a level of ${body}, is not a planned feature; plan each level as its own feature`)
        continue
      }
      // a level is a story a person sees at the whole-model view, not a slab: a slab at true scale reads as a line
      const h = Object.entries(f.sizes).find(([k]) => HEIGHT.test(k.trim()))?.[1]
      if (levels.length > 1 && h !== undefined && h < LEVEL_MIN_MM) out.push(`tiers: ${f.name}, a level of ${body}, is ${r1(h)} mm tall, which reads as a thin slab at the whole-model view; give each level at least ${LEVEL_MIN_MM} mm, a story with walls, even past its true scale`)
    }
    // a level stands on the one before it; a level that names what it stands on names that one
    levels.forEach((l, k) => {
      const f = feature(l)
      if (k > 0 && f?.on && f.on.trim().toLowerCase() !== levels[k - 1]!.trim().toLowerCase()) out.push(TIER_ON_DISAGREES(f.name, f.on.trim(), levels[k - 1]!, body))
    })
  }
  return out
}

/** The refusal for a level whose on names another feature than the level before it in its tier list. */
export const TIER_ON_DISAGREES = (level: string, on: string, before: string, body: string): string =>
  `on: ${level} stands on ${on}, but the tiers of ${body} put it on ${before}; name ${before} in its on, or take it out of the tier list`

const r2 = (v: number): number => Math.round(v * 100) / 100

/** The most a stacked part's base may sit off its support's top: one layer, mm. */
export const STAND_LAYER_MM = 0.2

/** A feature that copies another: an array or a pattern. */
const COPIES = /\b(array|pattern)\b/i

/**
 * The top a stacked part is read against (topUnder): its height, mm, and whether it is the lowest of a deck under the
 * part or the support's highest point.
 */
export interface TopRead {
  z: number
  under: boolean
}

/** The support a failure names, with the height of the top the part was read against, so the fix needs no reading. */
const supportTop = (support: string, top: TopRead): string => `${support}, whose ${top.under ? 'lowest point under it' : 'highest point'} is at z ${r2(top.z)} mm`

/** The failure for a stacked part whose base is sunk below its support's top, with a planned height. */
export const STANDS_OFF = (part: string, support: string, below: number, shows: number, planned: number, top: TopRead): string =>
  `${part} stands on ${support}, but its base is ${r2(below)} mm below its top, so ${r2(shows)} mm of it shows of a planned ${r2(planned)} mm; build it from the top of ${supportTop(support, top)}`

/** The failure for a stacked part whose base floats above its support's top, planned height or not. */
export const STANDS_FLOATS = (part: string, support: string, above: number, top: TopRead): string =>
  `${part} stands on ${support}, but its base is ${r2(above)} mm above its top, so it floats; build it from the top of ${supportTop(support, top)}`

/** The failure for a stacked part on its support's top whose planned height does not show above it. */
export const STANDS_HEIGHT_OFF = (part: string, support: string, shows: number, planned: number, top: TopRead): string =>
  `${part} stands on ${support}, but ${r2(shows)} mm of it shows of a planned ${r2(planned)} mm; make it ${r2(planned)} mm tall above the top of ${supportTop(support, top)}`

/** The failure for a stacked part with no planned height whose base is sunk below its support's top. */
export const STANDS_BASE_OFF = (part: string, support: string, below: number, top: TopRead): string =>
  `${part} stands on ${support}, but its base is ${r2(below)} mm below its top; build it from the top of ${supportTop(support, top)}`

/**
 * The stacking pairs a plan says, each a feature and the planned feature it stands on: each on that names a planned
 * feature, and each level of a tier list on the level before it. Display and fine plans only.
 */
export function stackPairs(plan: Pick<DetailPlan, 'features' | 'tiers' | 'detail'>): [string, string][] {
  if (plan.detail === 'basic') return []
  const named = new Map(plan.features.map((f) => [f.name.trim().toLowerCase(), f.name]))
  const pairs = new Map<string, [string, string]>()
  for (const f of plan.features) {
    const on = f.on?.trim()
    if (on && named.has(on.toLowerCase()) && on.toLowerCase() !== f.name.trim().toLowerCase()) pairs.set(f.name.trim().toLowerCase(), [f.name, named.get(on.toLowerCase())!])
  }
  for (const levels of Object.values(plan.tiers ?? {}))
    levels.forEach((l, k) => {
      const [a, b] = [named.get(l.trim().toLowerCase()), k > 0 ? named.get(levels[k - 1]!.trim().toLowerCase()) : undefined]
      if (a && b && !pairs.has(a.trim().toLowerCase())) pairs.set(a.trim().toLowerCase(), [a, b])
    })
  return [...pairs.values()]
}

/**
 * A feature's height range as built, mm, by its name in lower case; `loose` when a step gave only a bound around it.
 * A support whose top rises or falls along its length gives its top at each section (`deck`), and a part read against
 * one gives where it stands across the bed (`foot`).
 */
export type FeatureHeights = Readonly<
  Record<string, { lo: number; hi: number; loose?: true; deck?: { axis: 'x' | 'y'; at: readonly (readonly [number, number])[] }; foot?: { x: readonly [number, number]; y: readonly [number, number] } }>
>

/**
 * The lowest of a deck's top from `a` to `b` along it, mm, taken straight between its sections; null when that stretch
 * misses the deck.
 */
function lowestTop(deck: NonNullable<FeatureHeights[string]['deck']>, a: number, b: number): number | null {
  const at = deck.at
  const [lo, hi] = [Math.max(a, at[0]![0]), Math.min(b, at.at(-1)![0])]
  if (lo > hi) return null
  const zAt = (x: number): number => {
    const k = Math.max(0, at.findIndex((q, i) => i > 0 && x <= q[0]) - 1)
    const [p, q] = [at[k]!, at[k + 1] ?? at[k]!]
    return q[0] === p[0] ? p[1] : p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0])
  }
  return Math.min(zAt(lo), zAt(hi), ...at.filter(([x]) => x > lo && x < hi).map(([, z]) => z))
}

/**
 * The top a stacked part is read against: on a support whose top rises or falls along its length, the lowest of that
 * top under the part's footprint, where a flat base meets it with no gap; else, and for a part with no footprint or one
 * past the deck's ends, the support's highest point.
 */
function topUnder(p: FeatureHeights[string], s: FeatureHeights[string]): TopRead {
  if (!s.deck || !p.foot) return { z: s.hi, under: false }
  const [a, b] = s.deck.axis === 'x' ? p.foot.x : p.foot.y
  const z = lowestTop(s.deck, a, b)
  return z === null ? { z: s.hi, under: false } : { z, under: true }
}

/** What a stacked part's base and height say against its support's top: null when both hold. */
function standsWrong(part: string, support: string, base: number, shows: number, planned: number | undefined, top: TopRead): string | null {
  if (base > STAND_LAYER_MM + 1e-6) return STANDS_FLOATS(part, support, base, top)
  // no height planned: only the base is held, as the plan says nothing of how much should show
  if (base < -STAND_LAYER_MM - 1e-6) return planned === undefined ? STANDS_BASE_OFF(part, support, -base, top) : STANDS_OFF(part, support, -base, shows, planned, top)
  if (planned === undefined || (shows >= planned / SCALE_SLACK && shows <= planned * SCALE_SLACK)) return null
  return STANDS_HEIGHT_OFF(part, support, shows, planned, top)
}

/**
 * Each stacked part against what it stands on, from the height range of each feature as built: its base within a
 * layer of its support's top (on a deck that rises or falls along its length, the lowest of it under the part,
 * topUnder), and its planned height (a size named height) showing above that top within SCALE_SLACK, or the base
 * alone when no height is planned. A pair is read only when both features have an exact range; a plan with
 * no pair read gets no item.
 */
export function stackItem(plan: Pick<DetailPlan, 'features' | 'tiers' | 'detail'>, heights: FeatureHeights | undefined): { name: string; want: string; got: string; pass: boolean } | null {
  if (!heights) return null
  const read = stackPairs(plan).flatMap(([part, support]) => {
    const [p, s] = [heights[part.trim().toLowerCase()], heights[support.trim().toLowerCase()]]
    // a loose range on either side is a bound, not the solid: a support's top read too high or too low makes a part
    // placed right look sunk or floating, and a part's own bound fails it wrongly, so the pair is not read
    if (!p || !s || p.loose || s.loose) return []
    // an array or a pattern whose on is the part it copies starts where that part starts: its on is its source, not
    // a support, and the source's own pair reads where the copies stand
    const kind = plan.features.find((f) => f.name === part)?.kind ?? ''
    return COPIES.test(kind) && Math.abs(p.lo - s.lo) <= STAND_LAYER_MM ? [] : [{ part, support, p, s }]
  })
  if (!read.length) return null
  const off = read.flatMap(({ part, support, p, s }) => {
    const planned = Object.entries(plan.features.find((f) => f.name === part)?.sizes ?? {}).find(([k]) => /^height$/i.test(k.trim()))?.[1]
    const top = topUnder(p, s)
    // the height the failure names is the one the part was measured against, so the two never disagree
    const wrong = standsWrong(part, support, p.lo - top.z, p.hi - top.z, planned, top)
    return wrong ? [wrong] : []
  })
  return {
    name: 'stands on',
    want: `each stacked part's base on its support's top, within ${STAND_LAYER_MM} mm, its planned height showing above it within ${SCALE_SLACK} times`,
    got: off.length ? off.join('; ') : `${read.length} stacked ${read.length === 1 ? 'part' : 'parts'} on ${read.length === 1 ? 'its support' : 'their supports'}`,
    pass: off.length === 0,
  }
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
/** A plan shape that passes a display plan's rules on the first try, said in general terms, for any object. */
export const DETAIL_WORKED_SHAPE =
  'A plan of this shape passes on the first try: a stepped body is one main body in flat, keyed in tiers by its own name, its levels in order, each its own feature at least 3 mm tall, stacked; a detail that repeats is listed in repeats and planned as two features, one that builds it once and one with kind array (or pattern) and its count as a size'

export const DETAIL_HELP =
  'How a display model is built: a curved body is a table of sections, each with the same number of points, spaced evenly along its length, its lowest point at or above z 0, with upright sides for the last bit at a top or roof edge so no knife edge is left. The sections change along the length as the real thing does, in both directions across it: narrower toward the ends, and their top and bottom rising or falling (a bottom lifting at the ends, a hood lower than a roof); one outline stretched only in width is a box, and the check fails it. Color is planned only when the person asks for it, in the request or a follow-up; otherwise the part is one default filament and the plan gives no colors. When they ask, a body the real thing paints in two or more colors is built whole in its lightest large color, and each darker band is its own feature named for it (a band, a stripe) with its color in colors and its heights as sizes (below, or from and to, in mm above the bed), painted on by height once the body is built. Sizes of the parts on it (doors, chimneys, wheels) follow the looked-up proportions at the scale the plan gives, not a guess: look the real sizes up with design.lookup_sizes first and give each in real with its lookupId, and a part more than about a third off its looked-up size at scale is refused. A body the real thing builds in steps or stories is planned as its levels, each its own feature. Stack each level on the one below, sunk about 0.1 mm into it. Keep repeated detail (windows) at least two nozzle widths from edges and from each other. Plan the features a person recognizes the real thing by, from what you know of it and from lookups, with the detail its size can carry: anything smaller is named in assumptions. Repeated small parts are one part, then array and mirror. ' + DETAIL_WORKED_SHAPE

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
  return `${name}: all ${l.sections.length} sections span ${'xyz'[fixed]} ${r(l.sections[0]!.lo[fixed]!)} to ${r(l.sections[0]!.hi[fixed]!)} mm; only its size in ${'xyz'[other]} changes along its length, so it reads as one outline stretched out. Change the sections' top and bottom along the length as the real thing does (a bottom lifting at the ends, a roof sloping down to a hood), then check again`
}
