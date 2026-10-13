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
  const rounded = step('box-2', { ...box.params, spec: { distanceMm: 5, operation: 'new', taperDeg: 5 } } as StepParams)
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
  expect(m.status[1]).toEqual({ state: 'broken', message: 'The shape no longer reaches the part.' })
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
  // one the engine finds a problem in runs on the mesh, which says what it is
  clearReplayCache()
  const g = engine()
  const broken = async (op: string, req: unknown) => {
    if (op === 'sketch.curves') throw new Error('Loop 1 is open.')
    return g.call(op, req)
  }
  const r = await replayHistory(broken, { history: history(sketched), exact: true })
  expect(g.ops()).toEqual(['shape.extrude'])
  expect(r.status[0]).toEqual({ state: 'done' })
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
