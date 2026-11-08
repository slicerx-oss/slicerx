// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's own tools beside the design toolset: the question, the lookup card, the dimension sheet and its
// binding, and design.plan. Before mimir builds a part of two or more features, design.plan lays out the plan (each
// feature and the sizes that drive it, what it assumed, what it still needs to know) on a card the person can edit
// inline and approve with Go. The card answers through the same question channel pilot.ask uses. The plans made there
// are kept by id with the person's latest edits, so a later check can read the plan the part was built from. The app's
// tab and the creative eval make these tools here (toolset.ts tabToolset), each over its own plan registry.
import { askTool, clearanceProfileOf, defineTool, lookupTool, printInPlaceClearance, sheetBindTool, sheetTool, type PilotTool, type ToolOutput } from '@slicerx/pilot'
import type { z } from 'zod'
import { gapLimitsText, MAX_PLANS, partPlanSchema, plannedGaps, PLAN_SIZE_MAX, type PartPlan, type PlanRegistry } from './design-check'
import { fitLimits, type FitProfile } from './fit-facts'

export { PLAN_SIZE_MAX, type PartPlan }

/** A part's plan as the card takes it: the shared shape (design-check.ts, which design.check reads), with one feature at least. */
export const PartPlanSchema = partPlanSchema.extend({ features: partPlanSchema.shape.features.min(1) })

/** What mimir sends: the plan without its id, which the tool gives it. */
export const PlanInputSchema = PartPlanSchema.omit({ planId: true })
export type PlanInput = z.infer<typeof PlanInputSchema>

/** What the tool returns once the person answers on the card. */
export interface PlanAnswer {
  planId: string
  accepted: boolean
  /** The plan with the person's edits, when they changed anything before Go. */
  edits?: PartPlan
  /** For an approved plan with printInPlace: the smallest gaps moving pieces need on this printer, per side. */
  gaps?: { sideMm: number; verticalMm: number }
}

/** The fit rule's smallest print-in-place gaps for a 0.4 mm nozzle in PLA, as design.plan's text names them. */
const RULE = printInPlaceClearance()
const n = (v: number): string => `${Math.round(v * 1000) / 1000}`
const RULE_MIN = `at least ${n(RULE.sideMm)} mm side by side and ${n(RULE.verticalMm)} mm above or below`
const RULE_GAPS = `${RULE_MIN} (${n(RULE.nozzleMm)} mm nozzle, ${RULE.material.toUpperCase()})`

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
    return cardEntry(planId)?.plan ?? null
  }

  /** The plan with this id as mimir first showed it, before any edit, or null. */
  function shownPlan(planId: string): PartPlan | null {
    return cardEntry(planId) ? (shownPlans.get(planId) ?? null) : null
  }

  /** Records edits to a plan (sizes typed on its card); ignored for an unknown id or a plan of another shape. */
  function editPlan(planId: string, next: PartPlan): boolean {
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
    return cardEntry(planId) ? planId : null
  }

  /**
   * `newId` names each plan (tests, and the eval, whose recorded replies name their plans); by default a random plan_ id.
   * `fitProfile` is what design.check holds a print-in-place part's gaps to (the printer's nozzle, layer height and
   * material); what it leaves out comes from the run's machine.
   */
  function planTool(opts: { newId?: () => string; fitProfile?: () => FitProfile } = {}): PilotTool<never> {
    return defineTool({
      name: 'design.plan',
      version: '1.0.0',
      source: 'command',
      permission: 'read',
      description:
        `Before the first geometry step of a part with two or more features, show the person the plan and wait: the part, its units, each feature in build order with the sizes that drive it (and its kind, such as extrude, hole or fillet), the overall size and holes when known (one row with a count for several holes of one size), what you assumed, what you still need to know, and, when pieces of the part print assembled and move (hinges, chains, gears, jointed, articulated or flexi segments), those pieces by name in printInPlace, and keep the gaps where they meet ${RULE_GAPS}; an approved plan's result gives this printer's. The person edits sizes on the card and presses Go. Returns the plan id, whether it was accepted, and the edited plan when they changed anything; build from that. Not accepted: build nothing and ask what to change. A part of one feature skips the plan.`,
      localDescription:
        `Before the first geometry step of a part with two or more features, show the person the plan and wait: part, units, features in build order with their sizes and kind, the overall size and holes when known, assumptions and questions. printInPlace pieces: keep the gaps where they meet ${RULE_MIN}. Returns accepted and the edited plan; build from that. Not accepted: build nothing and ask what to change. One feature: no plan. More: kb.search "modeling tools".`,
      input: PlanInputSchema,
      args: (i) => `"${i.part}", ${i.features.length} feature${i.features.length === 1 ? '' : 's'}`,
      async run(i, ctx) {
        if (!ctx.ask) return { ok: false, summary: 'Nobody here can approve a plan' }
        const plan: PartPlan = { planId: (opts.newId ?? newPlanId)(), ...i }
        const shown = structuredClone(plan)
        remember(plan)
        const picked = await ctx.ask({
          title: 'Plan',
          question: `Build ${i.part} from this plan?`,
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
        const answer: PlanAnswer = edited ? { planId: plan.planId, accepted: true, edits: latest } : { planId: plan.planId, accepted: true }
        const said = edited ? 'Approved with changes' : 'Approved as shown'
        if (!latest.printInPlace || latest.printInPlace.length < 2) return { summary: said, output: answer }
        // a print-in-place part: the gaps this printer needs before the first step, and any planned gap under them
        const given = Object.fromEntries(Object.entries(opts.fitProfile?.() ?? {}).filter(([, v]) => v !== undefined))
        const limits = fitLimits({ ...clearanceProfileOf(ctx.context ?? {}), ...given })
        const under = plannedGaps(latest, limits).filter((g) => !g.pass)
        const summary = `${said}. Moving pieces need gaps of ${gapLimitsText(limits)} on this printer.${under.length ? ` ${under.map((g) => g.text).join('; ')}` : ''}`
        return { summary, output: { ...answer, gaps: { sideMm: limits.sideMm, verticalMm: limits.verticalMm } } }
      },
    }) as PilotTool<never>
  }

  return { plans, planById, shownPlan, editPlan, unbuiltPlan, clearPlans, tieBuiltPart, withPlanTies, planOfChoices, planTool }
}

export type CardPlans = ReturnType<typeof createCardPlans>

/**
 * The tab's tools: its own (the question, the lookup card, the dimension sheet and its binding, and `plan`), then
 * `extra` (the design toolset). The tab's own tools win, and the design toolset's design.put_plan (a client plan kept
 * with no card, for MCP clients) stays out: plans in the tab are made on the card. So does design.trace_image for now:
 * in the tab the person traces with the sketch tool's dialog.
 */
export function mimirTabTools(plan: PilotTool<never>, extra: readonly PilotTool<never>[] = []): PilotTool<never>[] {
  const own = [askTool({ sizesOnSheet: true }), lookupTool(), sheetTool(), sheetBindTool(), plan]
  const names = new Set([...own.map((t) => t.name), 'design.put_plan', 'design.trace_image'])
  return [...own, ...extra.filter((t) => !names.has(t.name))]
}
