// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Kept dimensions in the project file: Metadata/slicerx_dimensions.json as docs/cad-engine.md gives it.
import type { MeshHandle } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import type { Dimension } from '../src/geom/cad'
import { parseDimensions, readProject } from '../src/export/import3mf'
import { dimensionsJson, writeProject } from '../src/export/threemf'
import { unzipStored } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry, PlateMeta } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const bed = { widthMm: 256, depthMm: 256 }
const plane = (z: number, nz: number) => ({ kind: 'plane' as const, point: [10, 10, z] as [number, number, number], normal: [0, 0, nz] as [number, number, number], areaMm2: 400 })
// The example from docs/cad-engine.md, kept on the plate object 'obj_a'.
const dim: Dimension = {
  id: 'd1',
  kind: 'distance',
  a: { object: 'obj_a', pick: { triangle: 2, at: [10, 10, 20] }, snapMm: 0, feature: { ...plane(20, 1), triangles: [2, 3] } },
  b: { object: 'obj_a', pick: { triangle: 0, at: [10, 10, 0] }, snapMm: 0, feature: plane(0, -1) },
  value: 20,
}
const entry = (id: string, x: number, dims?: Dimension[]): PlateEntry => ({ id, name: id, handle: handle(id), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), ...(dims ? { dimensions: dims } : {}) })
const project = (objects: PlateEntry[]): PlateMeta[] => [{ id: 'p1', name: 'Plate 1', objects, settings: { sequence: 'by-layer' } }]
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

describe('dimensions in the project file', () => {
  it('writes the exact JSON from the engine doc, with 3MF object ids', () => {
    const files = unzipStored(writeProject({ plates: project([entry('obj_z', 40), entry('obj_a', 100, [dim])]), bed, settings: {} }))
    const json = JSON.parse(text(files.get('Metadata/slicerx_dimensions.json')))
    // Parts take ids 1 and 3, the objects 2 and 4.
    expect(json).toEqual({
      version: 1,
      dimensions: [
        {
          id: 'd1',
          kind: 'distance',
          a: { object: '4', pick: { triangle: 2, at: [10, 10, 20] }, snapMm: 0, feature: { kind: 'plane', point: [10, 10, 20], normal: [0, 0, 1], areaMm2: 400 } },
          b: { object: '4', pick: { triangle: 0, at: [10, 10, 0] }, snapMm: 0, feature: { kind: 'plane', point: [10, 10, 0], normal: [0, 0, -1], areaMm2: 400 } },
          value: 20,
        },
      ],
    })
    expect(text(files.get('3D/3dmodel.model'))).toContain('<object id="4" type="model">')
    expect(text(files.get('[Content_Types].xml'))).toContain('Extension="json"')
  })

  it('leaves the part out without dimensions, and such a project opens with none', async () => {
    const bytes = writeProject({ plates: project([entry('obj_a', 100)]), bed, settings: {} })
    expect(unzipStored(bytes).has('Metadata/slicerx_dimensions.json')).toBe(false)
    const p = await readProject(bytes, bed)
    expect(p.dimensions).toEqual([])
    expect(p.plates[0]!.objects).toHaveLength(1)
  })

  it('reads its own dimensions back by object id', async () => {
    const p = await readProject(writeProject({ plates: project([entry('obj_z', 40), entry('obj_a', 100, [dim])]), bed, settings: {} }), bed)
    const objs = p.plates[0]!.objects
    expect(objs.map((o) => o.fileId)).toEqual(['2', '4'])
    expect(p.dimensions).toHaveLength(1)
    const back = p.dimensions[0]!
    expect(back.a.object).toBe('4')
    // Everything but the object ids and the dropped triangle hint comes back as it went in.
    expect({ ...back, a: { ...back.a, object: 'obj_a' }, b: { ...back.b!, object: 'obj_a' } }).toEqual({ ...dim, a: { ...dim.a, feature: plane(20, 1) } })
  })

  it('distrusts the part: newer versions, bad fields and missing objects are dropped', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
    const good = JSON.parse(dimensionsJson([entry('obj_a', 0, [dim])], new Map([['obj_a', 4]]))!) as { dimensions: unknown[] }
    const ids = new Set(['4'])
    expect(parseDimensions(enc({ version: 2, dimensions: good.dimensions }), ids)).toEqual([])
    expect(parseDimensions(enc(good), ids)).toHaveLength(1)
    expect(parseDimensions(enc({ ...good, version: 1 }), new Set(['9']))).toEqual([])
    const broken = { version: 1, dimensions: [{ ...(good.dimensions[0] as object), kind: 'volume' }, { ...(good.dimensions[0] as object), b: undefined }, 'junk'] }
    expect(parseDimensions(enc(broken), ids)).toEqual([])
    expect(parseDimensions(new TextEncoder().encode('{not json'), ids)).toEqual([])
    expect(parseDimensions(undefined, ids)).toEqual([])
  })
})
