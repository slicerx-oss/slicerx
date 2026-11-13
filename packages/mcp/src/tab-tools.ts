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
import { AMEND_REASON_MAX, amendAdded, amendChanges, amendKinds, amendedSizes, amendProblem, amendReason, amendShapeProblem, changeText, type AmendChange } from './plan-amend'
import { type Bed, DEFAULT_BED, DETAIL_HELP, DETAIL_LEVELS, detailProblem, FEATURES_FLOOR, LONG_EXTRA, LONG_RATIO, SECTIONS_FLOOR } from './plan-detail'
import { GAP_MARGIN_MM, jointProblem, planFloors, raisedText, raisedWhy, raiseToFloors, underFloors, underLine, underName, type PlanFloors, type UnderFloor } from './plan-floors'

export { PLAN_SIZE_MAX, type PartPlan }

/**
 * A part's plan as the card takes it: the shared shape (design-check.ts, which design.check reads), with one feature at
 * least, and without openFaces, which only design.put_plan takes for now.
 */
export const PartPlanSchema = partPlanSchema.extend({ features: partPlanSchema.shape.features.min(1) }).omit({ openFaces: true })

/** What mimir sends: the plan without its id, which the tool gives it, and with no room for the card's own line. */
export const PlanInputSchema = PartPlanSchema.omit({ planId: true }).extend({
  assumptions: assumptionsInput,
  personSize: z.boolean().optional().describe("True when the person's words gave the size (a length, a scale, \"fits in my hand\"): the plan keeps it. Without it, a display or fine model is planned to fill about 85% of this printer's bed"),
})

/**
 * What a local model sends: the plan without the detail level's other fields, colors, scale and tiers, since a local
 * model's window holds the tab's tools within a few hundred tokens (packages/app test/mimir-local-context.test.ts) and
 * its prompt has no detail line. The level itself stays, bare, so the local form takes every value the full one does.
 * The tool still takes every field, and a plan without a detail level is checked as before.
 */
export const LocalPlanInputSchema = PlanInputSchema.omit({ curved: true, flat: true, proportions: true, repeats: true, colors: true, scale: true, real: true, tiers: true, personSize: true }).extend({
  detail: z.enum(DETAIL_LEVELS).optional(),
  // a hole row's recess flag stays off a local model's list too; the tool takes it either way
  holes: z.array(PlanInputSchema.shape.holes.unwrap().element.omit({ recess: true }).extend({ count: PlanInputSchema.shape.holes.unwrap().element.shape.count.describe('Holes the row stands for; default 1') })).max(60).optional(),
  // the pieces' examples stay on the full text; the field takes the same values
  printInPlace: PlanInputSchema.shape.printInPlace.describe('Pieces that print assembled and move, by name; false if they print separately'),
})

export type PlanInput = z.infer<typeof PlanInputSchema>

/** design.plan's input: the plan, and for a change to an approved plan, the plan it amends and why (plan-amend.ts). */
export const PlanToolInputSchema = PlanInputSchema.extend({
  amends: z.string().trim().min(1).max(64).optional().describe("Only to change a plan the person approved, once its part is built: that plan's planId. Leave it out of a first plan"),
  reason: z.string().max(AMEND_REASON_MAX).optional().describe('Only with amends: why the build changes the approved plan, in a sentence the person reads. A first plan takes none'),
  asked: z.string().trim().min(1).max(AMEND_REASON_MAX).optional().describe("Only with amends, for a change the person asked for in their latest message (a size, a detail added): their words. It goes in with no card, since their message is the go, and may add features; give no reason"),
})
type PlanToolInput = z.infer<typeof PlanToolInputSchema>

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
      version: '1.13.0',
      source: 'command',
      permission: 'read',
      description:
        `Before the first geometry step of a part with two or more features, show the person the plan. It waits for their Go only when a size must fit something (a sheet with fits) or pieces print assembled and move; any other plan, at its default size, is approved as shown at once, so build it then. Say its detail: display for a model of a real thing named without sizes (the default), basic when the person asks for simple, basic or nothing fancy, fine when they ask for detailed or accurate; the card names it and the person can change it there. A display plan names the features that build its main bodies, by their feature names, in curved when the real thing is curved and in flat when it is flat-sided; a curved body is a loft through at least ${SECTIONS_FLOOR.display} smooth sections (${SECTIONS_FLOOR.fine} at fine; a revolve or a sweep where that fits), with the count as a size named sections on that feature, never one extrude (each section at least two nozzle widths across at every point, the end ones too, so a bow or a nose ends on a narrow rounded section, not a knife edge), while a flat-sided one (a house, a bookshelf) can be extruded; it gives proportions, from a lookup or a stated source; it lists repeats, the real object's repeated details (windows, slats, vents, rivets), each built once and patterned (kind array); with no size from the person it fills about 85% of this printer's bed (its longest side, held to the other side and the height; 256 mm when no printer is chosen), so size it from the bed and set scale from that, and set personSize when the person gave the size (a functional part takes its real size from what it fits or holds; ask only when that cannot be known, once, then build); it gives scale (N of 1:N) and real, the real sizes in mm the lookup or stated source gives (the main body's and each part's it has), each held to scale within about a third; no part is wider or longer than the main body, or taller than the whole; each flat-sided main body lists its tiers, its levels from the bottom up, each its own feature (a body built in steps or stories is planned as its levels); it plans color only when the person asks for it (in the request or a follow-up), and otherwise gives no colors, so the part prints in one default filament; when they ask, it gives colors, each feature's color (every body in curved or flat, and every flat one its tiers, including any added to reach the feature count), with a body painted in two or more colors built in its lightest large color and each darker band its own feature, with its color and its heights as sizes, painted on by height; and it has at least ${FEATURES_FLOOR.display} features (${FEATURES_FLOOR.fine} at fine, ${LONG_EXTRA} more for an object ${LONG_RATIO} or more times as long as its next size, one more for each repeated detail past three). A display or fine plan that misses one is refused with what to plan instead; design.check then fails a curved body whose sections only grow or shrink one way while their top and bottom stay put. ${DETAIL_HELP}. ${STANDS_ON_HELP} The plan has: the part, its units, each feature in build order with the sizes that drive it (and its kind, such as extrude, loft, hole, fillet or array; in kinds, count or angle for every size that is a count or an angle, such as teeth: count or draft: angle, since a size with none is read by its name), the overall size and holes when known (one row with a count for several holes of one size; a thing made of parts in different colors, such as a two color tag, a toy house or a car, is planned assembled as it looks finished, one part per color, with the overall size of the whole, never as pieces laid apart unless the person asked for that), what you assumed, what you still need to know, and, when pieces of the part print assembled and move (hinges, chains, gears, jointed, articulated or flexi segments), those pieces by name in printInPlace, and keep the gaps where they meet ${RULE_GAPS}; plan each gap ${n(GAP_MARGIN_MM)} mm over that, since a round face is drawn as flat facets that sit a little closer than its circle; an approved plan's result gives this printer's. ${JOINT_LAYOUT_HELP} Two or more pieces (named in printInPlace, or counted by a size such as segment_count) with a gap or clearance size print in place unless printInPlace is false or an assumption says the pieces print separately. A size under the smallest this printer makes (a gap on each side between pieces, held to the side by side gap unless they print in place, with the bore it gives around a pin; a wall or pin under two nozzle lines; a hole under the nozzle) is raised on the card with a line saying why. A plan with a hinge or a pin piece says whether it prints assembled on its hinge (printInPlace) or laid apart (an assumption); one that says neither, or both, is refused. On a plan that waits, the person edits sizes on the card and presses Go. Returns the plan id, whether it was accepted, the edited plan when they changed anything or a size was raised (build from that), and raised, each size raised from what to what. Not accepted: build nothing and ask what to change. A part of one feature skips the plan. Once the part is built and the build finds an approved size it cannot keep, call it again with amends (the plan's planId) and reason (why, in a sentence the person reads): the person sees the changed sizes beside the old ones, raised to this printer's floors as a new plan's are, and presses Go or Not yet. It keeps every planned feature and may add features; once per fix round and never after the stop result; Go keeps the planId and its fix round and returns revision and changes, Not yet leaves the plan as approved. For a change the person asked for once the part is built (a size, a detail added), call it with amends and, with asked, the person's words for a change they asked for, and no reason: the change goes into the plan with no card, since their message is the go, it may add features, and the fix round starts again; then make the change in the design. A new plan that only changes the sizes of a part already built from an approved plan is refused: fix the part in its design, or change the sizes with amends.`,
      localDescription:
        `Before building a part with 2+ features, show the plan and wait: part, units, features in build order with sizes and kind (kinds: count or angle for each such size), overall and holes if known, assumptions, questions. printInPlace pieces: keep the gaps where they meet ${RULE_MIN}, planned ${n(GAP_MARGIN_MM)} mm over that; pieces with a gap size print in place unless printInPlace is false. Build from the accepted plan, else ask. More: kb.search "modeling tools".`,
      input: PlanToolInputSchema,
      // a local model plans and builds; changing an approved plan is for a cloud model, whose context holds its rules
      localInput: LocalPlanInputSchema,
      // a change the person asked for, sent with only their words, takes the approved plan as its body
      fill: (raw) => {
        const r = raw as Record<string, unknown> | null
        if (!r || typeof r !== 'object' || typeof r['amends'] !== 'string' || typeof r['asked'] !== 'string' || r['features'] !== undefined) return raw
        const kept = planById(r['amends'])
        if (!kept) return raw
        const { planId: _p, ...body } = kept
        return { ...body, ...r }
      },
      args: (i) => `"${i.part}", ${i.features.length} feature${i.features.length === 1 ? '' : 's'}${i.amends ? `, amends ${i.amends}` : ''}`,
      async run(i, ctx) {
        if (!ctx.ask) return { ok: false, summary: 'Nobody here can approve a plan' }
        // a plan waits for the person's Go only when its sizes must fit something (a sheet with fits) or its pieces print
        // assembled and move; any other, at its default size, shows on its card and is approved as shown at once
        const waits = (p: PlanInput | PartPlan): boolean => ctx.confirmsPlan?.() === true || printsTogether(p) || (Array.isArray(p.printInPlace) && p.printInPlace.length > 0)
        const askFor = (p: PlanInput | PartPlan): NonNullable<ToolContext['ask']> => (q) => ctx.ask!(q, waits(p) ? undefined : { auto: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id })
        // sizes under the printer's floors are raised before the card shows, so the plan approved is one the build can
        // match; the gaps are the ones design.check holds the part to
        const limits = runFitLimits(ctx.context, opts.fitProfile?.())
        const floors = planFloors(limits)
        if (i.amends !== undefined) return i.asked !== undefined ? askedChange(i, i.amends, i.asked, floors, limits) : amend(i, i.amends, askFor(planById(i.amends) ?? i), floors, limits)
        if (i.reason !== undefined) throw new ToolInputError('reason: give a reason only with amends, to change an approved plan')
        if (i.asked !== undefined) throw new ToolInputError('asked: only with amends, for a change the person asked for to a plan already built')
        const { amends: _a, reason: _r, asked: _k, ...input } = i
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
        // a display or fine plan holds its level's rules before the person sees it, so the build follows a plan that can
        // look like the real thing
        const detail = detailProblem(input, { bed: opts.bed?.() ?? DEFAULT_BED, printer: opts.bed?.() ? ctx?.context?.machine?.printer : undefined }, { local: ctx?.localForm === true })
        if (detail) throw new ToolInputError(detail)
        const { plan: raisedPlan, raised } = raiseToFloors(tidyPlan({ planId: (opts.newId ?? newPlanId)(), ...input }), floors)
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
  async function amend(i: PlanToolInput, planId: string, ask: NonNullable<ToolContext['ask']>, floors: PlanFloors, limits: FitLimits): Promise<ToolOutput> {
    const reason = amendReason(i.reason)
    if ('problem' in reason) throw new ToolInputError(reason.problem)
    const entry = plans.get(planId)
    const problem = amendProblem(planId, entry, 'card')
    if (problem) throw new ToolInputError(problem)
    const was = entry!.plan
    const shape = amendShapeProblem(was, i)
    if (shape) throw new ToolInputError(shape)
    if (!amendChanges(was, i).length && !amendAdded(was, i).length) throw new ToolInputError(`amends: no size differs from the approved plan ${planId}`)
    const revision = (entry!.revision ?? 1) + 1
    const id = amendId(planId, revision)
    // a size asked under its floor is raised as a new plan's is, with its line among the assumptions
    const { plan, raised } = raiseToFloors({ ...amendedSizes(was, i), planId: id }, floors)
    if (!amendChanges(was, plan).length && !amendAdded(was, plan).length) {
      const back = raised.map((u) => `${underName(u)} stays ${raisedText(u, was.units)}, ${raisedWhy(u)}`).join('; ')
      return { ok: false, summary: `Nothing changed: ${back}. Build to the plan as approved`, output: { planId, accepted: false } satisfies PlanAnswer }
    }
    amends.set(id, { planId, was: structuredClone(was), why: reason.why, revision, plan, shown: structuredClone(plan) })
    for (const k of [...amends.keys()].slice(0, Math.max(0, amends.size - AMENDS_KEEP))) amends.delete(k)
    const picked = await ask({
      title: 'Plan change',
      question: `Change the plan for ${was.part}?`,
      choices: [
        { id: planChoiceId(PLAN_GO, id), label: 'Go' },
        { id: planChoiceId(PLAN_CHANGE, id), label: 'Not yet' },
      ],
    })
    if (picked.id !== planChoiceId(PLAN_GO, id)) return { ok: false, summary: 'Not approved; the plan stays as approved. Build to it, or stop and tell the person what is off', output: { planId, accepted: false } satisfies PlanAnswer }
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
    const answer: PlanAnswer = { planId, accepted: true, edits: latest, revision, changes, ...(raised.length ? { raised: raised.map(raisedOut) } : {}) }
    const said = `Plan changed${edited ? ' with the person\'s edits' : ''} (revision ${revision}): ${changedText(was, latest)}. Build to it as changed`
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
    const shape = amendShapeProblem(was, i, { asked: true })
    if (shape) throw new ToolInputError(shape)
    const { plan, raised } = raiseToFloors({ ...amendedSizes(was, i), planId }, floors)
    if (!amendChanges(was, plan).length && !amendAdded(was, plan).length && !amendKinds(was, plan).length) return { summary: 'The plan stays as approved; make the change the person asked for in the design, then add any new feature to the plan with amends and asked', output: { planId, accepted: true, revision: entry.revision ?? 1, changes: [] } satisfies PlanAnswer }
    plans.put(plan, entry.design, 'card')
    const revision = plans.asked(planId, words)
    const changes = amendChanges(was, plan)
    const answer: PlanAnswer = { planId, accepted: true, edits: plan, revision, changes, ...(raised.length ? { raised: raised.map(raisedOut) } : {}) }
    return approved(answer, plan, { edited: false, raised, floors, limits, said: `Plan changed as asked (revision ${revision}): ${changedText(was, plan)}. Build to it as changed` })
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
    if (!inPlace) return { summary: [said, ...notes].join('. '), output: answer }
    // a print-in-place part: the gaps this printer needs before the first step, and any planned gap under them
    const gapsUnder = plannedGaps(latest, limits).filter((g) => !g.pass)
    const summary = `${said}.${together ? ` ${PRINTS_TOGETHER}.` : ''} Moving pieces need gaps of ${gapLimitsText(limits)} on this printer.${gapsUnder.length ? ` ${gapsUnder.map((g) => g.text).join('; ')}` : ''}`
    return { summary: notes.length ? `${summary.replace(/\.$/, '')}. ${notes.join('. ')}` : summary, output: { ...answer, gaps: { sideMm: limits.sideMm, verticalMm: limits.verticalMm } } }
  }

  return { plans, planById, shownPlan, amendOf, editPlan, unbuiltPlan, clearPlans, tieBuiltPart, withPlanTies, planOfChoices, planTool }
}

export type CardPlans = ReturnType<typeof createCardPlans>

/** What an amend changed, in plain words: each size, then each feature it added. */
function changedText(was: PartPlan, now: PartPlan): string {
  return [...amendKinds(was, now), ...amendChanges(was, now).map((c) => changeText(c, now.units)), ...amendAdded(was, now).map((n) => `added ${n}`)].join(', ')
}

/** A raised size as design.plan's answer gives it. */
function raisedOut(u: UnderFloor): NonNullable<PlanAnswer['raised']>[number] {
  return { feature: u.feature, size: u.feature === null ? `${u.hole} ${u.size}` : u.size, from: u.planned, to: u.to, why: raisedWhy(u), ...(u.toBore !== undefined ? { pin: u.pin!, bore: u.toBore } : {}) }
}

/**
 * The design toolset's tools the tab leaves out. design.put_plan keeps a client plan with no card, for MCP clients:
 * plans in the tab are made on the card. design.trace_image waits for now, since in the tab the person traces with the
 * sketch tool's dialog. design.save and design.open write and read 3MF files, which the tab has none of: a design there
 * stays on the plate, and saving the project is the person's, so offered, they only refused, and a reply called save
 * to finish a part.
 */
export const TAB_LEAVES_OUT: readonly string[] = ['design.put_plan', 'design.trace_image', 'design.save', 'design.open']

/**
 * The tab's tools: its own (the question, the lookup card, the dimension sheet and its binding, and `plan`), then
 * `extra` (the design toolset) without the tools in TAB_LEAVES_OUT. The tab's own tools win.
 */
export function mimirTabTools(plan: PilotTool<never>, extra: readonly PilotTool<never>[] = []): PilotTool<never>[] {
  const own = [askTool({ sizesOnSheet: true }), lookupTool(), sheetTool(), sheetBindTool(), plan]
  const names = new Set([...own.map((t) => t.name), ...TAB_LEAVES_OUT])
  return [...own, ...extra.filter((t) => !names.has(t.name))]
}
