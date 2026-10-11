// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A 3MF in inches comes in as millimeters, attributes in any order are read, and parts placed by components, directly
// and through a nested component, all come in (findings CAD-006, CAD-007 and CAD-008 of the October 2026 review). Each
// case runs through the TypeScript reader, and through the geometry engine's reader when the engine is built
// (packages/geom/wasm/scripts/build.sh). Placement on the bed moves objects, so the checks are on sizes and distances.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { projectOf, readProjectsWithGeom, scanProjectFile } from '../src/export/import3mf'
import { setGeomProvider } from '../src/geom/client'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { zip } from '../src/export/zip'

const wasm = join(__dirname, '..', '..', 'geom', 'wasm', 'pkg', 'sx_geom_core.wasm')
const engine = existsSync(wasm) ? ((await WebAssembly.instantiate(readFileSync(wasm), {})).instance.exports as unknown as GeomExports) : null

const vertices = '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>'
const triangles = '<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>'
const object = (v = vertices) => `<object id="1" type="model"><mesh><vertices>${v}</vertices><triangles>${triangles}</triangles></mesh></object>`

function project(unit: string, resources: string, items: string): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: `<?xml version="1.0"?><model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${resources}</resources><build>${items}</build></model>` },
  ])
}

const bed = { widthMm: 256, depthMm: 256 }
const xs = (p: { positions: Float32Array }) => Array.from(p.positions).filter((_, i) => i % 3 === 0)
const size = (p: { positions: Float32Array }) => Math.max(...xs(p)) - Math.min(...xs(p))

afterAll(() => {
  setGeomProvider(null)
  readProjectsWithGeom(true)
})

for (const reader of ['typescript', 'engine'] as const) {
  describe.skipIf(reader === 'engine' && !engine)(`the ${reader} reader`, () => {
    async function read(bytes: Uint8Array) {
      readProjectsWithGeom(reader === 'engine')
      setGeomProvider(reader === 'engine' ? { call: async <T,>(op: string, r: unknown) => callEngine(engine!, op, r) as T } : null)
      const scanned = await scanProjectFile(bytes)
      expect(scanned.parsedIn).toBe(reader === 'engine' ? 'geom' : 'page')
      return projectOf(scanned, bed)
    }

    it('reads an inch file in millimeters, its translations too', async () => {
      const p = await read(project('inch', object(), '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>'))
      const [a, b] = p.plates[0]!.objects
      expect(size(a!.parts[0]!)).toBeCloseTo(25.4, 5)
      expect(b!.transform[12]! - a!.transform[12]!).toBeCloseTo(50.8, 4)
    })

    it('reads attributes in any order', async () => {
      const reordered = vertices.replace('<vertex x="1" y="0" z="0"/>', '<vertex y="0" x="1" z="0"/>')
      const p = await read(project('millimeter', object(reordered), '<item objectid="1"/>'))
      expect(size(p.plates[0]!.objects[0]!.parts[0]!)).toBeCloseTo(1, 6)
    })

    it('keeps the parts of direct and nested components', async () => {
      const resources = object() + '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object><object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object>'
      const o = (await read(project('millimeter', resources, '<item objectid="3"/>'))).plates[0]!.objects[0]!
      expect(o.parts).toHaveLength(2)
      const lows = o.parts.map((p) => Math.min(...xs(p))).sort((a, b) => a - b)
      expect(lows[1]! - lows[0]!).toBeCloseTo(20, 5)
    })
  })
}
