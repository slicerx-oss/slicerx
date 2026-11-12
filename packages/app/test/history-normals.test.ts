// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exact corner normals on history parts (HistoryMesh.normals): they come from a solid's tessellation in either form
// the engine answers in, ride on the part while its triangles are that tessellation, and go the moment a step changes
// the triangles. A project never stores them. Never a normal that no longer fits its triangle.
import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY, bakeMesh, clearReplayCache, encodeMeshes, EXACT_FELL_BACK, historyFiles, parseHistories, replayHistory, tessellated, type History, type HistoryMesh, type Step, type StepParams } from '@slicerx/cad-history'
import { historyPart } from '@slicerx/cad-history/mesh-part'

// two triangles of a flat square, each corner's packed normal straight up (0, 0 in the upper half of the map)
const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]
const indices = [0, 1, 2, 0, 2, 3]
const up = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const plane = { kind: 'plane', normal: [0, 0, 1], offset: 0 }

/** The answer without output buffers: lists, one entry per face, the packed normals as a list. */
const listForm = () => ({ positions: [...positions], indices: [...indices], faceIds: [0, 0], faces: [{ id: 0, type: 'plane', surface: plane, key: 77 }], normals: [...up], surfaces: [{ kind: 'plane' }], edges: [{ faces: [0, 0], curve: 'line', tangent: false, points: [0, 1] }] })

/** The answer with output buffers read: typed arrays, the face table with its keys, a face number per triangle. */
const bufferForm = () => ({ meshForm: 2, positions: new Float32Array(positions), indices: new Uint32Array(indices), faceIds: new Uint32Array([0, 0]), normals: new Int16Array(up), faces: { table: [plane], keys: [77] }, surfaces: [{ kind: 'plane' }], edges: [{ faces: [0, 0], curve: 'line', tangent: false, points: 2 }] })

describe('reading a tessellation', () => {
  it('reads the list form, with the normals as packed numbers', () => {
    const t = tessellated(listForm())
    expect(t.normals).toBeInstanceOf(Int16Array)
    expect(Array.from(t.normals!)).toEqual(up)
    expect(Array.from(t.faces!.ids)).toEqual([0, 0])
    expect(t.faces!.table).toEqual([plane])
    expect(t.faces!.keys).toEqual([77])
    expect(Object.keys(t).sort()).toEqual(['faces', 'indices', 'normals', 'positions'])
  })

  it('reads the buffer form to the same part, and copies none of its arrays', () => {
    const given = bufferForm()
    const t = tessellated(given)
    expect(t.positions).toBe(given.positions)
    expect(t.indices).toBe(given.indices)
    expect(t.normals).toBe(given.normals)
    expect(t.faces!.ids).toBe(given.faceIds)
    expect(t.faces!.table).toEqual([plane])
    expect(t.faces!.keys).toEqual([77])
    const listed = tessellated(listForm())
    expect(Array.from(t.positions)).toEqual(Array.from(listed.positions))
    expect(Array.from(t.indices)).toEqual(Array.from(listed.indices))
    expect(Array.from(t.normals!)).toEqual(Array.from(listed.normals!))
  })

  it("reads today's answer, which has no normals, as before", () => {
    const { normals: _n, surfaces: _s, edges: _e, ...today } = listForm()
    const t = tessellated(today)
    expect(t.normals).toBeUndefined()
    expect('normals' in t).toBe(false)
    expect(t).toEqual({ positions, indices, faces: { ids: [0, 0], table: [plane], keys: [77] } })
  })

  it('gives a triangle on no face a face of its own, in both forms', () => {
    const a = tessellated({ ...listForm(), faceIds: [0, -1] })
    expect(Array.from(a.faces!.ids)).toEqual([0, 1])
    expect(a.faces!.table).toEqual([plane, { kind: 'other' }])
    expect(a.faces!.keys).toEqual([77, 0])
    const b = tessellated({ ...bufferForm(), faceIds: new Uint32Array([0, 0xffffffff]) })
    expect(Array.from(b.faces!.ids)).toEqual([0, 1])
    expect(b.faces!.table).toEqual([plane, { kind: 'other' }])
  })

  it('leaves the keys out when the table has none', () => {
    expect(tessellated({ ...bufferForm(), faces: { table: [plane] } }).faces).toEqual({ ids: new Uint32Array([0, 0]), table: [plane] })
  })

  it('drops normals that are not six per triangle', () => {
    expect(tessellated({ ...listForm(), normals: up.slice(0, 6) }).normals).toBeUndefined()
    expect(tessellated({ ...bufferForm(), normals: new Int16Array(18) }).normals).toBeUndefined()
  })
})

interface Sent {
  op: string
  req: Record<string, unknown>
}

/** An engine with a kernel that keeps bodies by number or hands them back as text, and mesh steps that give the mesh back. */
function engine(o: { form?: 'list' | 'buffer'; failing?: string[] } = {}) {
  const sent: Sent[] = []
  let n = 0
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    sent.push({ op, req })
    if (o.failing?.includes(op)) throw new Error(`kernel: ${op} failed`)
    if (op === 'brep.tessellate') return o.form === 'list' ? listForm() : bufferForm()
    if (op === 'brep.free') return { freed: true }
    if (op.startsWith('brep.')) return req['withKeys'] ? { body: ++n, bodyKeys: [77] } : { bodySmb: `solid-${++n}` }
    if (op === 'paint.select') return { changed: { 1: '4' } }
    // a mesh step gives back the mesh it was sent (alone, or with its transform); a new body is the square
    const given = (req['mesh'] ?? req['target']) as { mesh?: unknown } | undefined
    return { mesh: given?.mesh ?? given ?? { positions: [...positions], indices: [...indices] }, removedVolumeMm3: 1, report: { touches: true } }
  }
  return { call, sent, of: (op: string) => sent.filter((s) => s.op === op) }
}

const step = (id: string, params: StepParams, part = 0): Step => ({ id, part, transform: [...IDENTITY], params })
const box = step('box-1', { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams)
const hole = step('hole-1', { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole 4 mm' } as StepParams)
const repair = step('repair-1', { op: 'repair' })
const paint = step('paint-1', { op: 'paint', layer: 'color', state: 4, target: { kind: 'part' } })
const history = (...steps: Step[]): History => ({ version: 1, base: [], steps })
const kept = { keepsBodies: true }

beforeEach(() => clearReplayCache())

describe('normals through a replay', () => {
  it('a part that is still its solid has the solid normals, from kept bodies in the buffer form', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(box, hole), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(r.parts[0]!.normals).toBeInstanceOf(Int16Array)
    expect(Array.from(r.parts[0]!.normals!)).toEqual(up)
    expect(r.parts[0]!.positions).toBeInstanceOf(Float32Array)
    expect(r.parts[0]!.faces!.keys).toEqual([77])
    // the result carries no solid, only its mesh
    expect('body' in r.parts[0]!).toBe(false)
  })

  it('and from solids passed as text in the list form', async () => {
    const e = engine({ form: 'list' })
    const r = await replayHistory(e.call, { history: history(box, hole), exact: true })
    expect(Array.from(r.parts[0]!.normals!)).toEqual(up)
    expect('smb' in r.parts[0]!).toBe(false)
  })

  it('a mesh step after the solid leaves no normals behind', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(box, repair), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(r.parts[0]!.normals).toBeUndefined()
    expect('normals' in r.parts[0]!).toBe(false)
    // the mesh step was sent plain lists, not the tessellation's typed arrays
    const mesh = e.of('repair')[0]!.req['mesh'] as { positions: unknown; indices: unknown; faces: { ids: unknown } }
    expect(Array.isArray(mesh.positions) && Array.isArray(mesh.indices) && Array.isArray(mesh.faces.ids)).toBe(true)
    expect(JSON.parse(JSON.stringify(mesh))).toEqual({ positions, indices, faces: { ids: [0, 0], table: [plane], keys: [77] } })
    // and the part as it was before that step still has them
    const before = await replayHistory(e.call, { history: history(box, repair), exact: true, before: 1 }, kept)
    expect(Array.from(before.before![0]!.normals!)).toEqual(up)
  })

  it('a step the kernel fails on runs on the mesh and leaves no normals behind', async () => {
    const e = engine({ failing: ['brep.subtract'] })
    const r = await replayHistory(e.call, { history: history(box, hole), exact: true }, kept)
    expect(r.status[1]).toEqual({ state: 'done', note: EXACT_FELL_BACK })
    expect(r.parts[0]!.normals).toBeUndefined()
  })

  it('paint keeps them: the triangles are the same', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(box, paint), exact: true }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(r.parts[0]!.paint).toEqual({ color: { 1: '4' } })
    expect(Array.from(r.parts[0]!.normals!)).toEqual(up)
  })

  it('a new order of the parts keeps them', async () => {
    const e = engine()
    const second = step('box-2', { ...box.params, name: 'Second' } as StepParams, 1)
    const r = await replayHistory(e.call, { history: history(box, second, step('order-1', { op: 'parts.order', order: [1, 0] })), exact: true }, kept)
    expect(r.parts.map((p) => p.name)).toEqual(['Second', 'Body'])
    expect(r.parts.every((p) => p.normals?.length === 12)).toBe(true)
  })

  it('normals on a base mesh are not trusted: a replay starts from positions and indices alone', async () => {
    const base: HistoryMesh = { name: 'Base', slot: 1, positions, indices, normals: new Int16Array(up) }
    const e = engine()
    const r = await replayHistory(e.call, { history: { version: 1, base: [base], steps: [repair] } })
    expect(r.status[0]!.state).toBe('done')
    expect('normals' in r.parts[0]!).toBe(false)
  })

  it('a replay without exact solids never has them', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history({ ...box, id: 'mesh-box' }) })
    expect(e.of('brep.tessellate')).toHaveLength(0)
    expect(r.parts.every((p) => !('normals' in p))).toBe(true)
  })
})

describe('normals out of a replay', () => {
  const part = (normals?: Int16Array): HistoryMesh => ({ name: 'Plate', slot: 1, positions, indices, ...(normals ? { normals } : {}) })

  it('the part shown gets them when there are six per triangle', () => {
    const n = new Int16Array(up)
    expect(historyPart(part(n)).normals).toBe(n)
    expect('normals' in historyPart(part())).toBe(false)
    expect('normals' in historyPart(part(new Int16Array(6)))).toBe(false)
    expect('normals' in historyPart({ ...part(), normals: up as unknown as Int16Array })).toBe(false)
    // with or without a face table that reads
    expect(historyPart({ ...part(n), faces: { ids: [0, 0], table: [plane], keys: [77] } }).normals).toBe(n)
    expect(historyPart({ ...part(n), faces: { ids: [5, 0], table: [plane] } }).normals).toBe(n)
  })

  it('a baked mesh has none: its positions moved', () => {
    const moved = bakeMesh(part(new Int16Array(up)), [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1])
    expect('normals' in moved).toBe(false)
  })

  it('a saved project has no normals', () => {
    const withNormals: History = { version: 1, base: [part(new Int16Array(up))], steps: [step('add-1', { op: 'parts.add', parts: [part(new Int16Array(up))], label: 'Added part' } as StepParams)] }
    const without: History = { version: 1, base: [part()], steps: [step('add-1', { op: 'parts.add', parts: [part()], label: 'Added part' } as StepParams)] }
    const files = historyFiles([{ id: 'a', history: withNormals }], new Map([['a', 3]]))
    const plain = historyFiles([{ id: 'a', history: without }], new Map([['a', 3]]))
    // the same files, byte for byte, as the same history without them
    expect(files.map((f) => f.name)).toEqual(plain.map((f) => f.name))
    for (const [i, f] of files.entries()) expect(f.data).toEqual(plain[i]!.data)
    const text = files.map((f) => (typeof f.data === 'string' ? f.data : f.name.endsWith('.json') ? new TextDecoder().decode(f.data) : '')).join('\n')
    expect(text).toContain('parts.add')
    expect(text).not.toContain('normals')
    expect(encodeMeshes([part(new Int16Array(up))])).toEqual(encodeMeshes([part()]))
    // and it opens to parts without them
    const enc = new TextEncoder()
    const back = parseHistories(new Map(files.map((f) => [f.name, typeof f.data === 'string' ? enc.encode(f.data) : f.data])), new Set(['3']))
    const opened = back.get('3')!
    expect(opened.base).toHaveLength(1)
    expect('normals' in opened.base[0]!).toBe(false)
  })
})
