// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval builds a recorded reply's part where the app's plate would: a first body built off the bed lands
// on it in both (@slicerx/cad-history landing.ts), so the steps after it, given in plate millimeters, cut the same
// body. The recorded cable organizer builds its hook below and in front of the bed's corner, then cuts its slots.
import { bakeMesh, type Design, type DesignHost } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { creativeEnv } from '@slicerx/mcp/evals/creative'
import { createCardPlans, createPlanRegistry, tabToolset } from '@slicerx/mcp/toolset'
import { createScriptedClient, type PilotTool } from '@slicerx/pilot'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { geom } from '../src/geom/client'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-eval-landing', { compressed: true })

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

/** The cable organizer's recorded calls that build its part: design.new and the geometry steps after it. */
const recorded = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'mcp', 'evals', 'creative', 'recordings', 'cable-organizer.json'), 'utf8')) as { steps: { calls?: { name: string; args: Record<string, unknown> }[] }[] }).steps
  .flatMap((s) => s.calls ?? [])
  .filter((c) => c.name === 'design.new' || c.name.startsWith('geom.'))

const prompt = { id: 'cable-organizer', title: 'Cable organizer', prompt: 'x', machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }, bodies: [1, 1] as [number, number] }

/** Runs the calls on `tools`, with the recorded design id d1 as the id design.new gave; what each call said. */
async function build(tools: readonly PilotTool<never>[]): Promise<{ id: string; said: string[] }> {
  let id = 'd1'
  const said: string[] = []
  for (const c of recorded) {
    const tool = tools.find((t) => t.name === c.name)!
    const args = JSON.parse(JSON.stringify(c.args).split('"d1"').join(JSON.stringify(id))) as never
    try {
      const out = await tool.run(args, {} as never)
      if (c.name === 'design.new') id = (out.output as { design: string }).design
      said.push(`${c.name}: ${out.ok === false ? 'refused' : 'ok'} ${(out.output as { landed?: string } | undefined)?.landed ?? ''}`.trim())
    } catch (e) {
      said.push(`${c.name}: error`)
    }
  }
  return { id, said }
}

const r2 = (v: number) => Math.round(v * 100) / 100
/** The body in plate millimeters: its bounds and how many triangles it has. */
function body(d: Design): { min: number[]; max: number[]; triangles: number } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let triangles = 0
  for (const p of d.parts) {
    const w = bakeMesh(p, d.transform)
    triangles += w.indices.length / 3
    for (let i = 0; i + 2 < w.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, w.positions[i + k]!)
      max[k] = Math.max(max[k]!, w.positions[i + k]!)
    }
  }
  return { min: min.map(r2), max: max.map(r2), triangles }
}

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { ...get().bed, widthMm: 256, depthMm: 256, heightMm: 256 } }))

describe('the creative eval lands a body as the app does', () => {
  it('builds the recorded cable organizer into the same body on the same spot', async () => {
    expect(recorded.map((c) => c.name)).toEqual(['design.new', 'geom.extrude', 'geom.build', 'geom.subtract'])
    const appHost: DesignHost = appDesignHost(loader)
    const app = await build(tabToolset(appHost, createCardPlans(createPlanRegistry())))
    const env = creativeEnv(prompt, createScriptedClient([], { chunk: false }), { geom: { run: (op, input) => geom().call(op, input) } })
    const evalRun = await build(env.options.tools ?? [])
    expect(evalRun.said).toEqual(app.said)
    // the hook was built off the bed and moved onto it before its slots were cut
    expect(app.said.find((s) => s.startsWith('geom.build'))).toMatch(/moved to the plate/)
    const a = appHost.get(app.id)
    const e = env.designs.get(evalRun.id)
    expect(e.transform).toEqual(a.transform)
    expect(body(e)).toEqual(body(a))
    expect(e.history.steps.map((s) => s.params.op)).toEqual(a.history.steps.map((s) => s.params.op))
  })
})
