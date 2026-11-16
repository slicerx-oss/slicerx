// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's own tools beside the design toolset: the question, the lookup card, the dimension sheet and its
// binding, and design.plan. Before mimir builds a part of two or more features, design.plan lays out the plan (each
// feature and the sizes that drive it, what it assumed, what it still needs to know) on a card the person can edit
// inline and approve with Go. The card answers through the same question channel pilot.ask uses. The plans made there
// are kept by id with the person's latest edits, so a later check can read the plan the part was built from. The app's
// tab and the creative eval make these tools here (toolset.ts tabToolset), each over its own plan registry.
import { askTool, defineTool, lookupTool, printInPlaceClearance, sheetBindTool, sheetTool, type PilotTool, type ToolContext, type ToolOutput } from '@slicerx/pilot'
import { z } from 'zod'
import { assumptionsInput, gapLimitsText, type FitLimits, MAX_PLANS, partPlanSchema, plannedGaps, PLAN_SIZE_MAX, PRINTS_TOGETHER, printsTogether, tidyPlan, type PartPlan, type PlanRegistry } from './design-check'
import { ToolInputError } from './errors'
import { runFitLimits, type FitProfile } from './fit-facts'
import { AMEND_REASON_MAX, amendAdded, amendBody, amendChanges, amendDropProblem, amendKinds, amendedSizes, amendOnsText, amendOns, amendProblem, amendReason, amendShapeProblem, changeText, IGNORED_NOTE, type AmendChange } from './plan-amend'
import { type Bed, cardRealField, DEFAULT_BED, DETAIL_HELP, DETAIL_LEVELS, detailProblem, flatInput, flatLevels, type FlatLevels, planDetailFields, realBodyInput, withRealBody, FEATURES_FLOOR, unheldAsks, LONG_EXTRA, LONG_RATIO, realMemoryNote, type RealSources, SECTIONS_FLOOR } from './plan-detail'
import { createLookupStore, lookupSizesTool } from './real-lookup'
import { GAP_MARGIN_MM, jointProblem, planetsMiss, PLANETS_CANNOT_MESH, planFloors, raisedText, raisedWhy, raiseToFloors, underFloors, underLine, underName, type PlanFloors, type UnderFloor } from './plan-floors'

export { PLAN_SIZE_MAX, type PartPlan }

/**
 * A part's plan as the card takes it: the shared shape (design-check.ts, which design.check reads), with one feature at
 * least, and without openFaces, which only design.put_plan takes for now.
 */
export const PartPlanSchema = partPlanSchema.extend({ features: partPlanSchema.shape.features.min(1) }).omit({ openFaces: true })

/** What mimir sends: the plan without its id, which the tool gives it, and with no room for the card's own line. Each flat body's ends come with the body in flat (flatLevels). */
export const PlanInputSchema = PartPlanSchema.omit({ planId: true, ends: true }).extend({
  assumptions: assumptionsInput,
  // the card takes each real size's lookupId or the person's words; a source page is a client's own plan's
  real: cardRealField(planDetailFields.real.description ?? ''),
  personSize: z.boolean().optional().describe("True when the person's words gave the size (a length, a scale, \"fits in my hand\"): the plan keeps it. Without it, a display or fine model is planned to fill about 85% of this printer's bed"),
})

/**
 * What a local model sends: the plan without the detail level's other fields, colors, scale, tiers and leftOut, since a local
 * model's window holds the tab's tools within a few hundred tokens (packages/app test/mimir-local-context.test.ts) and
 * its prompt has no detail line. The level itself stays, bare, so the local form takes every value the full one does.
 * The tool still takes every field, and a plan without a detail level is checked as before.
 */
export const LocalPlanInputSchema = PlanInputSchema.omit({ curved: true, flat: true, proportions: true, repeats: true, colors: true, scale: true, real: true, tiers: true, personSize: true, leftOut: true }).extend({
  detail: z.enum(DETAIL_LEVELS).optional(),
  // a hole row's recess flag stays off a local model's list too; the tool takes it either way
  holes: z.array(PlanInputSchema.shape.holes.unwrap().element.omit({ recess: true }).extend({ count: PlanInputSchema.shape.holes.unwrap().element.shape.count.describe('Holes the row stands for; default 1') })).max(60).optional(),
  // the pieces' examples stay on the full text; the field takes the same values
  printInPlace: PlanInputSchema.shape.printInPlace.describe('Pieces that print assembled and move, by name; false if they print separately'),
})

export type PlanInput = z.infer<typeof PlanInputSchema>

/** The fields a first plan must give, which an amend may leave to the approved plan; its assumptions and questions are none when left out. */
const FIRST_PLAN_NEEDS = ['part', 'units', 'features'] as const

/**
 * design.plan's input: the plan, and for a change to an approved plan, the plan it amends and why (plan-amend.ts). An
 * amend may send only its changes: the part, units, features, assumptions and questions it leaves out are the approved
 * plan's. A first plan still needs its part, units and features, refused in the words the schema uses for any field
 * left out; its assumptions and questions left out are none.
 */
export const PlanToolInputSchema = PlanInputSchema.extend({
  part: PlanInputSchema.shape.part.optional(),
  units: PlanInputSchema.shape.units.optional(),
  features: PlanInputSchema.shape.features.optional(),
  assumptions: PlanInputSchema.shape.assumptions.optional().describe('What you assumed; none when left out'),
  questions: PlanInputSchema.shape.questions.optional().describe('What you still need to know; none when left out'),
  // each flat body with its levels; the older names-and-tiers form a saved plan or an older client sends is taken too
  flat: flatInput,
  realBody: realBodyInput,
  tiers: planDetailFields.tiers.describe('The older form of flat\'s levels, with flat as a list of feature names: each flat body\'s levels from the bottom up, keyed by its name. Give the levels in flat instead'),
  amends: z.string().trim().min(1).max(64).optional().describe("Only to change a plan the person approved, once its part is built: that plan's planId. Leave it out of a first plan. With amends, send only what changes: changes and add, with part, units, features, assumptions and questions left out, as the approved plan has them; any other plan field sent is ignored, and the result names it"),
  reason: z.string().max(AMEND_REASON_MAX).optional().describe('Only with amends: why the build changes the approved plan, in a sentence the person reads. A first plan takes none'),
  asked: z.string().trim().min(1).max(AMEND_REASON_MAX).optional().describe("Only with amends, for a change the person asked for in their latest message (a size, a detail added): their words. It goes in with no card, since their message is the go, and may add features; give no reason"),
  changes: z
    .array(z.object({ feature: z.string().trim().min(1).max(60), size: z.string().trim().min(1).max(40), to: z.number().positive().max(PLAN_SIZE_MAX) }))
    .min(1)
    .max(20)
    .optional()
    .describe('Only with amends: each size to change, as {feature, size, to}: a planned feature\'s name and one of its sizes, overall with x, y or z, or a row of holes\' name with diameter; to is the new value in the plan\'s units'),
  add: z.array(PlanInputSchema.shape.features.element).min(1).max(10).optional().describe('Only with amends: features to add after the planned ones, each as a planned feature is given'),
}).superRefine((i, ctx) => {
  if (i.amends !== undefined) return
  for (const k of FIRST_PLAN_NEEDS) {
    const got = PlanInputSchema.shape[k].safeParse(i[k])
    if (!got.success) for (const issue of got.error.issues) ctx.addIssue({ ...issue, path: [k, ...issue.path] } as Parameters<typeof ctx.addIssue>[0])
  }
})
/** design.plan's input with its flat bodies in the older form the rules and the card read (flatLevels). */
type PlanToolInput = Omit<z.infer<typeof PlanToolInputSchema>, 'flat' | 'tiers' | 'realBody'> & FlatLevels

/** What the tool returns once the person answers on the card. */
export interface PlanAnswer {
  planId: string
  accepted: boolean
  /** Approved as shown with nobody asked: a part at its default size that fits nothing the person has. */
  auto?: true
  /** The plan with the person's edits, when they changed anything before Go, or when the card raised a size. */
  edits?: PartPlan
  /** For an approved plan with printInPlace: the smallest gaps moving pieces need on this printer, per side. */
  gaps?: { sideMm: number; verticalMm: number }
  /** The sizes the card raised to the printer's floors before the person saw it, each from what to what and why. */
  raised?: { feature: string | null; size: string; from: number; to: number; why: string; pin?: number; bore?: number }[]
  /** For an amend the person approved: the plan's revision now, and each size it changed. */
  revision?: number
  changes?: AmendChange[]
  /** For an amend: the plan fields it sent otherwise than the plan has them, which the plan keeps as approved. */
  ignored?: string[]
  /**
   * The sizes the person set on the card under this printer's smallest, which the plan keeps as they set them: each
   * by feature and size, its plain name ("Lid wall"), the size planned, the floor and why.
   */
  underFloors?: { feature: string | null; size: string; name: string; planned: number; floor: number; why: string }[]
}

/** An amend waiting on the card or answered: the plan it amends, as approved, and the build's reason. */
export interface PlanAmend {
  /** The approved plan's id; the card's own id for the amend is amendId(planId, revision). */
  planId: string
  /** The approved plan as it was before the amend. */
  was: PartPlan
  why: string
  /** The revision the plan gets on Go. */
  revision: number
}

/** The card's id for an amend: the plan's id and the revision it would make, "plan_1~r2". */
export const amendId = (planId: string, revision: number): string => `${planId}~r${revision}`

/** The amends the card keeps for showing again (a saved conversation's cards). */
const AMENDS_KEEP = 50
/** The parts whose refused plans' asked sizes the card keeps (unheldAsked); the oldest goes first. */
const UNHELD_KEEP = 50

/** The fit rule's smallest print-in-place gaps for a 0.4 mm nozzle in PLA, as design.plan's text names them. */
const RULE = printInPlaceClearance()
const n = (v: number): string => `${Math.round(v * 1000) / 1000}`
const RULE_MIN = `at least ${n(RULE.sideMm)} mm side by side and ${n(RULE.verticalMm)} mm above or below`
const RULE_GAPS = `${RULE_MIN} (${n(RULE.nozzleMm)} mm nozzle, ${RULE.material.toUpperCase()})`

/** A stacked feature's support, so its height is measured from it; design.check holds the build to it. */
export const STANDS_ON_HELP = 'A stacked feature names in on the feature it stands on, its height planned above that one, and each part that makes the outline readable from afar has a real size.'

/**
 * Pieces that print in place are placed at their joints from the start: a layout chosen after the bodies are built (a
 * ring of pieces or a block of them) moves every piece, and design.check fails a piece 2 mm or more from every other.
 */
export const JOINT_LAYOUT_HELP =
  'Settle where they join before building any piece: ask any choice that moves a joint (pilot.ask) before the plan, say in an assumption which piece joins which, and build each piece at its joint, its planned gap from the piece it joins, never laid loose to join later.'

/** The registry keeps this many plans; the oldest goes first. */
export const PLAN_KEEP = MAX_PLANS

/** A value with every object's keys in order, so two plans compare by content alone. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}

/** True when two plans say the same thing, whatever order their keys came in. */
export function samePlan(a: PartPlan, b: PartPlan): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** The answers a plan card sends back on the question channel. */
export const PLAN_GO = 'go'
export const PLAN_CHANGE = 'change'

/** The choice ids of a plan's question carry its id, so the chat can tell the card from an ordinary question. */
export function planChoiceId(answer: typeof PLAN_GO | typeof PLAN_CHANGE, planId: string): string {
  return `${answer}:${planId}`
}

let counter = 0

function newPlanId(): string {
  counter = (counter + 1) % 1_000_000
  return `plan_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * The card plans over `plans`: design.plan, the plans it made (each as mimir first showed it and as last edited), and
 * the tie from the plan the person last approved to the design its part is built in. One per registry: the app's tab
 * makes one over its window's registry, the creative eval one per run.
 */
export function createCardPlans(plans: PlanRegistry) {
  /** Each chat's size lookups (design.lookup_sizes), which design.plan holds real sizes to. */
  const lookups = createLookupStore()
  /** Where a plan made in this chat may take its real sizes from. */
  const realSources = (ctx: ToolContext): RealSources => ({
    canLookUp: ctx.web !== undefined,
    lookup: (id) => lookups.get(id, ctx.sessionId),
    lookups: () => lookups.of(ctx.sessionId),
    said: ctx.said?.(),
  })
  /**
   * Per chat and part, the sizes a refused plan of that part was asked to give as real or name as not given by the
   * source (unheldAsks), until a plan of it is shown. The next plan may then name them so, as the refusal asked, though
   * no lookup listed them as missing; the not-asked rule holds every other size to a lookup as before.
   */
  const unheldAsked = new Map<string, Set<string>>()
  const chainKey = (ctx: ToolContext, part: string): string => `${ctx.sessionId}\0${part.trim().toLowerCase()}`
  /** Each plan as mimir first showed it, before any edit, while the registry still keeps the plan. */
  const shownPlans = new Map<string, PartPlan>()
  /** The plan the person last approved whose part is not built yet: the next design built ties to it. */
  let unbuilt: string | null = null
  /** Each amend shown on a card, by its own id (amendId): the plan as it would be, as first shown, and what it amends. */
  const amends = new Map<string, PlanAmend & { plan: PartPlan; shown: PartPlan }>()

  /** The card's own entry for this id: a plan an MCP client put (design.put_plan) is never the person's. */
  function cardEntry(planId: string) {
    const entry = plans.get(planId)
    return entry?.origin === 'card' ? entry : undefined
  }

  function remember(plan: PartPlan): void {
    plans.put(plan, undefined, 'card')
    shownPlans.set(plan.planId, structuredClone(plan))
    for (const id of shownPlans.keys()) if (!cardEntry(id)) shownPlans.delete(id)
  }

  /** The card plan with this id, as last edited, or null (also for a plan an MCP client put). */
  function planById(planId: string): PartPlan | null {
    return cardEntry(planId)?.plan ?? amends.get(planId)?.plan ?? null
  }

  /** The amend a card id stands for, or null for a plan's own card. */
  function amendOf(id: string): PlanAmend | null {
    const a = amends.get(id)
    return a ? { planId: a.planId, was: a.was, why: a.why, revision: a.revision } : null
  }

  /** The plan with this id as mimir first showed it, before any edit, or null. */
  function shownPlan(planId: string): PartPlan | null {
    return cardEntry(planId) ? (shownPlans.get(planId) ?? null) : (amends.get(planId)?.shown ?? null)
  }

  /** Records edits to a plan (sizes typed on its card); ignored for an unknown id or a plan of another shape. */
  function editPlan(planId: string, next: PartPlan): boolean {
    // an amend's card takes edits to its sizes only, held apart from the approved plan until Go
    const amend = amends.get(planId)
    if (amend) {
      const ok = PartPlanSchema.safeParse(next)
      if (!ok.success || next.planId !== planId || amendShapeProblem(amend.was, ok.data)) return false
      amend.plan = ok.data
      return true
    }
    const entry = cardEntry(planId)
    if (!entry || next.planId !== planId) return false
    const ok = PartPlanSchema.safeParse(next)
    if (!ok.success) return false
    plans.put(ok.data, entry.design, 'card')
    return true
  }

  /** The approved plan the next design built ties to, or null (tests). */
  function unbuiltPlan(): string | null {
    return unbuilt
  }

  /** Forgets every plan (tests). */
  function clearPlans(): void {
    plans.clear()
    shownPlans.clear()
    amends.clear()
    lookups.clear()
    unheldAsked.clear()
    unbuilt = null
  }

  /**
   * Ties the approved plan to the design its part is built in, once a tool builds it: the design design.new starts, or
   * the design a geometry step changes. design.check then checks that design, whatever else is open.
   */
  function tieBuiltPart(tool: { name: string; permission: string }, input: unknown, out: ToolOutput): void {
    if (!unbuilt || out.ok === false) return
    // the design id the step reports, so a design given by its name ties by its id; else the one it was given
    const made = (out.output as { design?: unknown } | undefined)?.design
    let design: unknown
    if (tool.name === 'design.new') design = made
    else if (tool.name.startsWith('geom.') && tool.permission !== 'read') design = typeof made === 'string' && made ? made : (input as { design?: unknown } | undefined)?.design
    if (typeof design !== 'string' || !design) return
    if (plans.tie(unbuilt, design)) unbuilt = null
  }

  /** The tools with tieBuiltPart after each run. */
  function withPlanTies(tools: readonly PilotTool<never>[]): PilotTool<never>[] {
    return tools.map((t) => {
      if (t.name !== 'design.new' && !t.name.startsWith('geom.')) return t
      const run = t.run.bind(t)
      return {
        ...t,
        async run(input: never, ctx: Parameters<typeof t.run>[1]): Promise<ToolOutput> {
          const out = await run(input, ctx)
          tieBuiltPart(t, input, out)
          return out
        },
      }
    })
  }

  /** The plan id behind a question's choices, when the question is a plan card made here; otherwise null. */
  function planOfChoices(choices: readonly { id: string }[]): string | null {
    const go = choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))
    if (!go) return null
    const planId = go.id.slice(PLAN_GO.length + 1)
    return cardEntry(planId) || amends.has(planId) ? planId : null
  }

  /**
   * `newId` names each plan (tests, and the eval, whose recorded replies name their plans); by default a random plan_ id.
   * `fitProfile` is what design.check holds a print-in-place part's gaps to (the printer's nozzle, layer height and
   * material); what it leaves out comes from the run's machine. The plan's sizes are held to the same printer's floors
   * (plan-floors.ts).
   */
  /**
   * The approved plan a part of this name is already built from, in an open design that has a body: the person's plan
   * (not stale or set aside) tied to it. A new plan for that part would start it over; it is fixed in its design instead.
   * A plan of another shape (a feature or row of holes more or less) is what amends cannot make, so the caller lets it
   * through while the fix round is open.
   */
  function builtPlanOf(part: string, designs: readonly { id: string; name: string; parts: readonly unknown[] }[]): { planId: string; design: string; closed: boolean; plan: PartPlan } | null {
    const name = part.trim().toLowerCase()
    for (const d of designs) {
      if (!d.parts.length) continue
      for (const planId of plans.tiedTo(d.id)) {
        const entry = cardEntry(planId)
        if (entry && !entry.stale && !entry.superseded && entry.plan.part.trim().toLowerCase() === name) return { planId, design: d.name, closed: !!entry.closed, plan: entry.plan }
      }
    }
    return null
  }

  /**
   * `designs` is the open designs, for refusing a second plan of a part already built from an approved one; without it
   * no plan is refused for that.
   */
  function planTool(opts: { newId?: () => string; fitProfile?: () => FitProfile; designs?: () => readonly { id: string; name: string; parts: readonly unknown[] }[]; bed?: () => Bed | undefined } = {}): PilotTool<never> {
    return defineTool({
      name: 'design.plan',
      version: '1.22.0',
      source: 'command',
      permission: 'read',
      description:
        `Before the first geometry step of a part with two or more features, show the person the plan. It waits for their Go only when a size must fit something (a sheet with fits) or pieces print assembled and move; any other plan, at its default size, is approved as shown at once, so build it then. Say its detail: display for a model of a real thing named without sizes (the default), basic when the person asks for simple, basic or nothing fancy, fine when they ask for detailed or accurate; the card names it and the person can change it there. A display plan names the features that build its main bodies, by their feature names, in curved when the real thing is curved and in flat when it is flat-sided; a curved body is a loft through at least ${SECTIONS_FLOOR.display} smooth sections (${SECTIONS_FLOOR.fine} at fine; a revolve or a sweep where that fits), with the count as a size named sections on that feature, never one extrude (each section at least two nozzle widths across at every point, the end ones too, so a bow or a nose ends on a narrow rounded section, not a knife edge), while a flat-sided one (a house, a bookshelf) can be extruded; it gives proportions, from a lookup or a stated source; it lists repeats, the real object's repeated details (windows, slats, vents, rivets), each built once and patterned (kind array); with no size from the person it fills about 85% of this printer's bed (its longest side, held to the other side and the height; 256 mm when no printer is chosen), so size it from the bed and set scale from that, and set personSize when the person gave the size (a functional part takes its real size from what it fits or holds; ask only when that cannot be known, once, then build); it gives scale (N of 1:N) and real, the real sizes in mm that design.lookup_sizes found before the sheet (the main body's and each part's), each with its lookupId and held to scale within about a third; no part has more bulk than the main body (one may run longer, as a neck, an arm or a mast does), or is taller than the whole; each flat-sided main body in flat lists its levels from the bottom up, each its own feature (a body built in steps or stories is planned as its levels); it plans color only when the person asks for it (in the request or a follow-up), and otherwise gives no colors, so the part prints in one default filament; when they ask, it gives colors, each feature's color (every body in curved or flat, and every level of a flat one, including any added to reach the feature count), with a body painted in two or more colors built in its lightest large color and each darker band its own feature, with its color and its heights as sizes, painted on by height; and it has at least ${FEATURES_FLOOR.display} features (${FEATURES_FLOOR.fine} at fine, ${LONG_EXTRA} more for an object ${LONG_RATIO} or more times as long as its next size, one more for each repeated detail past three). A display or fine plan that misses one is refused with what to plan instead; design.check then fails a curved body whose sections only grow or shrink one way while their top and bottom stay put. ${DETAIL_HELP}. ${STANDS_ON_HELP} The plan has: the part, its units, each feature in build order with the sizes that drive it (and its kind, such as extrude, loft, hole, fillet or array; in kinds, count or angle for every size that is a count or an angle, such as teeth: count or draft: angle, since a size with none is read by its name), the overall size and holes when known (one row with a count for several holes of one size; a thing made of parts in different colors, such as a two color tag, a toy house or a car, is planned assembled as it looks finished, one part per color, with the overall size of the whole, never as pieces laid apart unless the person asked for that), what you assumed, what you still need to know, the real thing's details you left out in leftOut (noun phrases only), and, when pieces of the part print assembled and move (hinges, chains, gears, jointed, articulated or flexi segments), those pieces by name in printInPlace, and keep the gaps where they meet ${RULE_GAPS}; plan each gap ${n(GAP_MARGIN_MM)} mm over that, since a round face is drawn as flat facets that sit a little closer than its circle; an approved plan's result gives this printer's. A change to existing features (a tilt, a move, a color) is a feature with no part of its own: never add a part to give it one. ${JOINT_LAYOUT_HELP} Two or more pieces (named in printInPlace, or counted by a size such as segment_count) with a gap or clearance size print in place unless printInPlace is false or an assumption says the pieces print separately. A size under the smallest this printer makes (a gap on each side between pieces, held to the side by side gap unless they print in place, with the bore it gives around a pin; a wall or pin under two nozzle lines; a hole under the nozzle) is raised on the card with a line saying why. A plan with a hinge or a pin piece says whether it prints assembled on its hinge (printInPlace) or laid apart (an assumption); one that says neither, or both, is refused. On a plan that waits, the person edits sizes on the card and presses Go. Returns the plan id, whether it was accepted, the edited plan when they changed anything or a size was raised (build from that), and raised, each size raised from what to what, and underFloors, each size the person kept under this printer's smallest. Not accepted: build nothing and ask what to change. A part of one feature skips the plan. Once the part is built and the build finds an approved size it cannot keep, call it again with amends (the plan's planId) and reason (why, in a sentence the person reads): the person sees the changed sizes beside the old ones, raised to this printer's floors as a new plan's are, and presses Go or Not yet. It keeps every planned feature, may add features, and may move a feature onto another planned one (on) when the part was built on that one; once per fix round and never after the stop result; Go keeps the planId and its fix round and returns revision and changes, Not yet leaves the plan as approved. For a change the person asked for once the part is built (a size, a detail added), call it with amends and, with asked, the person's words for a change they asked for, and no reason: the change goes into the plan with no card, since their message is the go, it may add features, and the fix round starts again; then make the change in the design. A new plan that only changes the sizes of a part already built from an approved plan is refused: fix the part in its design, or change the sizes with amends.`,
      localDescription:
        `Before building a part with 2+ features, show the plan and wait: part, units, features in build order with sizes and kind (kinds: count or angle for each such size), overall and holes if known, assumptions, questions. printInPlace pieces: keep the gaps where they meet ${RULE_MIN}, planned ${n(GAP_MARGIN_MM)} mm over that; pieces with a gap size print in place unless printInPlace is false. Build from the accepted plan, else ask. More: kb.search "modeling tools".`,
      input: PlanToolInputSchema,
      // a local model plans and builds; changing an approved plan is for a cloud model, whose context holds its rules
      localInput: LocalPlanInputSchema,
      args: (i) => (i.features ? `"${i.part ?? ''}", ${i.features.length} feature${i.features.length === 1 ? '' : 's'}${i.amends ? `, amends ${i.amends}` : ''}` : `amends ${i.amends ?? ''}${i.changes ? `, ${i.changes.length} size${i.changes.length === 1 ? '' : 's'}` : ''}${i.add ? `, ${i.add.length} added` : ''}`),
      async run(sent, ctx) {
        // flat bodies given with their levels read as the names and tiers the rules and the card take, and the main
        // body's real size as its row in real
        const i: PlanToolInput = withRealBody(flatLevels(sent, sent.features ?? (sent.amends !== undefined ? (planById(sent.amends)?.features ?? []) : [])))
        if (!ctx.ask) return { ok: false, summary: 'Nobody here can approve a plan' }
        // a plan waits for the person's Go only when its sizes must fit something (a sheet with fits) or its pieces print
        // assembled and move; any other, at its default size, shows on its card and is approved as shown at once
        const waits = (p: PlanInput | PartPlan): boolean => ctx.confirmsPlan?.() === true || printsTogether(p) || (Array.isArray(p.printInPlace) && p.printInPlace.length > 0)
        const askFor = (p: PlanInput | PartPlan): NonNullable<ToolContext['ask']> => (q) => ctx.ask!(q, waits(p) ? undefined : { auto: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id })
        // sizes under the printer's floors are raised before the card shows, so the plan approved is one the build can
        // match; the gaps are the ones design.check holds the part to
        const limits = runFitLimits(ctx.context, opts.fitProfile?.())
        const floors = planFloors(limits)
        if (i.amends !== undefined) return i.asked !== undefined ? askedChange(i, i.amends, i.asked, floors, limits) : amend(i, i.amends, askFor, floors, limits)
        if (i.reason !== undefined) throw new ToolInputError('reason: give a reason only with amends, to change an approved plan')
        if (i.asked !== undefined) throw new ToolInputError('asked: only with amends, for a change the person asked for to a plan already built')
        if (i.changes !== undefined || i.add !== undefined) throw new ToolInputError(`${i.changes !== undefined ? 'changes' : 'add'}: only with amends, to change a plan already built`)
        // the schema holds a first plan to its part, units and features
        const { amends: _a, reason: _r, asked: _k, changes: _c, add: _d, ...rest } = i
        const input = { ...rest, assumptions: rest.assumptions ?? [], questions: rest.questions ?? [] } as PlanInput
        // a part built from an approved plan is fixed where it is; planning it again would start it over
        const built = opts.designs ? builtPlanOf(input.part, opts.designs()) : null
        // a new plan of the same shape changes sizes only, which amends does without starting the part over
        if (built && (built.closed || !amendShapeProblem(built.plan, { ...input, part: built.plan.part })))
          throw new ToolInputError(
            built.closed
              ? `${input.part} is already built from the approved plan ${built.planId} in the open design ${built.design}, and its check used the fix round. Make no new plan: stop and tell the person exactly what is off.`
              : `${input.part} is already built from the approved plan ${built.planId} in the open design ${built.design}. Fix it there rather than planning it again: design.undo or design.edit_step for a step that went wrong, design.plan with amends ${built.planId} and a reason for a planned size the build cannot keep, and with amends and asked for a change the person asked for. If the person asked for a second part, give it another name.`,
          )
        // a hinged part says one way its lid prints, so the build has nothing to guess
        const joint = jointProblem(input)
        if (joint) throw new ToolInputError(`assumptions: ${joint}`)
        // gears that turn in place mesh only at tooth counts that fit together; no tooth shape fixes one that does not
        const planets = planetsMiss(input)
        if (planets) throw new ToolInputError(PLANETS_CANNOT_MESH(planets))
        // a display or fine plan holds its level's rules before the person sees it, so the build follows a plan that can
        // look like the real thing
        const chain = chainKey(ctx, input.part)
        const real: RealSources = { ...realSources(ctx), asked: [...(unheldAsked.get(chain) ?? [])] }
        const detail = detailProblem(input, { bed: opts.bed?.() ?? DEFAULT_BED, printer: opts.bed?.() ? ctx?.context?.machine?.printer : undefined }, { local: ctx?.localForm === true, real })
        if (detail) {
          // the sizes this refusal asks for stand as not given by the source in the part's next plan
          const asks = ctx?.localForm === true ? [] : unheldAsks(input, real)
          if (asks.length) {
            unheldAsked.delete(chain)
            unheldAsked.set(chain, new Set([...(real.asked ?? []), ...asks]))
            for (const k of [...unheldAsked.keys()].slice(0, Math.max(0, unheldAsked.size - UNHELD_KEEP))) unheldAsked.delete(k)
          }
          throw new ToolInputError(detail)
        }
        unheldAsked.delete(chain)
        // real sizes taken from memory say so on the card, among what the plan assumed
        const memory = input.detail && input.detail !== 'basic' && ctx?.localForm !== true ? realMemoryNote(input, real) : null
        const noted = memory && !input.assumptions.includes(memory) ? { ...input, assumptions: [...input.assumptions, memory] } : input
        const { plan: raisedPlan, raised } = raiseToFloors(tidyPlan({ planId: (opts.newId ?? newPlanId)(), ...noted }), floors)
        // pieces that print together without printInPlace naming them: the card says so first, plainly
        const plan: PartPlan = printsTogether(input) ? { ...raisedPlan, assumptions: [PRINTS_TOGETHER, ...raisedPlan.assumptions] } : raisedPlan
        const shown = structuredClone(plan)
        remember(plan)
        const auto = !waits(plan)
        const picked = await askFor(plan)({
          title: 'Plan',
          question: `Build ${input.part} from this plan?`,
          choices: [
            { id: planChoiceId(PLAN_GO, plan.planId), label: 'Go' },
            { id: planChoiceId(PLAN_CHANGE, plan.planId), label: 'Not yet' },
          ],
        })
        const latest = planById(plan.planId) ?? shown
        // anything but Go is not approved: Not yet, and a dismissed card too
        if (picked.id !== planChoiceId(PLAN_GO, plan.planId)) {
          // an approved plan whose sizes the person changed since is superseded by this answer: no design ties to it
          if (unbuilt && plans.get(unbuilt)?.stale) unbuilt = null
          const answer: PlanAnswer = { planId: plan.planId, accepted: false }
          return { ok: false, summary: 'Not approved; build nothing until the plan is agreed', output: answer }
        }
        // the next design built is this plan's part
        unbuilt = plan.planId
        const edited = !samePlan(latest, shown)
        const answer: PlanAnswer = { ...(edited || raised.length ? { planId: plan.planId, accepted: true, edits: latest } : { planId: plan.planId, accepted: true }), ...(auto ? { auto: true as const } : {}) }
        return approved(answer, latest, { edited, raised, floors, limits, said: auto ? 'Approved as shown at its default size (it fits nothing the person has, so the card does not wait): build it now, and give its size in the reply; the person changes it after' : edited ? 'Approved with changes' : 'Approved as shown' })
      },
    }) as PilotTool<never>
  }

  /**
   * design.plan with amends: the approved plan with the sizes the build asks for, raised to the printer's floors as a
   * new plan's are, on a card of its own beside the old values and the build's reason. On Go the plan takes the sizes
   * under its own planId, keeping its design tie and fix round, and its revision goes up by one. On Not yet nothing
   * changes.
   */
  async function amend(i: PlanToolInput, planId: string, askFor: (p: PartPlan) => NonNullable<ToolContext['ask']>, floors: PlanFloors, limits: FitLimits): Promise<ToolOutput> {
    const reason = amendReason(i.reason)
    if ('problem' in reason) throw new ToolInputError(reason.problem)
    const entry = plans.get(planId)
    const problem = amendProblem(planId, entry, 'card')
    if (problem) throw new ToolInputError(problem)
    const was = entry!.plan
    // the plan as the amend sends it: the approved plan wherever it leaves a field out, with its changes on it
    const { next, problems, ignored } = amendBody(was, i)
    // every way the amend is off, in one refusal: its shape, a change that sets no planned size, nothing changed (no
    // size, no feature added and none moved onto another), and a row's recess it would not keep (refused, so the plan
    // never reads as changed with that dropped)
    const shape = amendShapeProblem(was, next)
    const unchanged = !shape && !problems.length && !amendChanges(was, next).length && !amendAdded(was, next).length && !amendOns(was, next).length ? `amends: no size differs from the approved plan ${planId}` : null
    const off = [shape, ...problems, unchanged, amendDropProblem(was, next, { fields: false })].filter((p): p is string => p !== null)
    if (off.length) throw new ToolInputError(off.join('. '))
    const revision = (entry!.revision ?? 1) + 1
    const id = amendId(planId, revision)
    // a size asked under its floor is raised as a new plan's is, with its line among the assumptions
    const { plan, raised } = raiseToFloors({ ...amendedSizes(was, next), planId: id }, floors)
    if (!amendChanges(was, plan).length && !amendAdded(was, plan).length && !amendOns(was, plan).length) {
      const back = raised.map((u) => `${underName(u)} stays ${raisedText(u, was.units)}, ${raisedWhy(u)}`).join('; ')
      return { ok: false, summary: withIgnored(`Nothing changed: ${back}. Build to the plan as approved`, ignored), output: { planId, accepted: false, ...(ignored.length ? { ignored } : {}) } satisfies PlanAnswer }
    }
    amends.set(id, { planId, was: structuredClone(was), why: reason.why, revision, plan, shown: structuredClone(plan) })
    for (const k of [...amends.keys()].slice(0, Math.max(0, amends.size - AMENDS_KEEP))) amends.delete(k)
    // the card waits for Go as the approved plan's own card did
    const picked = await askFor(was)({
      title: 'Plan change',
      question: `Change the plan for ${was.part}?`,
      choices: [
        { id: planChoiceId(PLAN_GO, id), label: 'Go' },
        { id: planChoiceId(PLAN_CHANGE, id), label: 'Not yet' },
      ],
    })
    if (picked.id !== planChoiceId(PLAN_GO, id)) return { ok: false, summary: 'Not approved; the plan stays as approved. Build to it, or stop and tell the person what is off', output: { planId, accepted: false, ...(ignored.length ? { ignored } : {}) } satisfies PlanAnswer }
    // the plan was set aside or used its fix round while the card waited: nothing changes
    const now = amendProblem(planId, plans.get(planId), 'card')
    if (now) return { ok: false, summary: `Not changed: ${now.replace(/^amends: /, '')}`, output: { planId, accepted: false } satisfies PlanAnswer }
    const shown = amends.get(id)!.shown
    const card = amends.get(id)!.plan
    const latest: PartPlan = { ...card, planId }
    plans.put(latest, plans.get(planId)!.design, 'card')
    plans.amended(planId, reason.why)
    const changes = amendChanges(was, latest)
    const edited = !samePlan(card, shown)
    const answer: PlanAnswer = { planId, accepted: true, edits: latest, revision, changes, ...(raised.length ? { raised: raised.map(raisedOut) } : {}), ...(ignored.length ? { ignored } : {}) }
    const said = withIgnored(`Plan changed${edited ? ' with the person\'s edits' : ''} (revision ${revision})${changedText(was, latest)}. Build to it as changed`, ignored)
    return approved(answer, latest, { edited, raised, floors, limits, said })
  }

  /**
   * design.plan with amends and asked: a change the person asked for in their latest message, put into the approved
   * plan with no card (their message is the go). It may add features and is not held to the build's one amend per fix
   * round; the plan must be the person's, approved and built, and not set aside. The fix round starts again.
   */
  function askedChange(i: PlanToolInput, planId: string, words: string, floors: PlanFloors, limits: FitLimits): ToolOutput {
    if (i.reason !== undefined) throw new ToolInputError('reason: a change the person asked for takes their words in asked and no reason')
    const entry = plans.get(planId)
    if (!entry || entry.origin !== 'card') throw new ToolInputError(`amends: there is no plan the person approved with planId ${planId}`)
    if (entry.stale || entry.superseded) throw new ToolInputError('amends: the person changed sizes since that plan was approved; make a new plan with the sizes they set')
    if (!entry.design) throw new ToolInputError("amends: the plan's part is not built yet; build to the plan")
    const was = entry.plan
    const { next, problems, ignored } = amendBody(was, i)
    const off = [amendShapeProblem(was, next, { asked: true }), ...problems, amendDropProblem(was, next, { fields: false })].filter((p): p is string => p !== null)
    if (off.length) throw new ToolInputError(off.join('. '))
    const { plan, raised } = raiseToFloors({ ...amendedSizes(was, next), planId }, floors)
    const kept = ignored.length ? { ignored } : {}
    if (!amendChanges(was, plan).length && !amendAdded(was, plan).length && !amendKinds(was, plan).length && !amendOns(was, plan).length) return { summary: withIgnored('The plan stays as approved; make the change the person asked for in the design, then add any new feature to the plan with amends and asked', ignored), output: { planId, accepted: true, revision: entry.revision ?? 1, changes: [], ...kept } satisfies PlanAnswer }
    plans.put(plan, entry.design, 'card')
    const revision = plans.asked(planId, words)
    const changes = amendChanges(was, plan)
    const answer: PlanAnswer = { planId, accepted: true, edits: plan, revision, changes, ...(raised.length ? { raised: raised.map(raisedOut) } : {}), ...kept }
    return approved(answer, plan, { edited: false, raised, floors, limits, said: withIgnored(`Plan changed as asked (revision ${revision})${changedText(was, plan)}. Build to it as changed`, ignored) })
  }

  /** An approved plan's result: the raised sizes, sizes the person set under their floors, and a print-in-place part's gaps. */
  function approved(answer: PlanAnswer, latest: PartPlan, o: { edited: boolean; raised: UnderFloor[]; floors: PlanFloors; limits: FitLimits; said: string }): ToolOutput {
    const { edited, raised, floors, limits, said } = o
    if (raised.length) answer.raised = raised.map(raisedOut)
    const together = printsTogether(latest)
    const inPlace = together || (Array.isArray(latest.printInPlace) && latest.printInPlace.length >= 2)
    // a size the person typed back under its floor is theirs to keep; the result says so, so the build follows it
    // knowingly. A print-in-place part's gaps are named with the gaps this printer needs, below.
    const under = edited ? underFloors(latest, floors).filter((u) => !(inPlace && u.what === 'gap')) : []
    const notes = [
      ...(raised.length ? [`The card raised ${raised.map((u) => `${underName(u)} to ${raisedText(u, latest.units)}`).join(', ')} to this printer's smallest sizes; build from edits`] : []),
      ...(under.length ? [`${under.map((u) => underLine(u, latest.units)).join('; ')}; the person set it on the card`] : []),
    ]
    if (under.length) answer.underFloors = under.map(underRow)
    if (!inPlace) return { summary: [said, ...notes].join('. '), output: answer }
    // a print-in-place part: the gaps this printer needs before the first step, and any planned gap under them
    const gapsUnder = plannedGaps(latest, limits).filter((g) => !g.pass)
    const summary = `${said}.${together ? ` ${PRINTS_TOGETHER}.` : ''} Moving pieces need gaps of ${gapLimitsText(limits)} on this printer.${gapsUnder.length ? ` ${gapsUnder.map((g) => g.text).join('; ')}` : ''}`
    return { summary: notes.length ? `${summary.replace(/\.$/, '')}. ${notes.join('. ')}` : summary, output: { ...answer, gaps: { sideMm: limits.sideMm, verticalMm: limits.verticalMm } } }
  }

  /** design.lookup_sizes over this card's lookups. */
  function lookupTool(): PilotTool<never> {
    return lookupSizesTool(lookups)
  }

  return { plans, lookups, planById, shownPlan, amendOf, editPlan, unbuiltPlan, clearPlans, tieBuiltPart, withPlanTies, planOfChoices, planTool, lookupTool }
}

export type CardPlans = ReturnType<typeof createCardPlans>

/** What an amend changed, in plain words: each size, then each feature it added. */
function changedText(was: PartPlan, now: PartPlan): string {
  const said = [...amendKinds(was, now), ...amendOnsText(was, now), ...amendChanges(was, now).map((c) => changeText(c, now.units)), ...amendAdded(was, now).map((n) => `added ${n}`)].join(', ')
  return said ? `: ${said}` : ''
}

/** A result's words with the fields its amend ignored named after them. */
const withIgnored = (said: string, ignored: readonly string[]): string => (ignored.length ? `${said}. ${IGNORED_NOTE(ignored)}` : said)

/** A size the person kept under its floor, as design.plan's answer gives it. */
function underRow(u: UnderFloor): NonNullable<PlanAnswer['underFloors']>[number] {
  return { feature: u.feature, size: u.feature === null ? `${u.hole} ${u.size}` : u.size, name: underName(u), planned: u.planned, floor: u.floor, why: u.why }
}

/** A raised size as design.plan's answer gives it. */
function raisedOut(u: UnderFloor): NonNullable<PlanAnswer['raised']>[number] {
  return { feature: u.feature, size: u.feature === null ? `${u.hole} ${u.size}` : u.size, from: u.planned, to: u.to, why: raisedWhy(u), ...(u.toBore !== undefined ? { pin: u.pin!, bore: u.toBore } : {}) }
}

/**
 * The design toolset's tools the tab leaves out. design.put_plan keeps a client plan with no card, and design.get_plan
 * reads one back, for MCP clients:
 * plans in the tab are made on the card. design.trace_image waits for now, since in the tab the person traces with the
 * sketch tool's dialog. design.save and design.open write and read 3MF files, which the tab has none of: a design there
 * stays on the plate, and saving the project is the person's, so offered, they only refused, and a reply called save
 * to finish a part.
 */
export const TAB_LEAVES_OUT: readonly string[] = ['design.put_plan', 'design.get_plan', 'design.trace_image', 'design.save', 'design.open']

/**
 * The tab's tools: its own (the question, the lookup card, the dimension sheet and its binding, and `plan`), then
 * `extra` (the design toolset) without the tools in TAB_LEAVES_OUT. The tab's own tools win.
 */
export function mimirTabTools(plan: PilotTool<never>, extra: readonly PilotTool<never>[] = [], lookupSizes?: PilotTool<never>): PilotTool<never>[] {
  const own = [askTool({ sizesOnSheet: true }), lookupTool(), sheetTool(), sheetBindTool(), plan, ...(lookupSizes ? [lookupSizes] : [])]
  const names = new Set([...own.map((t) => t.name), ...TAB_LEAVES_OUT])
  return [...own, ...extra.filter((t) => !names.has(t.name))]
}
