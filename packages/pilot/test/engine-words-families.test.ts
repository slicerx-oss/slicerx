// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every engine refusal reaches the person as a plain line with what to try. The texts below are the engine's own, from
// packages/geom/src (with sample numbers where the engine fills one in), as the hosts pass them on: sx-geom's "op: why"
// and the design host's "The step did not go through: ...". The row shows the plain line, the engine's text stays in
// the row's details, and the model reads the engine's text with how to go on and a reminder never to quote it.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { geomStuckMessage } from '@slicerx/contracts/geom-limits'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '../src/index'
import { plainEngine } from '../src/engine-words'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

/** [tool, engine text, words the plain line has] */
const CASES: readonly (readonly [string, string, RegExp])[] = [
  // boolean.rs too_long, mcp geom.ts
  ['geom.array', 'boolean: this join is taking too long to finish; try fewer copies or join them in smaller groups', /took too long/],
  ['geom.cut', 'sx-geom cut exceeded its execution deadline (300000 ms). Retry the operation.', /took too long/],
  // edge.rs, shell.rs: a size that does not fit
  ['geom.fillet', 'radiusMm: 6 mm does not fit on this face; at most 5.000 mm', /too big for this part/],
  ['geom.fillet', 'The step did not go through: The result is not watertight; try a smaller size. The design is unchanged.', /too big for this part/],
  ['geom.shell', 'wallMm: the wall is too thick for this body; try a thinner one', /too big for this part/],
  // sketch_sweep.rs, sketch_loft.rs, thicken.rs: a shape that crosses itself
  ['geom.sweep', 'sweep: the path bends too tightly for the profile near (12.00, 0.00, 40.00) mm, so the sides would cross; use a wider bend or a smaller profile', /fold into itself/],
  ['geom.loft', 'loft: the lofted body runs into itself; space the profiles further apart or make them smaller', /fold into itself/],
  ['geom.loft', 'loft: profiles 2 and 3 touch or cross; space them apart along the loft', /fold into itself/],
  ['geom.sweep', 'thicken: a 3 mm outward shell runs into itself where parts of the surface are closer than that; use a thinner shell or move those parts apart', /fold into itself/],
  // edge.rs: too many fillets at a corner
  ['geom.fillet', 'edges: the corner at (20.000, 10.000, 5.000) joins more than three fillets; leave some of its edges out', /rounded edges/],
  // edge.rs, shell.rs, cad-history replay.ts: the pick moved
  ['geom.fillet', 'edges: edge 2 moved with the face beside it and is not there any more; pick it again', /Picking it again/],
  ['geom.shell', 'open: a face to open is not on a face of the body; pick it again', /Picking it again/],
  ['design.edit_step', 'Edited step 2, Fillet; step 3 broke: Missing face; pick the face again to repair this step.', /Picking it again/],
  // push.rs, shell.rs: nothing left
  ['geom.push_pull', 'face.push: the cut removes the whole body', /whole part/],
  ['geom.shell', 'open: opening every face leaves no body; leave at least one face closed', /whole part/],
  // array.rs, sketch_sweep.rs, hollow.rs: over a size limit
  ['geom.array', 'count: at most 2000 copies', /more detail/],
  ['geom.hollow', 'voxelMm: the grid would have 912000000 cells; use a larger voxel', /more detail/],
  // any other engine refusal
  ['geom.build', 'request: missing "parts"', /could not be made/],
  ['geom.build', 'unknown operation "brep.wedge"', /could not be made/],
  ['geom.shell', 'wallMm: must be above 0 (at most 1000 mm)', /could not be made/],
  ['geom.cut', 'sx-geom cut exited with code 101: thread main panicked at src/cut.rs', /could not be made/],
  ['design.edit_step', 'Exact replay stopped: Exact operation failed: brep: no body in the reply. The design is unchanged.', /could not be made/],
]

function failing(name: string, text: string) {
  return defineTool<Record<string, never>>({
    name,
    version: '1',
    description: 'A modeling step',
    source: 'command',
    permission: 'read',
    input: z.object({}),
    async run() {
      throw new Error(text)
    },
  })
}

async function runOnce(name: string, text: string): Promise<{ row: Extract<PilotEvent, { type: 'tool_result' }>; read: string }> {
  let read = ''
  const steps: ScriptStep[] = [
    { calls: [{ name, args: {} }] },
    (messages) => {
      read = messages.at(-1)?.content ?? ''
      return { text: 'Done.' }
    },
  ]
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [failing(name, text) as never] })
  const events: PilotEvent[] = []
  for await (const e of p.run('s', 'Make the part')) events.push(e)
  const row = events.find((e): e is Extract<PilotEvent, { type: 'tool_result' }> => e.type === 'tool_result')
  if (!row) throw new Error('no tool_result')
  return { row, read }
}

describe('every engine refusal in plain words', () => {
  it.each(CASES)('%s: %s', async (tool, text, plain) => {
    const { row, read } = await runOnce(tool, text)
    expect(row.ok).toBe(false)
    // the row: one plain line, none of the engine's words
    expect(row.summary).toMatch(plain)
    expect(row.summary).not.toContain(text)
    expect(row.summary).not.toMatch(/[a-z][A-Za-z0-9_.]*: |\b[a-z]+[A-Z]\w*\b|watertight|mesh|sx-geom|brep|\(|;|\u2014|\u2013/)
    // the engine's words stay in the row's details
    expect(row.detail).toBe(text)
    // the model reads the engine's text, with how to go on and never to quote it
    expect(read).toContain(text.slice(0, 40).replace(/"/g, '\\"'))
    expect(read).toMatch(/never quote the engine text/)
  })

  it('every plain line says what to try', () => {
    for (const [tool, text] of CASES) expect(plainEngine(text, tool)?.shown).toMatch(/Try|try|fixes it|Check/)
  })

  it('leaves a printer\'s or the slicer\'s own words alone, and a modeling tool\'s plain sentences', async () => {
    expect(plainEngine('The printer is offline. Check that it is on and on the same network.', 'printer.status')).toBeUndefined()
    expect(plainEngine('edges: the result is not watertight; try a smaller size', 'printer.status')).toBeUndefined()
    expect(plainEngine('No design named Stand. Start one with design.new first.', 'design.open')).toBeUndefined()
    // the hosts' time limit already says it plainly, naming the step
    expect(plainEngine(geomStuckMessage('array.merged', 180_000), 'geom.array')).toBeUndefined()
    expect(plainEngine(geomStuckMessage('face.pick', 30_000), 'geom.face_pick')).toBeUndefined()
    expect(plainEngine(`The step did not go through: ${geomStuckMessage('build', 180_000)}. The design is unchanged.`, 'geom.build')).toBeUndefined()
    // only the engine writes these, whichever tool passed them on
    expect(plainEngine('boolean: the result is unsafe at mesh storage precision (collapsed triangles); change the cut or placement', 'app.slice')?.shown).toMatch(/too thin/)
    const { row } = await runOnce('printer.status', 'The printer is offline. Check that it is on and on the same network.')
    expect(row.summary).toBe('The printer is offline. Check that it is on and on the same network.')
    expect(row.detail).toBeUndefined()
  })
})
