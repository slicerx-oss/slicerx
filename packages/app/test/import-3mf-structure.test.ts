// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// 3MF structure the project reader must honor: the model's unit, any XML attribute order, and components inside
// components.
import { describe, expect, it } from 'vitest'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'

const vertices = '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>'
const triangles = '<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>'
const object = (v = vertices, t = triangles, id = 1) => `<object id="${id}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`

function project(unit: string, resources: string, item: string, more: { name: string; data: string }[] = []) {
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: `<?xml version="1.0"?><model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>${resources}</resources><build>${item}</build></model>` },
    // Project settings, so the objects stay where the file puts them (a plain 3MF is centered on the bed instead).
    { name: 'Metadata/project_settings.config', data: '{}' },
    ...more,
  ])
}
const bed = { widthMm: 256, depthMm: 256 }
const xsOf = (parts: { positions: Float32Array }[]) => parts.flatMap((p) => Array.from(p.positions).filter((_, i) => i % 3 === 0))

describe('units', () => {
  it('reads an inch model as millimeters, its geometry and its translation', async () => {
    const result = await readProject(project('inch', object(), '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>'), bed)
    const o = result.plates[0]!.objects[0]!
    expect(Math.max(...o.parts[0]!.positions)).toBeCloseTo(25.4, 5)
    expect(o.transform[12]).toBeCloseTo(50.8, 5)
  })

  it('gives the same millimeters for the same part in every unit', async () => {
    const sizes: Record<string, number> = { micron: 25400, millimeter: 25.4, centimeter: 2.54, inch: 1, foot: 1 / 12, meter: 0.0254 }
    for (const [unit, n] of Object.entries(sizes)) {
      const v = vertices.replace(/"1"/g, `"${n}"`)
      const result = await readProject(project(unit, object(v), `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${2 * n} 0 0"/>`), bed)
      const o = result.plates[0]!.objects[0]!
      expect(Math.max(...o.parts[0]!.positions), unit).toBeCloseTo(25.4, 4)
      expect(o.transform[12], unit).toBeCloseTo(50.8, 4)
    }
  })

  it('reads each model part in its own unit', async () => {
    const part = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${object(vertices, triangles, 7)}</resources><build/></model>`
    const resources = '<object id="2" type="model"><components><component p:path="/3D/Objects/part.model" objectid="7" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object>'
    const result = await readProject(project('millimeter', resources, '<item objectid="2"/>', [{ name: '3D/Objects/part.model', data: part }]), bed)
    const o = result.plates[0]!.objects[0]!
    // A 1 cm part, moved 20 mm by a component written in millimeters.
    expect(Math.max(...xsOf(o.parts)) - Math.min(...xsOf(o.parts))).toBeCloseTo(10, 5)
  })
})
