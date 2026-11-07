// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A print-in-place plan's dimension sheet: after design.plan names pieces that print assembled and move
// (printInPlace), the next sheet shows the fit rule's gaps for the printer as guesses, side by side and above and
// below, unless it has its own. A plan without printInPlace, and a sheet before any plan, are as before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotContext, type PilotDim, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '../src/index'
import { defineTool, type PilotTool } from '../src/tool'
import { clearanceProfileOf, gapRows } from '../skills/fit_check/clearance'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

// a stand-in for the tab's design.plan: approved at once
const plan = defineTool({
  name: 'design.plan',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  description: 'test',
  input: z.object({ part: z.string(), printInPlace: z.array(z.string()).min(2).optional() }),
  async run() {
    return { summary: 'Approved' }
  },
}) as PilotTool<never>

const SHEET = { name: 'pilot.sheet', args: { title: 'Hinge', dims: [{ key: 'width', label: 'Width', value: 40, unit: 'mm', source: 'asked' }] } }

async function sheets(steps: ScriptStep[], context?: PilotContext): Promise<PilotDim[][]> {
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), plan] })
  const shown: PilotDim[][] = []
  for await (const e of p.run('s', 'A print-in-place hinge', context ? { context } : {}) as AsyncIterable<PilotEvent>) {
    if (e.type === 'sheet') {
      shown.push(e.sheet.dims)
      void p.answerSheet!(e.sheet.id, {})
    }
  }
  return shown
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

  it('come from the fit rule profile of the run', () => {
    expect(clearanceProfileOf({})).toEqual({ nozzleMm: undefined, material: undefined })
    expect(clearanceProfileOf({ machine: { nozzle: 0.6, material: 'TPU' }, overrides: { layer_height: 'x' } })).toEqual({ nozzleMm: 0.6, material: 'TPU' })
    expect(gapRows([], { nozzleMm: 0.6 }).map((r) => r.value)).toEqual([0.3, 0.6])
  })
})
