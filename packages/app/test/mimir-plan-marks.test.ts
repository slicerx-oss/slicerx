// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's runtime marks its card plans in the one registry design.check reads (session.ts gives the runtime
// mimirPlans): a size changed on the sheet after a print-in-place plan's Go marks that plan stale there, the design the
// chat starts for the part is recorded with it, its build waits and design.check refuses it, and the next plan's
// answer, approved or declined, lets the build go while design.check keeps refusing the old plan.
import { afterEach, describe, expect, it } from 'vitest'
import type { Design, DesignHost } from '@slicerx/cad-history'
import type { Host, PilotEvent, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type PilotTool, type ScriptStep } from '@slicerx/pilot'
import { designToolset } from '@slicerx/mcp/toolset'
import { z } from 'zod'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { clearPlans, planChoiceId, planOfChoices, withPlanTies } from '../src/workspaces/mimir/plan-tool'
import { mimirPlans } from '../src/workspaces/mimir/plans'
import { mimirTools } from '../src/workspaces/mimir/scripted'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

afterEach(clearPlans)

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Designs that start empty, d1, d2 and on, with the names they are given. */
function designHost(): DesignHost {
  const all: Design[] = []
  return {
    get: (id: string) => {
      const d = all.find((x) => x.id === id)
      if (!d) throw new Error(`no design ${id}`)
      return d
    },
    list: () => all,
    create: async (name: string) => {
      const d = { id: `d${all.length + 1}`, name, history: { version: 1, base: [], steps: [] }, transform: IDENTITY, parts: [], status: [], madeBy: {}, redo: [] } as unknown as Design
      all.push(d)
      return d
    },
    add: async () => Promise.reject(new Error('not here')),
    replay: async () => {},
    call: async () => Promise.reject(new Error('not here')),
  } as unknown as DesignHost
}

const HINGE = { part: 'Hinge', units: 'mm', features: [{ name: 'Leaf', kind: 'extrude', sizes: { width: 40 } }], printInPlace: ['Leaf', 'Pin'], assumptions: [], questions: [] }
const SHEET = { title: 'Hinge', dims: [{ key: 'width', label: 'Width', value: 40, unit: 'mm', source: 'asked' }] }

/**
 * One message in the tab's runtime, made with tabPilotOptions as the tab makes it, over the tab's own tools (design.plan
 * on the card, pilot.sheet), the design toolset's design tools on the app's registry and a geom.extrude stand-in, the
 * design tools with the tab's plan ties. Each plan card is answered Go, or Not yet for the indexes in `decline`; each
 * sheet with `answer`. `steps` may read the planIds shown so far.
 */
async function tab(steps: (plans: string[]) => ScriptStep[], opts: { decline?: number[]; answer?: Record<string, number> } = {}) {
  const built: string[] = []
  const extrude = defineTool({
    name: 'geom.extrude',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'test',
    input: z.object({ design: z.string().optional(), name: z.string().optional() }),
    async run(i) {
      built.push(`${i.name ?? ''}@${i.design ?? ''}`)
      return { summary: 'Done', output: { design: i.design } }
    },
  }) as PilotTool<never>
  const design = designToolset(designHost(), {}, { plans: mimirPlans, cardSide: true }).filter((t) => t.name.startsWith('design.'))
  const tools = withPlanTies(mimirTools([...design, extrude]))
  // the plate's slicer is not used here
  const slicer = { loadModel: async () => Promise.reject(new Error('not here')), slice: async () => Promise.reject(new Error('not here')) }
  const host = { kind: 'web', slicer, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const planIds: string[] = []
  const seen: string[] = []
  const watched = steps(planIds).map((s, k) => (k === 0 ? s : (m: { content?: string }[]) => (seen.push(m.at(-1)?.content ?? ''), typeof s === 'function' ? s(m as never) : s)))
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools, commands: [] })
  const pilot = createPilot({ ...options, client: createScriptedClient(watched as ScriptStep[], { chunk: false }) })
  const calls = new Map<string, string>()
  const results: { tool: string; ok: boolean; summary: string }[] = []
  for await (const e of pilot.run('tab', 'A print-in-place hinge', {}) as AsyncIterable<PilotEvent>) {
    if (e.type === 'ask') {
      const planId = planOfChoices(e.choices)
      if (planId) {
        planIds.push(planId)
        void pilot.answer!(e.askId, planChoiceId(opts.decline?.includes(planIds.length - 1) ? 'change' : 'go', planId))
      }
    }
    if (e.type === 'sheet') void pilot.answerSheet!(e.sheet.id, opts.answer ?? {})
    if (e.type === 'tool_call') calls.set(e.callId, e.tool)
    if (e.type === 'tool_result') results.push({ tool: calls.get(e.callId) ?? '', ok: e.ok, summary: e.summary })
  }
  return { built, seen, results, planIds }
}

const HELD = 'Nothing was built.'

describe("the mimir tab's plan marks in the registry design.check reads", () => {
  it('marks the plan stale and records the design started for its part, holds that design, and design.check refuses the plan', async () => {
    const marks: unknown[] = []
    const peek = (planIds: string[], step: ScriptStep): ScriptStep => (m) => (marks.push(structuredClone(mimirPlans.get(planIds[0]!) ?? null)), typeof step === 'function' ? step(m) : step)
    const { built, seen, results, planIds } = await tab(
      (ids) => [
        { calls: [{ name: 'design.plan', args: HINGE }] },
        { calls: [{ name: 'pilot.sheet', args: SHEET }] },
        // the part is started under another name than the plan's, after the sheet changed a size
        { calls: [{ name: 'design.new', args: { name: 'Hinge box' } }] },
        peek(ids, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] }),
        (() => ({ calls: [{ name: 'design.check', args: { planId: ids[0]! } }] })) as ScriptStep,
        { text: 'Waiting for the plan.' },
      ],
      { answer: { width: 60 } },
    )
    expect(planIds).toHaveLength(1)
    // the runtime's marks are the registry's own: stale, with the design started for the part, and tied to none
    expect(marks[0]).toMatchObject({ stale: true, claimed: 'd1' })
    expect((marks[0] as { design?: string }).design).toBeUndefined()
    expect(seen[3]).toContain(HELD)
    expect(built).toEqual([])
    const check = results.find((r) => r.tool === 'design.check')!
    expect(check.ok).toBe(false)
    expect(check.summary).toContain('The person changed sizes after the plan for Hinge was approved')
  })

  it('lets the build go once a later plan is turned down, and design.check still refuses the old plan as superseded', async () => {
    const { built, results, planIds } = await tab(
      (ids) => [
        { calls: [{ name: 'design.plan', args: HINGE }] },
        { calls: [{ name: 'pilot.sheet', args: SHEET }] },
        { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] },
        { calls: [{ name: 'design.plan', args: { ...HINGE, features: [{ name: 'Leaf', kind: 'extrude', sizes: { width: 60 } }] } }] },
        { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] },
        (() => ({ calls: [{ name: 'design.check', args: { planId: ids[0]! } }] })) as ScriptStep,
        { text: 'Done.' },
      ],
      { answer: { width: 60 }, decline: [1] },
    )
    expect(planIds).toHaveLength(2)
    expect(built).toEqual(['Leaf@d1'])
    expect(mimirPlans.get(planIds[0]!)).toMatchObject({ superseded: true, claimed: 'd1' })
    expect(mimirPlans.get(planIds[0]!)?.stale).toBeUndefined()
    // the part built from the confirmed sheet is not tied to the plan the person changed
    expect(mimirPlans.get(planIds[0]!)?.design).toBeUndefined()
    const check = results.find((r) => r.tool === 'design.check')!
    expect(check.ok).toBe(false)
    expect(check.summary).toContain('a newer plan has been answered since')
  })

  it('checks the part against the new plan once it is approved: the old one is superseded, the new one tied to the part', async () => {
    const { built, results, planIds } = await tab(
      (ids) => [
        { calls: [{ name: 'design.plan', args: HINGE }] },
        { calls: [{ name: 'pilot.sheet', args: SHEET }] },
        { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] },
        { calls: [{ name: 'design.plan', args: { ...HINGE, features: [{ name: 'Leaf', kind: 'extrude', sizes: { width: 60 } }] } }] },
        { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] },
        (() => ({ calls: [{ name: 'design.check', args: { planId: ids[1]! } }] })) as ScriptStep,
        { text: 'Done.' },
      ],
      { answer: { width: 60 } },
    )
    expect(built).toEqual(['Leaf@d1'])
    expect(mimirPlans.get(planIds[0]!)?.superseded).toBe(true)
    expect(mimirPlans.get(planIds[1]!)).toMatchObject({ design: 'd1' })
    expect(mimirPlans.get(planIds[1]!)?.stale).toBeUndefined()
    // the new plan prints in place, so its check waits for the fit check: it is not refused as changed or superseded
    const check = results.find((r) => r.tool === 'design.check')!
    expect(check.summary).toContain('prints in place, so its gaps are looked at first')
  })
  it('holds the part when a size changes again after the plan is made again, and design.check refuses the new plan', async () => {
    const wider = { ...HINGE, features: [{ name: 'Leaf', kind: 'extrude', sizes: { width: 60 } }] }
    const { built, seen, results, planIds } = await tab(
      (ids) => [
        { calls: [{ name: 'design.plan', args: HINGE }] },
        { calls: [{ name: 'pilot.sheet', args: SHEET }] },
        { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] },
        { calls: [{ name: 'design.plan', args: wider }] },
        // the sheet still shows 40 mm and the person types 60 again: the new plan's sizes changed before the build
        { calls: [{ name: 'pilot.sheet', args: SHEET }] },
        { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] },
        (() => ({ calls: [{ name: 'design.check', args: { planId: ids[1]! } }] })) as ScriptStep,
        { text: 'Waiting for the plan.' },
      ],
      { answer: { width: 60 } },
    )
    expect(planIds).toHaveLength(2)
    expect(seen[5]).toContain(HELD)
    expect(built).toEqual([])
    expect(mimirPlans.get(planIds[1]!)).toMatchObject({ stale: true, claimed: 'd1' })
    const check = results.find((r) => r.tool === 'design.check')!
    expect(check.ok).toBe(false)
    expect(check.summary).toContain('The person changed sizes after the plan for Hinge was approved')
  })
})
