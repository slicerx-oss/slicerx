// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval builds a reply's part where the app's plate would: a first body built off the bed lands on it in
// both (@slicerx/cad-history landing.ts), and so does a part an edit takes off the bed, so the steps after it, given in
// plate millimeters, change the same body. Each scenario runs the same calls on the app's design host and on the
// eval's, and every reply must match: summary, output and any error, with the design, step and revision ids each host
// makes put aside. The calls are kept here, not read from the eval's recordings, which every live capture rewrites.
import { bakeMesh, type Design, type DesignHost } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { creativeEnv } from '@slicerx/mcp/evals/creative'
import { createCardPlans, createPlanRegistry, tabToolset } from '@slicerx/mcp/toolset'
import { createScriptedClient, type PilotTool } from '@slicerx/pilot'
import { beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { geom } from '../src/geom/client'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-eval-landing', { compressed: true })

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

type Call = { name: string; args: Record<string, unknown> }

/**
 * A desk cable organizer as a model built it in a live run: a top plate extruded around the origin, then a hook below
 * and in front of the bed's front left corner, five slots cut in plate millimeters, and the list of designs. The extrude
 * names the design by its name, which both hosts take, so the top plate is the first body: built off the bed, it lands
 * on it. The hook, given in plate millimeters, reaches past the bed's front edge, so that edit lands the part again.
 */
const CABLE_ORGANIZER: Call[] = [
  { name: 'design.new', args: { name: 'Desk cable organizer' } },
  { name: 'geom.extrude', args: { design: 'Desk cable organizer', shape: { type: 'rectangle', widthMm: 100, heightMm: 44 }, distance_mm: 12, extent: 'oneSide', operation: 'new', name: 'Top plate' } },
  { name: 'geom.build', args: { design: 'd1', name: 'Base hook', solids: [{ type: 'box', min: [0, -40, 0], max: [100, 4, 12] }, { type: 'box', min: [0, 0, -25], max: [100, 4, 0] }] } },
  // the landed note belongs to the call that moved the part: a read right after it does not repeat it
  { name: 'design.list', args: {} },
  { name: 'geom.subtract', args: { design: 'd1', part: 0, label: 'Cable slots', solids: [9, 27, 45, 63, 81].map((x) => ({ type: 'box', min: [x, -36, 2], max: [x + 10, -4, 13] })) } },
  { name: 'design.steps', args: { design: 'd1' } },
]

/** A block in the middle of the bed, then a join that reaches past the bed's right edge, so the edit lands it again. */
const EDIT_OFF_THE_BED: Call[] = [
  { name: 'design.new', args: { name: 'Block' } },
  { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [128, 128] }, distance_mm: 5 } },
  { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 140, heightMm: 20 }, placement: { center: [200, 128] }, distance_mm: 5, operation: 'join', part: 0 } },
  { name: 'design.list', args: {} },
]

const prompt = { id: 'landing', title: 'Landing', prompt: 'x', machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }, bodies: [1, 1] as [number, number] }

const STEP_ID = /^s[0-9a-z]{8}[0-9a-z]+k?$/

/** `v` with the host's own ids put aside: its design id, its step and sketch ids, and its body revisions. */
function plain(v: unknown, id: string): unknown {
  if (typeof v === 'string') {
    if (v === id) return '<design>'
    if (STEP_ID.test(v)) return '<step>'
    return v.split(id).join('<design>')
  }
  if (Array.isArray(v)) return v.map((x) => plain(x, id))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /revision/i.test(k) && typeof x === 'string' ? '<revision>' : plain(x, id)]))
  return v
}

/** Runs the calls on `tools`, with the design id d1 as the id design.new gave; each call's whole reply, or its error. */
async function build(tools: readonly PilotTool<never>[], calls: readonly Call[]): Promise<{ id: string; replies: unknown[] }> {
  let id = 'd1'
  const replies: unknown[] = []
  for (const c of calls) {
    const tool = tools.find((t) => t.name === c.name)!
    const args = JSON.parse(JSON.stringify(c.args).split('"d1"').join(JSON.stringify(id))) as never
    try {
      const out = await tool.run(args, {} as never)
      if (c.name === 'design.new') id = (out.output as { design: string }).design
      replies.push({ call: c.name, ok: out.ok !== false, summary: out.summary, output: out.output })
    } catch (e) {
      replies.push({ call: c.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { id, replies: replies.map((r) => plain(r, id)) }
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

/** The calls on the app's plate and in the eval: the replies of each, and each host's design after them. */
async function both(calls: readonly Call[]) {
  const appHost: DesignHost = appDesignHost(loader)
  const app = await build(tabToolset(appHost, createCardPlans(createPlanRegistry())), calls)
  const env = creativeEnv(prompt, createScriptedClient([], { chunk: false }), { geom: { run: (op, input) => geom().call(op, input) } })
  const evalRun = await build(env.options.tools ?? [], calls)
  return { app, evalRun, a: appHost.get(app.id), e: env.designs.get(evalRun.id) }
}

// the P1S the prompt names: a 256 mm cube, as the eval reads it from the printer catalog
beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { ...get().bed, widthMm: 256, depthMm: 256, heightMm: 256 } }))

describe('the creative eval lands a body as the app does', () => {
  it('builds the cable organizer into the same body on the same spot, with the same replies', async () => {
    const { app, evalRun, a, e } = await both(CABLE_ORGANIZER)
    expect(evalRun.replies).toEqual(app.replies)
    // the top plate, taken by the design's name, was built off the bed and moved onto it, and only that call says so
    const said = app.replies.map((r) => JSON.stringify(r))
    expect(said[1]).toMatch(/"ok":true.*moved to the plate/)
    expect(said.filter((s) => /moved to the plate/.test(s))).toHaveLength(1)
    // the hook past the front edge moved the part again before its slots were cut, and the reads after it say nothing
    expect(said[2]).toMatch(/did not fit on the bed where it stood, so it moved by/)
    expect(said.filter((s) => /moved by/.test(s))).toHaveLength(1)
    expect(e.transform).toEqual(a.transform)
    expect(body(e)).toEqual(body(a))
    expect(e.history.steps.map((s) => s.params.op)).toEqual(a.history.steps.map((s) => s.params.op))
  })

  // Known failure: the first landing moves the design's coordinates onto the plate's, so the hook and the slots, given
  // in the frame the top plate was built in, miss it and the design ends as two parts. Placing a landed design as a
  // whole is its own change (fix/mimir-design-placement); this flips to a plain it there.
  it.fails('keeps the hook on the top plate and cuts its slots after the top plate lands', async () => {
    const { app, a } = await both(CABLE_ORGANIZER)
    const said = app.replies.map((r) => JSON.stringify(r))
    expect(said[4]).toMatch(/"ok":true/)
    expect(said[4]).not.toMatch(/no longer reaches/)
    // one piece: the top plate (44 mm deep) and the hook (44 mm deep) meet, so the body is no deeper than both
    const b = body(a)
    expect(b.max[1]! - b.min[1]!).toBeLessThanOrEqual(88.5)
  })

  it('lands a part again when an edit takes it past the edge of the bed', async () => {
    const { app, evalRun, a, e } = await both(EDIT_OFF_THE_BED)
    expect(evalRun.replies).toEqual(app.replies)
    expect(JSON.stringify(app.replies[2])).toMatch(/did not fit on the bed where it stood, so it moved by/)
    expect(JSON.stringify(app.replies[3])).not.toMatch(/moved by/)
    expect(e.transform).toEqual(a.transform)
    expect(body(e)).toEqual(body(a))
  })
})
