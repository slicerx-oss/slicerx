// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.plan takes a plan with no assumptions or questions as one that has none, and room for longer lines: an
// assumption of up to 300 characters, up to 20 of them, and proportions of up to 400 characters. design.put_plan takes
// the same assumptions. A plan past them is still refused by the schema.
import type { DesignHost } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import { toolSpec, type ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { PLAN_GO } from '../src/tab-tools'
import { createCardPlans, designToolset, tabToolset } from '../src/toolset'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
const host = { list: () => [], get: () => undefined } as unknown as DesignHost

/** A box and its lid, with no assumptions or questions given. */
const box = {
  part: 'Box',
  units: 'mm',
  features: [
    { name: 'Body', kind: 'extrude', sizes: { width: 60, depth: 40, height: 30, wall: 2 } },
    { name: 'Lid', kind: 'extrude', sizes: { width: 60, depth: 40, height: 4 } },
  ],
}

function tab() {
  const card = createCardPlans(createPlanRegistry())
  const tool = tabToolset(host, card, { nozzleMm: () => machine.nozzle, newPlanId: () => 'plan_1' }).find((t) => t.name === 'design.plan')!
  const ctx = { context: { project: 'creative', machine, objects: [] }, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices.find((c) => c.id.startsWith(`${PLAN_GO}:`))!.id }) } as unknown as ToolContext
  return { card, tool, run: (input: unknown) => tool.run(tool.input.parse(input) as never, ctx) }
}

describe('design.plan defaults and caps', () => {
  it('takes a plan with no assumptions or questions as one with none', async () => {
    const t = tab()
    const out = await t.run(box)
    expect(out.output).toMatchObject({ planId: 'plan_1', accepted: true })
    expect(t.card.plans.get('plan_1')!.plan).toMatchObject({ assumptions: [], questions: [] })
    const spec = toolSpec(t.tool) as unknown as { inputSchema: { required?: string[]; properties: Record<string, { maxItems?: number; items?: { maxLength?: number }; maxLength?: number }> } }
    expect(spec.inputSchema.required ?? []).not.toContain('assumptions')
    expect(spec.inputSchema.required ?? []).not.toContain('questions')
    expect(spec.inputSchema.properties['assumptions']).toMatchObject({ maxItems: 20, items: { maxLength: 300 } })
    expect(spec.inputSchema.properties['proportions']).toMatchObject({ maxLength: 400 })
  })

  it('takes 20 assumptions of 300 characters and proportions of 400, and refuses one more of each', async () => {
    const t = tab()
    const twenty = Array.from({ length: 20 }, (_, k) => `Assumption ${k + 1} `.padEnd(300, 'a'))
    const out = await t.run({ ...box, assumptions: twenty, questions: [] })
    expect(out.output).toMatchObject({ accepted: true })
    expect(t.card.plans.get('plan_1')!.plan.assumptions).toHaveLength(20)
    expect(t.tool.input.safeParse({ ...box, assumptions: [...twenty, 'one more'] }).success).toBe(false)
    expect(t.tool.input.safeParse({ ...box, assumptions: ['c'.repeat(301)] }).success).toBe(false)
    expect(t.tool.input.safeParse({ ...box, detail: 'display', proportions: 'p'.repeat(400) }).success).toBe(true)
    expect(t.tool.input.safeParse({ ...box, detail: 'display', proportions: 'p'.repeat(401) }).success).toBe(false)
  })

  it('design.put_plan takes the same assumptions', async () => {
    const plans = createPlanRegistry()
    const put = designToolset(host, {}, { plans, nozzleMm: () => 0.4 }).find((x) => x.name === 'design.put_plan')!
    expect(put.version).toBe('1.10.1')
    const plan: PartPlan = { planId: 'box-1', ...box, units: 'mm', assumptions: Array.from({ length: 20 }, () => 'd'.repeat(300)), questions: [] }
    await put.run(put.input.parse({ plan }) as never, { context: { machine } } as unknown as ToolContext)
    expect(plans.get('box-1')!.plan.assumptions).toHaveLength(20)
  })
})
