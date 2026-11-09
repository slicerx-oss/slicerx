// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mimir run nobody watches: a step whose geometry call is stuck in the engine is refused at the call's time limit
// (client.ts, @slicerx/contracts geom-limits.ts), the run reports it plainly and goes on with its next step, and the
// stuck call is not sent again. A modeling step stopped for good is not run again with the same input on the same
// design in that turn (the one it names by id, or by a name an answer in the turn tied to one id, before or after the
// stop; else the part the run started last), until a geometry change to that design goes through (a geom.* step that
// is not a read, or an edit, undo or redo). A step on a mesh model file is not run again with the same input at all.
// A quick step's refusal says to try it again, and it can be. The run is the tab's runtime
// as session.ts makes it, on scripted turns, with the engine a stand-in in a real thread that spins forever in `array`
// and `face.pick`.
import type { Host, PermissionClass, PilotEvent } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, READ_ONLY, defineTool, STOPPED_AGAIN_LINE, type PilotTool } from '@slicerx/pilot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { endIdleGeomWorker, setGeomCallLimit, setGeomProvider } from '../src/geom/client'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { tabPilotOptions } from '../src/workspaces/mimir/session'
import { busyWorkers } from './geom-busy-engine'

const STUCK = 'The step "Array" ran past its 0.4 s limit and was stopped; try a smaller version: fewer copies or a simpler part'
const QUICK = 'The step "Face pick" took too long (over its 0.4 s limit) and was stopped; try it again'

const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

const INPUT = z.object({
  design: z.string().optional(),
  model: z.string().optional(),
  copies: z.number().optional(),
  at: z.record(z.string(), z.number()).optional(),
  list: z.array(z.record(z.string(), z.number())).optional(),
})

/** A tool that runs one geometry call through the tab's host, counting its runs with their input. */
function geomTool(name: string, op: string, runs: string[], permission: PermissionClass = 'read') {
  return defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission,
    hints: { readOnly: permission === 'read' },
    description: name,
    input: INPUT,
    run: async (i, ctx) => {
      runs.push(i.copies === undefined ? name : `${name} ${i.copies}`)
      const reply = await ctx.host.geom!.run(op, i, ctx.signal)
      return { summary: JSON.stringify(reply) }
    },
  }) as PilotTool<never>
}

/** A tool that changes something and goes through, fails or throws, with no geometry call. */
function writeTool(name: string, runs: string[], outcome: 'ok' | 'fail' | 'throw' = 'ok', permissionFor?: (i: { apply?: boolean }) => PermissionClass) {
  return defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    ...(permissionFor ? { permissionFor, classNote: 'read or slice, by apply' } : {}),
    description: name,
    input: z.object({ design: z.string().optional(), apply: z.boolean().optional() }),
    run: async (i) => {
      runs.push(i.design === undefined ? name : `${name} ${i.design}`)
      if (outcome === 'throw') throw new Error('it did not go through')
      return outcome === 'ok' ? { summary: 'changed' } : { ok: false, summary: 'it did not go through' }
    },
  }) as PilotTool<never>
}

/** design.new: starts p1, p2 and on with the name it is given, each with a body. */
function newTool(runs: string[]) {
  let n = 0
  return defineTool({
    name: 'design.new',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'design.new',
    input: z.object({ name: z.string() }),
    run: async (i) => {
      runs.push(`design.new ${i.name}`)
      const design = `p${++n}`
      return { summary: `Started ${i.name} (${design})`, output: { design, name: i.name, parts: [{ index: 0 }] } }
    },
  }) as PilotTool<never>
}

/** Reads that name designs: design.steps of d1 "Bracket", and design.list of two designs (both "Box", or "Box" and one named "p1"). */
function designReads(runs: string[]) {
  const steps = defineTool({
    name: 'design.steps',
    version: '1.0.0',
    source: 'command',
    permission: 'read', hints: READ_ONLY,
    description: 'design.steps',
    input: z.object({ design: z.string() }),
    run: async (i) => {
      runs.push(`design.steps ${i.design}`)
      return { summary: '0 steps', output: { design: 'd1', name: 'Bracket', steps: [] } }
    },
  })
  const list = defineTool({
    name: 'design.list',
    version: '1.0.0',
    source: 'command',
    permission: 'read', hints: READ_ONLY,
    description: 'design.list',
    input: z.object({ second: z.string() }),
    run: async (i) => {
      runs.push('design.list')
      return { summary: '2 designs', output: { designs: [{ design: 'p1', name: 'Box' }, { design: 'p2', name: i.second }] } }
    },
  })
  return [steps, list] as PilotTool<never>[]
}

type Call = { name: string; args: Record<string, unknown> }
type Outcome = 'ok' | 'fail' | 'throw'

afterEach(() => {
  endIdleGeomWorker()
  vi.unstubAllGlobals()
  setGeomProvider(null)
  setGeomCallLimit(null)
})

/**
 * The tab's runtime as session.ts makes it, on scripted turns of `calls` (one a step, then "Done."), each its own
 * pilot.run of the same runtime. A card is approved.
 */
async function scriptedTurns(turns: Call[][], runs: string[], outcomes: Partial<Record<string, Outcome>> = {}) {
  const tools = [
    geomTool('geom.array', 'array', runs),
    geomTool('geom.pattern', 'array', runs),
    geomTool('geom.info', 'measure', runs),
    geomTool('geom.pick', 'face.pick', runs),
    geomTool('geom.fillet', 'array', runs, 'slice'),
    geomTool('geom.extrude', 'measure', runs, 'slice'),
    newTool(runs),
    ...designReads(runs),
    writeTool('design.edit_step', runs),
    writeTool('design.undo', runs, outcomes['design.undo'] ?? 'fail'),
    writeTool('design.redo', runs, outcomes['design.redo'] ?? 'throw'),
    writeTool('design.save', runs),
    writeTool('prefs.set', runs),
    writeTool('geom.mixed', runs, 'ok', (i) => (i.apply ? 'slice' : 'read')),
  ]
  // a host that models only: its slicer is never reached
  const slicer = { loadModel: async () => undefined, slice: async () => undefined }
  const host = { kind: 'web', slicer, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools, commands: [] })
  const steps = turns.flatMap((calls) => [...calls.map((c) => ({ calls: [c] })), { text: 'Done.' }])
  const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
  expect(pilot.tools().map((t) => t.name)).toEqual(expect.arrayContaining(tools.map((t) => t.name)))
  const events: PilotEvent[] = []
  for (const _ of turns) {
    for await (const ev of pilot.run('tab', 'make it', {})) {
      events.push(ev)
      if (ev.type === 'approval_request') await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
    }
  }
  return events
}

const results = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'tool_result' ? [[e.ok, e.summary] as const] : []))
const said = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
const arrays = (workers: { ops: string[] }[]) => workers.flatMap((w) => w.ops).filter((op) => op === 'array').length

/** Runs `body` with the stand-in engine and a 0.4 s limit for `array` and `face.pick`. */
async function stuckEngine(body: (workers: { ops: string[] }[]) => Promise<void>) {
  const { workers, end } = busyWorkers()
  setGeomCallLimit((op) => (op === 'array' || op === 'face.pick' ? 400 : 60_000))
  try {
    await body(workers)
  } finally {
    await end()
  }
}

/**
 * A turn that stops geom.array on design d1, runs `between`, and asks for the same array again: the results of
 * `between` and of the repeat, and how many arrays reached the engine.
 */
async function stopThen(between: Call[], outcomes: Partial<Record<string, Outcome>> = {}) {
  let out: { between: (readonly [boolean, string])[]; repeat: readonly [boolean, string]; arrays: number; runs: string[] } | undefined
  await stuckEngine(async (workers) => {
    const runs: string[] = []
    const array = { name: 'geom.array', args: { design: 'd1', copies: 12 } }
    const r = results(await scriptedTurns([[array, ...between, array]], runs, outcomes))
    expect(r[0]).toEqual([false, STUCK])
    out = { between: r.slice(1, -1), repeat: r.at(-1)!, arrays: arrays(workers), runs }
  })
  return out!
}

describe('a mimir run with a stuck geometry step', () => {
  it('reports the stuck step plainly, does not send it again, and goes on to the next step', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const t = performance.now()
      const events = await scriptedTurns([[{ name: 'geom.array', args: {} }, { name: 'geom.info', args: {} }]], runs)
      expect(performance.now() - t).toBeLessThan(10_000)
      expect(results(events)).toEqual([
        [false, STUCK],
        [true, JSON.stringify({ op: 'measure' })],
      ])
      // each step ran once, and the engine got the stuck call once
      expect(runs).toEqual(['geom.array', 'geom.info'])
      expect(arrays(workers)).toBe(1)
      expect(said(events)).toContain('Done.')
      expect(events.some((e) => e.type === 'error')).toBe(false)
    }), 20_000)

  it('does not run the same stopped step again in the turn, in any key order, and still runs a smaller version', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const list = [{ x: 1, y: 2 }, { x: 3, y: 4 }]
      const events = await scriptedTurns(
        [
          [
            { name: 'geom.array', args: { copies: 12, at: { x: 1, y: 2 }, list } },
            { name: 'geom.array', args: { list: [{ y: 2, x: 1 }, { y: 4, x: 3 }], at: { y: 2, x: 1 }, copies: 12 } },
            // the same items in another order are another step
            { name: 'geom.array', args: { copies: 12, at: { x: 1, y: 2 }, list: [list[1], list[0]] } },
            { name: 'geom.array', args: { copies: 6, at: { x: 1, y: 2 }, list } },
            { name: 'geom.info', args: {} },
          ],
        ],
        runs,
      )
      expect(results(events)).toEqual([
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
        [false, STUCK],
        [false, STUCK],
        [true, JSON.stringify({ op: 'measure' })],
      ])
      // the repeat never reached the tool or the engine; the reordered list and the smaller version did
      expect(runs).toEqual(['geom.array 12', 'geom.array 12', 'geom.array 6', 'geom.info'])
      expect(arrays(workers)).toBe(3)
      expect(said(events)).toContain('Done.')
    }), 20_000)

  it('runs the same input on another tool, and the same step again in the next turn', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const events = await scriptedTurns(
        [
          [
            { name: 'geom.array', args: { copies: 12 } },
            { name: 'geom.pattern', args: { copies: 12 } },
          ],
          [{ name: 'geom.array', args: { copies: 12 } }],
        ],
        runs,
      )
      expect(results(events)).toEqual([
        [false, STUCK],
        [false, STUCK],
        [false, STUCK],
      ])
      expect(runs).toEqual(['geom.array 12', 'geom.pattern 12', 'geom.array 12'])
      expect(arrays(workers)).toBe(3)
    }), 20_000)

  it('runs a stopped step again once an edit to its design went through, and refuses it again after it stops again', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const array = { name: 'geom.array', args: { design: 'd1', copies: 12 } }
      const events = await scriptedTurns([[array, { name: 'design.edit_step', args: { design: 'd1' } }, array, array]], runs)
      expect(results(events)).toEqual([
        [false, STUCK],
        [true, 'changed'],
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
      ])
      expect(runs).toEqual(['geom.array 12', 'design.edit_step d1', 'geom.array 12'])
      expect(arrays(workers)).toBe(2)
    }), 20_000)

  it.each([
    ['a read', { name: 'geom.info', args: { design: 'd1' } }],
    ['a save', { name: 'design.save', args: { design: 'd1' } }],
    ['a setting', { name: 'prefs.set', args: {} }],
    ['an edit to another design', { name: 'design.edit_step', args: { design: 'd2' } }],
  ])('keeps a stopped step refused after %s', async (_, between) => {
    const r = await stopThen([between])
    expect([r.between[0]![0], r.repeat]).toEqual([true, [false, STOPPED_AGAIN_LINE]])
    expect(r.arrays).toBe(1)
  }, 20_000)

  it('keeps a stopped step refused after an edit that failed or threw', async () => {
    for (const between of [
      { name: 'design.undo', args: { design: 'd1' } },
      { name: 'design.redo', args: { design: 'd1' } },
    ]) {
      const r = await stopThen([between])
      expect([between.name, r.between[0]![0], r.repeat]).toEqual([between.name, false, [false, STOPPED_AGAIN_LINE]])
      expect(r.arrays).toBe(1)
    }
  }, 20_000)

  it("goes by a tool's permission for its input: a read leaves a stopped step refused, a change lets it run", async () => {
    const read = await stopThen([{ name: 'geom.mixed', args: { design: 'd1', apply: false } }])
    expect(read.repeat).toEqual([false, STOPPED_AGAIN_LINE])
    expect(read.arrays).toBe(1)
    const change = await stopThen([{ name: 'geom.mixed', args: { design: 'd1', apply: true } }])
    expect(change.repeat).toEqual([false, STUCK])
    expect(change.arrays).toBe(2)
  }, 20_000)

  it('refuses the repeat of a stopped step that needs approval without asking for it again', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const fillet = { name: 'geom.fillet', args: { design: 'd1', copies: 12 } }
      const events = await scriptedTurns([[fillet, fillet]], runs)
      expect(results(events)).toEqual([
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
      ])
      expect(runs).toEqual(['geom.fillet 12'])
      expect(arrays(workers)).toBe(1)
      // at most the first call asked; the repeat was refused before any approval
      const calls = events.flatMap((e, i) => (e.type === 'tool_call' ? [i] : []))
      expect(events.slice(calls[1]! - 1).some((e) => e.type === 'approval_request')).toBe(false)
    }), 20_000)

  it.each(['design.undo', 'design.redo'])('runs a stopped step again once a %s of its design went through', async (name) => {
    const r = await stopThen([{ name, args: { design: 'd1' } }], { [name]: 'ok' })
    expect([r.between[0]![0], r.repeat]).toEqual([true, [false, STUCK]])
    expect(r.arrays).toBe(2)
  }, 20_000)

  it('does not count a refused repeat as a change', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const array = { name: 'geom.array', args: { design: 'd1', copies: 12 } }
      const fillet = { name: 'geom.fillet', args: { design: 'd1', copies: 12 } }
      const events = await scriptedTurns([[array, fillet, fillet, array]], runs)
      expect(results(events)).toEqual([
        [false, STUCK],
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
        [false, STOPPED_AGAIN_LINE],
      ])
      expect(arrays(workers)).toBe(2)
    }), 20_000)

  it('keys a design given by its name to its id', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const events = await scriptedTurns(
        [
          [
            { name: 'design.new', args: { name: 'Box' } },
            { name: 'geom.array', args: { design: 'p1', copies: 12 } },
            { name: 'geom.array', args: { design: ' box ', copies: 12 } },
            { name: 'design.edit_step', args: { design: 'Box' } },
            { name: 'geom.array', args: { design: 'p1', copies: 12 } },
          ],
        ],
        runs,
      )
      expect(results(events).slice(1)).toEqual([
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
        [true, 'changed'],
        [false, STUCK],
      ])
      expect(arrays(workers)).toBe(2)
    }), 20_000)

  it('keys a step with no design named to the part started last, the same when it stops and when it is asked again', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const events = await scriptedTurns(
        [
          [
            { name: 'design.new', args: { name: 'Box' } },
            { name: 'geom.array', args: { copies: 12 } },
            { name: 'geom.array', args: { copies: 12 } },
            { name: 'geom.array', args: { design: 'p1', copies: 12 } },
            { name: 'geom.extrude', args: { design: 'p1' } },
            { name: 'geom.array', args: { copies: 12 } },
          ],
        ],
        runs,
      )
      expect(results(events).slice(1)).toEqual([
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
        [false, STOPPED_AGAIN_LINE],
        [true, JSON.stringify({ op: 'measure' })],
        [false, STUCK],
      ])
      expect(arrays(workers)).toBe(2)
    }), 20_000)

  it('runs a step with no design named again on a part started after it stopped', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const array = { name: 'geom.array', args: { copies: 12 } }
      const events = await scriptedTurns([[array, array, { name: 'design.new', args: { name: 'Lid' } }, array, array]], runs)
      expect(results(events)).toEqual([
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
        [true, 'Started Lid (p1)'],
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
      ])
      expect(arrays(workers)).toBe(2)
    }), 20_000)

  it('keeps a step on a mesh model file refused after a change, and runs the same step on another file', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const array = { name: 'geom.array', args: { model: 'm1', copies: 12 } }
      const events = await scriptedTurns(
        [[array, { name: 'geom.extrude', args: { model: 'm1' } }, { name: 'design.edit_step', args: {} }, array, { name: 'geom.array', args: { model: 'm2', copies: 12 } }]],
        runs,
      )
      expect(results(events)).toEqual([
        [false, STUCK],
        [true, JSON.stringify({ op: 'measure' })],
        [true, 'changed'],
        [false, STOPPED_AGAIN_LINE],
        [false, STUCK],
      ])
      expect(arrays(workers)).toBe(2)
    }), 20_000)

  it.each(['Bracket', ' bracket ', 'd1'])(
    'keeps a step stopped on a design by name before any answer tied it refused, asked again as %j after a read ties it',
    (again) =>
      stuckEngine(async (workers) => {
        const runs: string[] = []
        const events = await scriptedTurns(
          [
            [
              { name: 'geom.array', args: { design: 'Bracket', copies: 12 } },
              { name: 'design.steps', args: { design: 'Bracket' } },
              { name: 'geom.array', args: { design: again, copies: 12 } },
              { name: 'design.edit_step', args: { design: 'd1' } },
              { name: 'geom.array', args: { design: 'Bracket', copies: 12 } },
            ],
          ],
          runs,
        )
        expect(results(events).map(([ok, said]) => (ok ? ok : said))).toEqual([STUCK, true, STOPPED_AGAIN_LINE, true, STUCK])
        expect(arrays(workers)).toBe(2)
      }),
    20_000,
  )

  it('keeps a name that stands for two designs as written: it neither blocks nor is cleared by either id', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const events = await scriptedTurns(
        [
          [
            { name: 'design.list', args: { second: 'Box' } },
            { name: 'geom.array', args: { design: 'Box', copies: 12 } },
            { name: 'geom.array', args: { design: 'p1', copies: 12 } },
            { name: 'design.edit_step', args: { design: 'p1' } },
            { name: 'geom.array', args: { design: 'Box', copies: 12 } },
            { name: 'geom.array', args: { design: 'p1', copies: 12 } },
          ],
        ],
        runs,
      )
      expect(results(events).slice(1)).toEqual([
        [false, STUCK],
        [false, STUCK],
        [true, 'changed'],
        [false, STOPPED_AGAIN_LINE],
        [false, STUCK],
      ])
      expect(arrays(workers)).toBe(3)
    }), 20_000)

  it("reads a name that is also a design's id as that id", () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const events = await scriptedTurns(
        [
          [
            { name: 'design.list', args: { second: 'p1' } },
            { name: 'geom.array', args: { design: 'p1', copies: 12 } },
            { name: 'geom.array', args: { design: 'p2', copies: 12 } },
            { name: 'design.edit_step', args: { design: 'p2' } },
            { name: 'geom.array', args: { design: 'p1', copies: 12 } },
          ],
        ],
        runs,
      )
      expect(results(events).slice(1)).toEqual([
        [false, STUCK],
        [false, STUCK],
        [true, 'changed'],
        [false, STOPPED_AGAIN_LINE],
      ])
      expect(arrays(workers)).toBe(2)
    }), 20_000)

  it('runs a quick step again when its refusal says to try it again', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const events = await scriptedTurns(
        [
          [
            { name: 'geom.pick', args: {} },
            { name: 'geom.pick', args: {} },
          ],
        ],
        runs,
      )
      expect(results(events)).toEqual([
        [false, QUICK],
        [false, QUICK],
      ])
      expect(runs).toEqual(['geom.pick', 'geom.pick'])
      expect(workers.flatMap((w) => w.ops).filter((op) => op === 'face.pick')).toHaveLength(2)
    }), 20_000)
})
