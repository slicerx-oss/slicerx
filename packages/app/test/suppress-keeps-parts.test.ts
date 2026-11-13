// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A turned-off boolean still numbers the parts as if it had run (cad-history numbering.ts): the parts it would have taken
// away stay at the end of the parts list, and a new body made after it keeps its own place instead of being made again
// over one of them. Each of replay's three ways of making a new body is checked: on the mesh, as an exact loft, and as an
// exact extrude. The engine here answers each call with a small mesh or a held body, so the parts' names tell them apart.
import { beforeEach, describe, expect, it } from 'vitest'
import { EXACT_OPS, IDENTITY, clearReplayCache, replayHistory, type History, type HistoryMesh, type ReplayRequest, type Step, type StepParams } from '@slicerx/cad-history'

const FIRST = 2 ** 30

function engine(sent: string[] = []) {
  const held = new Set<number>()
  let n = 0
  const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    sent.push(op === 'sketch.loft' && req['exact'] === true ? 'exact loft' : op)
    if (op === EXACT_OPS) return { ops: ['sketch.loft'] }
    if (op === 'boolean') return { mesh: (req['a'] as { mesh: unknown }[])[0]!.mesh }
    if (op === 'sketch.loft' && req['exact'] === true) {
      const body = FIRST + n++
      held.add(body)
      return { mesh: tri, body, bodyKeys: [] }
    }
    if (op === 'brep.extrude') {
      const body = FIRST + n++
      held.add(body)
      return { body, bodyKeys: [] }
    }
    if (op === 'brep.tessellate') {
      if (!held.has(req['body'] as number)) throw new Error('brep: body: no such body')
      return { meshForm: 2, positions: new Float32Array(tri.positions), indices: new Uint32Array(tri.indices), faceIds: new Uint32Array([0]), normals: new Int16Array(6), faces: { table: [{ kind: 'other' }], keys: [] }, surfaces: [{ kind: 'other' }], edges: [] }
    }
    if (op === 'brep.free') return { freed: held.delete(req['body'] as number) }
    if (op.startsWith('brep.')) throw new Error('brep: this operation cannot work on this body yet')
    return { mesh: tri }
  }
  return call
}

const block = (name: string, x: number): HistoryMesh => ({ name, slot: 1, positions: [x, 0, 0, x + 10, 0, 0, x, 10, 0, x, 0, 10], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] })
const step = (id: string, part: number, params: unknown, suppressed = false): Step => ({ id, part, transform: [...IDENTITY], params: params as StepParams, ...(suppressed ? { suppressed: true } : {}) })
const union = (suppressed: boolean) => step('union', 0, { op: 'boolean', kind: 'union', with: [1, 2] }, suppressed)
const extrude = (id: string, part: number, name: string) => step(id, part, { op: 'shape.extrude', shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, placement: { center: [40, 0] }, spec: { operation: 'new', distanceMm: 10 }, name })
const loft = (id: string, part: number, name: string) => step(id, part, { op: 'sketch.loft', profiles: [{ loops: [] }, { frame: { origin: [0, 0, 20], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [] }], operation: 'new', name })
// A, B and E as the base; the union takes B and E into A, and C is made after it as part 1
const history = (suppressed: boolean, made: Step): History => ({ version: 1, base: [block('A', 0), block('B', 5), block('E', -5)], steps: [union(suppressed), made] })

/** The parts' names after the replay; `by` is the engine call that must have made the new body. */
async function names(made: Step, suppressed: boolean, by: string, how: Partial<ReplayRequest> = {}): Promise<string[]> {
  clearReplayCache()
  const sent: string[] = []
  const r = await replayHistory(engine(sent), { history: history(suppressed, made), ...how }, { keepsBodies: true })
  expect(r.status.map((s) => s.state)).toEqual([suppressed ? 'suppressed' : 'done', 'done'])
  expect(sent).toContain(by)
  expect(r.exactFellBack).toBeUndefined()
  return r.parts.map((p) => p.name)
}

beforeEach(() => clearReplayCache())

describe('a new body after a turned-off union keeps its own place', () => {
  it('on the mesh', async () => {
    expect(await names(extrude('c', 1, 'C'), false, 'shape.extrude')).toEqual(['A', 'C'])
    expect(await names(extrude('c', 1, 'C'), true, 'shape.extrude')).toEqual(['A', 'C', 'B', 'E'])
  })

  it('as an exact loft', async () => {
    expect(await names(loft('c', 1, 'C'), false, 'exact loft', { exactLofts: true })).toEqual(['A', 'C'])
    expect(await names(loft('c', 1, 'C'), true, 'exact loft', { exactLofts: true })).toEqual(['A', 'C', 'B', 'E'])
  })

  it('as an exact extrude', async () => {
    expect(await names(extrude('c', 1, 'C'), false, 'brep.extrude', { exact: true })).toEqual(['A', 'C'])
    expect(await names(extrude('c', 1, 'C'), true, 'brep.extrude', { exact: true })).toEqual(['A', 'C', 'B', 'E'])
  })

  it('a step made after the union was turned off, on a part set aside, finds it at the number it was shown with', async () => {
    clearReplayCache()
    // with the union off the parts read A, C, B, E: a new body then is part 4, and a cut on part 2 is B
    const h: History = { ...history(true, extrude('c', 1, 'C')), steps: [union(true), extrude('c', 1, 'C'), extrude('f', 4, 'F'), step('cut', 2, { op: 'plane.cut', plane: { point: [0, 0, 5], normal: [0, 0, 1] }, keep: 'both', name: 'B top' })] }
    const call = engine()
    const cutting = async (op: string, req: unknown) => (op === 'cut' ? { below: (req as { mesh: unknown }).mesh, above: (req as { mesh: unknown }).mesh } : call(op, req))
    const r = await replayHistory(cutting, { history: h })
    expect(r.status.map((s) => s.state)).toEqual(['suppressed', 'done', 'done', 'done'])
    expect(r.parts.map((p) => p.name)).toEqual(['A', 'C', 'B', 'B top', 'E', 'F'])
  })
})
