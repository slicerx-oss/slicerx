// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every CAD tool records a history step, and replaying the recorded steps on the base gives the mesh
// the tools made. Against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyArray, applyExtrude, applyRevolve, BED_FRAME } from '../src/cad/cad-ops'
import { applyPush, pickPushFace } from '../src/cad/push'
import { followsOf, stepName } from '../src/cad/history/model'
import { clearReplayCache } from '../src/cad/history/replay'
import { runReplay } from '../src/cad/history/ops'
import { hollowSelected, repairSelected, subtractFromSelected } from '../src/plate/geom-ops'
import { mergeSelected, splitSelectedToParts } from '../src/plate/edit'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('cad-history-record-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const at = (x: number) => compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const block = (id: string, x: number): PlateEntry => ({ id, name: id, handle: handle(id), parts: [boxMesh(30, 20, 10)], colors: ['#bd93f9'], transform: at(x) })
const entry = (id: string) => get().plate.find((p) => p.id === id)!

/** The recorded history replayed from its base matches the object's mesh. */
async function replaysTo(id: string): Promise<void> {
  clearReplayCache()
  const e = entry(id)
  const r = await runReplay({ history: e.history! })
  expect(r.status.every((s) => s.state === 'done' || s.state === 'suppressed')).toBe(true)
  expect(r.parts.map((p) => p.indices.length)).toEqual(e.parts.map((p) => p.indices.length))
  r.parts.forEach((p, i) => {
    const want = e.parts[i]!.positions
    expect(Math.max(...Array.from(p.positions, (v, k) => Math.abs(v - want[k]!)))).toBeLessThan(1e-3)
  })
}

beforeEach(() => {
  set({ plate: [block('a', 100), block('b', 160)], selection: 'a', selectedIds: ['a'], historyEdit: null })
})

describe('tools record steps', () => {
  it('push and pull, a shape on the face it pulled, and a hole: three steps that replay to the same mesh', async () => {
    const face = await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 10] })
    await applyPush(host, face, 5)
    let h = entry('a').history!
    expect(h.base[0]!.indices.length).toBe(36)
    expect(h.steps.map((s) => stepName(s))).toEqual(['Pull 5 mm'])
    await applyExtrude(host, { frame: { origin: [100, 100, 15], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 8, heightMm: 6 }, placement: { center: [4, 0] }, spec: { distanceMm: 3, operation: 'join' }, target: { objectId: 'a', partIndex: 0 }, name: 'Rectangle' })
    await subtractFromSelected(host, { shape: 'cylinder', sizeMm: 4, depthMm: 6, offset: [-8, 0] })
    h = entry('a').history!
    expect(h.steps.map((s) => stepName(s))).toEqual(['Pull 5 mm', 'Rectangle extrude 3 mm', 'Hole 4 mm'])
    expect(followsOf(h.steps[1]!).map((f) => f.step)).toEqual([h.steps[0]!.id])
    await replaysTo('a')
  })

  it('a sketch body starts its own history; a revolve too', async () => {
    const loops = [{ start: [0, 0] as [number, number], segments: [{ type: 'line' as const, to: [10, 0] as [number, number] }, { type: 'line' as const, to: [10, 6] as [number, number] }, { type: 'line' as const, to: [0, 0] as [number, number] }] }]
    await applyExtrude(host, { frame: BED_FRAME, shape: { type: 'sketch', loops }, placement: {}, spec: { distanceMm: 4, operation: 'new' }, name: 'Sketch body' })
    const made = get().plate.find((p) => p.name === 'Sketch body')!
    expect(made.history!.base).toEqual([])
    expect(stepName(made.history!.steps[0]!)).toBe('Sketch extrude 4 mm')
    await replaysTo(made.id)
    await applyRevolve(host, { frame: BED_FRAME, loops: [{ points: [[20, 0], [24, 0], [24, 5], [20, 5]] }], axis: { point: [0, 0], direction: [0, 1] }, angleDeg: 90, operation: 'new', name: 'Ring' })
    const ring = get().plate.find((p) => p.name === 'Ring')!
    expect(stepName(ring.history!.steps[0]!)).toBe('Sketch revolve 90°')
    await replaysTo(ring.id)
  })

  it('hollow starts a history; repair and a merged array only add to one', async () => {
    await repairSelected(host)
    expect(entry('a').history).toBeUndefined()
    await applyPush(host, await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 10] }), 1)
    await repairSelected(host)
    await applyArray(host, 'a', { kind: 'linear', count: 2, step: [40, 0, 0] }, true)
    expect(entry('a').history!.steps.map((s) => stepName(s))).toEqual(['Pull 1 mm', 'Repair', 'Array of 2, merged'])
    await replaysTo('a')
    // Hollow on a small block (its result is dense, so the recorded reply stays small this way).
    set({ plate: [{ ...block('h', 100), parts: [boxMesh(8, 8, 6)] }], selection: 'h', selectedIds: ['h'] })
    await hollowSelected(host, 1.5)
    expect(entry('h').history!.steps.map((s) => stepName(s))).toEqual(['Hollow, 1.5 mm walls'])
    await replaysTo('h')
  })

  it('a merge adds the other meshes as a step; splitting to parts ends the history', async () => {
    const face = await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 10] })
    await applyPush(host, face, 2)
    set({ selection: 'a', selectedIds: ['a', 'b'] })
    await mergeSelected(host)
    const h = entry('a').history!
    expect(h.steps.map((s) => stepName(s))).toEqual(['Pull 2 mm', 'Merge with b'])
    await replaysTo('a')
  })

  it('splitting to parts ends the history and starts it again from the parts', async () => {
    // One part holding two separate boxes.
    const one = boxMesh(30, 20, 10)
    const two = { ...one, positions: one.positions.map((v, i) => (i % 3 === 0 ? v + 50 : v)), indices: one.indices.map((i) => i + 8) }
    const both: MeshPart = { ...one, positions: new Float32Array([...one.positions, ...two.positions]), indices: new Uint32Array([...one.indices, ...two.indices]) }
    set({ plate: [{ ...block('c', 100), parts: [both] }], selection: 'c', selectedIds: ['c'] })
    await applyPush(host, await pickPushFace('c', 0, { triangle: 2, at: [100, 100, 10] }), 2)
    expect(entry('c').history!.steps).toHaveLength(1)
    await splitSelectedToParts(host)
    const ended = entry('c').history!
    expect(ended.steps).toEqual([])
    expect(ended.ended).toBe('History ends here: the object was split into parts.')
    expect(ended.base).toBe(entry('c').parts)
  })
})
