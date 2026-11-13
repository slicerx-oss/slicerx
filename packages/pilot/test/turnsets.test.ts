// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A local model in the mimir tab gets one set of tools per turn: the set a request's words pick, the chat's last set
// when it names none, and another set when the model asks for one with pilot.tools or calls one of its tools. A cloud
// model gets every tool on every turn, as before.
import type { PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { defineTool, type PilotTool } from '../src/tool'
import { inTurnSet, TURN_SET_TOOL, TURN_SETS, turnSet, turnSetsOf, type TurnSet } from '../src/turnsets'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/** Stand-ins for the design tools the tab passes in, one or two from each set. */
const design = ['design.new', 'design.plan', 'geom.extrude', 'geom.fillet', 'geom.edge_pick', 'geom.faces', 'geom.mirror', 'geom.array', 'design.timeline', 'geom.sketch_edit'].map(
  (name) =>
    defineTool({
      name,
      version: '1.0.0',
      source: 'command',
      permission: 'read',
      description: `The ${name} step.`,
      input: z.object({}).passthrough(),
      async run() {
        return { summary: `${name} done` }
      },
    }) as PilotTool<never>,
)

function env(provider: string, steps: ScriptStep[], opts: { tools?: PilotTool<never>[]; hasDesign?: () => boolean } = {}) {
  const client = createScriptedClient(steps, { provider })
  const { pilot } = createEvalEnv({ client, machine: MACHINE, objects: [], tools: opts.tools ?? design, ...(opts.hasDesign ? { hasDesign: opts.hasDesign } : {}) })
  return { pilot, client }
}

/** A stand-in design tool that answers with `result` (ok false for a failed call). */
const answering = (name: string, result: { ok?: boolean; output?: unknown }) =>
  defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `The ${name} step.`,
    input: z.object({}).passthrough(),
    async run() {
      return { summary: `${name} ${result.ok === false ? 'failed' : 'done'}`, ...result }
    },
  }) as PilotTool<never>

/** What a design step answers with on a design that has a body: the design's id and its parts. */
const BODY = { design: 'd1', name: 'Lid', steps: 1, parts: [{ index: 0, name: 'Lid', sizeMm: [60, 60, 4], volumeMm3: 14400 }] }

/** A shaping request that names no part of its own: it shapes a design that is there, and builds when there is none. */
const PROBE = 'Make a circular pattern of six holes'

async function run(pilot: ReturnType<typeof env>['pilot'], session: string, message: string): Promise<PilotEvent[]> {
  const out: PilotEvent[] = []
  for await (const e of pilot.run(session, message, { context: { machine: MACHINE } })) out.push(e)
  return out
}

const names = (req: { tools: readonly { name: string }[] }) => req.tools.map((t) => t.name)

describe('the set a request picks', () => {
  // [request, the set the chat's last turn ended on, whether the chat has a design yet, the set it starts on]
  it.each<[string, TurnSet | undefined, boolean, TurnSet]>([
    // a rail is a shaping tool: on a design it shapes, with none it builds
    ['Add a railing round the deck', 'build', true, 'shape'],
    ['put a handrail along the top edge', 'edit', true, 'shape'],
    ['Add a railing round the deck', undefined, false, 'build'],
    ['A 30 mm cube with a fillet', undefined, false, 'build'],
    ['Design a wall hook for a 6 mm screw', undefined, false, 'build'],
    ['Make a hook and then slice it for my A1', undefined, false, 'build'],
    ['Mirror the bracket and add a pattern of four holes', 'build', true, 'shape'],
    // a new part with shaping words in it still builds: nothing is there to shape yet, or it opens on a new part
    ["Design a headphone stand: a round weighted base, a hollow tapered stem, and a curved hook at the top with a soft lip so the headband doesn't slide off. Ask me for the main sizes first.", undefined, false, 'build'],
    ['Make a box with a pattern of vent holes', 'shape', true, 'build'],
    ['Make it hollow', 'build', true, 'shape'],
    // a new part named with a shaping word builds, before the chat has a design and after
    ...['Make a hollow vase', 'Make me a hollow vase', 'Make a hollow cylinder 40 mm across and 60 mm tall', 'Make a split ring', 'Make a split ring clamp for a 25 mm pipe', 'Make an engraved name tag', 'Make an engraved keychain tag with my name', 'Make a mirror frame', 'Make a mirror mount', 'Design a mirror frame', 'Make a split keyboard stand', 'Design an engraved nameplate', 'Make a patterned lid', 'Make an embossed coaster', 'Make a text sign that says OPEN'].flatMap((m): [string, TurnSet | undefined, boolean, TurnSet][] => [
      [m, undefined, false, 'build'],
      [m, 'build', false, 'build'],
      [m, 'build', true, 'build'],
    ]),
    // with no design yet there is nothing to shape, so a request that asks for a part builds whatever words it has
    ['I need a box with a pattern of vent holes', undefined, false, 'build'],
    ['A hollow box 50 mm on each side with a lid', undefined, false, 'build'],
    // a request for a whole new part with a definite part in it still builds
    ['A hollow box with a hole in the middle', undefined, false, 'build'],
    ['I need a box with a pattern of vent holes in the lid', undefined, false, 'build'],
    ['Make a box with a pattern of vent holes in the lid', undefined, false, 'build'],
    // with no body on the plate there is nothing to shape, so a shaping of "it" or of "the lid" builds; with a design it shapes
    ...['Make it hollow', 'Make this hollow', 'Make the lid hollow', 'Make the lid split in half', 'Engrave SX on the lid', 'Add a pattern of holes to the lid', 'Make a pattern of four holes on it', 'Make a pattern of six vent holes in the lid', 'Make a mirrored copy of the bracket', 'Make a cut out in the lid', 'Mirror it', 'Hollow it out'].flatMap((m): [string, TurnSet | undefined, boolean, TurnSet][] => [
      [m, 'build', false, 'build'],
      [m, 'shape', false, 'build'],
      [m, 'build', true, 'shape'],
    ]),
    // a new part that names a place on it ("on the lid", "on the front") builds when there is no design, however it opens
    ...['Hey, can you make a hollow box with SX engraved on the lid', 'Give me a box with my name engraved on the lid', 'Design hooks with my name engraved on the front', 'Make the case for my Raspberry Pi with a cut-out'].flatMap((m): [string, TurnSet | undefined, boolean, TurnSet][] => [
      [m, undefined, false, 'build'],
      [m, 'shape', false, 'build'],
    ]),
    // a shaping with no part named builds when there is no design, and shapes the design when there is one
    [PROBE, 'build', false, 'build'],
    [PROBE, 'build', true, 'shape'],
    // up to two words between the article and the shaping noun
    ...['Make a circular pattern of six holes in the lid', 'Make a hole pattern on the lid', 'Make a linear array of pegs along the edge', 'Make a mirrored version of the bracket', 'Make a cutout for the USB port'].map((m): [string, TurnSet | undefined, boolean, TurnSet] => [m, 'build', true, 'shape']),
    // the shaping words the new part opener lets through still shape the design there
    ...['Make a cut in the lid', 'Make an engraving of my name on the lid', 'Make a split in the lid', 'Make a text label on the lid', 'Make a cut-out for the USB port'].map((m): [string, TurnSet | undefined, boolean, TurnSet] => [m, 'build', true, 'shape']),
    // the next part after one is finished, however it opens
    ...['Now make a hollow vase', 'Next, design an engraved name tag', 'Make another hollow vase', 'Can you please make a hollow vase', 'I want a hollow vase', 'I need a hollow box 50 mm on a side with a lid', 'Ok, now make one more split ring'].map((m): [string, TurnSet | undefined, boolean, TurnSet] => [m, 'shape', true, 'build']),
    // "make the <part>" followed by what the part has, not by a shaping of it, is a new part: with a design there it is
    // unclear, and an unclear request builds
    ...['Make the hollow vase I described', 'Make the cable organizer with a cut-out for the cable', 'Make the lid for my jar with a pattern of holes', 'Make the case for my Raspberry Pi with a cut-out for the USB port', 'Make my kid a name tag with her name engraved', 'Make the stand that holds two mirrored arms'].flatMap((m): [string, TurnSet | undefined, boolean, TurnSet][] => [
      [m, 'shape', true, 'build'],
      [m, undefined, false, 'build'],
    ]),
    // "make the <part>" followed by a shaping of it shapes the design there
    ...['Make the side wall hollow', 'Make the lid engraved with SX', 'Make my bracket mirrored', 'Make the case split in half'].map((m): [string, TurnSet | undefined, boolean, TurnSet] => [m, 'build', true, 'shape']),
    // still unclear with a design there: build and shape together do not fit a local model's context, so it builds
    ['A hollow box 50 mm on each side with a lid', 'shape', true, 'build'],
    // shaping the chat's design keeps the shape set even when it opens on "make a"
    ['Make a pattern of six vent holes in the lid', 'build', true, 'shape'],
    ['Make a pattern of four holes on it', 'build', true, 'shape'],
    ['Make an array of pegs along the edge', 'build', true, 'shape'],
    ['Make a mirrored copy of the bracket', 'build', true, 'shape'],
    ['Make a copy of the hook on the other side', 'build', true, 'shape'],
    ['Make a cut out in the lid', 'build', true, 'shape'],
    ['Make a cutout on the front for the USB port', 'build', true, 'shape'],
    // a shaping of a part the request names ("the bracket") shapes the design there, and builds when there is none
    ['Mirror the bracket', 'build', true, 'shape'],
    ['Split the case in half', 'build', true, 'shape'],
    ['Mirror the bracket', undefined, false, 'build'],
    ['Split the case in half', undefined, false, 'build'],
    ['Make the base thicker', 'build', true, 'edit'],
    ['Undo that step', 'shape', true, 'edit'],
    ['What layer height and infill should I print the bracket with?', 'build', true, 'app'],
    ['Slice the plate and send it to my printer', undefined, false, 'app'],
    ['Why is my PETG stringing?', undefined, false, 'app'],
    ["How's my print going?", 'app', false, 'print'],
    ['Pause the printer', 'build', true, 'print'],
    ['ok, go ahead', 'app', false, 'app'],
    ['ok, go ahead', 'build', true, 'build'],
    ['hello', undefined, false, 'build'],
  ])('%s (after %s, design %s) is %s', (message, last, design, want) => {
    expect(turnSet(message, [], last, { design })).toBe(want)
  })

  it('builds from a picture or a drawing', () => {
    expect(turnSet('Slice this', [{ type: 'image/png' }], 'app')).toBe('build')
    expect(turnSet('this one', [{ type: 'application/pdf' }])).toBe('build')
  })

  it('puts every design tool in a set and the rest of the app in app', () => {
    expect(turnSetsOf({ name: 'geom.extrude' })).toEqual(new Set(['build']))
    expect(turnSetsOf({ name: 'geom.loft' })).toEqual(new Set(['build']))
    expect(turnSetsOf({ name: 'geom.sweep' })).toEqual(new Set(['build']))
    expect(turnSetsOf({ name: 'geom.revolve' })).toEqual(new Set(['build']))
    expect(turnSetsOf({ name: 'geom.hole' })).toEqual(new Set(['build']))
    // a new part's holes are cut while it is built; changing a hole already there is an edit
    expect(turnSetsOf({ name: 'geom.hole_edit' })).toEqual(new Set(['edit']))
    // projecting a face or edges into a sketch needs a part already built, so it is an edit, beside the sketch tools
    // and edge picks it needs, and never a new part's step
    expect(turnSetsOf({ name: 'design.sketch_project' })).toEqual(new Set(['edit']))
    // a print-in-place part's gaps are measured with shape's tools: a local model's new part turn has no room for the
    // fit check, so it loads on demand there
    expect(turnSetsOf({ name: 'geom.fit_check' })).toEqual(new Set(['shape']))
    expect(turnSetsOf({ name: 'geom.mirror' })).toEqual(new Set(['shape']))
    expect(turnSetsOf({ name: 'design.timeline' })).toEqual(new Set(['edit']))
    // a design tool no list names yet still lands in a set
    expect(turnSetsOf({ name: 'geom.coil' })).toEqual(new Set(['edit']))
    // sending a sliced plate is in app as well as print; the rest of the printers only in print
    expect(turnSetsOf({ name: 'printer.queue' })).toEqual(new Set(['app', 'print']))
    expect(turnSetsOf({ name: 'printer.history' })).toEqual(new Set(['print']))
    expect(turnSetsOf({ name: 'app.slice' })).toEqual(new Set(['app']))
    // a part's colors come with shaping it, as well as with the rest of the project; a local model's build turn has no room
    for (const n of ['project.add_filament', 'project.set_filament']) expect(turnSetsOf({ name: n })).toEqual(new Set(['shape', 'app']))
    // and so does painting a design's parts in filaments
    for (const n of ['paint.preview', 'paint.apply', 'paint.regions']) expect(turnSetsOf({ name: n })).toEqual(new Set(['shape', 'app']))
    for (const n of ['pilot.ask', 'kb.search', 'project.info', TURN_SET_TOOL]) expect(turnSetsOf({ name: n })).toBe('every')
    // saving a note goes with every set but a new part's, and calling it never moves a turn to another set
    expect(turnSetsOf({ name: 'memory.remember' })).toBe('every')
    expect(TURN_SETS.filter((s) => inTurnSet({ name: 'memory.remember' }, s))).toEqual(['shape', 'edit', 'app', 'print'])
    expect(inTurnSet({ name: 'memory.recall' }, 'build')).toBe(true)
    expect(inTurnSet({ name: 'pilot.sheet' }, 'build')).toBe(true)
    expect(inTurnSet({ name: 'pilot.sheet' }, 'app')).toBe(false)
  })
})

describe('a local model in the tab', () => {
  it('sends the build set for a new part, then the app set for a printing question in the same chat', async () => {
    const { pilot, client } = env('openai-compatible', [{ text: 'Built.' }, { text: 'Use 0.2 mm.' }])
    await run(pilot, 's', 'A 30 mm cube with a fillet')
    const build = names(client.requests[0]!)
    expect(build).toEqual(expect.arrayContaining(['design.new', 'design.plan', 'geom.extrude', 'geom.fillet', 'geom.edge_pick', 'geom.faces', 'kb.search', TURN_SET_TOOL]))
    for (const n of ['geom.mirror', 'design.timeline', 'printer.list', 'settings.plan']) expect(build).not.toContain(n)

    await run(pilot, 's', 'What layer height and infill should I print it with?')
    const app = names(client.requests[1]!)
    expect(app).toEqual(expect.arrayContaining(['settings.plan', 'printer.list', 'kb.filament', 'kb.search', TURN_SET_TOOL]))
    for (const n of ['design.new', 'geom.extrude', 'geom.mirror']) expect(app).not.toContain(n)
    // the system prompt is the same on both turns and goes first
    expect(client.requests[1]!.messages[0]).toEqual(client.requests[0]!.messages[0])
    expect(client.requests[0]!.messages[0]!.role).toBe('system')
  })

  it('loads the design tools with pilot.tools when an app turn turns out to need them', async () => {
    const { pilot, client } = env('openai-compatible', [
      { calls: [{ name: TURN_SET_TOOL, args: { set: 'build' } }] },
      { calls: [{ name: 'geom.extrude', args: {} }] },
      { text: 'Added the tab, now slicing.' },
    ])
    const ev = await run(pilot, 's', 'Slice the plate, but first add a tab to the bracket')
    expect(names(client.requests[0]!)).not.toContain('geom.extrude')
    expect(names(client.requests[1]!)).toEqual(expect.arrayContaining(['geom.extrude', 'design.new']))
    expect(names(client.requests[1]!)).not.toContain('settings.plan')
    expect(ev.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, true])
    expect(ev.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('runs a tool of another set the model calls anyway, and sends that set from the next step', async () => {
    const { pilot, client } = env('openai-compatible', [{ calls: [{ name: 'geom.mirror', args: {} }] }, { text: 'Mirrored.' }])
    const ev = await run(pilot, 's', 'Slice the plate')
    expect(names(client.requests[0]!)).not.toContain('geom.mirror')
    expect(ev.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, summary: 'geom.mirror done' })
    expect(names(client.requests[1]!)).toEqual(expect.arrayContaining(['geom.mirror', 'geom.array']))
    expect(names(client.requests[1]!)).not.toContain('printer.list')
  })

  it('keeps the set the last turn ended on for a message that names none, and a design request after printer talk builds', async () => {
    const { pilot, client } = env('openai-compatible', [{ calls: [{ name: TURN_SET_TOOL, args: { set: 'shape' } }] }, { text: 'Ready.' }, { text: 'Done.' }, { text: 'Built.' }])
    await run(pilot, 's', 'Slice the plate')
    await run(pilot, 's', 'ok, go ahead')
    expect(names(client.requests[2]!)).toContain('geom.mirror')
    await run(pilot, 's', 'Now design a lid for it')
    expect(names(client.requests[3]!)).toContain('design.new')
  })

  it('builds a new part named with a shaping word in a fresh chat', async () => {
    const { pilot, client } = env('openai-compatible', [{ text: 'What size?' }, { text: 'Built.' }])
    await run(pilot, 's', 'Make a hollow vase')
    expect(names(client.requests[0]!)).toEqual(expect.arrayContaining(['design.new', 'geom.extrude']))
    await run(pilot, 't', 'Make an engraved name tag')
    expect(names(client.requests[1]!)).toContain('design.new')
  })

  it('shapes the chat design for "make a pattern of", and builds it when the chat has no design yet', async () => {
    const { pilot, client } = env('openai-compatible', [
      { calls: [{ name: 'design.new', args: {} }] },
      { text: 'Made the lid.' },
      { text: 'Patterned.' },
      { text: 'Hi.' },
      { text: 'Which part?' },
    ])
    await run(pilot, 'made', 'Design a lid for a 60 mm jar')
    await run(pilot, 'made', PROBE)
    expect(names(client.requests[2]!)).toEqual(expect.arrayContaining(['geom.array', 'geom.mirror']))
    expect(names(client.requests[2]!)).not.toContain('design.new')
    // the last turn ended on build, but no design came of it, so there is nothing to put a pattern in yet
    await run(pilot, 'none', 'hello')
    await run(pilot, 'none', PROBE)
    expect(names(client.requests[4]!)).toContain('design.new')
  })

  /** The set `PROBE` gets in chat `session` after `calls` ran there, each answering as its tool does. */
  async function afterCalls(tools: PilotTool<never>[], calls: string[]): Promise<string[]> {
    const { pilot, client } = env('openai-compatible', [{ calls: calls.map((name) => ({ name, args: {} })) }, { text: 'Done.' }, { text: 'Which part?' }], { tools })
    await run(pilot, 's', 'Design a lid for a 60 mm jar')
    await run(pilot, 's', PROBE)
    return names(client.requests.at(-1)!)
  }

  it('counts a chat as having a design only after design.new or design.open went through, or a step left a body', async () => {
    const shaped = (tools: string[]) => {
      expect(tools).toContain('geom.array')
      expect(tools).not.toContain('design.new')
    }
    const built = (tools: string[]) => {
      expect(tools).toContain('design.new')
      expect(tools).not.toContain('geom.array')
    }
    const shapeTools = design.filter((t) => t.name === 'geom.array' || t.name === 'geom.mirror')
    // a design.new that failed made nothing
    built(await afterCalls([answering('design.new', { ok: false, output: { error: 'no' } }), ...shapeTools], ['design.new']))
    // opening a design is having one
    shaped(await afterCalls([answering('design.open', { output: { designs: [BODY] } }), answering('design.new', {}), ...shapeTools], ['design.open']))
    // a first step on a design the app already holds, which leaves its body
    shaped(await afterCalls([answering('geom.extrude', { output: BODY }), answering('design.new', {}), ...shapeTools], ['geom.extrude']))
    // geometry tools that touch no design: a sketch solved on its own, an extrude of a loose model, a calibration model
    built(await afterCalls([answering('geom.sketch_solve', { output: { status: 'ok', dof: 0 } }), answering('geom.extrude', { output: { volumeMm3: 100, stlPath: '/tmp/a.stl' } }), answering('geom.calibration_model', { output: { files: ['/tmp/t.stl'] } }), answering('design.new', {}), ...shapeTools], ['geom.sketch_solve', 'geom.extrude', 'geom.calibration_model']))
    // listing designs or planning one is not having one
    built(await afterCalls([answering('design.list', { output: { designs: [] } }), answering('design.plan', { output: { planId: 'p1' } }), answering('design.new', {}), ...shapeTools], ['design.list', 'design.plan']))
    // a step that fails after a design went through leaves the design there
    shaped(await afterCalls([answering('design.new', { output: { design: 'd1', name: 'Lid', steps: 0, parts: [] } }), answering('geom.extrude', { ok: false, output: { error: 'bad loop' } }), ...shapeTools], ['design.new', 'geom.extrude']))
  })

  it('reads whether the project has a design from the host, in a new chat, after a reload and in a rebuilt mimir', async () => {
    let there = true
    const hasDesign = () => there
    const replies = () => [{ text: 'Which part?' }, { text: 'Which part?' }, { text: 'Which part?' }, { text: 'Which part?' }, { text: 'Which part?' }]
    // New conversation keeps the design on the plate: the fresh chat shapes it
    const a = env('openai-compatible', replies(), { hasDesign })
    await run(a.pilot, 'fresh', PROBE)
    expect(names(a.client.requests[0]!)).toContain('geom.array')
    expect(names(a.client.requests[0]!)).not.toContain('design.new')
    for (const m of ['Make the lid hollow', 'Engrave SX on the lid', 'Add a pattern of holes to the lid']) {
      await run(a.pilot, 'fresh', m)
      expect(names(a.client.requests.at(-1)!), m).toContain('geom.mirror')
    }
    // a reload: the chat comes back from its text, and the design is still on the plate
    const b = env('openai-compatible', replies(), { hasDesign })
    b.pilot.resume!('back', [{ user: 'Design a lid for a 60 mm jar', reply: 'Built the lid.' }])
    await run(b.pilot, 'back', PROBE)
    expect(names(b.client.requests[0]!)).toContain('geom.array')
    // a model change makes a new mimir over the same plate
    const c = env('openai-compatible', replies(), { hasDesign })
    await run(c.pilot, 'fresh', PROBE)
    expect(names(c.client.requests[0]!)).toContain('geom.array')
    // the design deleted from the plate: nothing is left to shape, even in the chat that made it
    there = false
    await run(c.pilot, 'fresh', PROBE)
    expect(names(c.client.requests[1]!)).toContain('design.new')
    expect(names(c.client.requests[1]!)).not.toContain('geom.array')
  })

  it('builds while a design is still waiting for its first body, in the chat that made it too, when the host sees no body', async () => {
    const shapeTools = design.filter((t) => t.name === 'geom.array' || t.name === 'geom.mirror')
    const waiting = { design: 'd1', name: 'Lid', steps: 0, parts: [] }
    // the host sees no body on the plate: with nothing there to shape, the chat that started the design builds too
    const a = env('openai-compatible', [{ calls: [{ name: 'design.new', args: {} }] }, { text: 'Started.' }, { text: 'Which part?' }, { text: 'Which part?' }], { tools: [answering('design.new', { output: waiting }), ...shapeTools], hasDesign: () => false })
    await run(a.pilot, 'mine', 'Design a lid for a 60 mm jar')
    await run(a.pilot, 'mine', PROBE)
    expect(names(a.client.requests[2]!)).toContain('design.new')
    expect(names(a.client.requests[2]!)).not.toContain('geom.array')
    await run(a.pilot, 'other', PROBE)
    expect(names(a.client.requests[3]!)).toContain('design.new')
    expect(names(a.client.requests[3]!)).not.toContain('geom.array')
    // the design got its body, and the body was then deleted: nothing is left to shape in the chat that made it either
    const b = env('openai-compatible', [{ calls: [{ name: 'design.new', args: {} }, { name: 'geom.extrude', args: {} }] }, { text: 'Built.' }, { text: 'Which part?' }], { tools: [answering('design.new', { output: waiting }), answering('geom.extrude', { output: BODY }), ...shapeTools], hasDesign: () => false })
    await run(b.pilot, 'mine', 'Design a lid for a 60 mm jar')
    await run(b.pilot, 'mine', PROBE)
    expect(names(b.client.requests[2]!)).toContain('design.new')
    // a host that cannot answer leaves the chat with what its own tools made
    const c = env('openai-compatible', [{ calls: [{ name: 'design.new', args: {} }] }, { text: 'Started.' }, { text: 'Which part?' }], {
      tools: [answering('design.new', { output: waiting }), ...shapeTools],
      hasDesign: () => {
        throw new Error('no plate')
      },
    })
    await run(c.pilot, 'mine', 'Design a lid for a 60 mm jar')
    await run(c.pilot, 'mine', PROBE)
    expect(names(c.client.requests[2]!)).toContain('geom.array')
  })

  it('seeds a resumed chat from the host, and keeps no design for it when the host has none', async () => {
    const yes = env('openai-compatible', [{ text: 'Which part?' }], { hasDesign: () => true })
    yes.pilot.resume!('r', [{ user: 'Design a lid', reply: 'Built the lid.' }])
    await run(yes.pilot, 'r', PROBE)
    expect(names(yes.client.requests[0]!)).toContain('geom.array')
    const no = env('openai-compatible', [{ text: 'Which part?' }], { hasDesign: () => false })
    no.pilot.resume!('r', [{ user: 'Design a lid', reply: 'Built the lid.' }])
    await run(no.pilot, 'r', PROBE)
    expect(names(no.client.requests[0]!)).toContain('design.new')
  })

  it('lists every set for the read-back', () => {
    const { pilot } = env('openai-compatible', [])
    const sets = pilot.turnSets!()!
    expect(Object.keys(sets)).toEqual(['build', 'shape', 'edit', 'app', 'print'])
    expect(sets.build).toEqual(expect.arrayContaining(['design.new', 'geom.extrude', TURN_SET_TOOL]))
    expect(sets.app).toEqual(expect.arrayContaining(['printer.list', TURN_SET_TOOL]))
    expect(sets.app).not.toContain('geom.extrude')
    expect(sets.app).not.toContain('printer.history')
    expect(sets.print).toEqual(expect.arrayContaining(['printer.history', 'printer.queue', TURN_SET_TOOL]))
    expect(pilot.tools().map((t) => t.name)).toContain(TURN_SET_TOOL)
  })
})

describe('the fit check on a local model', () => {
  it('a new part turn sends the face list and not the fit check; calling the fit check loads it for the next step', async () => {
    const tools = [...design, answering('geom.fit_check', { output: { gaps: [] } })]
    const { pilot, client } = env('openai-compatible', [{ calls: [{ name: 'geom.fit_check', args: {} }] }, { text: 'Checked.' }], { tools })
    const ev = await run(pilot, 's', 'A 30 mm cube with a fillet')
    const first = names(client.requests[0]!)
    expect(first).toEqual(expect.arrayContaining(['design.new', 'geom.fillet', 'geom.edge_pick', 'geom.faces', TURN_SET_TOOL]))
    expect(first).not.toContain('geom.fit_check')
    expect(ev.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, summary: 'geom.fit_check done' })
    expect(names(client.requests[1]!)).toContain('geom.fit_check')
  })

  it('a cloud model gets the fit check and the face list on a new part turn', async () => {
    const tools = [...design, answering('geom.fit_check', { output: { gaps: [] } })]
    const { pilot, client } = env('anthropic', [{ text: 'Built.' }], { tools })
    await run(pilot, 's', 'A 30 mm cube with a fillet')
    expect(names(client.requests[0]!)).toEqual(expect.arrayContaining(['geom.fit_check', 'geom.faces', 'design.new']))
  })
})

describe('a cloud model in the tab', () => {
  it('sends every tool on every turn, without pilot.tools', async () => {
    const { pilot, client } = env('anthropic', [{ text: 'Built.' }, { text: 'Use 0.2 mm.' }])
    await run(pilot, 's', 'A 30 mm cube with a fillet')
    await run(pilot, 's', 'What layer height should I print it with?')
    const all = pilot.tools().map((t) => t.name)
    expect(names(client.requests[0]!)).toEqual(all)
    expect(names(client.requests[1]!)).toEqual(all)
    expect(all).not.toContain(TURN_SET_TOOL)
    expect(all).toEqual(expect.arrayContaining(['geom.mirror', 'printer.list']))
    expect(pilot.turnSets!()).toBeNull()
  })
})
