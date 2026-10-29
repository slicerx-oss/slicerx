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
import { inTurnSet, TURN_SET_TOOL, turnSet, turnSetsOf, type TurnSet } from '../src/turnsets'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/** Stand-ins for the design tools the tab passes in, one or two from each set. */
const design = ['design.new', 'design.plan', 'geom.extrude', 'geom.fillet', 'geom.mirror', 'geom.array', 'design.timeline', 'geom.sketch_edit'].map(
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

function env(provider: string, steps: ScriptStep[]) {
  const client = createScriptedClient(steps, { provider })
  const { pilot } = createEvalEnv({ client, machine: MACHINE, objects: [], tools: design })
  return { pilot, client }
}

async function run(pilot: ReturnType<typeof env>['pilot'], session: string, message: string): Promise<PilotEvent[]> {
  const out: PilotEvent[] = []
  for await (const e of pilot.run(session, message, { context: { machine: MACHINE } })) out.push(e)
  return out
}

const names = (req: { tools: readonly { name: string }[] }) => req.tools.map((t) => t.name)

describe('the set a request picks', () => {
  it.each<[string, TurnSet | undefined, TurnSet]>([
    ['A 30 mm cube with a fillet', undefined, 'build'],
    ['Design a wall hook for a 6 mm screw', undefined, 'build'],
    ['Make a hook and then slice it for my A1', undefined, 'build'],
    ['Mirror the bracket and add a pattern of four holes', 'build', 'shape'],
    ['Make the base thicker', 'build', 'edit'],
    ['Undo that step', 'shape', 'edit'],
    ['What layer height and infill should I print the bracket with?', 'build', 'app'],
    ['Slice the plate and send it to my printer', undefined, 'app'],
    ['Why is my PETG stringing?', undefined, 'app'],
    ["How's my print going?", 'app', 'print'],
    ['Pause the printer', 'build', 'print'],
    ['ok, go ahead', 'app', 'app'],
    ['ok, go ahead', 'build', 'build'],
    ['hello', undefined, 'build'],
  ])('%s (after %s) is %s', (message, last, want) => {
    expect(turnSet(message, [], last)).toBe(want)
  })

  it('builds from a picture or a drawing', () => {
    expect(turnSet('Slice this', [{ type: 'image/png' }], 'app')).toBe('build')
    expect(turnSet('this one', [{ type: 'application/pdf' }])).toBe('build')
  })

  it('puts every design tool in a set and the rest of the app in app', () => {
    expect(turnSetsOf({ name: 'geom.extrude' })).toEqual(new Set(['build']))
    expect(turnSetsOf({ name: 'geom.mirror' })).toEqual(new Set(['shape']))
    expect(turnSetsOf({ name: 'design.timeline' })).toEqual(new Set(['edit']))
    // a design tool no list names yet still lands in a set
    expect(turnSetsOf({ name: 'geom.loft' })).toEqual(new Set(['edit']))
    // sending a sliced plate is in app as well as print; the rest of the printers only in print
    expect(turnSetsOf({ name: 'printer.queue' })).toEqual(new Set(['app', 'print']))
    expect(turnSetsOf({ name: 'printer.history' })).toEqual(new Set(['print']))
    expect(turnSetsOf({ name: 'app.slice' })).toEqual(new Set(['app']))
    for (const n of ['pilot.ask', 'kb.search', 'project.info', TURN_SET_TOOL]) expect(turnSetsOf({ name: n })).toBe('every')
    expect(inTurnSet({ name: 'pilot.sheet' }, 'build')).toBe(true)
    expect(inTurnSet({ name: 'pilot.sheet' }, 'app')).toBe(false)
  })
})

describe('a local model in the tab', () => {
  it('sends the build set for a new part, then the app set for a printing question in the same chat', async () => {
    const { pilot, client } = env('openai-compatible', [{ text: 'Built.' }, { text: 'Use 0.2 mm.' }])
    await run(pilot, 's', 'A 30 mm cube with a fillet')
    const build = names(client.requests[0]!)
    expect(build).toEqual(expect.arrayContaining(['design.new', 'design.plan', 'geom.extrude', 'geom.fillet', 'kb.search', TURN_SET_TOOL]))
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
