// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exact solids in a history with other parts and mesh steps, against an engine that answers as the kernel's older
// operations will once they take a body the engine holds: a held body number (2^31 and up) in any body field, a held
// number back with its faces' keys, and every held body tessellated with normals, face ids and keys.
// - A mesh step on one part leaves every other part's solid as it was, and does not tessellate it.
// - A part whose solid a mesh step ends says so on the step, in one plain line.
// - Paint keeps the solid and tessellates only the painted part.
// - A face whose key a merge cleared (0) goes by its place; a step saved with that key asks for the face again.
// - An added part that leans keeps the shape it was made as, turned with it, so it still starts as the kernel's solid.
import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY, clearReplayCache, EXACT_OPS, fits, PAINT_DROPPED, replayHistory, EXACT_MESH_FROM_HERE, stepSalt, tiltedParams, type History, type HistoryMesh, type Step, type StepParams } from '@slicerx/cad-history'
import type { PrimitiveSpec } from '@slicerx/contracts'

type Vec3 = [number, number, number]
interface Sent {
  op: string
  req: Record<string, unknown>
}

const FIRST = 2 ** 31
const kept = { keepsBodies: true }

/**
 * An engine whose kernel holds every body by number. The older operations take a held number in any body field and
 * answer with a new one; a union clears the key of the first face of each body it joins (a merged face). Each held
 * body tessellates as one triangle per face, 10 mm apart along X, so a face is found by its place.
 */
function engine() {
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
        // the hull's faces keep their keys; each cylinder's wall is a new face with the step's
        return hold([...keysOf(req['body']), ...(req['solids'] as unknown[]).map((_, i) => salt + 100 + i)])
      case 'brep.boolean': {
        const a = keysOf(req['a'])
        const b = keysOf(req['b'])
        return req['op'] === 'union' ? hold([0, ...a.slice(1), 0, ...b.slice(1)]) : hold([...a])
      }
      case 'brep.push': {
        const keys = keysOf(req['body'])
        const key = req['faceKey'] as number | undefined
        if (key !== undefined && !keys.includes(key)) throw new Error('brep: faceReference: no face has this key')
        return { ...hold(keys), frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, polygons: [], faceKey: key ?? 0, reached: true }
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
      case 'paint.select':
        return { changed: { '0': '2' } }
      case 'array': {
        const m = req['mesh'] as { mesh: { positions: number[]; indices: number[] } }
        return { mesh: { positions: [...m.mesh.positions, ...m.mesh.positions.map((v, i) => (i % 3 === 0 ? v + 30 : v))], indices: [...m.mesh.indices, ...m.mesh.indices.map((i) => i + m.mesh.positions.length / 3)] } }
      }
      case 'boolean':
        return { mesh: (req['a'] as { mesh: unknown }[])[0]!.mesh }
    }
    if (op.startsWith('brep.')) throw new Error(`brep: ${op} is not in this engine`)
    return { mesh: req['mesh'] }
  }
  return { call, sent, held, of: (op: string) => sent.filter((s) => s.op === op), ops: () => sent.map((s) => s.op) }
}

const frame = (z: number) => ({ origin: [0, 0, z] as Vec3, normal: [0, 0, 1] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 })
const hullLoft = (id = 'hull', part = 0): Step => ({ id, part, transform: [...IDENTITY], params: { op: 'sketch.loft', profiles: [{ frame: frame(0), loops: [] }, { frame: frame(20), loops: [] }], operation: 'new', name: 'Hull' } as StepParams })

/** A box as Add shape makes it: its frame's origin at the middle of its foot, `size` along u, v and the normal. */
function boxPart(name: string, size: Vec3, at: Vec3): HistoryMesh {
  const [w, d, h] = size
  const positions: number[] = []
  for (const z of [0, h]) for (const [x, y] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as const) positions.push(at[0] + x, at[1] + y, at[2] + z)
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  const primitive: PrimitiveSpec = { type: 'box', sizeMm: size, frame: { origin: at, u: [1, 0, 0], normal: [0, 0, 1] } }
  return { name, slot: 1, positions, indices, primitive }
}

/** A part with no shape spec: window glass, which stays a mesh. */
const glass: HistoryMesh = { name: 'Windows', slot: 1, positions: [0, 0, 10, 2, 0, 10, 0, 0, 12], indices: [0, 1, 2] }

const add = (id: string, ...parts: HistoryMesh[]): Step => ({ id, part: -1, transform: [...IDENTITY], params: { op: 'parts.add', parts, label: 'Add' } })
const step = (id: string, part: number, params: StepParams, more: Partial<Step> = {}): Step => ({ id, part, transform: [...IDENTITY], params, ...more })
const history = (...steps: Step[]): History => ({ version: 1, base: [], steps })
const portholes = Array.from({ length: 22 }, (_, i) => ({ type: 'cylinder' as const, origin: [5 + 4 * i, -20, 10] as Vec3, axis: [0, 1, 0] as Vec3, diameterMm: 2, heightMm: 40 }))

/** Whether the part came from a held body's tessellation: its own normals and its faces' keys. */
function exactPart(p: HistoryMesh | undefined, keys?: number[]) {
  expect(p?.normals).toBeInstanceOf(Int16Array)
  expect(p!.normals).toHaveLength(p!.indices.length * 2)
  if (keys) expect(p!.faces!.keys).toEqual(keys)
}

// bodies an earlier test left held are freed by the next replay that keeps bodies; this one frees them into an
// engine nothing reads
beforeEach(async () => {
  clearReplayCache()
  await replayHistory(engine().call, { history: history(), exact: true }, kept)
})

describe('the hull and the steps on it, on held bodies', () => {
  it('cuts 22 portholes from the lofted hull, which keeps its normals and its faces\' keys', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(hullLoft(), step('portholes', 0, { op: 'subtract', solids: portholes, label: 'Portholes' })), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'brep.subtract', 'brep.tessellate'])
    // the hull goes by its number, and the cut comes back held
    expect(e.of('brep.subtract')[0]!.req['body']).toBe(FIRST)
    expect(e.of('brep.subtract')[0]!.req['solids']).toHaveLength(22)
    expect(e.of('brep.tessellate')[0]!.req['body']).toBe(FIRST + 1)
    const hull = [1, 2, 3].map((k) => stepSalt('hull') + k)
    exactPart(r.parts[0], [...hull, ...portholes.map((_, i) => stepSalt('portholes') + 100 + i)])
  })

  it('joins the hull with a deck house box into one exact body', async () => {
    const e = engine()
    const house = boxPart('Deck house', [30, 10, 6], [40, 0, 20])
    const r = await replayHistory(e.call, { history: history(hullLoft(), add('house', house), step('join', 0, { op: 'boolean', kind: 'union', with: [1] })), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    // the house's box is a solid for the join only, and is freed once the replay is done
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'brep.primitive', 'brep.boolean', 'brep.tessellate', 'brep.free'])
    expect(e.of('brep.free')[0]!.req['body']).toBe(FIRST + 1)
    expect(e.of('brep.primitive')[0]!.req).toMatchObject({ type: 'box', sizeMm: [30, 10, 6], frame: house.primitive!.frame })
    expect(e.of('brep.boolean')[0]!.req).toMatchObject({ op: 'union', a: FIRST, b: FIRST + 1 })
    expect(r.parts).toHaveLength(1)
    // every face keeps its key but the merged ones, which go by their place
    exactPart(r.parts[0], [0, stepSalt('hull') + 2, stepSalt('hull') + 3, 0, stepSalt('join') + 12])
  })

  it('joins a leaning deck house exactly: it keeps its box, turned with it', async () => {
    const e = engine()
    const tilt = { degrees: 8, up: [0, 0, 1] as Vec3, toward: [-1, 0, 0] as Vec3 }
    const r = await replayHistory(e.call, { history: history(hullLoft(), { ...add('house', boxPart('Deck house', [30, 10, 6], [40, 0, 20])), tilt }, step('join', 0, { op: 'boolean', kind: 'union', with: [1] })), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'brep.primitive', 'brep.boolean', 'brep.tessellate', 'brep.free'])
    const asked = e.of('brep.primitive')[0]!.req['frame'] as PrimitiveSpec['frame']
    // the box's own up leans 8 degrees toward -x, and its foot stays where it stood
    const sin = Math.sin((8 * Math.PI) / 180)
    const cos = Math.cos((8 * Math.PI) / 180)
    ;[-sin, 0, cos].forEach((c, k) => expect(asked.normal[k]).toBeCloseTo(c, 9))
    ;[cos, 0, sin].forEach((c, k) => expect(asked.u[k]).toBeCloseTo(c, 9))
    ;[40, 0, 20].forEach((c, k) => expect(asked.origin[k]).toBeCloseTo(c, 6))
    expect(r.parts).toHaveLength(1)
    exactPart(r.parts[0])
  })

  it("repeats the windows on the mesh: their part changes, the hull's solid is left alone and not tessellated for it", async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(hullLoft(), add('glass', glass), step('windows', 1, { op: 'array.merged', spec: { kind: 'linear', count: 2, step: [30, 0, 0] } })), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    // the hull is tessellated once, for the result, after the array ran
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'array', 'brep.tessellate'])
    exactPart(r.parts[0], [1, 2, 3].map((k) => stepSalt('hull') + k))
    expect(r.parts[1]!.indices).toHaveLength(6)
    expect('normals' in r.parts[1]!).toBe(false)
  })

  it('paints the joined hull: the solid stays, with its normals, and only the painted part is tessellated for it', async () => {
    const e = engine()
    const house = boxPart('Deck house', [30, 10, 6], [40, 0, 20])
    const paint = step('paint', 0, { op: 'paint', layer: 'color', state: 2, target: { kind: 'part' } })
    const r = await replayHistory(e.call, { history: history(hullLoft(), hullLoft('mast', 1), add('house', house), step('join', 0, { op: 'boolean', kind: 'union', with: [2] }), paint), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(r.status[4]).toEqual({ state: 'done' })
    // the joined hull is tessellated for the paint; the mast is tessellated only for the result
    // the house's box was a solid for the join only, and goes after it
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'sketch.loft', 'brep.primitive', 'brep.boolean', 'brep.tessellate', 'paint.select', 'brep.tessellate', 'brep.free'])
    expect(e.of('brep.tessellate').map((s) => s.req['body'])).toEqual([FIRST + 3, FIRST + 1])
    exactPart(r.parts[0])
    expect(r.parts[0]!.paint).toEqual({ color: { 0: '2' } })
    exactPart(r.parts[1], [1, 2, 3].map((k) => stepSalt('mast') + k))
  })
})

describe('a part whose solid a mesh step ends', () => {
  it('says so in one plain line, and every other part keeps its solid', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(hullLoft(), hullLoft('mast', 1), step('fix', 0, { op: 'repair' })), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done', note: EXACT_MESH_FROM_HERE }])
    expect('normals' in r.parts[0]!).toBe(false)
    exactPart(r.parts[1], [1, 2, 3].map((k) => stepSalt('mast') + k))
    // the mast is not tessellated for the repair, only for the result
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'sketch.loft', 'brep.tessellate', 'repair', 'brep.tessellate'])
    expect(e.of('brep.tessellate').map((s) => s.req['body'])).toEqual([FIRST, FIRST + 1])
  })

  it('says so on a join with a part that has no solid, which runs on the mesh', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(hullLoft(), add('glass', glass), step('join', 0, { op: 'boolean', kind: 'union', with: [1] })), exact: true }, kept)
    expect(r.status[2]).toEqual({ state: 'done', note: EXACT_MESH_FROM_HERE })
    expect(e.of('boolean')).toHaveLength(1)
    expect(e.of('brep.boolean')).toHaveLength(0)
    expect('normals' in r.parts[0]!).toBe(false)
  })

  it('says nothing more on a mesh step of a part with no solid, nor without exact solids', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(hullLoft(), add('glass', glass), step('fix', 1, { op: 'repair' })), exact: true }, kept)
    expect(r.status[2]).toEqual({ state: 'done' })
    clearReplayCache()
    const plain = await replayHistory(engine().call, { history: history(hullLoft(), step('fix', 0, { op: 'repair' })) }, kept)
    expect(plain.status).toEqual([{ state: 'done' }, { state: 'done' }])
  })

  it('makes no solid of an added box for a step that has no exact version', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(hullLoft(), add('house', boxPart('Deck house', [30, 10, 6], [40, 0, 20])), step('fix', 1, { op: 'repair' })), exact: true }, kept)
    expect(r.status[2]).toEqual({ state: 'done' })
    expect(e.of('brep.primitive')).toHaveLength(0)
  })
})

describe('a face whose key a merge cleared', () => {
  const joined = (...more: Step[]) => history(hullLoft(), add('house', boxPart('Deck house', [30, 10, 6], [40, 0, 20])), step('join', 0, { op: 'boolean', kind: 'union', with: [1] }), ...more)

  it('goes by its place: a pull saved with no key asks the kernel by place, and saves none', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: joined(step('pull', 0, { op: 'face.push', at: [1, 1, 0], normal: [0, 0, 1], distanceMm: 2 })), exact: true }, kept)
    expect(r.status[3]).toEqual({ state: 'done' })
    expect('faceKey' in e.of('brep.push')[0]!.req).toBe(false)
    expect(r.found?.['pull']).toBeUndefined()
  })

  it('a step saved with the key the merge cleared asks for the face again', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: joined(step('pull', 0, { op: 'face.push', at: [1, 1, 0], normal: [0, 0, 1], distanceMm: 2, faceKey: stepSalt('hull') + 1 })), exact: true }, kept)
    expect(r.status[3]!.state).toBe('broken')
    expect(r.status[3]!.message).toMatch(/faceReference/)
  })

  it('paint seeded on it goes by its point, and paint seeded by the cleared key asks for the face again', async () => {
    const e = engine()
    const at: Vec3 = [1, 1, 0]
    const r = await replayHistory(e.call, { history: joined(step('paint', 0, { op: 'paint', layer: 'color', state: 2, target: { kind: 'seed', point: at } })), exact: true }, kept)
    expect(r.status[3]).toEqual({ state: 'done' })
    expect(e.of('paint.select')[0]!.req['target']).toEqual({ kind: 'seed', point: at })
    clearReplayCache()
    const lost = await replayHistory(engine().call, { history: joined(step('paint', 0, { op: 'paint', layer: 'color', state: 2, target: { kind: 'seed', point: at, faceKey: stepSalt('hull') + 1 } })), exact: true }, kept)
    expect(lost.status[3]).toEqual({ state: 'broken', message: 'Missing face; pick the face again to repair this step.' })
  })
})

describe('an added part that leans', () => {
  it('keeps the shape it was made as, turned with it, and the turned part still fits it', () => {
    const box = boxPart('Post', [4, 4, 30], [10, 5, 3])
    const p = tiltedParams({ op: 'parts.add', parts: [box], label: 'Add' }, { degrees: 12, up: [0, 0, 1], toward: [0, 1, 0] })
    if (p.op !== 'parts.add') throw new Error('not an add')
    const leaning = p.parts[0]!
    expect(leaning.positions).not.toEqual(box.positions)
    expect(leaning.primitive?.type).toBe('box')
    expect(leaning.primitive!.frame).not.toEqual(box.primitive!.frame)
    expect(fits(leaning.primitive!, leaning.positions, leaning.indices)).toBe(true)
    // the shape before the lean no longer fits the turned points
    expect(fits(box.primitive!, leaning.positions, leaning.indices)).toBe(false)
  })
})

describe('paint on an exact part, kept by face', () => {
  const paint = (id: string, part = 0): Step => step(id, part, { op: 'paint', layer: 'color', state: 2, target: { kind: 'part' } })
  const hull = [1, 2, 3].map((k) => stepSalt('hull') + k)
  /** The engine with its tessellations from the `from`th on giving the faces in the other order, so a face is found by its key, not its place in the list. */
  const reordered = (e: ReturnType<typeof engine>, from = 2) => {
    let n = 0
    return async (op: string, req: unknown) => {
      const r = (await e.call(op, req)) as Record<string, unknown>
      if (op !== 'brep.tessellate' || ++n < from || !r['faces'] || !('keys' in (r['faces'] as object))) return r
      const keys = [...(r['faces'] as { keys: number[] }).keys].reverse()
      return { ...r, faces: { table: keys.map(() => ({ kind: 'plane' })), keys } }
    }
  }

  it('keeps a painted face painted through a later cut, found by its key, and the part stays exact', async () => {
    const e = engine()
    // the paint lands on the first triangle: the face with the hull's first key
    const r = await replayHistory(reordered(e), { history: history(hullLoft(), paint('paint'), step('portholes', 0, { op: 'subtract', solids: portholes.slice(0, 2), label: 'Portholes' })), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    exactPart(r.parts[0])
    // after the cut the faces come in the other order: the paint is on the triangle whose face has that key now
    const keys = r.parts[0]!.faces!.keys!
    const at = Array.from(r.parts[0]!.faces!.ids).findIndex((id) => keys[id] === hull[0])
    expect(at).toBe(keys.length - 1)
    expect(r.parts[0]!.paint).toEqual({ color: { [at]: '2' } })
  })

  it('keeps paint on a face a join merged (key 0) by its place', async () => {
    const e = engine()
    const house = boxPart('Deck house', [30, 10, 6], [40, 0, 20])
    const r = await replayHistory(e.call, { history: history(hullLoft(), add('house', house), step('join', 0, { op: 'boolean', kind: 'union', with: [1] }), paint('paint'), step('portholes', 0, { op: 'subtract', solids: portholes.slice(0, 1), label: 'Portholes' })), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    exactPart(r.parts[0])
    // two faces have no key after the join; the paint stays on the one it was put on, by where it is
    expect(r.parts[0]!.faces!.keys!.filter((k) => k === 0)).toHaveLength(2)
    expect(r.parts[0]!.paint).toEqual({ color: { 0: '2' } })
  })

  it('paints both faces a join gives one key, provisionally, until a joined result reads back with one key per face', async () => {
    // two boxes made for the same join have the same keys; the union keeps one face of each with the same key
    const e = engine()
    const call = async (op: string, req: unknown) => (op === 'paint.select' ? { changed: { '1': '2' } } : e.call(op, req))
    const boxes = add('boxes', boxPart('Left', [10, 10, 10], [0, 0, 0]), boxPart('Right', [10, 10, 10], [20, 0, 0]))
    const r = await replayHistory(call, { history: history(boxes, step('join', 0, { op: 'boolean', kind: 'union', with: [1] }), paint('paint'), step('portholes', 0, { op: 'subtract', solids: portholes.slice(0, 1), label: 'Portholes' })), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
    exactPart(r.parts[0])
    const keys = r.parts[0]!.faces!.keys!
    expect(keys[1]).not.toBe(0)
    expect(keys.filter((k) => k === keys[1])).toHaveLength(2)
    // the paint was put on one of them; after the cut, both faces with that key are painted
    expect(r.parts[0]!.paint).toEqual({ color: { 1: '2', 3: '2' } })
  })

  it('takes paint in a design that must stay exact', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: { ...history(hullLoft(), paint('paint'), step('portholes', 0, { op: 'subtract', solids: portholes.slice(0, 1), label: 'Portholes' })), exact: true } }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    exactPart(r.parts[0])
    expect(r.parts[0]!.paint).toEqual({ color: { 0: '2' } })
  })

  describe('across part of a face', () => {
    /** The engine with each held body's first face made of two triangles, so painting one paints part of it. */
    const split = (e: ReturnType<typeof engine>) => async (op: string, req: unknown) => {
      const r = (await e.call(op, req)) as Record<string, unknown>
      if (op !== 'brep.tessellate' || !(r['positions'] instanceof Float32Array)) return r
      const p = r['positions'] as Float32Array
      const ids = r['faceIds'] as Uint32Array
      const positions = new Float32Array([...p, 0, 5, 0, 5, 0, 0, 5, 5, 0])
      return { ...r, positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i), faceIds: Uint32Array.from([...ids, 0]), normals: new Int16Array((positions.length / 9) * 6) }
    }

    it('stays on its triangles with the solid kept, and the next kernel step clears it with the paint note', async () => {
      const e = engine()
      const r = await replayHistory(split(e), { history: history(hullLoft(), paint('paint'), step('portholes', 0, { op: 'subtract', solids: portholes.slice(0, 1), label: 'Portholes' })), exact: true }, kept)
      expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done', note: PAINT_DROPPED }])
      expect(e.of('brep.subtract')).toHaveLength(1)
      exactPart(r.parts[0])
      expect(r.parts[0]!.paint).toBeUndefined()
    })

    it('is cleared with the paint note by a mesh step too, never silently', async () => {
      const e = engine()
      const r = await replayHistory(split(e), { history: history(hullLoft(), paint('paint'), step('fix', 0, { op: 'repair' })), exact: true }, kept)
      expect(r.status[2]).toMatchObject({ state: 'done' })
      expect((r.status[2] as { note?: string }).note).toContain(PAINT_DROPPED)
      expect(r.parts[0]!.paint).toBeUndefined()
    })

    it('stops a design that must stay exact, as before', async () => {
      const e = engine()
      const r = await replayHistory(split(e), { history: { ...history(hullLoft(), paint('paint')), exact: true } }, kept)
      expect(r.status[1]).toEqual({ state: 'broken', message: 'Exact replay does not support paint for this part. The mesh path was not used.' })
    })
  })
})
