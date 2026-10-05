// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { duplicatePlate } from '../src/plate/plates'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const at = (x: number) => compose({ position: [x, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })

function entry(id: string, extra: Partial<PlateEntry> = {}): PlateEntry {
  return { id, name: id, handle: handle(id), parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: at(50), ...extra }
}

describe('duplicate plate', () => {
  beforeEach(() => {
    const a = entry('a', { partSettings: { Body: { wall_loops: 4 } }, volumes: [{ id: 'v1', name: 'Neg', role: 'negative', handle: handle('v1'), part: boxMesh(2, 2, 2), local: at(0) }] })
    const b = entry('b', { instanceOf: 'a', transform: at(120) })
    set({
      plate: [a, b],
      plates: [
        { id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-object', bedType: 'textured-pei' } },
        { id: 'p2', name: 'Plate 2', objects: [], settings: { sequence: 'by-layer' } },
      ],
      activePlate: 'p1',
      objectSettings: { a: { layer_height: 0.12 } },
    })
  })

  it('copies objects, volumes, instances and settings onto a new plate after the original', () => {
    const id = duplicatePlate()!
    const s = get()
    expect(s.plates.map((p) => p.id)).toEqual(['p1', id, 'p2'])
    expect(s.activePlate).toBe(id)
    expect(s.plates[1]!.name).toBe('Plate 1 copy')
    expect(s.plates[1]!.settings).toEqual({ sequence: 'by-object', bedType: 'textured-pei' })
    const [a, b] = s.plate
    expect(s.plate).toHaveLength(2)
    expect(a!.id).not.toBe('a')
    expect(a!.transform).toEqual(at(50))
    expect(a!.partSettings).toEqual({ Body: { wall_loops: 4 } })
    expect(a!.volumes![0]!.id).not.toBe('v1')
    // The instance follows its new source, and object settings follow the source.
    expect(b!.instanceOf).toBe(a!.id)
    expect(s.objectSettings[a!.id]).toEqual({ layer_height: 0.12 })
  })

  it('leaves the original plate as it was', () => {
    duplicatePlate()
    const s = get()
    const original = s.plates.find((p) => p.id === 'p1')!
    expect(original.objects.map((o) => o.id)).toEqual(['a', 'b'])
    expect(s.objectSettings['a']).toEqual({ layer_height: 0.12 })
  })

  it('an unknown plate is not copied', () => {
    expect(duplicatePlate('nope')).toBeNull()
  })
})
