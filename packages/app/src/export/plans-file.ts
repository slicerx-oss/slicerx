// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir plans a project file keeps: Metadata/slicerx_plans.json (@slicerx/threemf project.ts plansJson), so a
// plan approved in one session can be checked and finished after the project is opened again. Plan state only: the
// plan as approved and edited, the object its part is built in, its failed checks, the check that used its fix round,
// whether its last check passed, and the design's step ids when mimir last worked on it. Read as untrusted: a part
// that is too big, not JSON or of another version is dropped whole with no note, and a row that is off is left out.
// The plan itself is checked against the plan schema when it goes back in the registry (workspaces/mimir/plan-state.ts).
import { PLANS_PART, PLANS_PART_MAX } from '@slicerx/threemf/project'

/** One plan as read from the file: `design` is the 3MF object id of the object its part is built in. */
export interface SavedPlan {
  plan: Record<string, unknown>
  design?: string
  failedChecks?: number
  closed?: { summary: string; output: Record<string, unknown> }
  passed?: true
  steps?: string[]
}

export interface SavedPlans {
  /** The planId of the plan the person approved last. */
  last?: string
  /** Oldest first. */
  plans: SavedPlan[]
}

/** The most plans read: as many as the registry keeps of each kind, twice over. */
const MAX_ROWS = 100
/** The most steps read for one design. */
const MAX_STEPS = 2000

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** The plans part of a project, or null when it has none or it is unreadable. `objectIds` are the file's object ids. */
export function parsePlans(files: ReadonlyMap<string, Uint8Array>, objectIds: ReadonlySet<string>): SavedPlans | null {
  const bytes = files.get(PLANS_PART)
  if (!bytes || bytes.length > PLANS_PART_MAX) return null
  let j: unknown
  try {
    j = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!isObj(j) || j['version'] !== 1 || !Array.isArray(j['plans'])) return null
  const plans: SavedPlan[] = []
  for (const raw of j['plans'].slice(0, MAX_ROWS)) {
    if (!isObj(raw) || !isObj(raw['plan'])) continue
    const design = raw['design']
    // a plan tied to an object the file does not hold has no part to go back to
    if (design !== undefined && !(typeof design === 'string' && objectIds.has(design))) continue
    const row: SavedPlan = { plan: raw['plan'], ...(typeof design === 'string' ? { design } : {}) }
    const failed = raw['failedChecks']
    if (typeof failed === 'number' && Number.isInteger(failed) && failed > 0 && failed <= 1000) row.failedChecks = failed
    const closed = raw['closed']
    if (isObj(closed) && typeof closed['summary'] === 'string' && closed['summary'].length <= 20_000 && isObj(closed['output'])) row.closed = { summary: closed['summary'], output: closed['output'] }
    if (raw['passed'] === true) row.passed = true
    const steps = raw['steps']
    if (Array.isArray(steps) && steps.length <= MAX_STEPS && steps.every((s) => shortText(s, 64))) row.steps = [...(steps as string[])]
    plans.push(row)
  }
  if (!plans.length) return null
  const last = j['last']
  return { ...(shortText(last, 64) ? { last } : {}), plans }
}

/** The project's plans as the reader returns them: `{ plans }`, or nothing when the file has none it can read. */
export function plansOf(files: ReadonlyMap<string, Uint8Array>, objectIds: ReadonlySet<string>): { plans?: SavedPlans } {
  const plans = parsePlans(files, objectIds)
  return plans ? { plans } : {}
}
