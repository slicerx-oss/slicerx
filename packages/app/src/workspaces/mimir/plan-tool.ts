// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.plan: before mimir builds a part of two or more features, it lays out the plan (each feature and the sizes
// that drive it, what it assumed, what it still needs to know) on a card the person can edit inline and approve with
// Go. The card answers through the same question channel pilot.ask uses. The plans made here are kept by id with the
// person's latest edits, so a later check can read the plan the part was built from.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'

const size = z.number().finite().min(-100_000).max(100_000)
const text = (max: number) => z.string().trim().min(1).max(max)

// Replaced by the PartPlan import from @slicerx/mcp (design-check) once that lands; keep the two shapes identical.
export const PartPlanSchema = z.object({
  planId: text(64),
  part: text(80),
  units: z.enum(['mm', 'in']),
  features: z
    .array(
      z.object({
        name: text(60),
        kind: text(40).optional(),
        sizes: z.record(text(40), size),
      }),
    )
    .min(1)
    .max(30),
  overall: z.object({ x: size, y: size, z: size }).optional(),
  holes: z.array(z.object({ name: text(60), diameter: size })).max(60).optional(),
  assumptions: z.array(text(200)).max(12),
  questions: z.array(text(200)).max(6),
})

/** A part's plan; every size is in `units`. */
export type PartPlan = z.infer<typeof PartPlanSchema>

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

// ---- the registry: every plan this window made, by id, with the latest edits applied ----

const plans = new Map<string, { shown: PartPlan; latest: PartPlan }>()
let counter = 0

/** The plan with this id, as last edited, or null. */
export function planById(planId: string): PartPlan | null {
  return plans.get(planId)?.latest ?? null
}

/** The plan with this id as mimir first showed it, before any edit, or null. */
export function shownPlan(planId: string): PartPlan | null {
  return plans.get(planId)?.shown ?? null
}

/** Records edits to a plan (sizes typed on its card); ignored for an unknown id or a plan of another shape. */
export function editPlan(planId: string, next: PartPlan): boolean {
  const entry = plans.get(planId)
  if (!entry || next.planId !== planId) return false
  const ok = PartPlanSchema.safeParse(next)
  if (!ok.success) return false
  entry.latest = ok.data
  return true
}

/** Forgets every plan (tests). */
export function clearPlans(): void {
  plans.clear()
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
  return plans.has(planId) ? planId : null
}

/** True when a plan's sizes, assumptions or questions differ from another's. */
function changed(a: PartPlan, b: PartPlan): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

export function planTool(): PilotTool<never> {
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
      const plan: PartPlan = { planId: newPlanId(), ...i }
      const shown = structuredClone(plan)
      plans.set(plan.planId, { shown, latest: plan })
      const picked = await ctx.ask({
        title: 'Plan',
        question: `Build ${i.part} from this plan?`,
        choices: [
          { id: planChoiceId(PLAN_GO, plan.planId), label: 'Go' },
          { id: planChoiceId(PLAN_CHANGE, plan.planId), label: 'Not yet' },
        ],
      })
      const latest = plans.get(plan.planId)?.latest ?? shown
      if (picked !== planChoiceId(PLAN_GO, plan.planId)) {
        const answer: PlanAnswer = { planId: plan.planId, accepted: false }
        return { ok: false, summary: 'Not approved; build nothing until the plan is agreed', output: answer }
      }
      const edited = changed(latest, shown)
      const answer: PlanAnswer = edited ? { planId: plan.planId, accepted: true, edits: latest } : { planId: plan.planId, accepted: true }
      return { summary: edited ? 'Approved with changes' : 'Approved as shown', output: answer }
    },
  }) as PilotTool<never>
}
