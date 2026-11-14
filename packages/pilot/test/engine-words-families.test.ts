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
  // boolean.rs storage_mesh, json_cad.rs loft_stored: slivers at storage precision, a loft with its own advice
  ['geom.cut', 'boolean: the result is unsafe at mesh storage precision (collapsed triangles); change the cut or placement', /too thin to keep/],
  ['geom.loft', "loft: the result is unsafe at mesh storage precision (collapsed triangles); change the loft's profiles or the spacing between them", /change the loft's profiles or the spacing between them/],
  ['design.edit_step', "The step did not go through: loft: the result is unsafe at mesh storage precision (collapsed triangles); change the loft's profiles or the spacing between them. The design is unchanged.", /change the loft's profiles or the spacing between them/],
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
  // edge.rs: edges on and along rounds the tool does not take
  ['geom.fillet', 'edges: edge 1: the picked face is curved. Pick the edge from the flat face on its other side', /Picking the edges again from that flat face/],
  ['geom.chamfer', 'edges: edges 1 and 2 meet along a round; pick both from the flat face they share', /Picking the edges again from that flat face/],
  ['design.edit_step', 'The step did not go through: edges: edges 3, 4 and 5 meet at one point along a round; pick each edge once. The design is unchanged.', /Picking each edge once/],
  ['geom.fillet', 'edges: edge 1: both faces along this edge are curved. Fillet and chamfer need a flat face on one side', /cannot follow that edge/],
  ['geom.fillet', 'edges: edge 2: the angle between the faces changes along the round the edge runs into', /cannot follow that edge/],
  ['geom.chamfer', 'The step did not go through: edges: edge 1: the edge ends at a curved face it does not run into smoothly. The design is unchanged.', /cannot follow that edge/],
  // edge.rs, shell.rs, cad-history replay.ts: the pick moved
  ['geom.fillet', 'edges: edge 2 moved with the face beside it and is not there any more; pick it again', /Picking it again/],
  ['geom.shell', 'open: a face to open is not on a face of the body; pick it again', /Picking it again/],
  // push.rs, shell.rs: nothing left
  ['geom.push_pull', 'face.push: the cut removes the whole body', /whole part/],
  ['geom.shell', 'open: opening every face leaves no body; leave at least one face closed', /whole part/],
  // array.rs, sketch_sweep.rs, hollow.rs: over a size limit
  ['geom.array', 'count: at most 2000 copies', /more detail/],
  ['geom.hollow', 'voxelMm: the grid would have 912000000 cells; use a larger voxel', /more detail/],
  // mcp cad.ts: a step sent with a target or part that does not fit the design; nothing for the person to do
  ['geom.cut', 'target: with a design, join and cut work on its "part"; leave target out', /sent that step the wrong way/],
  ['geom.join', 'target: with a design, join and cut work on its "part"; leave target out and give part, one of 0 (Plate), 1 (Hook)', /sent that step the wrong way/],
  ['geom.cut', 'target: Hook is part 1 (Hook), but part is 0 (Plate); give one of them', /sent that step the wrong way/],
  ['geom.face_pick', 'part: the design has 2 parts', /sent that step the wrong way/],
  ['geom.sweep', 'profile: its loop sits 40 mm from where the path starts (0, 5, 40), and the profile is carried as it sits. Loop points are [u, v] from the profile frame\'s origin, so with the origin on the path\'s start a loop around it is centered at [0, 0].', /sent that step the wrong way/],
  ['geom.hole', 'pick: no round hole on that axis line; the nearest face to the point is a flat face. Give a point on the hole\'s axis, such as its center on the face it starts at, and the axis. This tool changes a hole that is already there; for a new hole, cut a circle loop with the extrude tool (operation cut)', /sent that step the wrong way/],
  ['geom.subtract', "solids: a design's subtract step takes boxes and cylinders; a countersink cut needs a model (or build it as its own part)", /sent that step the wrong way/],
  // cad-history replay.ts: an earlier step removed the part
  ['design.edit_step', 'The step did not go through: The part this step works on is gone. The design is unchanged.', /no longer there/],
  ['geom.boolean', 'The part this step works on is gone.', /no longer there/],
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
    // the engine's words stay in the row's details; the title says what happened in a few words
    expect(row.detail).toBe(text)
    expect(row.title).toBe(plainEngine(text, tool)?.title)
    // the model reads the engine's text, with how to go on and never to quote it
    expect(read).toContain(text.slice(0, 40).replace(/"/g, '\\"'))
    expect(read).toMatch(/never quote the engine text/)
  })

  it('every plain line says what to try, unless there is nothing for the person to do', () => {
    for (const [tool, text] of CASES) {
      const shown = plainEngine(text, tool)?.shown
      if (/wrong way|no longer there/.test(shown ?? '')) expect(shown).not.toMatch(/Try|try|size|Check/)
      else expect(shown).toMatch(/Try|try|fixes it|Check/)
    }
  })

  it('every refusal has a short title, and none sends a refusal that is not about size to simpler sizes', () => {
    for (const [tool, text] of CASES) {
      const r = plainEngine(text, tool)!
      expect(r.title.split(' ').length).toBeLessThanOrEqual(4)
      expect(r.shown).not.toContain(r.title)
      expect(r.shown).not.toMatch(/simpler sizes/)
    }
    // the two refusals that read as "simpler sizes" before
    expect(plainEngine('target: with a design, join and cut work on its "part"; leave target out', 'geom.cut')?.title).toBe('Step sent wrong')
    expect(plainEngine('The step did not go through: The part this step works on is gone. The design is unchanged.', 'design.edit_step')?.title).toBe('Part is gone')
    expect(plainEngine('request: missing "parts"', 'geom.build')).toMatchObject({ title: 'Step not made', shown: 'That step could not be made, so the part is unchanged. Try asking for it another way.' })
  })

  it('leaves a printer\'s or the slicer\'s own words alone, and a modeling tool\'s plain sentences', async () => {
    expect(plainEngine('The printer is offline. Check that it is on and on the same network.', 'printer.status')).toBeUndefined()
    expect(plainEngine('edges: the result is not watertight; try a smaller size', 'printer.status')).toBeUndefined()
    expect(plainEngine('No design named Stand. Start one with design.new first.', 'design.open')).toBeUndefined()
    // the hosts' time limit already says it plainly, naming the step
    expect(plainEngine(geomStuckMessage('array.merged', 180_000), 'geom.array')).toBeUndefined()
    expect(plainEngine(geomStuckMessage('face.pick', 30_000), 'geom.face_pick')).toBeUndefined()
    expect(plainEngine(`The step did not go through: ${geomStuckMessage('build', 180_000)}. The design is unchanged.`, 'geom.build')).toBeUndefined()
    // a join or cut that misses the part says why in plain words already
    for (const why of ['The shape stops 1.2 mm short of the part.', 'The shape is already inside the part, so nothing changed.', 'The shape only touches the part, so nothing changed.', 'Part of the shape would float off the part, so nothing changed.']) {
      expect(plainEngine(`The step did not go through: ${why.replace(/\.$/, '')}. The design is unchanged.`, 'design.edit_step')).toBeUndefined()
      expect(plainEngine(why, 'geom.extrude')).toBeUndefined()
    }
    expect(plainEngine('The shape stops 2.0 mm short of the body, so nothing changed. Check the distance and the direction.', 'app.model_extrude')).toBeUndefined()
    // only the engine writes these, whichever tool passed them on
    expect(plainEngine('boolean: the result is unsafe at mesh storage precision (collapsed triangles); change the cut or placement', 'app.slice')?.shown).toMatch(/too thin/)
    const { row } = await runOnce('printer.status', 'The printer is offline. Check that it is on and on the same network.')
    expect(row.summary).toBe('The printer is offline. Check that it is on and on the same network.')
    expect(row.detail).toBeUndefined()
  })
})
