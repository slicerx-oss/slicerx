// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan waits for the person's Go only when its sizes must fit something (a sheet with fits in the run) or its pieces
// print assembled and move. Any other plan, at its default size, shows on its card and is approved as shown at once:
// the card carries its Go as the answer it went ahead with, and the result says so.
import type { Design as HostDesign, DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry } from '../src/design-check'
import { PLAN_GO, planChoiceId, type PlanAnswer, type PlanInput } from '../src/tab-tools'
import { createCardPlans, tabToolset } from '../src/toolset'

const machine: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }

/** A host with no design open yet: the plan comes before the first build. */
function host(): DesignHost {
  return {
    list: (): HostDesign[] => [],
    get: (id: string) => {
      throw new Error(`no design ${id}`)
    },
  } as unknown as DesignHost
}

function setup(o: { fits?: boolean } = {}) {
  const card = createCardPlans(createPlanRegistry())
  const tools = tabToolset(host(), card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' })
  const plan = tools.find((t) => t.name === 'design.plan')!
  const asked: { auto?: string }[] = []
  const ctx = {
    context: { project: 'creative', machine, objects: [] },
    ...(o.fits !== undefined ? { confirmsPlan: () => o.fits } : {}),
    ask: async (q: { choices: { id: string }[] }, opts?: { auto?: string }) => {
      asked.push(opts ?? {})
      return { id: opts?.auto ?? q.choices[0]!.id }
    },
  } as unknown as ToolContext
  const run = (input: PlanInput) => plan.run(plan.input.parse(input) as never, ctx)
  return { run, asked }
}

const planter: PlanInput = { part: 'Planter', units: 'mm', features: [{ name: 'Pot', kind: 'extrude', sizes: { width: 80, height: 70 } }, { name: 'Drain hole', kind: 'hole', sizes: { diameter: 8 } }], assumptions: [], questions: [] } as unknown as PlanInput

describe('a plan at its default size', () => {
  it('is approved as shown at once, its card answered with Go, and the result says to build and give the size', async () => {
    const { run, asked } = setup()
    const out = await run(planter)
    expect(asked).toEqual([{ auto: planChoiceId(PLAN_GO, 'plan_1') }])
    expect(out.output as PlanAnswer).toMatchObject({ planId: 'plan_1', accepted: true, auto: true })
    expect(out.summary).toMatch(/^Approved as shown at its default size/)
  })

  it('waits for the Go when its sizes must fit something', async () => {
    const { run, asked } = setup({ fits: true })
    const out = await run(planter)
    expect(asked).toEqual([{}])
    expect(out.output as PlanAnswer).toEqual({ planId: 'plan_1', accepted: true })
    expect(out.summary).toBe('Approved as shown')
  })

  it('waits for the Go when its pieces print assembled and move', async () => {
    const { run, asked } = setup({ fits: false })
    const hinged = { ...planter, part: 'Hinged box', features: [{ name: 'Base', kind: 'extrude', sizes: { width: 40 } }, { name: 'Lid', kind: 'extrude', sizes: { width: 40, hinge_gap: 0.4 } }], printInPlace: ['Base', 'Lid'] } as unknown as PlanInput
    await run(hinged)
    expect(asked).toEqual([{}])
  })
})
