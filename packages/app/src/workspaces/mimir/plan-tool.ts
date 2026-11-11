// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.plan: before mimir builds a part of two or more features, it lays out the plan (each feature and the sizes
// that drive it, what it assumed, what it still needs to know) on a card the person can edit inline and approve with
// Go. The card answers through the same question channel pilot.ask uses. The plans made here are kept by id with the
// person's latest edits, so a later check can read the plan the part was built from. The tool and its plans are made in
// @slicerx/mcp (tab-tools.ts), which the creative eval uses too; here they are the tab's, over the window's one
// registry (plans.ts), which design.check reads too.
import { createCardPlans } from '@slicerx/mcp/toolset'
import { mimirPlans } from './plans'

export { DETAIL_LABEL, DETAIL_LEVELS, DETAIL_LINE, type DetailLevel } from '@slicerx/mcp/toolset'
export { PartPlanSchema, PLAN_CHANGE, PLAN_GO, PLAN_KEEP, PLAN_SIZE_MAX, planChoiceId, PlanInputSchema, samePlan, type PartPlan, type PlanAnswer, type PlanInput } from '@slicerx/mcp/toolset'

/** The tab's card plans, over the window's registry. */
export const cardPlans = createCardPlans(mimirPlans)

export const { planById, shownPlan, amendOf, editPlan, unbuiltPlan, clearPlans, tieBuiltPart, withPlanTies, planOfChoices, planTool } = cardPlans
