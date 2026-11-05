// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's own layer heights in a project file: written as each object's layer_height_profile, from its bottom to its
// top, the form other slicers' project files use, and read back onto the plate.
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { readLayerHeights } from '@slicerx/threemf/layer-heights'
import { readProject } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { zip } from '../src/export/zip'
import { plateProfileFromFile } from '../src/plate/layer-profile'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const LIMITS = { minMm: 0.08, maxMm: 0.28 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const box = (id: string, x: number, h: number): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(10, 10, h), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const PROFILE: [number, number][] = [[0.2, 0.12], [4, 0.12], [8, 0.24]]
const input = (profile?: [number, number][]) => ({ plates: [{ id: 'p1', name: 'Plate 1', objects: [box('tall', 50, 10), box('short', 100, 6)], settings: profile ? { layerProfile: profile } : {} }], bed, settings: {} })

describe('a plate profile in a project file', () => {
  it('is written per object, from 0 to each object height, ending on its top', () => {
    const part = projectFiles(input(PROFILE)).find((f) => f.name === 'Metadata/layer_heights_profile.txt')
    expect(String(part!.data).split('\n')).toEqual([
      'object_id=1|0,0.12,0.2,0.12,4,0.12,8,0.24,10,0.24',
      'object_id=2|0,0.12,0.2,0.12,4,0.12,6,0.18',
      '',
    ])
  })

  it('is not written for a plate without one', () => {
    expect(projectFiles(input()).some((f) => f.name.includes('layer_heights_profile'))).toBe(false)
  })

  it('reads back onto the plate: the tallest object keeps the whole curve', async () => {
    const p = await readProject(writeProject(input(PROFILE)), bed)
    const objs = p.plates[0]!.objects
    expect(objs.map((o) => o.layerProfile?.length)).toEqual([5, 4])
    const got = plateProfileFromFile(objs.map((o) => ({ name: o.name, ...(o.layerProfile ? { points: o.layerProfile } : {}), entry: { parts: o.parts, transform: o.transform } })), LIMITS)
    expect(got!.points).toEqual([[0, 0.12], [0.2, 0.12], [4, 0.12], [8, 0.24], [10, 0.24]])
    expect(got!.clamped).toBe(false)
  })

  it("reads another slicer's file under the older part name, numbering objects from 1", async () => {
    const files = projectFiles(input()).concat([{ name: 'Metadata/Slic3r_PE_layer_heights_profile.txt', data: 'object_id=2|0,0.1,3,0.3,6,0.3\n' }])
    const objs = (await readProject(zip(files), bed)).plates[0]!.objects
    expect(objs[0]!.layerProfile).toBeUndefined()
    expect(objs[1]!.layerProfile).toEqual([[0, 0.1], [3, 0.3], [6, 0.3]])
  })

  it('keeps a profile outside the printer limits inside them', () => {
    const got = plateProfileFromFile([{ name: 'a', points: [[0, 0.02], [3, 0.5]] }], LIMITS)
    expect(got).toEqual({ points: [[0, 0.08], [3, 0.28]], clamped: true })
  })

  it('reads untrusted lines safely: bad numbers, an odd count and junk lines are left out', () => {
    expect([...readLayerHeights('object_id=1|0,0.2,x,0.3,1,0.1,7\nobject_id=x|0,1\njunk\nobject_id=3|\n')]).toEqual([[1, [[0, 0.2], [1, 0.1]]]])
  })
})
