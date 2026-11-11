// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How much detail a plan carries: basic, display or fine. A model of a real thing named with no sizes ("design me a
// sailboat") is planned at display by default, and the person's words pick basic ("simple", "nothing fancy") or fine
// ("detailed", "accurate"). The rules hold to the object, never to one kind of thing: each main body says whether the
// real thing is curved or flat-sided, a curved body is built through smooth sections (a loft, a revolve or a sweep),
// the proportions come from a lookup or a stated source, and a real object's repeated detail (windows,
// slats, vents) gets a pass by pattern. A flat-sided object (a house, a bookshelf) needs no loft. design.plan on the
// mimir tab's card refuses a display or fine plan that breaks them, in words that say what to plan instead.
import { z } from 'zod'

export const DETAIL_LEVELS = ['basic', 'display', 'fine'] as const
export type DetailLevel = (typeof DETAIL_LEVELS)[number]

/** The fewest smooth sections a curved body is lofted or swept through, at each level that holds the rules. */
export const SECTIONS_FLOOR: Record<Exclude<DetailLevel, 'basic'>, number> = { display: 5, fine: 8 }

/** The level, in plain words, as the plan card names it. */
export const DETAIL_LABEL: Record<DetailLevel, string> = { basic: 'Basic', display: 'Display model', fine: 'Fine' }
/** What each level means, in a line the plan card shows under it. */
export const DETAIL_LINE: Record<DetailLevel, string> = {
  basic: 'Simple shapes, quick to build',
  display: 'Real proportions, curved bodies through smooth sections, repeated details patterned',
  fine: 'As display, with more sections and finer details',
}

const text = (max: number) => z.string().trim().min(1).max(max)

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
}

/** The same fields with no descriptions, for a local model's shorter tool list: they take exactly what the full ones take. */
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
  if (!plan.proportions?.trim()) problems.push(`proportions: say where the proportions come from, a lookup (web.lookup) or a stated source, such as "lookup: 4.5 m long, 1.8 m wide, scaled 1:25"`)
  if (plan.repeats === undefined) problems.push('repeats: list the real object\'s repeated details (windows, slats, vents), or give an empty list when it has none')
  else if (plan.repeats.length && !plan.features.some((f) => PATTERN.test(f.kind ?? '') || PATTERN.test(f.name)))
    problems.push(`repeats: ${plan.repeats.join(', ')} repeat on the real object, so plan at least one detail pass that builds one and patterns it (kind array or pattern)`)
  return problems.length ? `A ${name} plan was not shown. ${problems.join('. ')}. ${DETAIL_HELP}` : null
}

/**
 * The method a display or fine plan follows, for any object (a car body, a plane's fuselage, a bottle): a few
 * lines in the plan tool's description and in each refusal, never a recipe for one object.
 */
export const DETAIL_HELP =
  'How a display model is built: a curved body is a table of sections, each with the same number of points, spaced evenly along its length, its lowest point at or above z 0, with upright sides for the last bit at a deck or roof edge so no knife edge is left. The sections change along the length as the real thing does: finer toward the ends, the top edge rising toward the ends where the real one does. Each color band of the real thing (a waterline, a stripe, a trim line) is its own part, split at its line, so paint follows the shape. Sizes of the parts above it (decks, funnels, wheels) follow the looked-up proportions, not a guess. Stack each level on the one below, sunk about 0.1 mm into it. Keep repeated detail (windows) at least two nozzle widths from edges and from each other. A tapered or raked round part (a funnel, a chimney, a leg) is a loft between two ellipses, offset for the rake, then arrayed. Repeated small parts are one part, then array and mirror'
