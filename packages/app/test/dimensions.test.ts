// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Kept dimensions against the geometry engine (live wasm when built, recorded replies otherwise):
// kept from a measurement, followed through a push, lost when their object goes, drawn in words.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { evaluateDimensions, type Dimension } from '../src/geom/cad'
import { allDimensions, dimensionText, keepDimension, keepableKinds, markFor, objectsFor, removeDimension, wholeTriangle } from '../src/cad/dimensions'
import { applyPush, pickPushFace } from '../src/cad/push'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('dimensions-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const at = (x: number) => compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const block = (id: string, x: number): PlateEntry => ({ id, name: id, handle: handle(id), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: at(x) })

// Dimension ids carry the time; a fixed clock keeps the recorded requests the same.
vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000)
beforeEach(() => set({ plate: [block('a', 100), block('b', 150)], selection: 'a', selectedIds: ['a'] }))

describe('dimension words', () => {
  it('offers the kinds a measurement can keep', () => {
    const plane = { kind: 'plane' as const, point: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], areaMm2: 1 }
    expect(keepableKinds([plane, plane], true, true)).toEqual(['distance', 'angle'])
    expect(keepableKinds([{ kind: 'circle', center: [0, 0, 0], axis: [0, 0, 1], radius: 2, sweepDeg: 360 }], false, false)).toEqual(['diameter', 'radius'])
    expect(keepableKinds([{ kind: 'edge', a: [0, 0, 0], b: [1, 0, 0] }], false, false)).toEqual(['length'])
    expect(keepableKinds([plane], false, false)).toEqual([])
    expect(dimensionText({ kind: 'diameter' }, { status: 'ok', value: 5, unit: 'mm' })).toBe('Ø 5.00 mm')
    expect(dimensionText({ kind: 'angle' }, { status: 'ok', value: 90, unit: 'deg' })).toBe('90.0°')
    expect(dimensionText({ kind: 'distance' }, { status: 'lost', unit: 'mm' })).toBe('Lost')
    expect(wholeTriangle({ ...block('x', 0), parts: [boxMesh(1, 1, 1), boxMesh(1, 1, 1)] }, 1, 3)).toBe(15)
  })
})

describe('kept dimensions on the model', () => {
  it('keeps a distance, follows a pushed face in the same undo step, and redraws', async () => {
    const top = { objectId: 'a', partIndex: 0, triangle: 2, at: [100, 100, 20] as [number, number, number] }
    const bottom = { objectId: 'a', partIndex: 0, triangle: 0, at: [100, 100, 0] as [number, number, number] }
    const d = await keepDimension('distance', [top, bottom], 20)
    expect(get().plate[0]!.dimensions).toEqual([d])
    // Anchors are local to the mesh: the object's x of 100 is gone.
    expect(d.a.pick.at).toEqual([0, 0, 20])
    const h = createHistory(appStore)
    const face = await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 20] })
    await applyPush(host, face, 5)
    const followed = get().plate[0]!.dimensions![0]!
    expect(followed.value).toBeCloseTo(25)
    const ev = await evaluateDimensions([followed], objectsFor(get().plate, [followed]))
    expect(ev[0]).toMatchObject({ status: 'ok', unit: 'mm' })
    expect(ev[0]!.value).toBeCloseTo(25)
    const mark = markFor(followed, ev[0]!, get().plate)!
    expect(mark.label).toBe('25.00 mm')
    expect(mark.from[0]).toBeCloseTo(100)
    // One undo takes back the push and the moved anchors together.
    h.undo()
    expect(get().plate[0]!.dimensions![0]).toEqual(d)
    h.dispose()
  })

  it('shows a dimension as lost when the object it ends on is gone, and removes it', async () => {
    const d = await keepDimension('distance', [{ objectId: 'a', partIndex: 0, triangle: 6, at: [110, 100, 10] }, { objectId: 'b', partIndex: 0, triangle: 10, at: [140, 100, 10] }])
    const ok = await evaluateDimensions([d], objectsFor(get().plate, [d]))
    expect(ok[0]!.value).toBeCloseTo(30)
    set({ plate: get().plate.filter((e) => e.id !== 'b') })
    const lost = await evaluateDimensions([d], objectsFor(get().plate, [d]))
    expect(lost[0]).toMatchObject({ status: 'lost', lost: ['b'] })
    expect(markFor(d, lost[0]!, get().plate)).toBeNull()
    removeDimension(d.id)
    expect(allDimensions(get().plate)).toEqual([])
  })

  it('draws a kept diameter across its circle', () => {
    const d: Dimension = { id: 'd9', kind: 'diameter', a: { object: 'a', pick: { triangle: 0, at: [0, 0, 0] }, snapMm: 0, feature: { kind: 'circle', center: [0, 0, 20], axis: [0, 0, 1], radius: 3, sweepDeg: 360 } } }
    const m = markFor(d, { id: 'd9', status: 'ok', value: 6, unit: 'mm', changed: false, a: d.a }, get().plate)!
    expect(m.label).toBe('Ø 6.00 mm')
    expect(Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1], m.to[2] - m.from[2])).toBeCloseTo(6)
    expect((m.from[0] + m.to[0]) / 2).toBeCloseTo(100)
  })
})
