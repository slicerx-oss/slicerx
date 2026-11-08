// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A print-in-place plan's dimension sheet: after design.plan names pieces that print assembled and move
// (printInPlace), the next sheet shows the fit rule's gaps for the printer as guesses, side by side and above and
// below, unless it has its own. A plan without printInPlace, and a sheet before any plan, are as before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotContext, type PilotDim, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '../src/index'
import { PLAN_AGAIN_NOTE } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'
import { clearanceProfileOf, gapRows } from '../skills/fit_check/clearance'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

// a stand-in for the tab's design.plan: approved at once, except a part named Declined, which the person answers Not yet
const plan = defineTool({
  name: 'design.plan',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  description: 'test',
  input: z.object({ part: z.string(), printInPlace: z.array(z.string()).min(2).optional() }),
  async run(i) {
    if (i.part === 'Declined') return { ok: false, summary: 'Not approved; build nothing until the plan is agreed', output: { planId: 'p', accepted: false } }
    return { summary: 'Approved', output: { planId: 'p', accepted: true } }
  },
}) as PilotTool<never>

// stand-ins for the tools that start a design and build a body of it
const stub = (name: string) =>
  defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({}).passthrough(),
    async run() {
      return { summary: 'Done', output: { design: 'd1' } }
    },
  }) as PilotTool<never>

const SHEET = { name: 'pilot.sheet', args: { title: 'Hinge', dims: [{ key: 'width', label: 'Width', value: 40, unit: 'mm', source: 'asked' }] } }

async function sheets(steps: ScriptStep[], context?: PilotContext): Promise<PilotDim[][]> {
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), plan, stub('design.new'), stub('geom.extrude')] })
  const shown: PilotDim[][] = []
  for await (const e of p.run('s', 'A print-in-place hinge', context ? { context } : {}) as AsyncIterable<PilotEvent>) {
    if (e.type === 'sheet') {
      shown.push(e.sheet.dims)
      void p.answerSheet!(e.sheet.id, {})
    }
  }
  return shown
}

/** The replies to each pilot.sheet call and what the model saw after each step, with the person's answer to every sheet. */
async function replies(steps: ScriptStep[], answer: Record<string, number>) {
  const built: string[] = []
  const extrude = defineTool({
    name: 'geom.extrude',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({}).passthrough(),
    async run() {
      built.push('geom.extrude')
      return { summary: 'Done', output: { design: 'd1' } }
    },
  }) as PilotTool<never>
  const seen: string[] = []
  const watched = steps.map((s, k) => (k === 0 ? s : (m: { content?: string }[]) => (seen.push(m.at(-1)?.content ?? ''), typeof s === 'function' ? s(m as never) : s)))
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(watched as ScriptStep[], { chunk: false }), builtins: false, tools: [sheetTool(), plan, stub('design.new'), extrude] })
  const sheet: string[] = []
  const calls = new Map<string, string>()
  for await (const e of p.run('s', 'A print-in-place hinge') as AsyncIterable<PilotEvent>) {
    if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, answer)
    if (e.type === 'tool_call') calls.set(e.callId, e.tool)
    if (e.type === 'tool_result' && calls.get(e.callId) === 'pilot.sheet') sheet.push(e.summary)
  }
  return { sheet, seen, built }
}

describe('the gaps on a print-in-place sheet', () => {
  it('are filled in from the fit rule as guesses after a print-in-place plan', async () => {
    const [before, after] = await sheets([{ calls: [SHEET] }, { calls: [{ name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }] }, { calls: [SHEET] }, { text: 'Done.' }])
    expect(before!.map((d) => d.key)).toEqual(['width'])
    expect(after).toEqual([
      SHEET.args.dims[0],
      { key: 'clearance', label: 'Gap between moving pieces, side by side', value: 0.3, unit: 'mm', min: 0, max: 5, source: 'guess', note: "The fit rule's gap for PLA, 0.4 mm nozzle, 0.2 mm layers" },
      { key: 'clearance_vertical', label: 'Gap between moving pieces, above and below', value: 0.4, unit: 'mm', min: 0, max: 5, source: 'guess', note: "The fit rule's gap for PLA, 0.4 mm nozzle, 0.2 mm layers" },
    ])
  })

  it('follow the printer, filament and layer height of the run', async () => {
    const steps: ScriptStep[] = [{ calls: [{ name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }] }, { calls: [SHEET] }, { text: 'Done.' }]
    const [dims] = await sheets(steps, { machine: { printer: 'A1', material: 'PETG', nozzle: 0.4 }, overrides: { layer_height: 0.28 } })
    expect(dims!.filter((d) => d.source === 'guess').map((d) => [d.key, d.value])).toEqual([
      ['clearance', 0.4],
      ['clearance_vertical', 0.84],
    ])
  })

  it('leave a gap the sheet already has, and are not added without printInPlace', async () => {
    const own = { ...SHEET, args: { ...SHEET.args, dims: [...SHEET.args.dims, { key: 'clearance', label: 'Clearance', value: 0.5, unit: 'mm', source: 'asked' }], part: [{ plane: 'xy', points: [[0, 0], [40, 0], [40, 10]], from: 0, to: 5 }] } }
    const [mine] = await sheets([{ calls: [{ name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }] }, { calls: [own] }, { text: 'Done.' }])
    expect(mine!.map((d) => [d.key, d.value])).toEqual([['width', 40], ['clearance', 0.5], ['clearance_vertical', 0.4]])
    const [plain] = await sheets([{ calls: [{ name: 'design.plan', args: { part: 'Box' } }] }, { calls: [SHEET] }, { text: 'Done.' }])
    expect(plain!.map((d) => d.key)).toEqual(['width'])
  })

  it('belong to the planned part: a later part with no plan gets none', async () => {
    const hinge = { name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }
    const spacer = { name: 'pilot.sheet', args: { title: 'Spacer', dims: [{ key: 'height', label: 'Height', value: 20, unit: 'mm', source: 'asked' }] } }
    // the hinge is built after its sheet, then a spacer is asked for: it skips the plan
    const built = await sheets([{ calls: [hinge] }, { calls: [SHEET] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf' } }] }, { calls: [spacer] }, { text: 'Done.' }])
    expect(built.map((dims) => dims.map((d) => d.key))).toEqual([['width', 'clearance', 'clearance_vertical'], ['height']])
    // the person moved on before the hinge was built: the spacer's own design starts, then its sheet
    const moved = await sheets([{ calls: [hinge] }, { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] }, { calls: [SHEET] }, { calls: [{ name: 'design.new', args: { name: 'Spacer' } }] }, { calls: [spacer] }, { text: 'Done.' }])
    expect(moved.map((dims) => dims.map((d) => d.key))).toEqual([['width', 'clearance', 'clearance_vertical'], ['height']])
    // a later plan without printInPlace takes them away
    const replanned = await sheets([{ calls: [hinge] }, { calls: [{ name: 'design.plan', args: { part: 'Box' } }] }, { calls: [SHEET] }, { text: 'Done.' }])
    expect(replanned.map((dims) => dims.map((d) => d.key))).toEqual([['width']])
  })

  it('are not added after a plan the person did not approve', async () => {
    const [dims] = await sheets([{ calls: [{ name: 'design.plan', args: { part: 'Declined', printInPlace: ['Leaf', 'Pin'] } }] }, { calls: [SHEET] }, { text: 'Done.' }])
    expect(dims!.map((d) => d.key)).toEqual(['width'])
  })

  it('ask for the plan again before a build when the person changes a size on the sheet after the plan', async () => {
    const hinge = { name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }
    const build = { name: 'geom.extrude', args: { name: 'Leaf' } }
    // the person types 60 for the 40 mm width the plan has: the sheet's reply says to plan again, and a build waits for it
    const changed = await replies([{ calls: [hinge] }, { calls: [SHEET] }, { calls: [build] }, { calls: [hinge] }, { calls: [build] }, { text: 'Done.' }], { width: 60 })
    expect(changed.sheet[0]).toContain(PLAN_AGAIN_NOTE)
    expect(changed.seen[2]).toContain(`Nothing was built. ${PLAN_AGAIN_NOTE}`)
    expect(changed.built).toEqual(['geom.extrude'])
    // the sizes as shown, or only the gap rows changed: no new plan
    for (const answer of [{}, { clearance: 0.35, clearance_vertical: 0.45 }]) {
      const same = await replies([{ calls: [hinge] }, { calls: [SHEET] }, { calls: [build] }, { text: 'Done.' }], answer)
      expect(same.sheet[0]).not.toContain(PLAN_AGAIN_NOTE)
      expect(same.built).toEqual(['geom.extrude'])
    }
    // a sheet before any plan changes nothing either
    const early = await replies([{ calls: [SHEET] }, { calls: [build] }, { text: 'Done.' }], { width: 60 })
    expect(early.sheet[0]).not.toContain(PLAN_AGAIN_NOTE)
    expect(early.built).toEqual(['geom.extrude'])
  })

  it('come from the fit rule profile of the run', () => {
    expect(clearanceProfileOf({})).toEqual({ nozzleMm: undefined, material: undefined })
    expect(clearanceProfileOf({ machine: { nozzle: 0.6, material: 'TPU' }, overrides: { layer_height: 'x' } })).toEqual({ nozzleMm: 0.6, material: 'TPU' })
    expect(gapRows([], { nozzleMm: 0.6 }).map((r) => r.value)).toEqual([0.3, 0.6])
  })
})
