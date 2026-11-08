// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mimir run nobody watches: a step whose geometry call is stuck in the engine is refused at the call's time limit
// (client.ts, @slicerx/contracts geom-limits.ts), the run reports it plainly and goes on with its next step, and the
// stuck call is not sent again. The run is the tab's runtime as session.ts makes it, on a scripted turn, with the
// engine a stand-in in a real thread that spins forever in `array`.
import type { Host, PilotEvent } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type PilotTool } from '@slicerx/pilot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { endIdleGeomWorker, setGeomCallLimit, setGeomProvider } from '../src/geom/client'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { tabPilotOptions } from '../src/workspaces/mimir/session'
import { busyWorkers } from './geom-busy-engine'

const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

/** A tool that runs one geometry call through the tab's host, counting its runs. */
function geomTool(name: string, op: string, runs: string[]) {
  return defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: name,
    input: z.object({}),
    run: async (_i, ctx) => {
      runs.push(name)
      const reply = await ctx.host.geom!.run(op, {}, ctx.signal)
      return { summary: JSON.stringify(reply) }
    },
  }) as PilotTool<never>
}

afterEach(() => {
  endIdleGeomWorker()
  vi.unstubAllGlobals()
  setGeomProvider(null)
  setGeomCallLimit(null)
})

describe('a mimir run with a stuck geometry step', () => {
  it('reports the stuck step plainly, does not send it again, and goes on to the next step', async () => {
    const { workers, end } = busyWorkers()
    setGeomCallLimit((op) => (op === 'array' ? 400 : 60_000))
    try {
      const runs: string[] = []
      const tools = [geomTool('geom.array', 'array', runs), geomTool('geom.info', 'measure', runs)]
      // a host that models only: its slicer is never reached
      const slicer = { loadModel: async () => undefined, slice: async () => undefined }
      const host = { kind: 'web', slicer, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
      const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools, commands: [] })
      const steps = [{ calls: [{ name: 'geom.array', args: {} }] }, { calls: [{ name: 'geom.info', args: {} }] }, { text: 'Done.' }]
      const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
      expect(pilot.tools().map((t) => t.name)).toEqual(expect.arrayContaining(['geom.array', 'geom.info']))
      const events: PilotEvent[] = []
      const t = performance.now()
      for await (const ev of pilot.run('tab', 'make it', {})) events.push(ev)
      expect(performance.now() - t).toBeLessThan(10_000)
      const results = events.flatMap((e) => (e.type === 'tool_result' ? [e] : []))
      expect(results.map((r) => [r.ok, r.summary])).toEqual([
        [false, 'the array step ran past its 0.4 s limit and was stopped; try a smaller version: fewer copies or a simpler part'],
        [true, JSON.stringify({ op: 'measure' })],
      ])
      // each step ran once, and the engine got the stuck call once
      expect(runs).toEqual(['geom.array', 'geom.info'])
      expect(workers.flatMap((w) => w.ops).filter((op) => op === 'array')).toHaveLength(1)
      const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
      expect(text).toContain('Done.')
      expect(events.some((e) => e.type === 'error')).toBe(false)
    } finally {
      await end()
    }
  }, 20_000)
})
