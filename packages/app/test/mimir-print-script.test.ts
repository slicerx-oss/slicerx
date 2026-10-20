// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scripted print run: "print it on my A1" models a clip, picks the printer and spool from the message, slices and
// sends, in that order, through the same tool calls a model makes. A pick on the card goes on to the slice and the send,
// and is offered once to be remembered at the end. The tools here stand in for the app's, so only the order is tested.
import type { PilotEvent } from '@slicerx/contracts'
import { defineTool, type PilotTool, type ToolContext } from '@slicerx/pilot'
import type { ToolRowModel } from '@slicerx/pilot/ui'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { mimirTools, scriptedMimir } from '../src/workspaces/mimir/scripted'
import { printAsk, SCRIPTS } from '../src/workspaces/mimir/scripts'
import { stepWords } from '../src/workspaces/mimir/step-words'

/** A stand-in tool that answers with what `out` makes of its input (null fails it), needing no approval. */
function fake(name: string, out: (input: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown> | null> | Record<string, unknown>): PilotTool<never> {
  return defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Stands in for ${name}.`,
    input: z.object({}).passthrough(),
    async run(i, ctx) {
      const output = await out(i as Record<string, unknown>, ctx)
      return output ? { summary: `${name} done`, output } : { ok: false, summary: 'No printer picked. Nothing changed.' }
    },
  }) as PilotTool<never>
}

// the printer and spool: what the message named, else a pick on the card
const target = fake('run.target', async (i, ctx) => {
  if (i['printer'] === 'A1') return { printerId: 'p_a1', printerName: 'Bench A1', slots: [{ filament: 1, slot: 'A2', material: 'PETG', color: 'black' }], from: 'words' }
  const picked = await ctx.ask!({ title: 'Which printer and spool?', question: 'Pick the spool to print with.', choices: [{ id: 'pick:p_p1s:A1', label: 'Bay 2, slot A1: PLA, White' }, { id: 'pick:none', label: 'None of these' }] })
  if (picked === 'pick:none') return null
  return { printerId: 'p_p1s', printerName: 'Bay 2', slots: [{ filament: 1, slot: 'A1', material: 'PLA', color: 'white' }], from: 'picked' }
})

const tools = (): PilotTool<never>[] =>
  mimirTools([
    fake('design.new', () => ({ design: 'design_1' })),
    fake('geom.extrude', () => ({ design: 'design_1' })),
    target,
    fake('app.slice', () => ({ status: 'done', sliceId: 'slice_1', timeS: 900, grams: 3.1 })),
    fake('printer.queue', (i) => ({ printerId: i['printerId'], file: 'Clip_plate_1.gcode.3mf', state: 'printing' })),
    fake('memory.remember', () => ({ id: 'mem_1' })),
  ])

async function play(message: string, pick?: string): Promise<PilotEvent[]> {
  const p = scriptedMimir(SCRIPTS, tools())
  const events: PilotEvent[] = []
  for await (const e of p.run('s', message)) {
    events.push(e)
    if (e.type === 'ask') void p.answer!(e.askId, pick ?? e.choices[0]!.id)
    if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
  }
  return events
}

const calls = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'tool_call' ? [{ tool: e.tool, input: e.input as Record<string, unknown> }] : []))
const said = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
const failed = (events: PilotEvent[]) => events.filter((e) => e.type === 'tool_result' && !e.ok)

describe('the scripted print run', () => {
  it('the print-run script calls design, target, slice and queue in order', async () => {
    const events = await play('Make me a cable clip and print it on my A1 in black PETG')
    expect(failed(events)).toEqual([])
    const made = calls(events)
    expect(made.map((c) => c.tool)).toEqual(['pilot.sheet', 'design.new', 'geom.extrude', 'pilot.sheet_bind', 'run.target', 'app.slice', 'printer.queue'])
    // a 30 x 12 x 8 mm clip, in one extrude
    expect(made.find((c) => c.tool === 'geom.extrude')?.input).toMatchObject({ design: 'design_1', shape: { type: 'rectangle', widthMm: 30, heightMm: 12 }, distance_mm: 8 })
    // the printer and material from the message, and the send to the printer that answered
    expect(made.find((c) => c.tool === 'run.target')?.input).toEqual({ printer: 'A1', filaments: [{ material: 'PETG', color: 'black' }] })
    expect(made.find((c) => c.tool === 'printer.queue')?.input).toEqual({ printerId: 'p_a1', plate: 1 })
    // the step list comes before the first call, the send marked as needing the person
    const first = events.findIndex((e) => e.type === 'tool_call')
    expect(said(events.slice(0, first))).toMatch(/1\. .*\n2\. .*\n3\. .*\n4\. .*needs your OK/)
    expect(said(events)).toContain('Sent to Bench A1')
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
    // the target step reads in the person's words
    const row: ToolRowModel = { callId: 'c', tool: 'run.target', source: 'command', args: '', callSummary: undefined, state: 'ok', summary: 'Printing on Bench A1', display: [], progress: [], ms: 1, untrusted: false }
    expect(stepWords(row)).toMatchObject({ doing: 'Picking the printer and spool', done: 'Picked the printer and spool' })
  })

  it('the script answers a picker and goes on', async () => {
    const events = await play('Print it on the shelf printer, please')
    expect(failed(events)).toEqual([])
    expect(events.find((e) => e.type === 'ask')).toMatchObject({ title: 'Which printer and spool?' })
    const made = calls(events)
    // the pick goes on to the slice and the send, and is offered once to be remembered after it
    expect(made.map((c) => c.tool)).toEqual(['pilot.sheet', 'design.new', 'geom.extrude', 'pilot.sheet_bind', 'run.target', 'app.slice', 'printer.queue', 'memory.remember'])
    expect(made.find((c) => c.tool === 'run.target')?.input).toEqual({ printer: 'shelf printer' })
    expect(made.find((c) => c.tool === 'printer.queue')?.input).toEqual({ printerId: 'p_p1s', plate: 1 })
    expect(made.find((c) => c.tool === 'memory.remember')?.input).toMatchObject({ kind: 'printer', text: expect.stringContaining('Bay 2') })
    expect(said(events)).toContain('Sent to Bay 2')
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('the printer name stops where the next instruction starts', () => {
    expect(printAsk('print it on my A1 and slice it')).toEqual({ printer: 'A1' })
    expect(printAsk('Print it on the shelf printer then tell me the time')).toEqual({ printer: 'shelf printer' })
    expect(printAsk('print it on my A1 mini in white PLA')).toEqual({ printer: 'A1 mini', filaments: [{ material: 'PLA', color: 'white' }] })
  })

  it('stops before slicing when no printer was picked', async () => {
    const events = await play('print this on the shelf printer', 'pick:none')
    const made = calls(events).map((c) => c.tool)
    expect(made.at(-1)).toBe('run.target')
    expect(said(events)).toContain('No printer picked. Nothing changed.')
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })
})
