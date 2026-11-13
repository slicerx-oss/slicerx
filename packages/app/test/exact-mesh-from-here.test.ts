// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A normal design replayed with exact solids on: a step with no exact path that an exact part goes through runs on the
// mesh, and says once, on that step, that the part is no longer an exact solid from there on. A part that was never
// exact, and the steps after the first, say nothing; a design that must stay exact still stops there. In the replay,
// and as a client reads it over the app link (design.steps). A stand-in exact engine.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache, EXACT_MESH_FROM_HERE, IDENTITY, replayHistory, type History, type Step, type StepParams } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { setGeomProvider } from '../src/geom/client'
import { set } from '../src/state/store'

type R = Record<string, unknown>
const tri = (mark: number) => ({ positions: [mark, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] })

/** Kernel ops answer a new body as text; the mesh ops answer a mesh. Every op is logged. */
function engine() {
  const sent: string[] = []
  let n = 0
  const call = async (op: string, request: unknown) => {
    const req = request as R
    sent.push(op)
    if (op === 'brep.tessellate') return { ...tri(1), faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.extrude') return req['target'] !== undefined ? { touches: true, bodySmb: `cut-${++n}` } : { bodySmb: `box-${++n}` }
    if (op.startsWith('brep.')) return { bodySmb: `${op.slice(5)}-${++n}` }
    return { mesh: tri(2), removedVolumeMm3: 1, report: { touches: true } }
  }
  return { call, sent }
}

const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const step = (id: string, part: number, params: StepParams): Step => ({ id, part, transform: [...IDENTITY], params })
const box = (id: string, x: number) => step(id, 0, { op: 'shape.extrude', frame: { ...frame, origin: [x, 0, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams)
const cut = (id: string, part: number, x: number) => step(id, part, { op: 'shape.extrude', frame: { ...frame, origin: [x, 0, 5], normal: [0, 0, -1] }, shape: { type: 'circle', diameterMm: 2 }, spec: { distanceMm: 2, operation: 'cut' } } as StepParams)
const mirror = (id: string, part: number) => step(id, part, { op: 'mirror', plane: { point: [40, 0, 0], normal: [1, 0, 0] }, copy: false } as StepParams)

beforeEach(() => clearReplayCache())

describe('a part that leaves the exact path', () => {
  it('says so once, on the step where it goes to the mesh', async () => {
    const e = engine()
    const history: History = { version: 1, base: [], steps: [box('a', 0), cut('a-cut', 0, 2), mirror('a-mirror', 0), cut('a-cut-2', 0, -2)] }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(r.status.map((s) => s.note ?? null)).toEqual([null, null, EXACT_MESH_FROM_HERE, null])
    expect(r.status.every((s) => s.state === 'done')).toBe(true)
    // a part going to the mesh is not a kernel failure
    expect(r.exactFellBack).toBeUndefined()
    // the cuts before it ran on the kernel, the one after on the mesh
    expect(e.sent.filter((o) => o === 'brep.extrude')).toHaveLength(2)
    expect(e.sent.filter((o) => o === 'shape.extrude')).toHaveLength(1)
  })

  it('says so for each part, once each', async () => {
    const e = engine()
    const second = { ...box('b', 60), part: 1 }
    const history: History = { version: 1, base: [], steps: [box('a', 0), second, mirror('a-mirror', 0), mirror('b-mirror', 1), mirror('a-again', 0)] }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(r.status.map((s) => s.note ?? null)).toEqual([null, null, EXACT_MESH_FROM_HERE, EXACT_MESH_FROM_HERE, null])
  })

  it('says nothing for a part that was never exact, or with exact solids off', async () => {
    const e = engine()
    const base: History['base'] = [{ name: 'Imported', slot: 1, ...tri(3) }]
    const imported = await replayHistory(e.call, { history: { version: 1, base, steps: [mirror('m', 0)] }, exact: true })
    expect(imported.status).toEqual([{ state: 'done' }])
    clearReplayCache()
    const off = await replayHistory(e.call, { history: { version: 1, base: [], steps: [box('a', 0), mirror('a-mirror', 0)] } })
    expect(off.status).toEqual([{ state: 'done' }, { state: 'done' }])
  })

  it('still stops a design that must stay exact there', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: { version: 1, base: [], steps: [box('a', 0), mirror('a-mirror', 0)], exact: true } })
    expect(r.status[1]).toMatchObject({ state: 'broken', message: expect.stringContaining('Exact replay does not support mirror for this part') })
  })
})

describe('over the app link', () => {
  const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 1, bboxMm: [20, 10, 5], openEdges: 0, parts: [] })
  beforeAll(() => useDesignHost({ loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }))
  beforeEach(() => {
    set({ plate: [], selection: null, selectedIds: [], historyEdit: null, settingsMode: 'developer' })
    localStorage.setItem('sx.exactSolids', '1')
  })
  afterEach(() => {
    localStorage.removeItem('sx.exactSolids')
    set({ settingsMode: 'simple' })
    setGeomProvider(null)
  })

  it('reads the note on the step where the part went to the mesh, and on no other', async () => {
    setGeomProvider({ call: engine().call as never })
    const design = ((await runCall('design.new', { name: 'Plate' })) as { output: { design: string } }).output.design
    await runCall('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 5, name: 'Plate' })
    await runCall('geom.mirror', { design, part: 0, plane: { axis: 'x', at: 40 } })
    await runCall('geom.extrude', { design, part: 0, shape: { type: 'circle', diameterMm: 2 }, frame: { origin: [0, 0, 5], normal: [0, 0, 1] }, distance_mm: 2, operation: 'cut' })
    const rows = ((await runCall('design.steps', { design })) as { output: { steps: { op: string; state: string; note?: string }[] } }).output.steps
    expect(rows.map((s) => [s.op, s.note ?? null])).toEqual([['shape.extrude', null], ['mirror', EXACT_MESH_FROM_HERE], ['shape.extrude', null]])
  })
})
