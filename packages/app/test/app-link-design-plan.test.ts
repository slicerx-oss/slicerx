// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An MCP client's plan over the app link (design.put_plan): kept in the registry the app's design.check reads, beside
// the mimir tab's plans, with no card; a plan off the shared schema is refused and nothing is kept. A client never
// replaces, pushes out or edits a plan the person made on the card.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall, useDesignHost, type LinkError } from '../src/app-link/methods'
import { mimirPlans } from '../src/workspaces/mimir/plans'
import { clearPlans, planById, planChoiceId, planOfChoices, planTool } from '../src/workspaces/mimir/plan-tool'

const handle = (name: string): MeshHandle => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 10, 3], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
beforeAll(() => useDesignHost(loader))
afterEach(clearPlans)

const plan = { planId: 'client-1', part: 'Spacer', units: 'mm', features: [{ name: 'body', kind: 'extrude', sizes: { width: 40, depth: 20, height: 5 } }], overall: { x: 40, y: 20, z: 5 }, assumptions: [], questions: [] }

describe('design.put_plan over the app link', () => {
  it('reads with the read class', () => {
    expect(APP_LINK_METHODS['design.put_plan']).toBe('read')
    expect(APP_LINK_METHODS['design.plan']).toBeUndefined()
  })

  it("keeps a client's plan where the app's design.check reads it", async () => {
    const out = (await runCall('design.put_plan', { plan })) as { summary: string; output: { planId: string } }
    expect(out.output.planId).toBe('client-1')
    expect(mimirPlans.get('client-1')).toEqual({ plan, origin: 'client' })
    // design.check now finds it (no design open, so it says what to build)
    const e = await runCall('design.check', { planId: 'client-1' }).then(() => null, (x: unknown) => x as LinkError)
    expect(e?.message).toContain('build Spacer first')
  })

  it("never ties the person's card plan from a read-class client", async () => {
    mimirPlans.put({ ...plan, planId: 'card-1', part: 'Box' }, 'design_tab', 'card')
    const e = await runCall('design.check', { planId: 'card-1', design: 'design_other' }).then(() => null, (x: unknown) => x as LinkError)
    expect(e?.code).toBe('invalid_input')
    expect(e?.message).toContain('made in the mimir tab and is already tied to design design_tab')
    expect(mimirPlans.get('card-1')?.design).toBe('design_tab')
  })

  it('refuses a plan off the schema and keeps nothing', async () => {
    const e = await runCall('design.put_plan', { plan: { ...plan, overall: { x: -1, y: 20, z: 5 } } }).then(() => null, (x: unknown) => x as LinkError)
    expect(e?.code).toBe('invalid_input')
    expect(mimirPlans.get('client-1')).toBeUndefined()
  })

  it("refuses a card plan's id, never pushes card plans out, and a waiting card returns the person's plan unchanged", async () => {
    const card = { part: 'Box', units: 'mm' as const, features: [{ name: 'Body', kind: 'extrude', sizes: { width: 80, depth: 60, height: 40 } }], assumptions: [], questions: [] }
    const older = ((await planTool().run(card as never, { ask: async (q: { choices: { id: string }[] }) => q.choices[0]!.id } as never)).output as { planId: string }).planId
    const out = await planTool().run(card as never, {
      ask: async (q: { choices: { id: string }[] }) => {
        const id = planOfChoices(q.choices)!
        // a client tries to overwrite the plan on the card while the person looks at it
        const e = await runCall('design.put_plan', { plan: { ...plan, planId: id, part: 'Steered' } }).then(() => null, (x: unknown) => x as LinkError)
        expect(e?.code).toBe('invalid_input')
        expect(e?.message).toContain('plan the person made')
        // and floods the registry
        for (let k = 0; k < 60; k++) await runCall('design.put_plan', { plan: { ...plan, planId: `flood-${k}` } })
        return planChoiceId('go', id)
      },
    } as never)
    const answer = out.output as { planId: string; accepted: boolean; edits?: unknown }
    expect(answer).toEqual({ planId: answer.planId, accepted: true })
    expect(out.summary).toBe('Approved as shown')
    expect(planById(answer.planId)).toEqual({ planId: answer.planId, ...card })
    expect(mimirPlans.get(older)?.origin).toBe('card')
    expect(mimirPlans.get('flood-59')?.origin).toBe('client')
    expect(mimirPlans.get('flood-0')).toBeUndefined()
    // a client plan is never the card's
    expect(planById('flood-59')).toBeNull()
  })
})
