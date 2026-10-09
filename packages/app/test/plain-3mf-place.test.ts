// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A 3MF that is no slicer's project (a CAD export or a downloaded model, in the modeler's own coordinates) opens
// centered on the bed with every object resting on it, as Orca places one. A project keeps its placement, apart from an
// object a hair under the bed from the rounding of its transforms, which is set down on it.
import { describe, expect, it } from 'vitest'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { bounds } from '../src/plate/transform'

const bed = { widthMm: 256, depthMm: 256 }

/** A 10 mm cube with its corner at (x, y, z), as one 3MF object. */
function cube(id: number, x: number, y: number, z: number): string {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([a, b, c]) => `<vertex x="${a! + x}" y="${b! + y}" z="${c! + z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube(1, -45, -12, 2)}${cube(2, 20, -12, 0)}</resources><build><item objectid="1"/><item objectid="2"/></build></model>`

const box = (o: { parts: Parameters<typeof bounds>[0]; transform: number[] }) => bounds(o.parts, o.transform)!

describe('a plain 3MF', () => {
  it('opens centered on the bed, each object resting on it, the objects keeping their layout', async () => {
    const p = await readProject(zip([{ name: '3D/3dmodel.model', data: MODEL }]), bed)
    const [a, b] = p.plates[0]!.objects.map(box)
    // The pair spans x -45 to 30 and y -12 to -2 in the file: 75 by 10 mm, centered on (128, 128).
    expect((a!.min[0] + b!.max[0]) / 2).toBeCloseTo(128)
    expect((a!.min[1] + a!.max[1]) / 2).toBeCloseTo(128)
    expect(b!.min[0] - a!.max[0]).toBeCloseTo(55)
    expect(a!.min[2]).toBeCloseTo(0)
    expect(b!.min[2]).toBeCloseTo(0)
  })

  it('keeps a project where it was placed', async () => {
    const bytes = zip([
      { name: '3D/3dmodel.model', data: MODEL },
      { name: 'Metadata/project_settings.config', data: JSON.stringify({ layer_height: '0.2' }) },
    ])
    const [a] = (await readProject(bytes, bed)).plates[0]!.objects.map(box)
    expect(a!.min[0]).toBeCloseTo(-45)
  })

  it('sets a project object that sits a hair under the bed down on it, and leaves one sunk on purpose', async () => {
    // A cube on its side, turned by a rotation written to three decimals ("0.001" for 0), lands 0.005 mm under the bed.
    const turned = `<object id="3" type="model"><components><component objectid="1" transform="1 0 0 0 0.001 -1 0 1 0.001 0 0 0"/></components></object>`
    const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube(1, 0, -5, -5)}${turned}${cube(2, 0, 0, 0)}</resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 50 50 5"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 50 -1"/></build></model>`
    const bytes = zip([
      { name: '3D/3dmodel.model', data: model },
      { name: 'Metadata/project_settings.config', data: JSON.stringify({ layer_height: '0.2' }) },
    ])
    const [a, sunk] = (await readProject(bytes, bed)).plates[0]!.objects.map(box)
    expect(a!.min[2]).toBeCloseTo(0, 6)
    expect(a!.max[2]).toBeCloseTo(10, 1)
    expect(sunk!.min[2]).toBeCloseTo(-1)
  })
})
