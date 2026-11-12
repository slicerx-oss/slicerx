// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the project keeps of the tab's card plans, so a plan outlives the chat and the session that approved it: the
// plan the person approved last, whether each plan's last design.check passed, and its design's step ids when mimir
// last worked on it. A save writes them with the registry's plans (Metadata/slicerx_plans.json, export/plans-file.ts);
// an open puts them back. With them, design.check finds a plan after the project is opened again, and a chat with no
// plan of its own gets the last approved one as history (standingPlan, pilot planSeed), so "keep going" finishes it.
// No chat text, prompt or account detail is kept.
import { stepName } from '@slicerx/cad-history'
import { planSeed, type LlmMessage, type PilotTool, type StandingPlan } from '@slicerx/pilot'
import type { PlansInput } from '@slicerx/threemf/project'
import type { SavedPlans } from '../../export/plans-file'
import { setPlansSource } from '../../project/plans-source'
import { get } from '../../state/store'
import { mimirPlans } from './plans'

/** The card plans this window has seen (shown on a card or opened with a project), oldest first. */
const seen = new Set<string>()
/** Per plan: its design's step ids when mimir last worked on it, and whether its last check passed. */
const runs = new Map<string, { steps?: string[]; passed?: true }>()
/** The plan the person approved last. */
let last: string | null = null
/** An approved plan opened with a project before its part was started: the next design built ties to it. */
let opened: string | null = null

const cardEntry = (planId: string) => {
  const e = mimirPlans.get(planId)
  return e?.origin === 'card' ? e : undefined
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** The step ids of a design on the plate, or undefined when it is not there or has no history. */
function stepIds(design: string): string[] | undefined {
  return get().plate.find((e) => e.id === design)?.history?.steps.map((s) => s.id)
}

/** After a design or modeling call: the steps of the last approved plan's design now. A change since a pass undoes it. */
function noteSteps(): void {
  if (!last) return
  const design = cardEntry(last)?.design
  const ids = design ? stepIds(design) : undefined
  if (!ids) return
  const run = runs.get(last) ?? {}
  if (run.steps && !sameIds(run.steps, ids)) delete run.passed
  run.steps = ids
  runs.set(last, run)
}

/** What a tool call tells the plan state: a plan shown and answered, a check, or a design built or changed. */
function noteRun(name: string, input: unknown, out: { ok?: boolean; output?: unknown }): void {
  const o = (out.output ?? {}) as { planId?: unknown; accepted?: unknown; pass?: unknown; design?: unknown }
  if (name === 'design.plan') {
    if (typeof o.planId !== 'string') return
    seen.delete(o.planId)
    seen.add(o.planId)
    if (o.accepted === true) {
      last = o.planId
      opened = null
      runs.delete(o.planId)
    }
    return
  }
  if (name === 'design.check') {
    if (typeof o.planId !== 'string' || out.ok === false) return
    const run = runs.get(o.planId) ?? {}
    if (o.pass === true) run.passed = true
    else delete run.passed
    runs.set(o.planId, run)
    return
  }
  if (!/^(design|geom)\./.test(name) || out.ok === false) return
  // an approved plan opened with its part not started ties to the design the next build starts, as the card does
  if (opened && (name === 'design.new' || name.startsWith('geom.'))) {
    const made = typeof o.design === 'string' && o.design ? o.design : (input as { design?: unknown } | undefined)?.design
    if (typeof made === 'string' && made && stepIds(made) !== undefined && !cardEntry(opened)?.design) {
      mimirPlans.tie(opened, made)
      opened = null
    }
  }
  noteSteps()
}

/** The tab's tools, each telling the plan state what it did once it has run. */
export function withPlanState(tools: readonly PilotTool<never>[]): PilotTool<never>[] {
  return tools.map((t) => {
    if (t.name !== 'design.plan' && !/^(design|geom)\./.test(t.name)) return t
    const run = t.run.bind(t)
    return {
      ...t,
      async run(input: never, ctx: Parameters<typeof t.run>[1]) {
        const out = await run(input, ctx)
        noteRun(t.name, input, out)
        return out
      },
    }
  })
}

/**
 * The plans a save writes, for the objects written (by plate object id): every card plan tied to one of them, oldest
 * first, and the plan approved last while its part is not started and the project has no design yet. None: no part.
 */
export function projectPlans(objects: ReadonlySet<string>, designs: boolean): PlansInput | undefined {
  const entries: PlansInput['entries'][number][] = []
  for (const id of seen) {
    const e = cardEntry(id)
    if (!e) continue
    if (e.design ? !objects.has(e.design) : id !== last || designs) continue
    const run = runs.get(id)
    entries.push({
      plan: e.plan,
      ...(e.design ? { design: e.design } : {}),
      ...(e.failedChecks ? { failedChecks: e.failedChecks } : {}),
      ...(e.closed ? { closed: e.closed } : {}),
      ...(run?.passed ? { passed: true } : {}),
      ...(run?.steps ? { steps: run.steps } : {}),
    })
  }
  return entries.length ? { ...(last ? { last } : {}), entries } : undefined
}

/**
 * Puts a project's plans back, as card plans tied to the objects the open placed (`objectOf` maps a file object id to
 * the plate's). A plan that fails the plan schema is left out. The plan approved last in the file is the one approved
 * last here, when it came back.
 */
export function restorePlans(saved: SavedPlans, objectOf: (fileId: string) => string | undefined): void {
  for (const row of saved.plans) {
    const design = row.design === undefined ? undefined : objectOf(row.design)
    if (row.design !== undefined && !design) continue
    try {
      mimirPlans.put(row.plan as never, design, 'card')
    } catch {
      continue
    }
    const planId = String(row.plan['planId'])
    const entry = mimirPlans.get(planId)
    if (!entry) continue
    if (row.failedChecks) entry.failedChecks = row.failedChecks
    if (row.closed) mimirPlans.close(planId, row.closed)
    seen.delete(planId)
    seen.add(planId)
    runs.set(planId, { ...(row.steps ? { steps: row.steps } : {}), ...(row.passed ? { passed: true as const } : {}) })
  }
  if (saved.last && cardEntry(saved.last)) {
    last = saved.last
    opened = cardEntry(saved.last)!.design ? null : saved.last
  }
}

/**
 * The plan approved last as a chat's history (planSeed), when mimir can go on with it: its fix round is not used, its
 * last check did not pass, and its design is on the plate with the same steps as when mimir last worked on it (so a
 * step the person edited, undid or deleted by hand is never rebuilt). A plan whose part is not started counts only
 * while the project has no design. Undefined otherwise: the chat starts with no plan, as before.
 */
export function standingPlan(): LlmMessage[] | undefined {
  if (!last) return undefined
  const e = cardEntry(last)
  if (!e || e.closed) return undefined
  const run = runs.get(last)
  if (run?.passed) return undefined
  const { planId, ...plan } = e.plan
  const seed: StandingPlan = { planId, plan }
  if (!e.design) return get().plate.some((p) => p.history) ? undefined : planSeed(seed)
  const d = get().plate.find((p) => p.id === e.design)
  if (!d?.history || !run?.steps || !sameIds(run.steps, d.history.steps.map((s) => s.id))) return undefined
  const steps = d.history.steps.map((s) => ({ id: s.id, name: stepName(s), ...(s.feature ? { feature: s.feature } : {}) }))
  return planSeed({ ...seed, design: { id: d.id, name: d.name, steps, parts: d.parts.map((p) => p.name) } })
}

/**
 * The design of the plan approved last, when it is on the plate and its plan was checked after the build (passed, failed
 * or closed): a turn on it is a follow-up, in any chat. Undefined otherwise.
 */
export function checkedDesign(): string | undefined {
  if (!last) return undefined
  const e = cardEntry(last)
  if (!e?.design || !get().plate.some((p) => p.id === e.design && p.history)) return undefined
  return e.closed || e.failedChecks || e.passed || e.passedOnce || runs.get(last)?.passed ? e.design : undefined
}

/** Forgets the plan state (tests, with the registry's clear). */
export function forgetPlanState(): void {
  seen.clear()
  runs.clear()
  last = null
  opened = null
}

setPlansSource(projectPlans)
