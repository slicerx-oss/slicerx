// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.plan: before mimir builds a part of two or more features, it lays out the plan (each feature and the sizes
// that drive it, what it assumed, what it still needs to know) on a card the person can edit inline and approve with
// Go. The card answers through the same question channel pilot.ask uses. The plans made here are kept by id with the
// person's latest edits, so a later check can read the plan the part was built from.
import { MAX_PLANS, partPlanSchema, PLAN_SIZE_MAX, type PartPlan } from '@slicerx/mcp/toolset'
import { defineTool, type PilotTool, type ToolOutput } from '@slicerx/pilot'
import type { z } from 'zod'
import { mimirPlans } from './plans'

export { PLAN_SIZE_MAX, type PartPlan }

/** A part's plan as the card takes it: the shared shape (@slicerx/mcp, which design.check reads), with one feature at least. */
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
}

// ---- the plans: the tab's one registry (plans.ts), which design.check reads too, with the latest edits applied ----

/** The registry keeps this many plans; the oldest goes first. */
export const PLAN_KEEP = MAX_PLANS
/** Each plan as mimir first showed it, before any edit, while the registry still keeps the plan. */
const shownPlans = new Map<string, PartPlan>()
let counter = 0
/** The plan the person last approved whose part is not built yet: the next design built ties to it. */
let unbuilt: string | null = null

function remember(plan: PartPlan): void {
  mimirPlans.put(plan)
  shownPlans.set(plan.planId, structuredClone(plan))
  for (const id of shownPlans.keys()) if (!mimirPlans.get(id)) shownPlans.delete(id)
}

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

/** The plan with this id, as last edited, or null. */
export function planById(planId: string): PartPlan | null {
  return mimirPlans.get(planId)?.plan ?? null
}

/** The plan with this id as mimir first showed it, before any edit, or null. */
export function shownPlan(planId: string): PartPlan | null {
  return mimirPlans.get(planId) ? (shownPlans.get(planId) ?? null) : null
}

/** Records edits to a plan (sizes typed on its card); ignored for an unknown id or a plan of another shape. */
export function editPlan(planId: string, next: PartPlan): boolean {
  const entry = mimirPlans.get(planId)
  if (!entry || next.planId !== planId) return false
  const ok = PartPlanSchema.safeParse(next)
  if (!ok.success) return false
  mimirPlans.put(ok.data, entry.design)
  return true
}

/** Forgets every plan (tests). */
export function clearPlans(): void {
  mimirPlans.clear()
  shownPlans.clear()
  unbuilt = null
}

/**
 * Ties the approved plan to the design its part is built in, once a tool builds it: the design design.new starts, or
 * the design a geometry step changes. design.check then checks that design, whatever else is open.
 */
export function tieBuiltPart(tool: { name: string; permission: string }, input: unknown, out: ToolOutput): void {
  if (!unbuilt || out.ok === false) return
  let design: unknown
  if (tool.name === 'design.new') design = (out.output as { design?: unknown } | undefined)?.design
  else if (tool.name.startsWith('geom.') && tool.permission !== 'read') design = (input as { design?: unknown } | undefined)?.design
  if (typeof design !== 'string' || !design) return
  if (mimirPlans.tie(unbuilt, design)) unbuilt = null
}

/** The tools with tieBuiltPart after each run. */
export function withPlanTies(tools: readonly PilotTool<never>[]): PilotTool<never>[] {
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

function newPlanId(): string {
  counter = (counter + 1) % 1_000_000
  return `plan_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ---- the question the card answers ----

/** The answers a plan card sends back on the question channel. */
export const PLAN_GO = 'go'
export const PLAN_CHANGE = 'change'

/** The choice ids of a plan's question carry its id, so the chat can tell the card from an ordinary question. */
export function planChoiceId(answer: typeof PLAN_GO | typeof PLAN_CHANGE, planId: string): string {
  return `${answer}:${planId}`
}

/** The plan id behind a question's choices, when the question is a plan card this window made; otherwise null. */
export function planOfChoices(choices: readonly { id: string }[]): string | null {
  const go = choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))
  if (!go) return null
  const planId = go.id.slice(PLAN_GO.length + 1)
  return mimirPlans.get(planId) ? planId : null
}

/** `newId` names each plan (tests); by default a random plan_ id. */
export function planTool(opts: { newId?: () => string } = {}): PilotTool<never> {
  return defineTool({
    name: 'design.plan',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Before the first geometry step of a part with two or more features, show the person the plan and wait: the part, its units, each feature in build order with the sizes that drive it (and its kind, such as extrude, hole or fillet), the overall size and holes when known, what you assumed, and what you still need to know. The person edits sizes on the card and presses Go. Returns the plan id, whether it was accepted, and the edited plan when they changed anything; build from that. Not accepted: build nothing and ask what to change. A part of one feature skips the plan.',
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
      if (picked !== planChoiceId(PLAN_GO, plan.planId)) {
        const answer: PlanAnswer = { planId: plan.planId, accepted: false }
        return { ok: false, summary: 'Not approved; build nothing until the plan is agreed', output: answer }
      }
      // the next design built is this plan's part
      unbuilt = plan.planId
      const edited = !samePlan(latest, shown)
      const answer: PlanAnswer = edited ? { planId: plan.planId, accepted: true, edits: latest } : { planId: plan.planId, accepted: true }
      return { summary: edited ? 'Approved with changes' : 'Approved as shown', output: answer }
    },
  }) as PilotTool<never>
}
