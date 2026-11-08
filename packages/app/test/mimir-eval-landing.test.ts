// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval builds a reply's part where the app's plate would: a first body built off the bed lands on it in
// both (@slicerx/cad-history landing.ts), and so does a part an edit takes off the bed. A landing moves the design as a
// whole, so the steps after it, given in the frame the design was built in, change the same body. Each scenario runs the same calls on the app's design host and on the
// eval's, and every reply must match: summary, output and any error, with the design, step and revision ids each host
// makes put aside. The calls are kept here, not read from the eval's recordings, which every live capture rewrites.
import { bakeMesh, clearReplayCache, type Design, type DesignHost } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { creativeEnv } from '@slicerx/mcp/evals/creative'
import { createCardPlans, createPlanRegistry, tabToolset } from '@slicerx/mcp/toolset'
import { createScriptedClient, type PilotTool } from '@slicerx/pilot'
import { beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { geom } from '../src/geom/client'
import { startTimeline } from '../src/plate/timeline'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-eval-landing', { compressed: true, freshCache: true })

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

type Call = { name: string; args: Record<string, unknown> }

/**
 * A desk cable organizer built the way a user builds it: a top plate extruded around the origin, then a hook below
 * and in front of it, five slots cut in the top plate, and the list of designs, all in the frame the top plate was built
 * in. The extrude names the design by its name, which both hosts take, so the top plate is the first body: built off the
 * bed, it lands on it. The hook reaches below the bed, so that edit lands the part again, as a whole.
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

/**
 * The first steps of a headphone stand built the way a user builds it: a round base extruded around the origin, so
 * it lands on the plate, then the stem revolved about the design's own origin, the middle of the base, and joined to it.
 */
const HEADPHONE_STAND: Call[] = [
  { name: 'design.new', args: { name: 'Headphone stand' } },
  { name: 'geom.extrude', args: { design: 'd1', distance_mm: 12, extent: 'oneSide', operation: 'new', name: 'Base', shape: { type: 'circle', diameterMm: 110 } } },
  { name: 'geom.revolve', args: { design: 'd1', frame: { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, loops: [{ points: [[12.5, 0], [15, 0], [15, 12], [11, 162], [8.5, 162], [12.5, 12]] }], axis: { point: [0, 0], direction: [0, 1] }, angle_deg: 360, operation: 'join', name: 'Stem' } },
]

/** A block in the middle of the bed, then a join that reaches past the bed's right edge, so the edit lands it again. */
const EDIT_OFF_THE_BED: Call[] = [
  { name: 'design.new', args: { name: 'Block' } },
  { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [128, 128] }, distance_mm: 5 } },
  { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 140, heightMm: 20 }, placement: { center: [200, 128] }, distance_mm: 5, operation: 'join', part: 0 } },
  { name: 'design.list', args: {} },
]

/**
 * A block built around the origin, so it lands, then a sketch drawn for it on its top, in its own frame: a cut from the
 * sketch, that cut undone, and a deeper cut from the same sketch. k1 stands for the id design.sketch gave.
 */
const SKETCH_AFTER_LANDING: Call[] = [
  { name: 'design.new', args: { name: 'Block' } },
  { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, distance_mm: 10 } },
  { name: 'design.sketch', args: { design: 'd1', frame: { origin: [2, 0, 10], normal: [0, 0, 1] }, loops: [{ points: [[-3, -3], [3, -3], [3, 3], [-3, 3]] }] } },
  { name: 'geom.extrude', args: { design: 'd1', sketch: 'k1', distance_mm: 2, operation: 'cut' } },
  { name: 'design.undo', args: { design: 'd1' } },
  { name: 'geom.extrude', args: { design: 'd1', sketch: 'k1', distance_mm: 4, operation: 'cut' } },
  { name: 'design.list', args: {} },
]

/**
 * Two blocks built where they print, so neither lands, and a sketch drawn on the plate across both for no design: a
 * square over each. The second design made (Right) is cut from it first, then the first (Left), so Right's cut is the
 * first drawn on it and the sketch moves with Right. A tab past the bed's left edge lands Left again, and Right is cut
 * again from the sketch, which stayed with Right. d2 stands for the second id design.new gave.
 */
const SHARED_SKETCH: Call[] = [
  { name: 'design.new', args: { name: 'Left' } },
  { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [40, 128] }, distance_mm: 10 } },
  { name: 'design.new', args: { name: 'Right' } },
  { name: 'geom.extrude', args: { design: 'd2', shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [200, 128] }, distance_mm: 10 } },
  { name: 'design.sketch', args: { frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: [[40, 128], [200, 128]].map(([x, y]) => ({ points: [[x! - 3, y! - 3], [x! + 3, y! - 3], [x! + 3, y! + 3], [x! - 3, y! + 3]] })) } },
  { name: 'geom.extrude', args: { design: 'd2', sketch: 'k1', distance_mm: 2, operation: 'cut' } },
  { name: 'geom.extrude', args: { design: 'd1', sketch: 'k1', distance_mm: 2, operation: 'cut' } },
  { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 60, heightMm: 20 }, placement: { center: [10, 128] }, distance_mm: 10, operation: 'join', part: 0 } },
  { name: 'geom.extrude', args: { design: 'd2', sketch: 'k1', distance_mm: 4, operation: 'cut' } },
  { name: 'design.list', args: {} },
]

/**
 * SHARED_SKETCH with Right's first cut undone and redone before the tab: the redone cut comes back after Left's in the
 * timeline, so Left's cut is now the first drawn on the sketch and the sketch moves with Left, in the app and here.
 */
const SHARED_SKETCH_REDONE: Call[] = [
  ...SHARED_SKETCH.slice(0, 7),
  { name: 'design.undo', args: { design: 'd2' } },
  { name: 'design.redo', args: { design: 'd2' } },
  ...SHARED_SKETCH.slice(7),
]

const prompt = { id: 'landing', title: 'Landing', prompt: 'x', machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }, bodies: [1, 1] as [number, number] }

const STEP_ID = /^s[0-9a-z]{8}[0-9a-z]+k?$/

/** `v` with the host's own ids put aside: its design ids, its step and sketch ids, and its body revisions. */
function plain(v: unknown, ids: readonly string[]): unknown {
  const named = (i: number) => (i ? `<design${i + 1}>` : '<design>')
  if (typeof v === 'string') {
    const i = ids.indexOf(v)
    if (i >= 0) return named(i)
    if (STEP_ID.test(v)) return '<step>'
    return ids.reduce((t, id, k) => t.split(id).join(named(k)), v)
  }
  if (Array.isArray(v)) return v.map((x) => plain(x, ids))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /revision/i.test(k) && typeof x === 'string' ? '<revision>' : plain(x, ids)]))
  return v
}

/**
 * Runs the calls on `tools`, with d1 and d2 as the ids design.new gave, in order, and k1 as the id design.sketch gave;
 * each call's whole reply, or its error.
 */
async function build(tools: readonly PilotTool<never>[], calls: readonly Call[]): Promise<{ id: string; replies: unknown[] }> {
  const ids: string[] = []
  let sketch = 'k1'
  const replies: unknown[] = []
  for (const c of calls) {
    const tool = tools.find((t) => t.name === c.name)!
    const args = JSON.parse(JSON.stringify(c.args).split('"d1"').join(JSON.stringify(ids[0] ?? 'd1')).split('"d2"').join(JSON.stringify(ids[1] ?? 'd2')).split('"k1"').join(JSON.stringify(sketch))) as never
    try {
      const out = await tool.run(args, {} as never)
      if (c.name === 'design.new') ids.push((out.output as { design: string }).design)
      if (c.name === 'design.sketch') sketch = (out.output as { id: string }).id
      replies.push({ call: c.name, ok: out.ok !== false, summary: out.summary, output: out.output })
    } catch (e) {
      replies.push({ call: c.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { id: ids[0] ?? 'd1', replies: replies.map((r) => plain(r, ids)) }
}

const r2 = (v: number) => Math.round(v * 100) / 100
/** The body in the design's frame: its bounds and how many triangles it has. */
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

/** Each part's bounds in the design's frame. */
function partBoxes(d: Design): { min: number[]; max: number[] }[] {
  return d.parts.map((p) => {
    const w = bakeMesh(p, d.transform)
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < w.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, w.positions[i + k]!)
      max[k] = Math.max(max[k]!, w.positions[i + k]!)
    }
    return { min, max }
  })
}

/** Whether every part's box meets another's, so the parts make one piece (a single part always does). */
function touching(d: Design): boolean {
  const b = partBoxes(d)
  const meet = (x: (typeof b)[number], y: (typeof b)[number]) => [0, 1, 2].every((k) => x.min[k]! <= y.max[k]! + 0.01 && y.min[k]! <= x.max[k]! + 0.01)
  return b.length === 1 || b.every((x, i) => b.some((y, j) => i !== j && meet(x, y)))
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
// and no replay cached by an earlier test: each test makes every engine call it needs, live or recorded, in any order
beforeEach(() => {
  clearReplayCache()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { ...get().bed, widthMm: 256, depthMm: 256, heightMm: 256 } })
})

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

  it('keeps the hook on the top plate and cuts its slots after the top plate lands', async () => {
    const { app, evalRun, a, e } = await both(CABLE_ORGANIZER)
    expect(evalRun.replies).toEqual(app.replies)
    const said = app.replies.map((r) => JSON.stringify(r))
    expect(said[1]).toMatch(/moved to the plate by \(128, 128\) mm/)
    // the hook, given in the frame the top plate was built in, joins the top plate: the landing moved the whole design
    expect(said[2]).toMatch(/"ok":true/)
    expect(touching(a)).toBe(true)
    expect(touching(e)).toBe(true)
    // the slots, in that frame too, are cut from the top plate
    expect(said[4]).toMatch(/"ok":true.*Cable slots/)
    expect(said[4]).not.toMatch(/no longer reaches|did not go through/)
    // one piece no deeper than the top plate and the hook together
    for (const d of [a, e]) {
      const b = body(d)
      expect(b.max[1]! - b.min[1]!).toBeLessThanOrEqual(88.5)
    }
    expect(body(e)).toEqual(body(a))
  })

  it('keeps a step given in the design frame on the body after the first body lands', async () => {
    const { app, evalRun, a, e } = await both(HEADPHONE_STAND)
    expect(evalRun.replies).toEqual(app.replies)
    const said = app.replies.map((r) => JSON.stringify(r))
    expect(said[1]).toMatch(/moved to the plate by \(128, 128\) mm/)
    // the stem, revolved about the design's origin, stands in the middle of the base and joins it
    expect(said[2]).toMatch(/"ok":true.*Revolved/)
    expect(a.parts).toHaveLength(1)
    expect(e.parts).toHaveLength(1)
    expect(body(a).max[2]).toBe(162)
    expect(body(e)).toEqual(body(a))
    // on the plate the stand stands where the base landed, the middle of the bed
    const plate = get().plate.find((p) => p.id === a.id)!
    expect([plate.transform[12], plate.transform[13]]).toEqual([128, 128])
  })

  it('reads a sketch drawn for a landed design the same as the app, through a cut, its undo and a deeper cut', async () => {
    set({ timeline: { bodies: [], items: [], marker: 0 } })
    const stop = startTimeline()
    try {
      const { app, evalRun, a, e } = await both(SKETCH_AFTER_LANDING)
      expect(evalRun.replies).toEqual(app.replies)
      const said = app.replies.map((r) => JSON.stringify(r))
      expect(said[3]).toMatch(/"ok":true/)
      expect(said[5]).toMatch(/"ok":true/)
      // one 6 mm square hole 4 mm deep, 2 mm off the block's middle in the design's frame
      for (const d of [a, e]) expect(d.history.steps).toHaveLength(2)
      expect(body(e)).toEqual(body(a))
    } finally {
      stop()
    }
  })

  it('moves a sketch shared by two designs with the one whose step was drawn on it first, as the app does', async () => {
    set({ timeline: { bodies: [], items: [], marker: 0 } })
    const stop = startTimeline()
    try {
      const { app, evalRun } = await both(SHARED_SKETCH)
      expect(evalRun.replies).toEqual(app.replies)
      const said = app.replies.map((r) => JSON.stringify(r))
      // Left landed again by its tab; Right did not move, and neither did the sketch, so the deeper cut meets Right
      expect(said[7]).toMatch(/did not fit on the bed where it stood, so it moved by/)
      expect(said[8]).toMatch(/"ok":true/)
      expect(said[8]).not.toMatch(/does not reach|no longer reaches|did not go through/)
    } finally {
      stop()
    }
  })

  it('moves a shared sketch with the design whose step on it is first after an undo and redo of the other\'s, as the app does', async () => {
    set({ timeline: { bodies: [], items: [], marker: 0 } })
    const stop = startTimeline()
    try {
      const { app, evalRun } = await both(SHARED_SKETCH_REDONE)
      expect(evalRun.replies).toEqual(app.replies)
      const said = app.replies.map((r) => JSON.stringify(r))
      expect(said[8]).toMatch(/"ok":true/)
      // Left landed again by its tab, and the sketch went with it: Right's deeper cut no longer meets Right
      expect(said[9]).toMatch(/did not fit on the bed where it stood, so it moved by/)
      expect(said[10]).toMatch(/does not reach|no longer reaches|did not go through/)
    } finally {
      stop()
    }
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
