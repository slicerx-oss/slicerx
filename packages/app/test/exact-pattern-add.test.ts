// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A pattern of a cut on an exact solid, and parts added as shapes in a design that must stay exact, against an engine
// that answers as the kernel's older operations will once they take a body the engine holds (a held number in any
// body field, a held number back with its faces' keys, every held body tessellated with normals, face ids and keys).
// The sizes are a toy ship's: a row of 55 portholes 1.6 mm apart along a hull side, boxes for deck houses.
// - A row made by a pattern of one cut is one kernel call with every copy's cutter, not one call per copy.
// - A pattern that turns or mirrors its copies runs copy by copy, as before.
// - The copies the kernel says missed are left out and named; a row that reaches nothing breaks the pattern.
// - In a design that must stay exact, boxes and cylinders added as shapes are each their own solid; a mesh is added
//   beside them as a mesh part.
import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY, clearReplayCache, EXACT_OPS, NO_COPY_LANDS, replayHistory, stepSalt, type History, type HistoryMesh, type Step, type StepParams } from '@slicerx/cad-history'
import type { PrimitiveSpec } from '@slicerx/contracts'

type Vec3 = [number, number, number]
type Vec2 = [number, number]
interface Sent {
  op: string
  req: Record<string, unknown>
}

const FIRST = 2 ** 31
const kept = { keepsBodies: true }

/**
 * An engine whose kernel holds every body by number; `reaches` false makes a join or cut of more than one outline miss.
 * With `missed`, a call with more than one outline or cutter says which of them (from 0) left no face, as the kernel's
 * reply does; without it the reply says nothing of them, as an engine from before that.
 */
function engine(reaches = true, missed?: number[]) {
  const sent: Sent[] = []
  const held = new Map<number, number[]>()
  let n = 0
  const hold = (keys: number[]) => {
    const body = FIRST + n++
    held.set(body, keys)
    return { body, bodyKeys: keys }
  }
  const keysOf = (b: unknown): number[] => {
    if (typeof b !== 'number' || b < FIRST) throw new Error('brep: body: a held body number is expected')
    const k = held.get(b)
    if (!k) throw new Error('brep: body: no such body (freed, or from an earlier session)')
    return k
  }
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    sent.push({ op, req })
    const salt = req['keySalt'] as number
    switch (op) {
      case EXACT_OPS:
        return { ops: ['sketch.loft'] }
      case 'sketch.loft':
        return { mesh: { positions: [], indices: [] }, report: { watertight: true }, ...hold([salt + 1, salt + 2, salt + 3]) }
      case 'brep.primitive':
        return hold([salt + 11, salt + 12])
      case 'brep.subtract':
        return { ...hold([...keysOf(req['body']), ...(req['solids'] as unknown[]).map((_, i) => salt + 100 + i)]), ...(missed && (req['solids'] as unknown[]).length > 1 ? { missed } : {}) }
      case 'brep.extrude': {
        // a cut makes one new face per outline it cuts
        if (req['target'] === undefined) return hold([salt + 21])
        if (!reaches && (req['polygons'] as unknown[]).length > 1) return { touches: false, body: null }
        return { touches: true, ...hold([...keysOf(req['target']), ...(req['polygons'] as unknown[]).map((_, i) => salt + 200 + i)]), ...(missed && (req['polygons'] as unknown[]).length > 1 ? { missed } : {}) }
      }
      case 'brep.tessellate': {
        const keys = keysOf(req['body'])
        const t = keys.length
        const positions = new Float32Array(t * 9)
        for (let k = 0; k < t; k++) positions.set([10 * k, 0, 0, 10 * k + 5, 0, 0, 10 * k, 5, 0], 9 * k)
        return { meshForm: 2, positions, indices: Uint32Array.from({ length: t * 3 }, (_, i) => i), faceIds: Uint32Array.from({ length: t }, (_, i) => i), normals: new Int16Array(t * 6), faces: { table: keys.map(() => ({ kind: 'plane' })), keys }, surfaces: [], edges: [] }
      }
      case 'brep.free':
        return { freed: held.delete(req['body'] as number) }
    }
    if (op.startsWith('brep.')) throw new Error(`brep: ${op} is not in this engine`)
    return { mesh: req['mesh'] }
  }
  return { call, sent, of: (op: string) => sent.filter((s) => s.op === op), ops: () => sent.map((s) => s.op) }
}

const frame = (z: number) => ({ origin: [0, 0, z] as Vec3, normal: [0, 0, 1] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 })
const hullLoft = (): Step => ({ id: 'hull', part: 0, transform: [...IDENTITY], params: { op: 'sketch.loft', profiles: [{ frame: frame(0), loops: [] }, { frame: frame(9), loops: [] }], operation: 'new', name: 'Hull' } as StepParams })
const step = (id: string, part: number, params: StepParams): Step => ({ id, part, transform: [...IDENTITY], params })
const history = (steps: Step[], exact?: boolean): History => ({ version: 1, base: [], steps, ...(exact ? { exact: true } : {}) })

// the port side, looking out of the ship: u along it, v up
const side = { origin: [0, -8.55, 0] as Vec3, normal: [0, -1, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 0, 1] as Vec3 }
/** One porthole cut 0.35 mm into the side at x 24, z 5. */
const porthole = step('port', 0, { op: 'shape.extrude', frame: side, shape: { type: 'circle', diameterMm: 0.55 }, placement: { center: [24, 5] }, spec: { distanceMm: 0.35, operation: 'cut' } })
const row = (count: number, stepMm: Vec3 = [1.6, 0, 0]): Step => step('row', 0, { op: 'pattern', steps: ['port'], spec: { kind: 'linear', count, step: stepMm } })

/** A box or cylinder as Add shape makes it: its frame's origin at the middle of its foot. */
function boxPart(name: string, size: Vec3, at: Vec3): HistoryMesh {
  const [w, d, h] = size
  const positions: number[] = []
  for (const z of [0, h]) for (const [x, y] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as const) positions.push(at[0] + x, at[1] + y, at[2] + z)
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  const primitive: PrimitiveSpec = { type: 'box', sizeMm: size, frame: { origin: at, u: [1, 0, 0], normal: [0, 0, 1] } }
  return { name, slot: 1, positions, indices, primitive }
}
const add = (id: string, ...parts: HistoryMesh[]): Step => ({ id, part: -1, transform: [...IDENTITY], params: { op: 'parts.add', parts, label: 'Add' } })

function exactPart(p: HistoryMesh | undefined) {
  expect(p?.normals).toBeInstanceOf(Int16Array)
  expect(p!.normals).toHaveLength(p!.indices.length * 2)
}

beforeEach(async () => {
  clearReplayCache()
  await replayHistory(engine().call, { history: history([]), exact: true }, kept)
})

describe('a pattern of one cut on an exact solid', () => {
  it('cuts a row of 55 portholes in one kernel call with every copy\'s outline, and the hull keeps its normals', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history([hullLoft(), porthole, row(55)]), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done', copies: { total: 55, kept: 55, missed: [] } }])
    expect(r.exactFellBack).toBeUndefined()
    // the first porthole, then the 54 copies at once
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'brep.extrude', 'brep.extrude', 'brep.tessellate'])
    const copies = e.of('brep.extrude')[1]!.req
    expect(copies['target']).toBe(FIRST + 1)
    expect(copies['operation']).toBe('cut')
    expect(copies['keySalt']).toBe(stepSalt('row'))
    const outlines = copies['polygons'] as { outer: { center: Vec2; diameterMm: number } }[]
    expect(outlines).toHaveLength(54)
    // shifted 1.6 mm a copy along the side, at the same height, the same size
    outlines.forEach((o, k) => {
      expect(o.outer.center[0]).toBeCloseTo(24 + 1.6 * (k + 1), 9)
      expect(o.outer.center[1]).toBeCloseTo(5, 9)
      expect(o.outer.diameterMm).toBe(0.55)
    })
    // the cut goes as deep as the first one did
    const first = e.of('brep.extrude')[0]!.req
    expect([copies['fromMm'], copies['toMm']]).toEqual([first['fromMm'], first['toMm']])
    exactPart(r.parts[0])
    expect(r.parts[0]!.faces!.keys).toHaveLength(3 + 1 + 54)
  })

  it('repeats a subtract of cylinders as one subtract of every copy\'s cylinders', async () => {
    const e = engine()
    const cyl = { type: 'cylinder' as const, origin: [24, -20, 5] as Vec3, axis: [0, 1, 0] as Vec3, diameterMm: 0.55, heightMm: 40 }
    const cut = step('port', 0, { op: 'subtract', solids: [cyl], label: 'Porthole' })
    const r = await replayHistory(e.call, { history: history([hullLoft(), cut, row(22)]), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'brep.subtract', 'brep.subtract', 'brep.tessellate'])
    const moved = e.of('brep.subtract')[1]!.req['solids'] as { origin: Vec3; axis: Vec3 }[]
    expect(moved).toHaveLength(21)
    moved.forEach((c, k) => {
      ;[24 + 1.6 * (k + 1), -20, 5].forEach((v, a) => expect(c.origin[a]).toBeCloseTo(v, 9))
      expect(c.axis).toEqual([0, 1, 0])
    })
    exactPart(r.parts[0])
  })

  it('runs copy by copy when the copies turn (around an axis) or leave the cut\'s plane', async () => {
    const e = engine()
    const around = step('row', 0, { op: 'pattern', steps: ['port'], spec: { kind: 'circular', count: 4, center: [60, 0, 0], axis: [0, 0, 1] } })
    const r = await replayHistory(e.call, { history: history([hullLoft(), porthole, around]), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(e.of('brep.extrude')).toHaveLength(4)
    clearReplayCache()
    const off = engine()
    // a step out of the side's plane (along its normal) cannot share one outline plane
    const r2 = await replayHistory(off.call, { history: history([hullLoft(), porthole, row(3, [1.6, -0.2, 0])]), exact: true }, kept)
    expect(r2.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(off.of('brep.extrude')).toHaveLength(3)
  })

  it('breaks with a plain sentence when the row of copies reaches nothing', async () => {
    const e = engine(false)
    const r = await replayHistory(e.call, { history: history([hullLoft(), porthole, row(5)]), exact: true }, kept)
    expect(r.status[1]).toEqual({ state: 'done' })
    expect(r.status[2]).toEqual({ state: 'broken', message: NO_COPY_LANDS })
  })

  it('keeps the copies the kernel says landed, names the ones it says missed, and stays one exact call', async () => {
    // outlines 1 and 3 of the copies' call are copies 3 and 5: a row past the narrower stations of a curved hull
    const e = engine(true, [1, 3])
    const r = await replayHistory(e.call, { history: history([hullLoft(), porthole, row(6)]), exact: true }, kept)
    expect(r.status[2]).toEqual({ state: 'done', note: 'Copies 3 and 5 did not reach the part and were left out.', copies: { total: 6, kept: 4, missed: [3, 5] } })
    expect(r.exactFellBack).toBeUndefined()
    expect(e.of('brep.extrude')).toHaveLength(2)
    exactPart(r.parts[0])
  })

  it('names the copies a subtract of every copy\'s cylinders missed', async () => {
    const cyl = { type: 'cylinder' as const, origin: [24, -20, 5] as Vec3, axis: [0, 1, 0] as Vec3, diameterMm: 0.55, heightMm: 40 }
    const cut = step('port', 0, { op: 'subtract', solids: [cyl], label: 'Porthole' })
    const e = engine(true, [0])
    const r = await replayHistory(e.call, { history: history([hullLoft(), cut, row(4)]), exact: true }, kept)
    expect(r.status[2]).toEqual({ state: 'done', note: 'Copy 2 did not reach the part and was left out.', copies: { total: 4, kept: 3, missed: [2] } })
    expect(e.of('brep.subtract')).toHaveLength(2)
  })

  it('breaks when the kernel says every copy missed, and adds no note when it says none did', async () => {
    const all = engine(true, [0, 1, 2])
    const r = await replayHistory(all.call, { history: history([hullLoft(), porthole, row(4)]), exact: true }, kept)
    expect(r.status[2]).toEqual({ state: 'broken', message: NO_COPY_LANDS })
    clearReplayCache()
    const none = engine(true, [])
    const r2 = await replayHistory(none.call, { history: history([hullLoft(), porthole, row(4)]), exact: true }, kept)
    expect(r2.status[2]).toEqual({ state: 'done', copies: { total: 4, kept: 4, missed: [] } })
  })

  it('counts a copy with several cutters as missed only when all of them missed', async () => {
    const cyl = (z: number) => ({ type: 'cylinder' as const, origin: [24, -20, z] as Vec3, axis: [0, 1, 0] as Vec3, diameterMm: 0.55, heightMm: 40 })
    const pair = step('port', 0, { op: 'subtract', solids: [cyl(5), cyl(6)], label: 'Portholes' })
    // copy 2's cutters are 0 and 1, copy 3's are 2 and 3: copy 2 lost both, copy 3 one
    const e = engine(true, [0, 1, 2])
    const r = await replayHistory(e.call, { history: history([hullLoft(), pair, row(3)]), exact: true }, kept)
    expect(r.status[2]).toEqual({ state: 'done', note: 'Copy 2 did not reach the part and was left out.', copies: { total: 3, kept: 2, missed: [2] } })
  })
})

describe('parts added as shapes in a design that must stay exact', () => {
  it('makes each added box its own solid beside the exact hull', async () => {
    const e = engine()
    const houses = [boxPart('Deck house', [4, 3.2, 0.85], [60, 0, 12.8]), boxPart('Aft house', [4.5, 4.8, 0.85], [30, 0, 12.8])]
    const r = await replayHistory(e.call, { history: history([hullLoft(), add('houses', ...houses)], true), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    expect(e.of('brep.primitive').map((s) => s.req['sizeMm'])).toEqual([[4, 3.2, 0.85], [4.5, 4.8, 0.85]])
    expect(r.parts.map((p) => p.name)).toEqual(['Hull', 'Deck house', 'Aft house'])
    r.parts.forEach(exactPart)
  })

  it('adds a mesh part beside them, which has no shape the kernel starts from, and keeps the added boxes exact', async () => {
    const e = engine()
    const davits: HistoryMesh = { name: 'Davits', slot: 1, positions: [0, 0, 10, 2, 0, 10, 0, 0, 12], indices: [0, 1, 2] }
    const house = boxPart('Deck house', [4, 3.2, 0.85], [60, 0, 12.8])
    const r = await replayHistory(e.call, { history: history([hullLoft(), add('deck', house, davits)], true), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    // the house is its own solid, the davits a mesh part
    expect(e.of('brep.primitive').map((s) => s.req['sizeMm'])).toEqual([[4, 3.2, 0.85]])
    expect(r.parts.map((p) => p.name)).toEqual(['Hull', 'Deck house', 'Davits'])
    expect(r.meshParts).toEqual([2])
    r.parts.slice(0, 2).forEach(exactPart)
  })
})
