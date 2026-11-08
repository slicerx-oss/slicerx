// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mimir run nobody watches: a step whose geometry call is stuck in the engine is refused at the call's time limit
// (client.ts, @slicerx/contracts geom-limits.ts), the run reports it plainly and goes on with its next step, and the
// stuck call is not sent again. A modeling step stopped for good is not run again with the same input in that turn,
// until a change goes through; a quick step's refusal says to try it again, and it can be. The run is the tab's
// runtime as session.ts makes it, on scripted turns, with the engine a stand-in in a real thread that spins forever in
// `array` and `face.pick`.
import type { Host, PilotEvent } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, STOPPED_AGAIN_LINE, type PilotTool } from '@slicerx/pilot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { endIdleGeomWorker, setGeomCallLimit, setGeomProvider } from '../src/geom/client'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { tabPilotOptions } from '../src/workspaces/mimir/session'
import { busyWorkers } from './geom-busy-engine'

const STUCK = 'The step "Array" ran past its 0.4 s limit and was stopped; try a smaller version: fewer copies or a simpler part'
const QUICK = 'The step "Face pick" took too long (over its 0.4 s limit) and was stopped; try it again'

const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

/** A tool that runs one geometry call through the tab's host, counting its runs with their input. */
function geomTool(name: string, op: string, runs: string[]) {
  return defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: name,
    input: z.object({ copies: z.number().optional(), at: z.record(z.string(), z.number()).optional() }),
    run: async (i, ctx) => {
      runs.push(i.copies === undefined ? name : `${name} ${i.copies}`)
      const reply = await ctx.host.geom!.run(op, i, ctx.signal)
      return { summary: JSON.stringify(reply) }
    },
  }) as PilotTool<never>
}

/** A tool that changes the design and goes through, as an edit or an undo does. */
function editTool(runs: string[]) {
  return defineTool({
    name: 'design.shrink',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'design.shrink',
    input: z.object({}),
    run: async () => {
      runs.push('design.shrink')
      return { summary: 'fewer copies' }
    },
  }) as PilotTool<never>
}

type Call = { name: string; args: Record<string, unknown> }

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
async function scriptedTurns(turns: Call[][], runs: string[]) {
  const tools = [geomTool('geom.array', 'array', runs), geomTool('geom.pattern', 'array', runs), geomTool('geom.info', 'measure', runs), geomTool('geom.pick', 'face.pick', runs), editTool(runs)]
  // a host that models only: its slicer is never reached
  const slicer = { loadModel: async () => undefined, slice: async () => undefined }
  const host = { kind: 'web', slicer, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools, commands: [] })
  const steps = turns.flatMap((calls) => [...calls.map((c) => ({ calls: [c] })), { text: 'Done.' }])
  const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
  expect(pilot.tools().map((t) => t.name)).toEqual(expect.arrayContaining(['geom.array', 'geom.pattern', 'geom.info', 'geom.pick', 'design.shrink']))
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
      const events = await scriptedTurns(
        [
          [
            { name: 'geom.array', args: { copies: 12, at: { x: 1, y: 2 } } },
            { name: 'geom.array', args: { at: { y: 2, x: 1 }, copies: 12.0 } },
            { name: 'geom.array', args: { copies: 6, at: { x: 1, y: 2 } } },
            { name: 'geom.info', args: {} },
          ],
        ],
        runs,
      )
      expect(results(events)).toEqual([
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
        [false, STUCK],
        [true, JSON.stringify({ op: 'measure' })],
      ])
      // the repeat never reached the tool or the engine; the smaller version did
      expect(runs).toEqual(['geom.array 12', 'geom.array 6', 'geom.info'])
      expect(arrays(workers)).toBe(2)
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

  it('runs a stopped step again once a change to the design went through', () =>
    stuckEngine(async (workers) => {
      const runs: string[] = []
      const events = await scriptedTurns(
        [
          [
            { name: 'geom.array', args: { copies: 12 } },
            { name: 'design.shrink', args: {} },
            { name: 'geom.array', args: { copies: 12 } },
            { name: 'geom.array', args: { copies: 12 } },
          ],
        ],
        runs,
      )
      expect(results(events)).toEqual([
        [false, STUCK],
        [true, 'fewer copies'],
        [false, STUCK],
        [false, STOPPED_AGAIN_LINE],
      ])
      expect(runs).toEqual(['geom.array 12', 'design.shrink', 'geom.array 12'])
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
