// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening 3MF projects as designs with the real engine, as a client does: the server reads each file with the
// sx-geom program's 3MF reader (format.read3mf), then the client reads the designs back and works on one.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, noSxGeom, sxBin, sxTimeout, text } from './helpers'

type V3 = [number, number, number]
interface Opened {
  design: string
  name: string
  steps: number
  fromHistory: boolean
  leftOut?: string[]
  sizeMm: V3
  minMm: V3
  volumeMm3: number
  parts: { name: string; slot: number; triangles: number; paintedTriangles?: Record<string, number> }[]
}

const v = (x: number, y: number, z: number): string => `<vertex x="${x}" y="${y}" z="${z}"/>`
const TRIS = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
/** A closed box mesh, its corners shared by the triangles as a slicer writes them; `painted` triangles get a color. */
const box = (s: number, painted: number[] = []): string =>
  `<mesh><vertices>${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => v(i & 1 ? s : 0, i & 2 ? s : 0, i & 4 ? s : 0)).join('')}</vertices><triangles>${TRIS.map(([a, b, c], k) => `<triangle v1="${a}" v2="${b}" v3="${c}"${painted.includes(k) ? ' paint_color="8"' : ''}/>`).join('')}</triangles></mesh>`

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'

describe.skipIf(noSx() || noSxGeom())('opening 3MF projects with the engine', () => {
  it(
    'reads parts in their object, in millimeters, with slots and paint, and leaves out modifiers by name',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      // In centimeters: a 2 cm shell with a 0.5 cm modifier, the build item 5 cm along X and Y, and a second object.
      const model =
        `<?xml version="1.0"?><model unit="centimeter" ${NS}><resources>` +
        `<object id="1" type="model">${box(2, [2, 3])}</object><object id="2" type="model">${box(0.5)}</object>` +
        `<object id="3" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 -1 -1 0"/><component objectid="2"/></components></object>` +
        `<object id="4" type="model" name="Peg">${box(1)}</object>` +
        `</resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 5 5 0"/><item objectid="4"/></build></model>`
      const settings =
        `<?xml version="1.0"?><config><object id="3"><metadata key="name" value="Ball"/><metadata key="extruder" value="1"/>` +
        `<part id="1" subtype="normal_part"><metadata key="name" value="Shell"/><metadata key="extruder" value="3"/></part>` +
        `<part id="2" subtype="modifier_part"><metadata key="name" value="Infill box"/></part></object>` +
        `<object id="4"><metadata key="name" value="Peg"/><metadata key="extruder" value="2"/></object></config>`
      const file = join(h.dir, 'ball.3mf')
      writeFileSync(file, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: settings }]))

      const r = await h.call('slicerx_design_open', { path: file })
      expect(r.isError, text(r)).toBeFalsy()
      const [ball, peg] = data<{ output: { designs: Opened[] } }>(r).output.designs
      expect(ball).toMatchObject({ name: 'Ball', steps: 0, fromHistory: false, leftOut: ['Infill box (modifier part)'] })
      expect(ball?.parts.map((p) => [p.name, p.slot, p.triangles])).toEqual([['Shell', 3, 12]])
      expect(ball?.parts[0]?.paintedTriangles).toEqual({ color: 2 })
      // 20 mm across, centered on the item, which the file puts 50 mm along X and Y.
      expect(ball?.sizeMm).toEqual([20, 20, 20])
      expect(ball?.minMm).toEqual([40, 40, 0])
      expect(ball?.volumeMm3).toBeCloseTo(8000, 3)
      expect(peg).toMatchObject({ name: 'Peg', steps: 0, sizeMm: [10, 10, 10], minMm: [0, 0, 0] })
      expect(peg?.parts.map((p) => p.slot)).toEqual([2])

      // The client reads it back from the list and works on it: a cut through the middle.
      const listed = data<{ output: { designs: { design: string; name: string }[] } }>(await h.call('slicerx_design_list', {})).output.designs
      expect(listed.map((d) => d.name)).toEqual(['Ball', 'Peg'])
      const cut = await h.call('slicerx_geom_cut', { design: ball!.design, plane: { axis: 'z', at: 10 } })
      expect(cut.isError, text(cut)).toBeFalsy()
      expect(data<{ output: Opened }>(cut).output.steps).toBe(1)
    },
    sxTimeout,
  )

  it(
    'opens a saved design with its steps, and refuses a broken file with its reason',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      const ok = async (name: string, args: Record<string, unknown>): Promise<Opened> => {
        const r = await h.call(name, args)
        expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
        return data<{ output: Opened }>(r).output
      }
      const d = (await ok('slicerx_design_new', { name: 'Plate' })).design
      await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, distance_mm: 4 })
      const made = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 8 }, distance_mm: 10, operation: 'join' })
      const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output

      const again = data<{ output: { designs: Opened[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs
      expect(again).toHaveLength(1)
      expect(again[0]).toMatchObject({ name: 'Plate', steps: 2, fromHistory: true })
      expect(again[0]?.volumeMm3).toBeCloseTo(made.volumeMm3, 2)
      // Its steps edit as before: a thinner plate.
      const thinner = await ok('slicerx_design_edit_step', { design: again[0]!.design, step: 1, value: 2 })
      expect(thinner.volumeMm3).toBeLessThan(made.volumeMm3)

      const broken = join(h.dir, 'broken.3mf')
      writeFileSync(broken, writeZip([{ name: '3D/3dmodel.model', data: `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><object id="1" type="model"><mesh><vertices>${v(0, 0, 0)}</vertices><triangles><triangle v1="0" v2="1" v3="7"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>` }]))
      const refused = await h.call('slicerx_design_open', { path: broken })
      expect(refused.isError).toBe(true)
      expect(text(refused)).toMatch(/broken\.3mf/)
    },
    sxTimeout,
  )
})
