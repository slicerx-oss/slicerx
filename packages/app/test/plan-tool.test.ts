// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.plan in the mimir tab: a plan needs at least one feature, waits on the question channel pilot.ask uses, and
// returns accepted with the person's edits, or not accepted. Every plan stays in the registry by id with its latest
// edits, for a later check to read.
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { mimirTools, scriptedMimir, type MimirScript } from '../src/workspaces/mimir/scripted'
import { clearPlans, editPlan, PartPlanSchema, planById, planChoiceId, planOfChoices, planTool, shownPlan, type PartPlan, type PlanInput } from '../src/workspaces/mimir/plan-tool'

afterEach(clearPlans)

const BOX: PlanInput = {
  part: 'a box with a lid',
  units: 'mm',
  features: [
    { name: 'Body', kind: 'extrude', sizes: { width: 80, depth: 60, height: 40, wall: 2 } },
    { name: 'Lid lip', sizes: { height: 4, clearance: 0.2 } },
  ],
  assumptions: ['PLA, so a 0.2 mm clearance on the lip'],
  questions: [],
}

const script = (args: Record<string, unknown>): MimirScript[] => [{ id: 'plan', match: /plan/, steps: [{ calls: [{ name: 'design.plan', args }] }, { text: 'Done.' }] }]

/** Runs one message; `answer` sees each question and says how to answer it. */
async function run(args: Record<string, unknown>, answer: (e: Extract<PilotEvent, { type: 'ask' }>) => string | null): Promise<PilotEvent[]> {
  const p = scriptedMimir(script(args), mimirTools())
  const out: PilotEvent[] = []
  for await (const e of p.run('s', 'plan a box')) {
    out.push(e)
    if (e.type === 'ask') {
      const id = answer(e)
      if (id !== null) void p.answer!(e.askId, id)
    }
  }
  return out
}

const result = (ev: PilotEvent[]) => ev.find((e): e is Extract<PilotEvent, { type: 'tool_result' }> => e.type === 'tool_result')!

describe('design.plan', () => {
  it('is in the tab toolset, as a read tool', () => {
    const t = mimirTools().find((x) => x.name === 'design.plan')!
    expect(t).toBeDefined()
    expect(t.permission).toBe('read')
    expect(planTool().name).toBe('design.plan')
  })

  it('a plan with no features is refused', async () => {
    const ev = await run({ ...BOX, features: [] }, () => 'x')
    expect(ev.some((e) => e.type === 'ask')).toBe(false)
    const r = result(ev)
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/Invalid arguments: features/)
  })

  it('Go returns accepted true, with no edits when nothing changed', async () => {
    let planId = ''
    const ev = await run(BOX, (e) => {
      planId = planOfChoices(e.choices)!
      return planChoiceId('go', planId)
    })
    const ask = ev.find((e) => e.type === 'ask')!
    expect(ask).toMatchObject({ title: 'Plan', question: 'Build a box with a lid from this plan?', choices: [{ label: 'Go' }, { label: 'Not yet' }] })
    const r = result(ev)
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('Approved as shown')
    expect(r.output).toEqual({ planId, accepted: true })
    expect(planById(planId)).toEqual({ planId, ...BOX })
  })

  it('editing a size returns the edited plan, and the registry keeps the edit', async () => {
    let planId = ''
    const ev = await run(BOX, (e) => {
      planId = planOfChoices(e.choices)!
      const plan = planById(planId)!
      const edited: PartPlan = { ...plan, features: plan.features.map((f, i) => (i === 0 ? { ...f, sizes: { ...f.sizes, wall: 2.4 } } : f)) }
      expect(editPlan(planId, edited)).toBe(true)
      return planChoiceId('go', planId)
    })
    const r = result(ev)
    expect(r.summary).toBe('Approved with changes')
    const out = r.output as { planId: string; accepted: boolean; edits: PartPlan }
    expect(out.accepted).toBe(true)
    expect(out.edits.features[0]!.sizes.wall).toBe(2.4)
    expect(PartPlanSchema.parse(out.edits)).toEqual(out.edits)
    expect(planById(planId)!.features[0]!.sizes.wall).toBe(2.4)
    expect(shownPlan(planId)!.features[0]!.sizes.wall).toBe(2)
  })

  it('Not yet returns accepted false, and nothing builds from it', async () => {
    const ev = await run(BOX, (e) => planChoiceId('change', planOfChoices(e.choices)!))
    const r = result(ev)
    expect(r.ok).toBe(false)
    expect((r.output as { accepted: boolean }).accepted).toBe(false)
    expect(r.output).not.toHaveProperty('edits')
  })

  it('takes the overall size and holes when mimir knows them', async () => {
    const ev = await run({ ...BOX, overall: { x: 80, y: 60, z: 44 }, holes: [{ name: 'Vent', diameter: 5 }] }, (e) => planChoiceId('go', planOfChoices(e.choices)!))
    expect(result(ev).ok).toBe(true)
  })

  it('refuses edits of another shape or to an unknown plan, and tells a plan question from an ordinary one', async () => {
    let planId = ''
    await run(BOX, (e) => {
      planId = planOfChoices(e.choices)!
      const plan = planById(planId)!
      expect(editPlan(planId, { ...plan, features: [] })).toBe(false)
      expect(editPlan('plan_nope', { ...plan, planId: 'plan_nope' })).toBe(false)
      expect(editPlan(planId, { ...plan, planId: 'plan_other' })).toBe(false)
      return planChoiceId('go', planId)
    })
    expect(planById(planId)!.features).toHaveLength(2)
    expect(planOfChoices([{ id: 'same' }, { id: 'other' }])).toBeNull()
    expect(planOfChoices([{ id: 'go:plan_unknown' }])).toBeNull()
  })

  it('without anyone to answer, it says so', async () => {
    const tool = planTool()
    const out = await tool.run(BOX as never, {} as never)
    expect(out).toMatchObject({ ok: false, summary: 'Nobody here can approve a plan' })
  })
})
