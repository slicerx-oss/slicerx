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
    // a sheet of several rows places each one on the drawing (at)
    const own = {
      ...SHEET,
      args: {
        ...SHEET.args,
        dims: [
          { ...SHEET.args.dims[0]!, at: { a: [0, 0, 0], b: [40, 0, 0], off: [0, -5, 0] } },
          { key: 'clearance', label: 'Clearance', value: 0.5, unit: 'mm', source: 'asked', at: { a: [40, 0, 0], b: [40.5, 0, 0], off: [0, -5, 0] } },
        ],
        part: [{ plane: 'xy', points: [[0, 0], [40, 0], [40, 10]], from: 0, to: 5 }],
      },
    }
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

  it('are not added to the next run\'s sheet after the planned part\'s sheet was confirmed and the part never built', async () => {
    // the hinge's sheet is confirmed, then the person asks for a spacer instead: a one-feature part skips the plan
    const spacer = { name: 'pilot.sheet', args: { title: 'Spacer', dims: [{ key: 'height', label: 'Height', value: 20, unit: 'mm', source: 'asked' }] } }
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([{ calls: [{ name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }] }, { calls: [SHEET] }, { text: 'Shall I build it?' }, { calls: [spacer] }, { text: 'Done.' }], { chunk: false }), builtins: false, tools: [sheetTool(), plan, stub('design.new'), stub('geom.extrude')] })
    const shown: string[][] = []
    for (const message of ['A print-in-place hinge', 'Skip that, make a 20 mm spacer instead'])
      for await (const e of p.run('s', message) as AsyncIterable<PilotEvent>)
        if (e.type === 'sheet') {
          shown.push(e.sheet.dims.map((d) => d.key))
          void p.answerSheet!(e.sheet.id, {})
        }
    expect(shown).toEqual([['width', 'clearance', 'clearance_vertical'], ['height']])
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

  // every call that starts a design or builds a body, in the order they ran, and the replies the model saw
  async function building(steps: ScriptStep[], answers: Record<string, number>[]) {
    const ran: string[] = []
    const tool = (name: string) =>
      defineTool({
        name,
        version: '1.0.0',
        source: 'command',
        permission: 'read',
        description: 'test',
        input: z.object({}).passthrough(),
        async run() {
          ran.push(name)
          return { summary: 'Done', output: { design: 'd1' } }
        },
      }) as PilotTool<never>
    const seen: string[] = []
    const watched = steps.map((s, k) => (k === 0 ? s : (m: { content?: string }[]) => (seen.push(m.at(-1)?.content ?? ''), typeof s === 'function' ? s(m as never) : s)))
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(watched as ScriptStep[], { chunk: false }), builtins: false, tools: [sheetTool(), plan, tool('design.new'), tool('design.open'), tool('geom.extrude'), tool('geom.build')] })
    const sheet: string[] = []
    const calls = new Map<string, string>()
    let k = 0
    for await (const e of p.run('s', 'A print-in-place hinge') as AsyncIterable<PilotEvent>) {
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, answers[k++] ?? {})
      if (e.type === 'tool_call') calls.set(e.callId, e.tool)
      if (e.type === 'tool_result' && calls.get(e.callId) === 'pilot.sheet') sheet.push(e.summary)
    }
    return { ran, seen, sheet }
  }

  it('start a new design for the planned part while the plan waits to be made again, and hold its first body until it is', async () => {
    const hinge = { name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }
    const start = { name: 'design.new', args: { name: 'Hinge' } }
    const build = { name: 'geom.extrude', args: { name: 'Leaf' } }
    // the person types 60 for the 40 mm width, and the model starts the design before it plans again
    const { ran, seen, sheet } = await building([{ calls: [hinge] }, { calls: [SHEET] }, { calls: [start] }, { calls: [build] }, { calls: [SHEET] }, { calls: [hinge] }, { calls: [build] }, { text: 'Done.' }], [{ width: 60 }, { width: 60 }])
    expect(seen[2]).not.toContain('Nothing was built')
    expect(seen[3]).toContain(`Nothing was built. ${PLAN_AGAIN_NOTE}`)
    // a sheet shown while the plan waits still says to plan again
    expect(sheet[1]).toContain(PLAN_AGAIN_NOTE)
    expect(ran).toEqual(['design.new', 'geom.extrude'])
  })

  it('ask for the plan again when the size changes on a sheet shown after the planned part\'s design was started', async () => {
    const hinge = { name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }
    const start = { name: 'design.new', args: { name: 'Hinge' } }
    for (const build of [{ name: 'geom.extrude', args: { name: 'Leaf' } }, { name: 'geom.build', args: { name: 'Hinge' } }]) {
      const { ran, seen, sheet } = await building([{ calls: [hinge] }, { calls: [start] }, { calls: [SHEET] }, { calls: [build] }, { calls: [hinge] }, { calls: [build] }, { text: 'Done.' }], [{ width: 60 }])
      expect(sheet[0]).toContain(PLAN_AGAIN_NOTE)
      expect(seen[3]).toContain(`Nothing was built. ${PLAN_AGAIN_NOTE}`)
      expect(ran).toEqual(['design.new', build.name])
    }
    // the sizes as shown: the design's first body is built at once
    const same = await building([{ calls: [hinge] }, { calls: [start] }, { calls: [SHEET] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf' } }] }, { text: 'Done.' }], [{}])
    expect(same.ran).toEqual(['design.new', 'geom.extrude'])
  })

  it('open a file to look at while the plan waits to be made again: opening builds nothing', async () => {
    const hinge = { name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }
    const open = { name: 'design.open', args: { path: 'hinge.3mf' } }
    const { ran, seen } = await building([{ calls: [hinge] }, { calls: [SHEET] }, { calls: [open] }, { text: 'Done.' }], [{ width: 60 }])
    expect(seen[2]).not.toContain('Nothing was built')
    expect(ran).toEqual(['design.open'])
  })

  // the hinge's plan and a spacer's sheet, and a run of messages in one chat with each sheet answered in turn: the tool
  // replies other than design.plan's, and the names geom.extrude built
  const HINGE = { name: 'design.plan', args: { part: 'Hinge', printInPlace: ['Leaf', 'Pin'] } }
  const SPACER = { name: 'pilot.sheet', args: { title: 'Spacer', dims: [{ key: 'height', label: 'Height', value: 20, unit: 'mm', source: 'asked' }] } }
  async function chat(steps: ScriptStep[], messages: string[], answers: Record<string, number>[]) {
    const built: string[] = []
    const extrude = defineTool({
      name: 'geom.extrude',
      version: '1.0.0',
      source: 'command',
      permission: 'read',
      description: 'test',
      input: z.object({}).passthrough(),
      async run(i: { name?: string }) {
        built.push(i.name ?? '')
        return { summary: 'Done', output: { design: 'd1' } }
      },
    }) as PilotTool<never>
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), plan, stub('design.new'), extrude] })
    const summaries: string[] = []
    const calls = new Map<string, string>()
    let k = 0
    for (const message of messages)
      for await (const e of p.run('s', message) as AsyncIterable<PilotEvent>) {
        if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, answers[k++] ?? {})
        if (e.type === 'tool_call') calls.set(e.callId, e.tool)
        if (e.type === 'tool_result' && calls.get(e.callId) !== 'design.plan') summaries.push(e.summary)
      }
    return { summaries, built }
  }

  it('stop asking for the plan again in a later run that drops the print-in-place part', async () => {
    // run 1 changes the hinge's width on its sheet and ends before a new plan; run 2 asks for a spacer instead
    const { summaries, built } = await chat(
      [{ calls: [HINGE] }, { calls: [SHEET] }, { text: 'I will plan it again.' }, { calls: [SPACER] }, { calls: [{ name: 'design.new', args: { name: 'Spacer' } }] }, { calls: [{ name: 'geom.extrude', args: { name: 'Spacer', design: 'd1' } }] }, { text: 'Done.' }],
      ['A print-in-place hinge', 'Forget it, make me a 20 mm spacer'],
      [{ width: 60 }, {}],
    )
    expect(summaries[0]).toContain(PLAN_AGAIN_NOTE)
    expect(summaries.slice(1).join(' ')).not.toContain(PLAN_AGAIN_NOTE)
    expect(built).toEqual(['Spacer'])
  })

  it('stop asking for the plan again when the person declines the new plan: the part is built from the sheet', async () => {
    const { summaries, built } = await chat(
      [{ calls: [HINGE] }, { calls: [SHEET] }, { calls: [{ name: 'design.plan', args: { part: 'Declined', printInPlace: ['Leaf', 'Pin'] } }] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf' } }] }, { text: 'Done.' }],
      ['A print-in-place hinge'],
      [{ width: 60 }],
    )
    expect(summaries[0]).toContain(PLAN_AGAIN_NOTE)
    expect(summaries.join(' ')).not.toContain('Nothing was built')
    expect(built).toEqual(['Leaf'])
  })

  // A chat of several messages over stand-ins that keep their designs apart: design.new and design.open start designs
  // d1, d2 and on, with their names, and geom.extrude records what it built and on which design. What every call
  // started or built, the replies the model saw after each step, and the tool rows other than design.plan's.
  async function talk(steps: ScriptStep[], messages: string[], answers: Record<string, number>[], opts: { plans?: unknown } = {}) {
    const ran: string[] = []
    let n = 0
    const tool = (name: string, run: (i: Record<string, unknown>) => Record<string, unknown>, permission: 'read' | 'slice' = 'read') =>
      defineTool({ name, version: '1.0.0', source: 'command', permission, description: 'test', input: z.object({}).passthrough(), async run(i: Record<string, unknown>) { return { summary: 'Done', output: run(i) } } }) as PilotTool<never>
    const tools = [
      sheetTool(),
      plan,
      tool('design.new', (i) => (ran.push(`new ${String(i.name)}`), { design: `d${++n}`, name: i.name })),
      tool('design.open', () => { const id = `d${++n}`; ran.push(`open ${id}`); return { designs: [{ design: id, name: 'Lamp' }] } }),
      tool('geom.extrude', (i) => (ran.push(`${String(i.name)}@${String(i.design)}`), { design: i.design }), 'slice'),
      tool('geom.push_pull', (i) => (ran.push(`push@${String(i.design)}`), { design: i.design }), 'slice'),
    ]
    const seen: string[] = []
    const watched = steps.map((s, k) => (k === 0 ? s : (m: { content?: string }[]) => (seen.push(m.at(-1)?.content ?? ''), typeof s === 'function' ? s(m as never) : s)))
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(watched as ScriptStep[], { chunk: false }), builtins: false, tools, ...(opts.plans ? { plans: opts.plans as never } : {}) })
    const summaries: string[] = []
    const calls = new Map<string, string>()
    let k = 0
    for (const message of messages)
      for await (const e of p.run('s', message) as AsyncIterable<PilotEvent>) {
        if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, answers[k++] ?? {})
        if (e.type === 'tool_call') calls.set(e.callId, e.tool)
        if (e.type === 'tool_result' && calls.get(e.callId) !== 'design.plan') summaries.push(e.summary)
      }
    return { ran, seen, summaries }
  }
  const HELD = `Nothing was built. ${PLAN_AGAIN_NOTE}`
  // a sheet with its own gap rows, as mimir may send for a print-in-place part, each row placed on the drawing
  const OWN_GAPS = {
    name: 'pilot.sheet',
    args: {
      title: 'Hinge',
      part: [{ plane: 'xy', points: [[0, 0], [40, 0], [40, 10]], from: 0, to: 5 }],
      dims: [
        { key: 'width', label: 'Width', value: 40, unit: 'mm', source: 'asked', at: { a: [0, 0, 0], b: [40, 0, 0], off: [0, -5, 0] } },
        { key: 'clearance', label: 'Gap side by side', value: 0.4, unit: 'mm', source: 'guess', at: { a: [40, 0, 0], b: [40.4, 0, 0], off: [0, -5, 0] } },
        { key: 'clearance_vertical', label: 'Gap above and below', value: 0.4, unit: 'mm', source: 'guess', at: { a: [0, 0, 5], b: [0, 0, 5.4], off: [-5, 0, 0] } },
      ],
    },
  }

  it('keep holding the planned part across a run boundary until the plan is made again, when the person says go ahead', async () => {
    // run 1 changes the width and ends before a new plan; run 2 is the person saying ok
    const { ran, seen } = await talk(
      [{ calls: [HINGE] }, { calls: [SHEET] }, { text: 'The width changed, shall I plan it again?' }, { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] }, { calls: [HINGE] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] }, { text: 'Done.' }],
      ['A print-in-place hinge', 'ok, go ahead'],
      [{ width: 60 }],
    )
    expect(seen[3]).not.toContain('Nothing was built')
    expect(seen[4]).toContain(HELD)
    expect(ran).toEqual(['new Hinge', 'Leaf@d1'])
  })

  it('end with the planned part when the sheet has its own gap rows: a later run opens a file and builds a spacer', async () => {
    const { ran, seen } = await talk(
      [{ calls: [HINGE] }, { calls: [OWN_GAPS] }, { text: 'Shall I plan it again?' }, { calls: [{ name: 'design.open', args: { path: 'lamp.3mf' } }] }, { text: 'Opened.' }, { calls: [SPACER] }, { calls: [{ name: 'design.new', args: { name: 'Spacer' } }] }, { calls: [{ name: 'geom.extrude', args: { name: 'Spacer', design: 'd2' } }] }, { text: 'Done.' }],
      ['A print-in-place hinge', 'Forget the hinge, open lamp.3mf so I can look', 'Make me a 20 mm spacer'],
      [{ width: 60 }, {}],
    )
    expect(seen.join(' ')).not.toContain('Nothing was built')
    expect(ran).toEqual(['open d1', 'new Spacer', 'Spacer@d2'])
    // the planned part itself still waits for the plan
    const hinge = await talk(
      [{ calls: [HINGE] }, { calls: [OWN_GAPS] }, { text: 'Shall I plan it again?' }, { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] }, { text: 'Waiting.' }],
      ['A print-in-place hinge', 'go'],
      [{ width: 60 }],
    )
    expect(hinge.seen[4]).toContain(HELD)
    expect(hinge.ran).toEqual(['new Hinge'])
  })

  it('build at once when only the gap rows mimir put on the sheet change: the plan does not hold them', async () => {
    const { ran, seen } = await talk(
      [{ calls: [HINGE] }, { calls: [OWN_GAPS] }, { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] }, { text: 'Done.' }],
      ['A print-in-place hinge'],
      [{ clearance: 0.5, clearance_vertical: 0.6 }],
    )
    expect(seen.join(' ')).not.toContain(PLAN_AGAIN_NOTE)
    expect(ran).toEqual(['new Hinge', 'Leaf@d1'])
  })

  it("open a file and build on another design after the planned part's design was started, holding only the planned part", async () => {
    const leaf = { name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }
    const { ran, seen } = await talk(
      [{ calls: [HINGE] }, { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] }, { calls: [SHEET] }, { calls: [{ name: 'design.open', args: { path: 'lamp.3mf' } }] }, { calls: [leaf] }, { calls: [{ name: 'geom.extrude', args: { name: 'Shade', design: 'd2' } }] }, { calls: [HINGE] }, { calls: [leaf] }, { text: 'Done.' }],
      ['A print-in-place hinge'],
      [{ width: 60 }],
    )
    expect(seen[3]).not.toContain('Nothing was built')
    expect(seen[4]).toContain(HELD)
    expect(seen[5]).not.toContain('Nothing was built')
    expect(ran).toEqual(['new Hinge', 'open d2', 'Shade@d2', 'Leaf@d1'])
  })

  it('hold every change to the planned part started from a model while its plan waits, a join on it included', async () => {
    // design.new from a model brings the part's bodies, so its first change is no new body: a push or a join on it
    const join = { name: 'geom.extrude', args: { name: 'Knuckle', design: 'd1', operation: 'join' } }
    const push = { name: 'geom.push_pull', args: { design: 'd1' } }
    const { ran, seen } = await talk(
      [{ calls: [HINGE] }, { calls: [SHEET] }, { calls: [{ name: 'design.new', args: { name: 'Hinge', from: 'hinge.stl' } }] }, { calls: [push] }, { calls: [join] }, { calls: [HINGE] }, { calls: [push] }, { calls: [join] }, { text: 'Done.' }],
      ['A print-in-place hinge'],
      [{ width: 60 }],
    )
    expect(seen[2]).not.toContain('Nothing was built')
    expect(seen[3]).toContain(HELD)
    expect(seen[4]).toContain(HELD)
    expect(ran).toEqual(['new Hinge', 'push@d1', 'Knuckle@d1'])
  })

  it('hold a join on the empty design of the planned part while its plan waits, and change another design', async () => {
    // the open question from the review: a join on a design with no body yet makes none (the step has no part to join),
    // and while the plan waits it does not run at all; a change to another design does
    const { ran, seen } = await talk(
      [{ calls: [HINGE] }, { calls: [{ name: 'design.new', args: { name: 'Hinge' } }] }, { calls: [SHEET] }, { calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1', operation: 'join' } }] }, { calls: [{ name: 'design.open', args: { path: 'lamp.3mf' } }] }, { calls: [{ name: 'geom.push_pull', args: { design: 'd2' } }] }, { text: 'Waiting for the plan.' }],
      ['A print-in-place hinge'],
      [{ width: 60 }],
    )
    expect(seen[3]).toContain(HELD)
    expect(seen[5]).not.toContain('Nothing was built')
    expect(ran).toEqual(['new Hinge', 'open d2', 'push@d2'])
  })

  it("keep the mark in the host's plans: a size change marks the plan, a plan made again or declined clears it, and the plan's own design is the one held", async () => {
    const marks = new Map<string, { stale?: true; design?: string }>()
    const plans = {
      stale: (id: string) => (marks.set(id, { ...marks.get(id), stale: true }), true),
      fresh: (id: string) => void delete (marks.get(id) ?? {}).stale,
      get: (id: string) => marks.get(id),
    }
    // the host tied the plan to the design its part was started in, whatever that design is called
    marks.set('p', { design: 'd1' })
    const states: (true | undefined)[] = []
    const peek = (step: ScriptStep): ScriptStep => (m) => (states.push(marks.get('p')?.stale), typeof step === 'function' ? step(m) : step)
    const { ran, seen } = await talk(
      [{ calls: [HINGE] }, { calls: [{ name: 'design.new', args: { name: 'Hinge box' } }] }, { calls: [SHEET] }, peek({ calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] }), { calls: [{ name: 'design.plan', args: { part: 'Declined', printInPlace: ['Leaf', 'Pin'] } }] }, peek({ calls: [{ name: 'geom.extrude', args: { name: 'Leaf', design: 'd1' } }] }), { text: 'Done.' }],
      ['A print-in-place hinge'],
      [{ width: 60 }],
      { plans },
    )
    expect(states).toEqual([true, undefined])
    expect(seen[3]).toContain(HELD)
    expect(ran).toEqual(['new Hinge box', 'Leaf@d1'])
  })

  it('come from the fit rule profile of the run', () => {
    expect(clearanceProfileOf({})).toEqual({ nozzleMm: undefined, material: undefined })
    expect(clearanceProfileOf({ machine: { nozzle: 0.6, material: 'TPU' }, overrides: { layer_height: 'x' } })).toEqual({ nozzleMm: 0.6, material: 'TPU' })
    expect(gapRows([], { nozzleMm: 0.6 }).map((r) => r.value)).toEqual([0.3, 0.6])
  })
})
