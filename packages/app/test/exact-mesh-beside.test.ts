// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mesh part added to a design with exact solids lives beside the exact parts: adding it is never refused, the exact
// parts stay exact, steps on the mesh part alone run on the mesh, and the replay marks it a mesh part (meshParts).
// Joining it into an exact part takes that part to the mesh: the step says so on a normal design and stops on a design
// that must stay exact. A stand-in exact engine.
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache, EXACT_MESH_FROM_HERE, IDENTITY, replayHistory, type History, type Step, type StepParams } from '@slicerx/cad-history'

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
const box = (id: string) => step(id, 0, { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams)
const cut = (id: string, part: number) => step(id, part, { op: 'shape.extrude', frame: { ...frame, origin: [2, 0, 5], normal: [0, 0, -1] }, shape: { type: 'circle', diameterMm: 2 }, spec: { distanceMm: 2, operation: 'cut' } } as StepParams)
const add = (id: string) => step(id, -1, { op: 'parts.add', parts: [{ name: 'Davit', slot: 1, ...tri(5) }], label: 'Add Davit' })
const join = (id: string, part: number, other: number) => step(id, part, { op: 'boolean', kind: 'union', with: [other] })

beforeEach(() => clearReplayCache())

describe('a mesh part beside exact parts', () => {
  it('is added to a design that must stay exact, and steps on it alone run on the mesh', async () => {
    const e = engine()
    const history: History = { version: 1, base: [], steps: [box('a'), add('davit'), cut('davit-cut', 1), cut('a-cut', 0)], exact: true }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }])
    expect(r.meshParts).toEqual([1])
    // the box and its cut ran on the kernel, the davit's cut on the mesh
    expect(e.sent.filter((o) => o === 'brep.extrude')).toHaveLength(2)
    expect(e.sent.filter((o) => o === 'shape.extrude')).toHaveLength(1)
  })

  it('leaves the exact parts exact on a normal design, with no note', async () => {
    const e = engine()
    const history: History = { version: 1, base: [], steps: [box('a'), add('davit'), cut('davit-cut', 1), cut('a-cut', 0)] }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(r.status.map((s) => s.note ?? null)).toEqual([null, null, null, null])
    expect(r.meshParts).toEqual([1])
    expect(e.sent.filter((o) => o === 'brep.extrude')).toHaveLength(2)
  })

  it('takes an exact part it joins into to the mesh, saying so on a normal design', async () => {
    const e = engine()
    const history: History = { version: 1, base: [], steps: [box('a'), add('davit'), join('j', 0, 1)] }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(r.status.map((s) => s.note ?? null)).toEqual([null, null, EXACT_MESH_FROM_HERE])
    expect(r.status.every((s) => s.state === 'done')).toBe(true)
    expect(r.meshParts).toEqual([0])
  })

  it('stops a join into an exact part, either way round, on a design that must stay exact', async () => {
    for (const [part, other] of [[0, 1], [1, 0]] as const) {
      clearReplayCache()
      const r = await replayHistory(engine().call, { history: { version: 1, base: [], steps: [box('a'), add('davit'), join('j', part, other)], exact: true }, exact: true })
      expect(r.status.slice(0, 2)).toEqual([{ state: 'done' }, { state: 'done' }])
      expect(r.status[2]).toMatchObject({ state: 'broken', message: 'Exact replay does not support boolean for this part. The mesh path was not used.' })
    }
  })

  it('marks no part with exact solids off', async () => {
    const r = await replayHistory(engine().call, { history: { version: 1, base: [], steps: [box('a'), add('davit')] } })
    expect(r.meshParts).toBeUndefined()
  })
})
