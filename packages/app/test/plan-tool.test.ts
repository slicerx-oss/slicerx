// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.plan in the mimir tab: a plan needs at least one feature, waits on the question channel pilot.ask uses, and
// returns accepted with the person's edits, or not accepted. Every plan stays in the registry by id with its latest
// edits, for a later check to read.
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { mimirTools, scriptedMimir, type MimirScript } from '../src/workspaces/mimir/scripted'
import { clearPlans, editPlan, PartPlanSchema, PLAN_KEEP, PLAN_SIZE_MAX, planById, planChoiceId, planOfChoices, planTool, samePlan, shownPlan, withPlanTies, type PartPlan, type PlanInput } from '../src/workspaces/mimir/plan-tool'
import { mimirPlans } from '../src/workspaces/mimir/plans'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'

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

  it('refuses a size of 0 or less, or past the largest a plan takes, before any card shows', async () => {
    const bad = [
      { ...BOX, features: [{ name: 'Body', sizes: { wall: -2 } }] },
      { ...BOX, features: [{ name: 'Body', sizes: { wall: 0 } }] },
      { ...BOX, features: [{ name: 'Body', sizes: { width: PLAN_SIZE_MAX + 1 } }] },
      { ...BOX, holes: [{ name: 'Vent', diameter: -5 }] },
      { ...BOX, overall: { x: 80, y: 0, z: 44 } },
    ]
    for (const args of bad) {
      const ev = await run(args, () => 'x')
      expect(ev.some((e) => e.type === 'ask')).toBe(false)
      expect(result(ev).summary).toMatch(/Invalid arguments/)
    }
  })

  it('a negative or out-of-range edit is refused and the registry keeps the size it had', async () => {
    let planId = ''
    const ev = await run(BOX, (e) => {
      planId = planOfChoices(e.choices)!
      const plan = planById(planId)!
      const withWall = (wall: number): PartPlan => ({ ...plan, features: plan.features.map((f, i) => (i === 0 ? { ...f, sizes: { ...f.sizes, wall } } : f)) })
      expect(editPlan(planId, withWall(-1))).toBe(false)
      expect(editPlan(planId, withWall(0))).toBe(false)
      expect(editPlan(planId, withWall(PLAN_SIZE_MAX * 2))).toBe(false)
      expect(planById(planId)!.features[0]!.sizes.wall).toBe(2)
      return planChoiceId('go', planId)
    })
    expect(result(ev).output).toEqual({ planId, accepted: true })
  })

  it('compares plans by content, whatever order their keys came in', () => {
    const a: PartPlan = { planId: 'p', ...BOX }
    const b = JSON.parse(JSON.stringify({ questions: [], assumptions: a.assumptions, features: a.features.map((f) => ({ sizes: Object.fromEntries(Object.entries(f.sizes).reverse()), name: f.name, ...(f.kind ? { kind: f.kind } : {}) })), units: 'mm', part: a.part, planId: 'p' })) as PartPlan
    expect(samePlan(a, b)).toBe(true)
    expect(samePlan(a, { ...b, units: 'in' })).toBe(false)
  })

  it(`keeps the last ${PLAN_KEEP} plans, the oldest going first`, async () => {
    const tool = planTool()
    const ids: string[] = []
    const ctx = { ask: async (q: { choices: { id: string }[] }) => q.choices[1]!.id } as never
    for (let n = 0; n <= PLAN_KEEP; n++) {
      const out = await tool.run(BOX as never, ctx)
      ids.push((out.output as { planId: string }).planId)
    }
    expect(new Set(ids).size).toBe(PLAN_KEEP + 1)
    expect(planById(ids[0]!)).toBeNull()
    expect(shownPlan(ids[0]!)).toBeNull()
    for (const id of ids.slice(1)) expect(planById(id)).not.toBeNull()
  })

  it('a plan id with colons in it still finds its plan', async () => {
    const tool = planTool({ newId: () => 'plan:with:colons' })
    let seen: string | null = null
    const out = await tool.run(BOX as never, {
      ask: async (q: { choices: { id: string }[] }) => {
        seen = planOfChoices(q.choices)
        return q.choices[0]!.id
      },
    } as never)
    expect(seen).toBe('plan:with:colons')
    expect(out.output).toEqual({ planId: 'plan:with:colons', accepted: true })
    expect(planChoiceId('go', 'plan:with:colons')).toBe('go:plan:with:colons')
  })

  it('without anyone to answer, it says so', async () => {
    const tool = planTool()
    const out = await tool.run(BOX as never, {} as never)
    expect(out).toMatchObject({ ok: false, summary: 'Nobody here can approve a plan' })
  })
})

describe("the tab's design.plan", () => {
  it("is the card's, and the design toolset's design.put_plan (plans kept for MCP clients) stays out of the tab", () => {
    const keeper = defineTool({ name: 'design.put_plan', version: '1.0.0', source: 'command', permission: 'read', description: 'keeps a plan', input: z.object({}), run: async () => ({ summary: 'kept' }) }) as PilotTool<never>
    const tools = mimirTools([keeper])
    expect(tools.filter((t) => t.name === 'design.plan')).toHaveLength(1)
    expect(tools.some((t) => t.name === 'design.put_plan')).toBe(false)
  })
})

describe('design.plan and design.check share one registry', () => {
  const go = { ask: async (q: { choices: { id: string }[] }) => q.choices[0]!.id } as never
  const no = { ask: async (q: { choices: { id: string }[] }) => q.choices[1]!.id } as never
  /** A stand-in for a design tool: design.new answers with its design id, a geometry step takes one. */
  const fake = (name: string, permission: 'read' | 'slice', output?: unknown): PilotTool<never> =>
    defineTool({ name, version: '1.0.0', source: 'command', permission, description: `${name} stand-in for the test`, input: z.object({ design: z.string().optional() }), run: async () => ({ summary: name, output }) }) as PilotTool<never>

  it('a plan made on the card is the one the shared registry holds, edits included', async () => {
    const out = await planTool().run(BOX as never, {
      ask: async (q: { choices: { id: string }[] }) => {
        const id = planOfChoices(q.choices)!
        expect(editPlan(id, { ...planById(id)!, features: [{ ...BOX.features[0]!, sizes: { ...BOX.features[0]!.sizes, wall: 2.4 } }, BOX.features[1]!] })).toBe(true)
        return q.choices[0]!.id
      },
    } as never)
    const { planId } = out.output as { planId: string }
    expect(mimirPlans.get(planId)?.plan.features[0]!.sizes.wall).toBe(2.4)
    expect(mimirPlans.latest()?.planId).toBe(planId)
  })

  it('the design built after Go ties to the approved plan, and only once', async () => {
    const [made, extrude, info] = withPlanTies([fake('design.new', 'slice', { design: 'd7' }), fake('geom.extrude', 'slice'), fake('geom.info', 'read')])
    const { planId } = (await planTool().run(BOX as never, go)).output as { planId: string }
    await info!.run({ design: 'd1' } as never, {} as never)
    expect(mimirPlans.get(planId)?.design).toBeUndefined()
    await made!.run({} as never, {} as never)
    expect(mimirPlans.get(planId)?.design).toBe('d7')
    await extrude!.run({ design: 'd9' } as never, {} as never)
    expect(mimirPlans.get(planId)?.design).toBe('d7')
  })

  it('a geometry step on an existing design ties the plan to it; a plan not approved ties to nothing', async () => {
    const [extrude] = withPlanTies([fake('geom.extrude', 'slice')])
    const refused = ((await planTool().run(BOX as never, no)).output as { planId: string }).planId
    await extrude!.run({ design: 'd3' } as never, {} as never)
    expect(mimirPlans.get(refused)?.design).toBeUndefined()
    const { planId } = (await planTool().run(BOX as never, go)).output as { planId: string }
    await extrude!.run({ design: 'd3' } as never, {} as never)
    expect(mimirPlans.get(planId)?.design).toBe('d3')
  })

  it('sizes past the plan maximum are refused by the shared shape', () => {
    expect(PartPlanSchema.safeParse({ planId: 'p', ...BOX, overall: { x: PLAN_SIZE_MAX + 1, y: 1, z: 1 } }).success).toBe(false)
    expect(() => mimirPlans.put({ planId: 'p', ...BOX, overall: { x: -1, y: 1, z: 1 } })).toThrow()
  })
})
