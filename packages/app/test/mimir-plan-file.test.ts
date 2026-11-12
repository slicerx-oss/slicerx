// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir plans a project file keeps (Metadata/slicerx_plans.json): read as untrusted, so a part that is not JSON,
// too big, of another version or the wrong shape is dropped whole with no note and the project opens as before, and a
// row that is off is left out; a project with no mimir plan open saves exactly the bytes it did before the part
// existed; and the plan a reopened project holds goes to a new chat only when mimir can go on with it: never for an
// older file without the part, a design edited or deleted by hand, a plan that passed or used its fix round, or one
// that is not the plan approved last. The save, reopen and "keep going" on the engine are mimir-plan-restored.test.ts.
import type { History, Step } from '@slicerx/cad-history'
import type { Host } from '@slicerx/contracts'
import { planLeft, type LlmMessage } from '@slicerx/pilot'
import { PLANS_PART, PLANS_PART_MAX } from '@slicerx/threemf/project'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sx3mfBytes } from '../src/export/actions'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { parsePlans, type SavedPlans } from '../src/export/plans-file'
import { writeProject } from '../src/export/threemf'
import { unzipEntries } from '../src/export/unzip'
import { zip } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { setPlansSource } from '../src/project/plans-source'
import { get, set, type PlateEntry, type PlateMeta } from '../src/state/store'
import { checkedDesign, forgetPlanState, projectPlans, restorePlans, standingPlan, withPlanState } from '../src/workspaces/mimir/plan-state'
import { cardPlans } from '../src/workspaces/mimir/plan-tool'
import { mimirPlans } from '../src/workspaces/mimir/plans'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const plan = (planId: string) => ({ planId, part: 'Mounting plate', units: 'mm', features: [{ name: 'Plate', kind: 'extrude', sizes: {} }, { name: 'Screw holes', kind: 'hole', sizes: {} }], assumptions: [], questions: [] })
const step = (id: string, feature?: string): Step => ({ id, part: 0, transform: I, params: { op: 'face.push', at: [0, 0, 4], normal: [0, 0, 1], distanceMm: 2 }, ...(feature ? { feature } : {}) }) as Step
const history = (...steps: Step[]): History => ({ version: 1, base: [], steps }) as History
/** A plate object, with a history when given steps. */
function entry(id: string, steps?: Step[]): PlateEntry {
  const box = boxMesh(80, 50, 4)
  return { id, name: 'Mounting plate', handle: { id, hash: id, name: id, triangles: 12, bboxMm: [80, 50, 4], openEdges: 0, parts: [] }, parts: [{ name: 'Mounting plate', slot: 1, positions: box.positions, indices: box.indices }], colors: ['#ffffff'], transform: I, ...(steps ? { history: history(...steps) } : {}) } as unknown as PlateEntry
}
const meta = (objects: PlateEntry[]): PlateMeta[] => [{ id: 'plate-1', name: 'Plate 1', objects, settings: { sequence: 'by-layer' } }] as unknown as PlateMeta[]
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v))
const files = (part?: Uint8Array) => new Map(part ? [[PLANS_PART, part]] : [])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-09T00:00:00Z'))
  cardPlans.clearPlans()
  forgetPlanState()
  set({ plate: [] })
})
afterEach(() => {
  vi.useRealTimers()
  readProjectsWithGeom(true)
  setPlansSource(projectPlans)
})

describe('reading the plans part', () => {
  const row = { plan: plan('p1'), design: '1', failedChecks: 1, passed: true, steps: ['s1', 's2'] }

  it('reads a part as written', () => {
    expect(parsePlans(files(enc({ version: 1, last: 'p1', plans: [row] })), new Set(['1']))).toEqual({ last: 'p1', plans: [row] })
  })

  it('drops a part that is not JSON, too big, of another version or the wrong shape, whole and with no error', () => {
    const ids = new Set(['1'])
    for (const bad of ['{"version":1,"plans":[', enc('x'.repeat(10)), { version: 2, plans: [row] }, { version: 1, plans: {} }, { version: 1 }, [row], null, 7, { version: 1, plans: [] }]) {
      expect(parsePlans(files(bad instanceof Uint8Array ? bad : enc(bad)), ids)).toBeNull()
    }
    const big = enc({ version: 1, plans: [{ ...row, plan: { ...row.plan, pad: 'x'.repeat(PLANS_PART_MAX) } }] })
    expect(big.length).toBeGreaterThan(PLANS_PART_MAX)
    expect(parsePlans(files(big), ids)).toBeNull()
    expect(parsePlans(files(), ids)).toBeNull()
  })

  it('leaves out a row tied to an object the file does not hold, and any field that is off', () => {
    const odd = { plan: plan('p2'), design: '1', failedChecks: -3, passed: 'yes', steps: ['s1', 7], closed: { summary: 4 } }
    const out = parsePlans(files(enc({ version: 1, last: 12, plans: [{ ...row, design: '9' }, odd, 'row', { design: '1' }] })), new Set(['1']))
    expect(out).toEqual({ plans: [{ plan: plan('p2'), design: '1' }] })
  })

  it('a project with a part that is off opens as it would without one', async () => {
    readProjectsWithGeom(false)
    const plain = writeProject({ plates: meta([entry('obj_a')]), bed: { widthMm: 256, depthMm: 256 } })
    const entries = await unzipEntries(plain)
    const withBad = zip([...[...entries].map(([name, data]) => ({ name, data })), { name: PLANS_PART, data: '{"version":1,"plans":[{"plan":' }])
    const bed = { widthMm: 256, depthMm: 256 }
    const a = await readProject(withBad, bed)
    const b = await readProject(plain, bed)
    expect(a.plans).toBeUndefined()
    expect(a.plates.map((p) => p.objects.map((o) => o.name))).toEqual(b.plates.map((p) => p.objects.map((o) => o.name)))
  })

  it('puts back only plans the plan schema takes, with their failed checks and fix round', () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate')])] })
    const closed = { summary: 'The fix round is used', output: { pass: false, stop: 'stop' } }
    restorePlans({ last: 'p1', plans: [{ plan: { ...plan('bad'), units: 'cubits' }, design: '1' }, { plan: plan('p1'), design: '1', failedChecks: 2, closed }] }, (f) => (f === '1' ? 'obj_new' : undefined))
    expect(mimirPlans.get('bad')).toBeUndefined()
    expect(mimirPlans.get('p1')).toMatchObject({ origin: 'card', design: 'obj_new', failedChecks: 2, closed })
  })
})

describe('saving a project with no mimir plan open', () => {
  it('writes the same bytes as before the plans part existed, whatever plans the window holds for other projects', async () => {
    set({ plate: [entry('obj_a', [step('s1', 'Plate')]), entry('obj_b')] })
    const plates = meta(get().plate)
    // the save with no plans source at all: what it wrote before
    setPlansSource(null)
    const before = await sx3mfBytes(plates, { settings: {} })
    setPlansSource(projectPlans)
    expect(await sx3mfBytes(plates, { settings: {} })).toEqual(before)
    // a card plan tied to a design this project does not hold, and one approved but never built while this project
    // already has a design: neither is this project's
    restorePlans({ last: 'p2', plans: [{ plan: plan('p1'), design: 'x' }, { plan: plan('p2') }] }, (f) => (f === 'x' ? 'obj_elsewhere' : undefined))
    expect(mimirPlans.get('p1')?.design).toBe('obj_elsewhere')
    const after = await sx3mfBytes(plates, { settings: {} })
    expect(after).toEqual(before)
    expect((await unzipEntries(after)).has(PLANS_PART)).toBe(false)
  })
})

describe('the plan a reopened project gives a new chat', () => {
  const opened = (saved: Partial<SavedPlans> = {}) => restorePlans({ last: 'p1', plans: [{ plan: plan('p1'), design: '1', steps: ['s1'] }], ...saved }, (f) => (f === '1' ? 'obj_new' : undefined))
  const keepGoing = (seed: readonly LlmMessage[]): LlmMessage[] => [{ role: 'system', content: 's' }, ...seed, { role: 'user', content: 'User request:\nkeep going' }]

  it('is the plan with the design as it opened, which leaves the screw holes to build', () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate')])] })
    opened()
    const seed = standingPlan()!
    expect(seed).toBeDefined()
    const messages = keepGoing(seed)
    expect(planLeft(messages, messages.length)).toMatchObject({ planId: 'p1', design: 'obj_new', noBody: false, build: ['Screw holes'] })
  })

  it('is none for an older file with no plans part', () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate')])] })
    expect(standingPlan()).toBeUndefined()
  })

  it('is none when a step was edited, added or removed by hand since mimir worked on it', () => {
    for (const steps of [[step('s1b', 'Plate')], [step('s1', 'Plate'), step('s2')], []]) {
      cardPlans.clearPlans()
      forgetPlanState()
      set({ plate: [entry('obj_new', steps)] })
      opened()
      expect(standingPlan()).toBeUndefined()
    }
  })

  it('is none when the design was deleted', () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate')])] })
    opened()
    set({ plate: [] })
    expect(standingPlan()).toBeUndefined()
  })

  it('is none when the plan passed, or used its fix round', () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate')])] })
    opened({ plans: [{ plan: plan('p1'), design: '1', steps: ['s1'], passed: true }] })
    expect(standingPlan()).toBeUndefined()
    cardPlans.clearPlans()
    forgetPlanState()
    opened({ plans: [{ plan: plan('p1'), design: '1', steps: ['s1'], failedChecks: 2, closed: { summary: 'The fix round is used', output: { pass: false } } }] })
    expect(standingPlan()).toBeUndefined()
  })

  it('is none when the plan is not the one approved last', () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate')])] })
    opened({ last: 'p9' })
    expect(standingPlan()).toBeUndefined()
  })

  it('is a plan never built only while the project has no design', () => {
    restorePlans({ last: 'p1', plans: [{ plan: plan('p1') }] }, () => undefined)
    const messages = keepGoing(standingPlan()!)
    expect(planLeft(messages, messages.length)).toMatchObject({ planId: 'p1', noBody: true })
    set({ plate: [entry('obj_other', [step('s7')])] })
    expect(standingPlan()).toBeUndefined()
  })
})

describe('the design a reopened project gives a follow-up', () => {
  it('stays the follow-up design after a follow-up changes it, as it is in the chat that built it', async () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate'), step('s2', 'Screw holes')])] })
    restorePlans({ last: 'p1', plans: [{ plan: plan('p1'), design: '1', steps: ['s1', 's2'], passed: true }] }, (f) => (f === '1' ? 'obj_new' : undefined))
    expect(checkedDesign()).toBe('obj_new')
    // the first follow-up adds a step; the pass no longer holds, but the design was checked
    const [chamfer] = withPlanState([{ name: 'geom.chamfer', run: async () => ({ summary: 'Beveled', output: { design: 'obj_new' } }) } as never])
    set({ plate: [entry('obj_new', [step('s1', 'Plate'), step('s2', 'Screw holes'), step('s3', 'Bevel')])] })
    await chamfer!.run({ design: 'obj_new' } as never, {} as never)
    expect(checkedDesign()).toBe('obj_new')
  })

  it('is none for a plan never checked', () => {
    set({ plate: [entry('obj_new', [step('s1', 'Plate')])] })
    restorePlans({ last: 'p1', plans: [{ plan: plan('p1'), design: '1', steps: ['s1'] }] }, (f) => (f === '1' ? 'obj_new' : undefined))
    expect(checkedDesign()).toBeUndefined()
  })
})
