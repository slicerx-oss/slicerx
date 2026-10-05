// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { modifierSettings } from '../src/export/project-settings'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { partOverridesOf, setPartSetting } from '../src/plate/object-settings'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

function entry(id: string): PlateEntry {
  const a = { ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }
  const b = { ...boxMesh(6, 6, 6), name: 'Lid', slot: 1 }
  return { id, name: 'Box', handle: handle(id), parts: [a, b], colors: ['#fff', '#fff'], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

describe('per-part settings', () => {
  beforeEach(() => set({ plate: [entry('o1')], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1' }))

  it('sets, changes and clears a key on one part', () => {
    setPartSetting('o1', 'Lid', 'wall_loops', 4)
    expect(get().plate[0]!.partSettings).toEqual({ Lid: { wall_loops: 4 } })
    setPartSetting('o1', 'Lid', 'sparse_infill_density', '50%')
    expect(partOverridesOf(get().plate, get().plate[0]!)['Lid']).toEqual({ wall_loops: 4, sparse_infill_density: '50%' })
    setPartSetting('o1', 'Lid', 'wall_loops', undefined)
    setPartSetting('o1', 'Lid', 'sparse_infill_density', undefined)
    expect(get().plate[0]!.partSettings).toBeUndefined()
  })

  it('an instance reads the settings of the object it copies', () => {
    setPartSetting('o1', 'Body', 'wall_loops', 3)
    const inst = { ...entry('o2'), instanceOf: 'o1' }
    expect(partOverridesOf(get().plate, inst)).toEqual({ Body: { wall_loops: 3 } })
  })

  it('round-trips through a project file', async () => {
    const e = { ...entry('o1'), partSettings: { Lid: { wall_loops: 4, detect_thin_wall: true } } }
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }], bed, settings: {} })
    const p = await readProject(bytes, bed)
    const o = p.plates[0]!.objects[0]!
    expect(Object.keys(o.rawPartSettings ?? {})).toEqual(['Lid'])
    expect(modifierSettings(o.rawPartSettings!['Lid']!)).toEqual({ wall_loops: 4, detect_thin_wall: true })
  })
})
