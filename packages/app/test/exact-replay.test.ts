// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Replays on exact solids (@slicerx/cad-history exact.ts) with a stand-in engine: which steps go to the B-rep kernel,
// what they send it, and how a step falls back to the mesh when the kernel fails. The kernel itself is tested in
// packages/brep (cargo) and brep-module.test.ts.
import { beforeEach, expect, it } from 'vitest'
import { EXACT_FELL_BACK, EXACT_OPS, IDENTITY, clearReplayCache, replayHistory, stepSalt, translation, type History, type Step, type StepParams, type Vec3 } from '@slicerx/cad-history'
import { primitive } from '../src/plate/mesh-ops'

const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }

type Sent = { op: string; req: Record<string, unknown> }
type R = Record<string, unknown>

/** An engine whose kernel names each solid after the op that made it, and fails the ops in `failing`. */
function engine(failing: string[] = []) {
  const sent: Sent[] = []
  let n = 0
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    // which operations it makes exact and the largest solid it takes, asked once a replay: not a step's call
    if (op === EXACT_OPS) return { ops: [] }
    sent.push({ op, req })
    if (failing.includes(op)) throw new Error(`kernel: ${op} failed (SMLib status 1001)`)
    if (op === 'brep.tessellate') return { ...tri, faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.cut') return { below: 1, above: 2, belowSmb: `below-${++n}`, aboveSmb: `above-${n}` }
    if (op.startsWith('brep.')) return { body: 1, bodySmb: `${op.slice(5)}-${++n}` }
    if (op === 'cut') return { below: tri, above: tri }
    return { mesh: { ...tri, positions: [1, 0, 0, 10, 0, 0, 0, 10, 0] }, removedVolumeMm3: 1 }
  }
  return { call, sent, ops: () => sent.map((s) => s.op) }
}

const step = (id: string, params: StepParams, transform = [...IDENTITY]): Step => ({ id, part: 0, transform, params })
const box = step('box-1', { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } })
const hole = step('hole-1', { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole 4 mm' } as StepParams)
const cut = step('cut-1', { op: 'plane.cut', plane: { point: [0, 0, 2], normal: [0, 0, 1] }, keep: 'both' } as StepParams)
const history = (...steps: Step[]): History => ({ version: 1, base: [], steps })

beforeEach(() => clearReplayCache())

it('runs on the mesh unless the replay asks for exact solids', async () => {
  const e = engine()
  await replayHistory(e.call, { history: history(box, hole) })
  expect(e.ops().filter((o) => o.startsWith('brep.'))).toEqual([])
})

it('builds a new body, holes and cuts on the kernel and keeps the solid with each part', async () => {
  const e = engine()
  const r = await replayHistory(e.call, { history: history(box, hole, cut), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.subtract', 'brep.tessellate', 'brep.cut', 'brep.tessellate', 'brep.tessellate'])
  const extrude = e.sent[0]!.req
  // the rectangle centered on the frame, counterclockwise, run from the face up its distance
  expect(extrude['polygons']).toEqual([{ outer: { points: [[-10, -5], [10, -5], [10, 5], [-10, 5]] }, holes: [] }])
  expect([extrude['fromMm'], extrude['toMm']]).toEqual([0, 5])
  expect(extrude['keySalt']).toBe(stepSalt('box-1'))
  // the hole goes into the solid the box made, the part's frame with it for the world solids
  expect(e.sent[2]!.req['body']).toEqual({ smb: 'extrude-1' })
  expect(e.sent[2]!.req['frame']).toEqual({ origin: [0, 0, 0], u: [1, 0, 0], normal: [0, 0, 1] })
  expect(r.parts.map((p) => p.name)).toEqual(['Body', 'Body top'])
  // the kernel's faces and keys come with the mesh
  expect(r.parts[0]!.faces).toEqual({ ids: [0], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }], keys: [77] })
})

it('runs a step the kernel fails on the mesh, with a note, and the steps after it too', async () => {
  const e = engine(['brep.subtract'])
  const r = await replayHistory(e.call, { history: history(box, hole, cut), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(r.status[1]).toEqual({ state: 'done', note: EXACT_FELL_BACK })
  expect(e.ops().slice(2)).toEqual(['brep.subtract', 'subtract', 'cut'])
  expect(r.parts.every((p) => !(p as { smb?: string }).smb)).toBe(true)
})

it('leaves to the mesh what the kernel has no version of', async () => {
  const copies = step('box-2', { ...box.params, pattern: { kind: 'linear', count: 2, stepMm: [30, 0] } } as StepParams)
  const scaled = step('hole-2', hole.params, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])
  const e = engine()
  await replayHistory(e.call, { history: history(copies), exact: true })
  expect(e.ops()).toEqual(['shape.extrude'])
  const f = engine()
  await replayHistory(f.call, { history: history(box, scaled), exact: true })
  expect(f.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'subtract'])
})

it('sends a taper to the kernel, and runs it on the mesh when the kernel refuses it', async () => {
  const tapered = step('box-2', { ...box.params, spec: { distanceMm: 5, operation: 'new', extent: 'symmetric', taperDeg: 5 } } as StepParams)
  const e = engine()
  await replayHistory(e.call, { history: history(tapered), exact: true })
  expect(e.sent[0]).toMatchObject({ op: 'brep.extrude', req: { fromMm: -5, toMm: 5, taperDeg: 5 } })
  const g = engine()
  await replayHistory(g.call, { history: history(box), exact: true })
  expect('taperDeg' in g.sent[0]!.req).toBe(false)
  clearReplayCache()
  const f = engine(['brep.extrude'])
  const r = await replayHistory(f.call, { history: history(tapered), exact: true })
  expect(f.ops()).toEqual(['brep.extrude', 'shape.extrude'])
  expect(r.status[0]).toEqual({ state: 'done', note: EXACT_FELL_BACK })
})

it('a plane that misses the solid breaks the step, as on the mesh', async () => {
  const e = engine()
  const missing = async (op: string, req: unknown) => (op === 'brep.cut' ? { below: 1, above: null, belowSmb: 'x' } : e.call(op, req))
  const r = await replayHistory(missing, { history: history(box, cut), exact: true })
  expect(r.status[1]).toEqual({ state: 'broken', message: 'The plane no longer crosses the part.' })
})

it('a painted part keeps its paint through a kernel step, by the face it was on', async () => {
  const e = engine()
  const paintCall = async (op: string, req: unknown) => (op === 'paint.select' ? { changed: { 0: 'ff0000' } } : e.call(op, req))
  const paint = step('paint-1', { op: 'paint', layer: 'color', state: 1, target: { kind: 'part' } } as StepParams)
  const r = await replayHistory(paintCall, { history: history(box, paint, hole), exact: true })
  // paint keeps the solid, so the hole still goes to the kernel
  expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.subtract', 'brep.tessellate'])
  // the whole face was painted, so its key carries the paint onto the hole's triangles of that face
  expect(r.status[2]).toEqual({ state: 'done' })
  expect(r.parts[0]!.paint).toEqual({ color: { 0: 'ff0000' } })
})

it('never reads a solid that came with the history, and never returns one', async () => {
  const e = engine()
  const base = { name: 'Part', slot: 1, ...tri, smb: 'from a file' }
  const r = await replayHistory(e.call, { history: { version: 1, base: [base] as never, steps: [hole] }, exact: true })
  expect(e.ops()).toEqual(['subtract'])
  const made = await replayHistory(e.call, { history: history(box, hole), exact: true })
  expect(made.parts.some((p) => 'smb' in p)).toBe(false)
  expect(r.parts.some((p) => 'smb' in p)).toBe(false)
})

it('reports the steps that fell back, so a developer sees them', async () => {
  const r = await replayHistory(engine(['brep.subtract']).call, { history: history(box, hole), exact: true })
  expect(r.exactFellBack).toEqual(['hole-1'])
})

it('rounds edges on the kernel, in the part frame, and falls back to the mesh when it fails', async () => {
  const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
  const fillet = step('fillet-1', { op: 'edge.fillet', edges: [{ a: [15, -5, 0], b: [15, -5, 5], face: [1, 0, 0], keys: [3, 4] }], radiusMm: 1 }, moved)
  const e = engine()
  const r = await replayHistory(e.call, { history: history(box, fillet), exact: true })
  expect(r.status[1]).toEqual({ state: 'done' })
  expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.fillet', 'brep.tessellate'])
  const sent = e.sent[2]!.req
  expect(sent['body']).toEqual({ smb: 'extrude-1' })
  expect(sent['edges']).toEqual([{ a: [10, -5, 0], b: [10, -5, 5], keys: [3, 4] }])
  expect(sent['radiusMm']).toBe(1)
  // the same history again would come from the replay cache
  clearReplayCache()
  const f = engine(['brep.fillet'])
  const back = await replayHistory(f.call, { history: history(box, fillet), exact: true })
  expect(back.exactFellBack).toEqual(['fillet-1'])
  expect(f.ops().slice(2)).toEqual(['brep.fillet', 'edge.fillet'])
})

it('chamfers on the kernel with one distance', async () => {
  const chamfer = step('chamfer-1', { op: 'edge.chamfer', edges: [{ a: [10, -5, 0], b: [10, -5, 5], face: [1, 0, 0] }], distanceMm: 1 })
  const e = engine()
  await replayHistory(e.call, { history: history(box, chamfer), exact: true })
  expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.chamfer', 'brep.tessellate'])
  expect(e.sent[2]!.req['distanceMm']).toBe(1)
  expect(e.sent[2]!.req).not.toHaveProperty('distance2Mm')
})

it('joins and cuts a sketch on a face into the solid, and a shape that misses breaks the step', async () => {
  const on = (operation: 'join' | 'cut', id: string) => step(id, { ...box.params, shape: { type: 'circle', diameterMm: 4 }, spec: { distanceMm: 3, operation } } as StepParams)
  const e = engine()
  const sent: Record<string, unknown>[] = []
  const into = async (op: string, req: unknown) => {
    if (op === 'brep.extrude') sent.push(req as Record<string, unknown>)
    return op === 'brep.extrude' && (req as { target?: unknown }).target ? { touches: true, body: 1, bodySmb: 'into' } : e.call(op, req)
  }
  const r = await replayHistory(into, { history: history(box, on('cut', 'pocket-1'), on('join', 'boss-1')), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
  // a cut runs into the face, a join out of it, each into the solid the step before left
  expect(sent.map((q) => [q['operation'], q['fromMm'], q['toMm']])).toEqual([[undefined, 0, 5], ['cut', -3, 0], ['join', 0, 3]])
  expect(sent[1]!['target']).toEqual({ smb: 'extrude-1' })
  expect(sent[2]!['target']).toEqual({ smb: 'into' })
  const away = async (op: string, req: unknown) => (op === 'brep.extrude' && (req as { target?: unknown }).target ? { touches: false, body: null } : e.call(op, req))
  clearReplayCache()
  const m = await replayHistory(away, { history: history(box, on('cut', 'pocket-1')), exact: true })
  expect(m.status[1]).toEqual({ state: 'broken', message: "The cut's shape sits at x -2 to 2, y -2 to 2, z -3 to 0, 0.0 mm short of the part." })
})

it('says where a join or cut that misses sits against the part, in the frame the design tools read points in', async () => {
  // the part is the stand-in kernel's triangle: x 0 to 10, y 0 to 10, z 0
  const e = engine()
  const away = async (op: string, req: unknown) => (op === 'brep.extrude' && (req as { target?: unknown }).target ? { touches: false, body: null } : e.call(op, req))
  const on = (operation: 'join' | 'cut', origin: Vec3, normal: Vec3, u: Vec3, v: Vec3, transform?: number[]) => step('hole-1', { op: 'shape.extrude', frame: { origin, normal, u, v }, shape: { type: 'circle', diameterMm: 2 }, spec: { distanceMm: 2, operation } } as StepParams, transform)
  const said = async (h: History) => {
    clearReplayCache()
    return (await replayHistory(away, { history: h, exact: true })).status[1]
  }
  // a cut 140 mm off the part's side runs into the face, from y 150 to 152; a join runs out of it, from 148 to 150
  const side = (operation: 'join' | 'cut') => on(operation, [5, 150, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1])
  expect(await said(history(box, side('cut')))).toEqual({ state: 'broken', message: "The cut's shape sits at x 4 to 6, y 150 to 152, z -1 to 1, 140.0 mm from the part (x 0 to 10, y 0 to 10, z 0)." })
  expect(await said(history(box, side('join')))).toEqual({ state: 'broken', message: "The join's shape sits at x 4 to 6, y 148 to 150, z -1 to 1, 138.0 mm from the part (x 0 to 10, y 0 to 10, z 0)." })
  // a cut wholly below the part
  expect(await said(history(box, on('cut', [5, 5, -50], [0, 0, 1], [1, 0, 0], [0, 1, 0])))).toEqual({ state: 'broken', message: "The cut's shape sits at x 4 to 6, y 4 to 6, z -52 to -50, under the part (x 0 to 10, y 0 to 10, z 0)." })
  // a design moved onto the bed by (20, 30): its steps stand at the plate, and the sentence reads in the design's own
  // frame, as the points given and the bounds read back do
  const t = translation([20, 30, 0])
  const moved: History = { ...history({ ...box, transform: t }, on('cut', [25, 180, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1], t)), placed: [20, 30] }
  expect(await said(moved)).toEqual({ state: 'broken', message: "The cut's shape sits at x 4 to 6, y 150 to 152, z -1 to 1, 140.0 mm from the part (x 0 to 10, y 0 to 10, z 0)." })
})

it('sends circles as circles and polygons as their corners, turned and moved as the engine places them', async () => {
  const circle = step('circle-1', { ...box.params, shape: { type: 'circle', diameterMm: 8 }, placement: { center: [1, 2] } } as StepParams)
  const e = engine()
  await replayHistory(e.call, { history: history(circle), exact: true })
  expect(e.sent[0]!.req['polygons']).toEqual([{ outer: { center: [1, 2], diameterMm: 8 }, holes: [] }])
  const square = step('square-1', { ...box.params, shape: { type: 'polygon', sides: 4, diameterMm: 10, fit: 'circumscribed' }, placement: { rotationDeg: 45 } } as StepParams)
  const f = engine()
  await replayHistory(f.call, { history: history(square), exact: true })
  // a square around a 10 mm circle, flat side down, turned 45 degrees: its corners on the axes at 5 * sqrt 2
  const corners = (f.sent[0]!.req['polygons'] as { outer: { points: number[][] } }[])[0]!.outer.points
  const r = 5 * Math.SQRT2
  for (const [p, q] of corners.map((c, i) => [c, [[0, -r], [r, 0], [0, r], [-r, 0]][i]!])) for (const k of [0, 1]) expect(p![k]).toBeCloseTo(q![k]!, 9)
})

it('pushes and pulls a flat face on the kernel, and records the face it moved as the mesh path does', async () => {
  // the part moved 5 along x since the box: the face goes to the kernel in the part's own coordinates
  const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
  const pull = step('pull-1', { op: 'face.push', at: [7, 1, 5], normal: [0, 0, 2], distanceMm: 3, faceKey: 9 }, moved)
  const e = engine()
  const frame = { origin: [0, 0, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
  const slot = { start: [-5, -2], segments: [{ to: [5, -2] }, { to: [5, 2], center: [5, 0], sweepDeg: 180 }, { to: [-5, 2] }, { to: [-5, -2], center: [-5, 0], sweepDeg: 180 }] }
  let reply: Record<string, unknown> = { body: 1, bodySmb: 'pushed', faceKey: 9, frame, polygons: [{ outer: slot, holes: [{ center: [0, 0], diameterMm: 2 }] }], reached: true }
  const push = async (op: string, req: unknown) => {
    const r = await e.call(op, req)
    return op === 'brep.push' ? reply : r
  }
  const r = await replayHistory(push, { history: history(box, pull), exact: true })
  expect(r.status[1]).toEqual({ state: 'done' })
  expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.push', 'brep.tessellate'])
  const sent = e.sent[2]!.req
  expect(sent).toMatchObject({ body: { smb: 'extrude-1' }, at: [2, 1, 5], normal: [0, 0, 1], distanceMm: 3, faceKey: 9 })
  // the moved face in world, its outline in the face's frame with each arc in pieces of 5 degrees
  const m = r.moved['pull-1']!
  expect(m.frame).toEqual({ origin: [5, 0, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
  expect(m.distanceMm).toBe(3)
  expect(m.outline[0]!.outer.length).toBe(4 + 2 * 35)
  expect(m.outline[0]!.holes[0]!.length).toBe(72)
  for (const q of m.outline[0]!.outer) expect(Math.abs(q[1]) <= 2 + 1e-9 && Math.abs(q[0]) <= 7 + 1e-9).toBe(true)
  expect(r.found).toBeUndefined()
  // a face found by place gets its key recorded, and one pushed through the part leaves no face where it moved to
  clearReplayCache()
  reply = { ...reply, faceKey: 12, reached: false }
  const through = await replayHistory(push, { history: history(box, step('pull-1', { op: 'face.push', at: [0, 0, 5], normal: [0, 0, 1], distanceMm: -5 })), exact: true })
  expect(through.found).toEqual({ 'pull-1': { faceKey: 12 } })
  // the kernel failing sends the push to the mesh, with the note
  clearReplayCache()
  const f = engine(['brep.push'])
  const back = await replayHistory(f.call, { history: history(box, step('pull-1', { op: 'face.push', at: [1, 1, 0], normal: [0, 0, 1], distanceMm: 2 })), exact: true })
  expect(back.exactFellBack).toEqual(['pull-1'])
  expect(f.ops().slice(2, 4)).toEqual(['brep.push', 'face.push'])
})

it('makes a hole another size on the kernel, in the part frame, and runs it on the mesh when the kernel refuses it', async () => {
  // the part moved 5 along x since the box: the hole goes to the kernel in the part's own coordinates
  const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
  const params = { op: 'hole.apply', hole: { entry: [5, 0, 5], axis: [0, 0, 2], diameterMm: 4, depthMm: 5, through: true }, spec: { diameterMm: 3.4, counterbore: { diameterMm: 6.5, depthMm: 3.4 } }, label: 'M3 counterbore' } as StepParams
  const e = engine()
  const r = await replayHistory(e.call, { history: history(box, hole, step('fit-1', params, moved)), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.subtract', 'brep.tessellate', 'brep.hole', 'brep.tessellate'])
  expect(e.sent[4]!.req).toMatchObject({ body: { smb: 'subtract-2' }, hole: { entry: [0, 0, 5], axis: [0, 0, 1], diameterMm: 4, depthMm: 5, through: true }, spec: { diameterMm: 3.4, counterbore: { diameterMm: 6.5, depthMm: 3.4 } }, keySalt: stepSalt('fit-1') })
  // a hole the kernel cannot find or make goes to the mesh, which says why when it is gone
  clearReplayCache()
  const f = engine(['brep.hole'])
  const back = await replayHistory(f.call, { history: history(box, hole, step('fit-1', params)), exact: true })
  expect(back.exactFellBack).toEqual(['fit-1'])
  expect(f.ops().slice(4, 6)).toEqual(['brep.hole', 'hole.apply'])
})

it('sends slots, rounded rectangles and sketches to the kernel as lines and arcs', async () => {
  const slot = step('slot-1', { ...box.params, shape: { type: 'slot', lengthMm: 30, widthMm: 10 } } as StepParams)
  const e = engine()
  await replayHistory(e.call, { history: history(slot), exact: true })
  expect(e.sent[0]!.req['polygons']).toEqual([
    { outer: { start: [-10, -5], segments: [{ to: [10, -5] }, { to: [10, 5], center: [10, 0], sweepDeg: 180 }, { to: [-10, 5] }, { to: [-10, -5], center: [-10, 0], sweepDeg: 180 }] }, holes: [] },
  ])
  // a sketch's loops come nested and exact from the engine, then are placed in the frame
  const loops = [{ start: [0, 0], segments: [{ type: 'line', to: [4, 0] }, { type: 'arc', to: [0, 0], through: [2, 2] }] }]
  const sketched = step('sketch-1', { ...box.params, shape: { type: 'sketch', loops }, placement: { center: [1, 2] } } as StepParams)
  const profile = { outer: { start: [0, 0], segments: [{ to: [4, 0] }, { to: [0, 0], center: [2, 0], sweepDeg: 180 }] }, holes: [{ center: [2, 0.5], diameterMm: 1 }] }
  const f = engine()
  const withProfiles = async (op: string, req: unknown) => (op === 'sketch.curves' ? [profile] : f.call(op, req))
  await replayHistory(withProfiles, { history: history(sketched), exact: true })
  expect(f.ops()).toEqual(['brep.extrude', 'brep.tessellate'])
  expect(f.sent[0]!.req['polygons']).toEqual([
    { outer: { start: [1, 2], segments: [{ to: [5, 2] }, { to: [1, 2], center: [3, 2], sweepDeg: 180 }] }, holes: [{ center: [3, 2.5], diameterMm: 1 }] },
  ])
  // one the kernel cannot take though its check finds nothing wrong runs on the mesh
  clearReplayCache()
  const g = engine()
  const spline = async (op: string, req: unknown) => {
    if (op === 'sketch.curves') throw new Error('sketch: splines go on the mesh path for now')
    return op === 'sketch.check' ? { issues: [], polygons: [] } : g.call(op, req)
  }
  const r = await replayHistory(spline, { history: history(sketched), exact: true })
  expect(g.ops()).toEqual(['shape.extrude'])
  expect(r.status[0]).toEqual({ state: 'done' })
})

it('says what is wrong with a sketch before saying an exact design does not support it', async () => {
  const CROSS = 'sketch: Loop 2 crosses loop 1 (segment 1 of loop 2 meets segment 2 of loop 1).'
  const SPLINE = 'sketch: splines go on the mesh path for now'
  const square = { points: [[0, 0], [10, 0], [10, 10], [0, 10]] }
  const sketch = (loops: unknown[]) => step('sketch-1', { ...box.params, shape: { type: 'sketch', loops } } as StepParams)
  // an engine whose sketch check answers as sx-geom's does: the issues it finds, the first of them the curves' error
  const checked = (why?: string) => {
    const e = engine()
    const call = async (op: string, req: unknown) => {
      if (op === 'sketch.curves' && why) throw new Error(why)
      if (op === 'sketch.curves') return [{ outer: { points: square.points }, holes: [] }]
      if (op === 'sketch.check') return { issues: why === CROSS ? [{ kind: 'loopsCross', message: CROSS.slice('sketch: '.length) }] : [], polygons: [] }
      return e.call(op, req)
    }
    return { call, ops: e.ops }
  }
  const strict = (s: Step): History => ({ ...history(s), exact: true })
  // loops that cross: the sketch's own sentence, as the mesh path gives it, in a design that must stay exact or not,
  // and neither the kernel nor the mesh is asked
  const crossing = sketch([square, { type: 'circle', center: [10, 5], diameterMm: 4 }])
  for (const h of [strict(crossing), history(crossing)]) {
    clearReplayCache()
    const x = checked(CROSS)
    const r = await replayHistory(x.call, { history: h, exact: true })
    expect(r.status[0]).toEqual({ state: 'broken', message: CROSS })
    expect(x.ops()).toEqual([])
  }
  // a sketch with nothing wrong goes to the kernel
  clearReplayCache()
  const ok = checked()
  const done = await replayHistory(ok.call, { history: strict(sketch([square])), exact: true })
  expect(done.status[0]).toEqual({ state: 'done' })
  expect(ok.ops()).toEqual(['brep.extrude', 'brep.tessellate'])
  // one with nothing wrong that the kernel cannot take yet is refused as before
  clearReplayCache()
  const no = checked(SPLINE)
  const refused = await replayHistory(no.call, { history: strict(sketch([{ type: 'spline', points: square.points }])), exact: true })
  expect(refused.status[0]).toEqual({ state: 'broken', message: 'Exact replay does not support shape.extrude for this part. The mesh path was not used.' })
  expect(no.ops()).toEqual([])
})

it('intersects a part with several others, as the mesh does, and breaks the step when nothing is left', async () => {
  const body = (id: string, part: number) => ({ ...step(id, box.params), part })
  const meet = step('meet-1', { op: 'boolean', kind: 'intersection', with: [1, 2] })
  const e = engine()
  const r = await replayHistory(e.call, { history: history(body('a', 0), body('b', 1), body('c', 2), meet), exact: true })
  expect(r.status.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done'])
  const bools = e.sent.filter((x) => x.op === 'brep.boolean').map((x) => [x.req['op'], x.req['a'], x.req['b']])
  expect(bools).toEqual([
    ['intersection', { smb: 'extrude-1' }, { smb: 'extrude-2' }],
    ['intersection', { smb: 'boolean-4' }, { smb: 'extrude-3' }],
  ])
  expect(r.parts).toHaveLength(1)
  clearReplayCache()
  const f = engine()
  const empty = async (op: string, req: unknown) => (op === 'brep.boolean' && (req as R)['op'] === 'intersection' ? { body: null } : f.call(op, req))
  const n = await replayHistory(empty, { history: history(body('a', 0), body('b', 1), body('c', 2), meet), exact: true })
  expect(n.status[3]).toEqual({ state: 'broken', message: 'Nothing is left of the part after this step.' })
})

it('starts a part Add shape made as the kernel\'s solid of that shape, while its triangles still fit it', async () => {
  const shape = primitive('box', 20)
  const tagged: History = { version: 1, base: [shape], steps: [hole] }
  const e = engine()
  const r = await replayHistory(e.call, { history: tagged, exact: true })
  expect(r.status.map((x) => x.state)).toEqual(['done'])
  expect(e.ops().slice(0, 3)).toEqual(['brep.primitive', 'brep.tessellate', 'brep.subtract'])
  expect(e.sent[0]!.req).toMatchObject({ type: 'box', sizeMm: [20, 20, 20], frame: { origin: [0, 0, 0], u: [1, 0, 0], normal: [0, 0, 1] } })
  expect(e.sent[2]!.req['body']).toEqual({ smb: 'primitive-1' })
  // untagged, edited since, or a sphere, it stays on the mesh
  const { primitive: _tag, ...untagged } = shape
  for (const base of [untagged, primitive('sphere', 20), { ...shape, positions: Float32Array.from(shape.positions, (x, i) => (i === 0 ? x + 0.01 : x)) }]) {
    clearReplayCache()
    const f = engine()
    await replayHistory(f.call, { history: { ...tagged, base: [base] }, exact: true })
    expect(f.ops()).toEqual(['subtract'])
  }
})

/** A kernel that keeps bodies by number, each with the face keys its op gave it, and records what it frees. */
function keeper() {
  const sent: Sent[] = []
  const bodies = new Map<number, number[]>()
  const freed: number[] = []
  let n = 0
  const make = (keys: number[]) => {
    bodies.set(++n, keys)
    return n
  }
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    const of = (v: unknown) => (typeof v === 'number' ? bodies.get(v)! : [])
    if (op === 'brep.free') {
      freed.push(req['body'] as number)
      return { freed: true }
    }
    sent.push({ op, req })
    if (op === 'brep.tessellate') {
      const keys = of(req['body'])
      return { ...tri, faceIds: [0], faces: keys.map((k, id) => ({ id, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: k })) }
    }
    if (op === 'brep.cut') {
      const keys = of(req['body'])
      const [below, above] = [make([...keys, 90]), make([...keys, 91])]
      return { below, above, belowKeys: bodies.get(below), aboveKeys: bodies.get(above) }
    }
    if (op.startsWith('brep.')) {
      const keys = [...of(req['body']), 10 + n]
      const body = make(keys)
      return { body, bodyKeys: keys }
    }
    return { mesh: { ...tri, positions: [1, 0, 0, 10, 0, 0, 0, 10, 0] }, report: {} }
  }
  return { call, sent, freed, ops: () => sent.map((s) => s.op) }
}

const fillet2 = step('fillet-2', { op: 'edge.fillet', edges: [{ a: [10, -5, 0], b: [10, -5, 5], face: [1, 0, 0] }], radiusMm: 1 })

it('with kept bodies, passes them by number and tessellates once, for the result', async () => {
  const e = keeper()
  const r = await replayHistory(e.call, { history: history(box, hole, fillet2), exact: true }, { keepsBodies: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(e.ops()).toEqual(['brep.extrude', 'brep.subtract', 'brep.fillet', 'brep.tessellate'])
  // no text either way
  expect(e.sent.every((s) => s.req['save'] === undefined)).toBe(true)
  expect(e.sent.slice(0, 3).every((s) => s.req['withKeys'] === true)).toBe(true)
  expect(e.sent[1]!.req['body']).toBe(1)
  expect(e.sent[2]!.req['body']).toBe(2)
  expect(e.sent[3]!.req['body']).toBe(3)
  // which step made each face, from the keys each op gave back
  expect(r.madeBy).toEqual({ 10: 'box-1', 11: 'hole-1', 12: 'fillet-2' })
  expect(r.parts[0]!.faces?.keys).toEqual([10, 11, 12])
  expect(r.parts.some((p) => 'body' in p || 'smb' in p || 'unmeshed' in p)).toBe(false)
  // every body is held by a cached step, so none is freed
  expect(e.freed).toEqual([])
})

it('with kept bodies, a step on the mesh gets the mesh first, and a warm replay starts from a kept body', async () => {
  const e = keeper()
  const shell = step('shell-1', { op: 'shell', open: [], wallMm: 1 } as StepParams)
  await replayHistory(e.call, { history: history(box, hole), exact: true }, { keepsBodies: true })
  expect(e.ops()).toEqual(['brep.extrude', 'brep.subtract', 'brep.tessellate'])
  const r = await replayHistory(e.call, { history: history(box, hole, shell), exact: true }, { keepsBodies: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  // the warm start has the hole's body, tessellated for the shell, which runs on the mesh
  expect(e.ops().slice(3)).toEqual(['brep.tessellate', 'shell'])
  expect(e.sent[3]!.req['body']).toBe(2)
})

it('with kept bodies, frees the ones no cached step holds', async () => {
  const e = keeper()
  await replayHistory(e.call, { history: history(box, hole), exact: true }, { keepsBodies: true })
  // (that replay also freed what earlier tests left in the cache)
  e.freed.length = 0
  clearReplayCache()
  // a plane that misses: the kernel drops the empty side itself, and the other is not kept
  const missing = async (op: string, req: unknown) => {
    if (op !== 'brep.cut') return e.call(op, req)
    const r = (await e.call(op, req)) as Record<string, unknown>
    return { ...r, above: null }
  }
  const r = await replayHistory(missing, { history: history(box, cut), exact: true }, { keepsBodies: true })
  expect(r.status[1]).toEqual({ state: 'broken', message: 'The plane no longer crosses the part.' })
  // the first replay's two bodies (the cache was cleared) and the cut's side
  expect(e.freed.sort((a, b) => a - b)).toEqual([1, 2, 4])
})

it('repeats a hole along a row on the kernel as one subtract of every copy\'s cutter, with the pattern\'s own face keys', async () => {
  const e = engine()
  const row = step('row-1', { op: 'pattern', steps: ['hole-1'], spec: { kind: 'linear', count: 3, step: [6, 0, 0] } })
  const r = await replayHistory(e.call, { history: history(box, hole, row), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(r.exactFellBack).toBeUndefined()
  const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
  // the hole itself, then both copies at once
  expect(subtracts).toHaveLength(2)
  expect(subtracts.map((s) => s.req['frame'])).toEqual([0, 0].map((x) => ({ origin: [x, 0, 0], u: [1, 0, 0], normal: [0, 0, 1] })))
  // the copies' cylinders, each 6 mm further along than the one before
  expect((subtracts[1]!.req['solids'] as { origin: number[] }[]).map((c) => c.origin)).toEqual([[6, 0, 0], [12, 0, 0]])
  expect(subtracts.map((s) => s.req['keySalt'])).toEqual([stepSalt('hole-1'), stepSalt('row-1')])
})

it('mirrors a hole on the kernel: a cylinder mirrored is the same cylinder at its mirror place', async () => {
  const e = engine()
  const both = step('both-1', { op: 'pattern', steps: ['hole-1'], spec: { kind: 'mirror', plane: { point: [5, 0, 0], normal: [1, 0, 0] } } })
  const r = await replayHistory(e.call, { history: history(box, hole, both), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(e.sent.filter((s) => s.op === 'subtract')).toHaveLength(0)
  const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
  expect(subtracts).toHaveLength(2)
  // reflected through x = 5
  expect(subtracts[1]!.req['solids']).toMatchObject([{ type: 'cylinder', origin: [10, 0, 0], diameterMm: 4, heightMm: 5 }])
})

// a slot as a box, and a mirror of it through x = 5
const boxHole = step('hole-1', { op: 'subtract', solids: [{ type: 'box', min: [-1, -1, 0], max: [1, 1, 5] }], label: 'Slot' } as StepParams)
const mirrorAt = (normal: [number, number, number]) => step('both-1', { op: 'pattern', steps: ['hole-1'], spec: { kind: 'mirror', plane: { point: [5, 0, 0], normal } } })

it('mirrors a box cutter on the kernel as the same box at its mirror place, in a design that must stay exact too', async () => {
  for (const strict of [false, true]) {
    clearReplayCache()
    const e = engine()
    const r = await replayHistory(e.call, { history: { ...history(box, boxHole, mirrorAt([1, 0, 0])), ...(strict ? { exact: true } : {}) }, exact: true })
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(r.status[2]).not.toHaveProperty('note')
    expect(r.exactFellBack).toBeUndefined()
    // nothing on the mesh: the slot, then its mirror image reflected through x = 5, its two ends on x traded
    expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
    const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
    expect(subtracts.map((s) => s.req['solids'])).toEqual([[{ type: 'box', min: [-1, -1, 0], max: [1, 1, 5] }], [{ type: 'box', min: [9, -1, 0], max: [11, 1, 5] }]])
    expect(subtracts[1]!.req['keySalt']).toBe(stepSalt('both-1'))
  }
})

it('turns a box cutter half way round on the kernel, as the same box at its turned place, in a design that must stay exact too', async () => {
  const pair = step('pair-1', { op: 'pattern', steps: ['hole-1'], spec: { kind: 'circular', count: 2, center: [5, 0, 0] } })
  for (const strict of [false, true]) {
    clearReplayCache()
    const e = engine()
    const r = await replayHistory(e.call, { history: { ...history(box, boxHole, pair), ...(strict ? { exact: true } : {}) }, exact: true })
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(r.status[2]).not.toHaveProperty('note')
    expect(r.exactFellBack).toBeUndefined()
    expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
    // the second copy, turned 180 degrees about z through x = 5: both ends on x and on y traded, z as it was
    const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
    expect(subtracts).toHaveLength(2)
    const [turned] = subtracts[1]!.req['solids'] as { type: string; min: number[]; max: number[] }[]
    expect(turned!.type).toBe('box')
    ;[...turned!.min, ...turned!.max].forEach((v, i) => expect(v).toBeCloseTo([9, -1, 0, 11, 1, 5][i]!, 9))
  }
})

it('mirrors a box cutter through a slanted plane on the mesh, where the mirrored box would no longer sit square', async () => {
  const e = engine()
  const r = await replayHistory(e.call, { history: history(box, boxHole, mirrorAt([1, 1, 0])), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  const mesh = e.sent.filter((s) => s.op === 'subtract')
  expect(mesh).toHaveLength(1)
  expect(e.ops().filter((o) => o === 'brep.subtract')).toHaveLength(1)
  // reflected through x + y = 5, as a column-major transform the engine applies to the part
  const t = (mesh[0]!.req['mesh'] as { transform: number[] }).transform
  expect(t).toHaveLength(16)
  ;[0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 5, 0, 1].forEach((v, i) => expect(t[i]).toBeCloseTo(v, 9))
})

// a window cut 1 mm into the side at y -10 of a 40 x 20 x 10 mm block, its center 1 mm up the side, a row of three
// 6 mm apart, and both mirrored to the side at y 10 in one step
const block = step('block-1', { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, spec: { distanceMm: 10, operation: 'new' } })
const sideWindow = (op: 'cut' | 'join') => step('window-1', { op: 'shape.extrude', frame: { origin: [-10, -10, 5], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, shape: { type: 'rectangle', widthMm: 2, heightMm: 1 }, placement: { center: [0, 1] }, spec: { distanceMm: 1, operation: op } })
const windowRow = step('row-1', { op: 'pattern', steps: ['window-1'], spec: { kind: 'linear', count: 3, step: [6, 0, 0] } })
const mirrorBoth = step('both-1', { op: 'pattern', steps: ['window-1', 'row-1'], spec: { kind: 'mirror', plane: { point: [0, 0, 0], normal: [0, 1, 0] } } })
/** The stand-in engine, with the kernel saying each join or cut reached the part and the mesh path that it touched it. */
function touching() {
  const e = engine()
  const call = async (op: string, request: unknown) => {
    const r = (await e.call(op, request)) as R
    return op === 'brep.extrude' ? { ...r, touches: true } : op === 'shape.extrude' ? { ...r, report: { touches: true } } : r
  }
  return { ...e, call }
}

it('mirrors a window and its row on the kernel, the mirror image cut as its outline flipped in the mirrored frame, each window once', async () => {
  const e = touching()
  const r = await replayHistory(e.call, { history: history(block, sideWindow('cut'), windowRow, mirrorBoth), exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
  expect(r.exactFellBack).toBeUndefined()
  // nothing on the mesh: the block, the window, its row in one call, then the mirrored window and its mirrored row
  expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
  // as sent, a mirror's -0 read as 0
  const extrudes = e.sent.filter((s) => s.op === 'brep.extrude').map((s) => JSON.parse(JSON.stringify(s.req)) as R)
  expect(extrudes).toHaveLength(5)
  const [, window, row, mirrored, mirroredRow] = extrudes
  expect(window!['frame']).toEqual({ origin: [-10, -10, 5], u: [1, 0, 0], normal: [0, -1, 0] })
  expect(window!['polygons']).toEqual([{ outer: { points: [[-1, 0.5], [1, 0.5], [1, 1.5], [-1, 1.5]] }, holes: [] }])
  expect((row!['polygons'] as unknown[]).length).toBe(2)
  // reflected through y = 0: the frame faces +y, so its v (normal x u) runs down the side, and the window's center,
  // 1 mm up, is at v -1, still counterclockwise in the frame
  expect(mirrored!['frame']).toEqual({ origin: [-10, 10, 5], u: [1, 0, 0], normal: [0, 1, 0] })
  expect(mirrored!['polygons']).toEqual([{ outer: { points: [[-1, -1.5], [1, -1.5], [1, -0.5], [-1, -0.5]] }, holes: [] }])
  expect([mirrored!['fromMm'], mirrored!['toMm']]).toEqual([window!['fromMm'], window!['toMm']])
  // the mirrored row's two copies, 6 and 12 mm along, in one call
  expect(mirroredRow!['frame']).toEqual(mirrored!['frame'])
  expect((mirroredRow!['polygons'] as { outer: { points: number[][] } }[]).map((q) => q.outer.points[0])).toEqual([[5, -1.5], [11, -1.5]])
})

it('mirrors a boss and its row on the mesh with each boss joined once, never a second time inside the first', async () => {
  const e = touching()
  const r = await replayHistory(e.call, { history: history(block, sideWindow('join'), windowRow, mirrorBoth) })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
  // the block, the boss, its two copies, then the mirrored boss and its mirrored two
  expect(e.ops().filter((o) => o === 'shape.extrude')).toHaveLength(7)
})

// the block's 12 triangles, each face wound outward: the surface a row along its side follows
const blockMesh = {
  positions: [-20, -10, 0, 20, -10, 0, 20, 10, 0, -20, 10, 0, -20, -10, 10, 20, -10, 10, 20, 10, 10, -20, 10, 10],
  indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7],
}

it('with kept bodies, a row along the side follows the side read from the solid, each copy cut on the kernel', async () => {
  const sent: string[] = []
  let n = 0
  // a kernel that keeps its bodies: each answer is a body number with no triangles until it is tessellated
  const call = async (op: string, request: unknown) => {
    if (op === EXACT_OPS) return { ops: [] }
    sent.push(op)
    if (op === 'brep.tessellate') return { ...blockMesh, faceIds: Array.from({ length: 12 }, () => 0), faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.free' || op === 'brep.count') return {}
    if (op.startsWith('brep.')) return { body: ++n, bodyKeys: [10 + n], ...((request as R)['target'] !== undefined ? { touches: true } : {}) }
    throw new Error(`the mesh path ran ${op}`)
  }
  const along = step('row-1', { op: 'pattern', steps: ['window-1'], spec: { kind: 'linear', count: 3, step: [6, 0, 0], onSurface: true } })
  const r = await replayHistory(call, { history: history(block, sideWindow('cut'), along), exact: true }, { keepsBodies: true })
  expect(r.status[2]).toEqual({ state: 'done', copies: { total: 3, kept: 3, missed: [] } })
  // the block and the window, the solid tessellated for the row to read its side, then each copy on its own
  expect(sent.slice(0, 5)).toEqual(['brep.extrude', 'brep.extrude', 'brep.tessellate', 'brep.extrude', 'brep.extrude'])
})

it('breaks a pattern whose steps are gone or cannot be repeated, in words', async () => {
  const gone = await replayHistory(engine().call, { history: history(box, hole, step('row-1', { op: 'pattern', steps: ['nope'], spec: { kind: 'linear', count: 2, step: [6, 0, 0] } })) })
  expect(gone.status[2]).toEqual({ state: 'broken', message: 'A step this pattern repeats is gone or comes after it; pick the steps again.' })
  clearReplayCache()
  const body = await replayHistory(engine().call, { history: history(box, hole, step('row-1', { op: 'pattern', steps: ['box-1'], spec: { kind: 'linear', count: 2, step: [6, 0, 0] } })) })
  expect(body.status[2]?.message).toMatch(/makes a new body/)
  clearReplayCache()
  const off = await replayHistory(engine().call, { history: history(box, { ...hole, suppressed: true }, step('row-1', { op: 'pattern', steps: ['hole-1'], spec: { kind: 'linear', count: 2, step: [6, 0, 0] } })) })
  expect(off.status[2]).toEqual({ state: 'done', note: 'The steps this pattern repeats are turned off, so it repeats nothing.' })
})

// a cut on every part (part -1), as geom.subtract with no part stores it, on two exact bodies
const onPart = (id: string, part: number) => ({ ...step(id, box.params), part })
const holeAll: Step = { ...step('hole-all', hole.params), part: -1 }
/** The stand-in engine, with the kernel saying its cutters all missed the bodies named in `miss`. */
function missing(miss: string[]) {
  const e = engine()
  const call = async (op: string, request: unknown) => {
    const r = (await e.call(op, request)) as R
    const b = (request as R)['body'] as { smb?: string } | undefined
    return op === 'brep.subtract' && b?.smb && miss.includes(b.smb) ? { ...r, missed: [0] } : r
  }
  return { ...e, call }
}

it('cuts every part on the kernel for a step on every part, with the same cutters and frame, in a design that must stay exact too', async () => {
  for (const strict of [false, true]) {
    clearReplayCache()
    const e = engine()
    const r = await replayHistory(e.call, { history: { ...history(onPart('a', 0), onPart('b', 1), holeAll), ...(strict ? { exact: true } : {}) }, exact: true })
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    // nothing on the mesh: one subtract for each part's solid
    expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
    const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
    expect(subtracts.map((s) => s.req['body'])).toEqual([{ smb: 'extrude-1' }, { smb: 'extrude-2' }])
    expect(subtracts.map((s) => s.req['solids'])).toEqual([hole.params, hole.params].map((p) => (p as { solids: unknown }).solids))
    expect(subtracts.map((s) => s.req['frame'])).toEqual([0, 0].map(() => ({ origin: [0, 0, 0], u: [1, 0, 0], normal: [0, 0, 1] })))
    expect(subtracts.map((s) => s.req['keySalt'])).toEqual([stepSalt('hole-all'), stepSalt('hole-all')])
  }
})

it('keeps a part the cutters all miss as it is on a step on every part, and breaks the step when they miss every part', async () => {
  const cutB = { ...cut, id: 'cut-b', part: 1 }
  const e = missing(['extrude-2'])
  const r = await replayHistory(e.call, { history: { ...history(onPart('a', 0), onPart('b', 1), holeAll, cutB), exact: true }, exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
  // the kernel answers a miss with an unchanged copy and every cutter in `missed`: the part keeps the body it had
  expect(e.sent.filter((s) => s.op === 'brep.cut').map((s) => s.req['body'])).toEqual([{ smb: 'extrude-2' }])
  clearReplayCache()
  const all = missing(['extrude-1', 'extrude-2'])
  const none = await replayHistory(all.call, { history: { ...history(onPart('a', 0), onPart('b', 1), holeAll), exact: true }, exact: true })
  expect(none.status[2]).toEqual({ state: 'broken', message: 'The shape no longer reaches the part.' })
})

it('with kept bodies, a part the cutters all miss keeps its body by number, and the unchanged copy is freed', async () => {
  const e = keeper()
  const call = async (op: string, request: unknown) => {
    const r = (await e.call(op, request)) as R
    return op === 'brep.subtract' && (request as R)['body'] === 2 ? { ...r, missed: [0] } : r
  }
  const filletB = { ...fillet2, id: 'fillet-b', part: 1 }
  clearReplayCache()
  e.freed.length = 0
  const r = await replayHistory(call, { history: history(onPart('a', 0), onPart('b', 1), holeAll, filletB), exact: true }, { keepsBodies: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
  expect(e.sent.filter((s) => s.op === 'brep.subtract').map((s) => s.req['body'])).toEqual([1, 2])
  // body 4 is the miss's copy of body 2: the fillet works on body 2, and nothing holds 4
  expect(e.sent.find((s) => s.op === 'brep.fillet')!.req['body']).toBe(2)
  expect(e.freed).toContain(4)
})

it('cuts the exact parts on the kernel and a mesh part beside them on the mesh, for a step on every part', async () => {
  const base: History['base'] = [{ name: 'Imported', slot: 1, ...tri }]
  for (const strict of [false, true]) {
    clearReplayCache()
    const e = engine()
    const r = await replayHistory(e.call, { history: { version: 1, base, steps: [onPart('b', 1), holeAll], ...(strict ? { exact: true } : {}) }, exact: true })
    // the exact part stays exact, and the mesh part was never one: no note either way
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.subtract', 'brep.tessellate', 'subtract'])
    expect(e.sent[2]!.req['body']).toEqual({ smb: 'extrude-1' })
    expect((e.sent[4]!.req['mesh'] as { mesh: unknown }).mesh).toEqual(tri)
    expect(r.meshParts).toEqual([0])
  }
})

// a mesh part beside an exact body, for the patterns of a cut on every part
const meshBase: History['base'] = [{ name: 'Imported', slot: 1, ...tri }]
const meshOps = (ops: string[]) => ({ kernel: ops.filter((o) => o === 'brep.subtract').length, mesh: ops.filter((o) => o === 'subtract').length })

it('repeats a cut on every part along a row in one kernel call per exact part, with the mesh part beside it cut copy by copy', async () => {
  const row: Step = { ...step('row-1', { op: 'pattern', steps: ['hole-all'], spec: { kind: 'linear', count: 3, step: [6, 0, 0] } }), part: -1 }
  const e = engine()
  const r = await replayHistory(e.call, { history: { ...history(onPart('a', 0), onPart('b', 1), holeAll, row), exact: true }, exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
  expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
  const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
  // the cut on each part, then each part with both copies' cylinders at once
  expect(subtracts).toHaveLength(4)
  expect(subtracts.slice(2).map((s) => (s.req['solids'] as { origin: number[] }[]).map((c) => c.origin))).toEqual([[[6, 0, 0], [12, 0, 0]], [[6, 0, 0], [12, 0, 0]]])
  expect(subtracts.slice(2).map((s) => s.req['keySalt'])).toEqual([stepSalt('row-1'), stepSalt('row-1')])
  for (const strict of [false, true]) {
    clearReplayCache()
    const f = engine()
    const mixed = await replayHistory(f.call, { history: { version: 1, base: meshBase, steps: [onPart('b', 1), holeAll, row], ...(strict ? { exact: true } : {}) }, exact: true })
    // the exact part stays exact: the cut and both copies on the kernel, two calls; the mesh part's cut and copies on the mesh
    expect(mixed.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done', copies: { kept: 3, missed: [], total: 3 } }])
    expect(meshOps(f.ops())).toEqual({ kernel: 2, mesh: 3 })
    expect(mixed.meshParts).toEqual([0])
    // each mesh copy moved by its step along the row
    expect(f.sent.filter((s) => s.op === 'subtract').map((s) => (s.req['mesh'] as { transform: number[] }).transform[12])).toEqual([0, -6, -12])
  }
})

it('leaves out a copy of a row of cuts on every part only when it misses every part, on the kernel and on the mesh', async () => {
  const row: Step = { ...step('row-1', { op: 'pattern', steps: ['hole-all'], spec: { kind: 'linear', count: 3, step: [6, 0, 0] } }), part: -1 }
  // the kernel says the row's copy 3 (its second cutter) missed the exact part; `meshMiss` has the mesh miss copy 3 too
  const run = async (meshMiss: boolean) => {
    clearReplayCache()
    const e = engine()
    const call = async (op: string, request: unknown) => {
      const req = request as R
      const r = (await e.call(op, request)) as R
      if (op === 'brep.subtract' && (req['solids'] as unknown[]).length === 2) return { ...r, missed: [1] }
      if (op === 'subtract' && meshMiss && (req['mesh'] as { transform: number[] }).transform[12] === -12) return { ...r, removedVolumeMm3: 0 }
      return r
    }
    return replayHistory(call, { history: { version: 1, base: meshBase, steps: [onPart('b', 1), holeAll, row] }, exact: true })
  }
  expect((await run(false)).status[2]).toEqual({ state: 'done', copies: { kept: 3, missed: [], total: 3 } })
  expect((await run(true)).status[2]).toMatchObject({ state: 'done', note: 'Copy 3 did not reach the part and was left out.', copies: { missed: [3], total: 3 } })
})

it('mirrors a cut on every part in one kernel call per exact part, with the mesh part beside it cut on the mesh', async () => {
  const both: Step = { ...step('both-1', { op: 'pattern', steps: ['hole-all'], spec: { kind: 'mirror', plane: { point: [5, 0, 0], normal: [1, 0, 0] } } }), part: -1 }
  const e = engine()
  const r = await replayHistory(e.call, { history: { ...history(onPart('a', 0), onPart('b', 1), holeAll, both), exact: true }, exact: true })
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
  expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
  const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
  // the cut on each part, then each part with the mirrored cylinder, reflected through x = 5
  expect(subtracts).toHaveLength(4)
  expect(subtracts.slice(2).map((s) => s.req['solids'])).toMatchObject([0, 1].map(() => [{ type: 'cylinder', origin: [10, 0, 0], diameterMm: 4, heightMm: 5 }]))
  expect(subtracts.slice(2).map((s) => s.req['keySalt'])).toEqual([stepSalt('both-1'), stepSalt('both-1')])
  for (const strict of [false, true]) {
    clearReplayCache()
    const f = engine()
    const mixed = await replayHistory(f.call, { history: { version: 1, base: meshBase, steps: [onPart('b', 1), holeAll, both], ...(strict ? { exact: true } : {}) }, exact: true })
    // the exact part stays exact, with no note: the mirrored cylinder goes to the kernel, and the mesh part's mirror image
    // is cut on the mesh, reflected through x = 5 as the engine applies it to the part
    expect(mixed.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done', copies: { kept: 2, missed: [], total: 2 } }])
    expect(meshOps(f.ops())).toEqual({ kernel: 2, mesh: 2 })
    expect(f.sent.filter((s) => s.op === 'brep.subtract')[1]!.req['solids']).toMatchObject([{ type: 'cylinder', origin: [10, 0, 0] }])
    expect(f.sent.filter((s) => s.op === 'subtract')[1]!.req['mesh']).toMatchObject({ transform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1] })
    expect(mixed.meshParts).toEqual([0])
  }
})

it('mirrors a box cutter on every part in one kernel call per exact part, in a design that must stay exact too', async () => {
  const slotAll: Step = { ...boxHole, id: 'hole-all', part: -1 }
  const both: Step = { ...step('both-1', { op: 'pattern', steps: ['hole-all'], spec: { kind: 'mirror', plane: { point: [0, 2, 0], normal: [0, -1, 0] } } }), part: -1 }
  for (const strict of [false, true]) {
    clearReplayCache()
    const e = engine()
    const r = await replayHistory(e.call, { history: { ...history(onPart('a', 0), onPart('b', 1), slotAll, both), ...(strict ? { exact: true } : {}) }, exact: true })
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(r.exactFellBack).toBeUndefined()
    expect(e.ops().filter((o) => !o.startsWith('brep.'))).toEqual([])
    // the slot on each part, then each part with the slot reflected through y = 2
    const subtracts = e.sent.filter((s) => s.op === 'brep.subtract')
    expect(subtracts.slice(2).map((s) => [s.req['body'], s.req['solids']])).toEqual([3, 4].map((n) => [{ smb: `subtract-${n}` }, [{ type: 'box', min: [-1, 3, 0], max: [1, 5, 5] }]]))
  }
})
