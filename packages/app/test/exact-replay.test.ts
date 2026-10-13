// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Replays on exact solids (@slicerx/cad-history exact.ts) with a stand-in engine: which steps go to the B-rep kernel,
// what they send it, and how a step falls back to the mesh when the kernel fails. The kernel itself is tested in
// packages/brep (cargo) and brep-module.test.ts.
import { beforeEach, expect, it } from 'vitest'
import { EXACT_FELL_BACK, IDENTITY, PAINT_DROPPED, clearReplayCache, replayHistory, stepSalt, type History, type Step, type StepParams } from '@slicerx/cad-history'

const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }

type Sent = { op: string; req: Record<string, unknown> }

/** An engine whose kernel names each solid after the op that made it, and fails the ops in `failing`. */
function engine(failing: string[] = []) {
  const sent: Sent[] = []
  let n = 0
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
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
  const rounded = step('box-2', { ...box.params, shape: { type: 'rectangle', widthMm: 20, heightMm: 10, cornerRadiusMm: 2 } } as StepParams)
  const scaled = step('hole-2', hole.params, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])
  const e = engine()
  await replayHistory(e.call, { history: history(rounded), exact: true })
  expect(e.ops()).toEqual(['shape.extrude'])
  const f = engine()
  await replayHistory(f.call, { history: history(box, scaled), exact: true })
  expect(f.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'subtract'])
})

it('a plane that misses the solid breaks the step, as on the mesh', async () => {
  const e = engine()
  const missing = async (op: string, req: unknown) => (op === 'brep.cut' ? { below: 1, above: null, belowSmb: 'x' } : e.call(op, req))
  const r = await replayHistory(missing, { history: history(box, cut), exact: true })
  expect(r.status[1]).toEqual({ state: 'broken', message: 'The plane no longer crosses the part.' })
})

it('a painted part loses its paint to a kernel step, with the same note', async () => {
  const e = engine()
  const paintCall = async (op: string, req: unknown) => (op === 'paint.select' ? { changed: { 0: 'ff0000' } } : e.call(op, req))
  const paint = step('paint-1', { op: 'paint', layer: 'color', state: 1, target: { kind: 'part' } } as StepParams)
  const r = await replayHistory(paintCall, { history: history(box, paint, hole), exact: true })
  // paint keeps the solid, so the hole still goes to the kernel
  expect(e.ops()).toEqual(['brep.extrude', 'brep.tessellate', 'brep.subtract', 'brep.tessellate'])
  expect(r.status[2]).toEqual({ state: 'done', note: PAINT_DROPPED })
  expect(r.parts[0]!.paint).toBeUndefined()
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
