// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a 3MF with textures as a design, painted from them, as a client does: the server reads the file and its
// texture2d groups with the sx-geom program (format.read3mf, paint.texture) and the parts come back with color paint.
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, noSxGeom, sxBin, sxTimeout, text } from './helpers'

const fixture = join(__dirname, '..', '..', 'geom', 'tests', 'fixtures', 'texture', 'textured-cube.3mf')

interface Opened {
  design: string
  parts: { slot: number; triangles: number; paintedTriangles?: Record<string, number> }[]
  texture?: { colors: number[]; slots: { slot: number; areaMm2: number }[]; palette?: string[]; notes: string[] }
}

describe.skipIf(noSx() || noSxGeom())('a textured 3MF opened as a design', () => {
  it(
    'paints each part from the texture to the nearest filament, and the most area becomes the part\'s own',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      const file = join(h.dir, 'textured-cube.3mf')
      copyFileSync(fixture, file)
      const r = await h.call('slicerx_design_open', { path: file, texture: { filaments: ['#e6141e', '#14c828', '#1428dc', '#f5f5f5'] } })
      expect(r.isError, text(r)).toBeFalsy()
      const [cube] = data<{ output: { designs: Opened[] } }>(r).output.designs
      expect(cube?.texture?.colors).toEqual([1, 2, 3, 4])
      const area = Object.fromEntries((cube?.texture?.slots ?? []).map((s) => [s.slot, Math.round(s.areaMm2)]))
      expect(area).toEqual({ 1: 500, 2: 500, 3: 500, 4: 900 })
      // white covers the most: the part prints white, and the rest is paint
      expect(cube?.parts[0]?.slot).toBe(4)
      expect(cube?.parts[0]?.paintedTriangles?.['color']).toBeGreaterThan(0)

      // without the texture option the file opens as it always has
      const plain = data<{ output: { designs: Opened[] } }>(await h.call('slicerx_design_open', { path: file })).output.designs[0]
      expect(plain?.texture).toBeUndefined()
      expect(plain?.parts[0]?.paintedTriangles).toBeUndefined()
    },
    sxTimeout,
  )

  it(
    'picks the filament colors from the texture in palette mode',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      const file = join(h.dir, 'textured-cube.3mf')
      copyFileSync(fixture, file)
      const r = await h.call('slicerx_design_open', { path: file, texture: { filaments: ['#000000', '#000000', '#000000', '#000000'], mode: 'palette' } })
      expect(r.isError, text(r)).toBeFalsy()
      const [cube] = data<{ output: { designs: Opened[] } }>(r).output.designs
      expect(cube?.texture?.palette).toHaveLength(4)
      expect(cube?.texture?.palette).not.toContain('#000000')
      expect(Object.values(Object.fromEntries((cube?.texture?.slots ?? []).map((s) => [s.slot, Math.round(s.areaMm2)]))).sort()).toEqual([500, 500, 500, 900])
    },
    sxTimeout,
  )

  it(
    'opens a 3MF without textures as before when asked to paint from them',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      const ns = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
      const v = (x: number, y: number, z: number) => `<vertex x="${x}" y="${y}" z="${z}"/>`
      const model = `<?xml version="1.0"?><model unit="millimeter" ${ns}><resources><object id="1" type="model"><mesh><vertices>${v(0, 0, 0)}${v(10, 0, 0)}${v(0, 10, 0)}${v(0, 0, 10)}</vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`
      const file = join(h.dir, 'plain.3mf')
      writeFileSync(file, writeZip([{ name: '3D/3dmodel.model', data: model }]))
      const r = await h.call('slicerx_design_open', { path: file, texture: { filaments: ['#ffffff', '#000000'] } })
      expect(r.isError, text(r)).toBeFalsy()
      const [d] = data<{ output: { designs: Opened[] } }>(r).output.designs
      expect(d?.texture).toBeUndefined()
      expect(d?.parts.map((p) => [p.slot, p.triangles, p.paintedTriangles])).toEqual([[1, 4, undefined]])
    },
    sxTimeout,
  )

  it(
    'refuses a filament that is not #rrggbb',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      const file = join(h.dir, 'textured-cube.3mf')
      copyFileSync(fixture, file)
      const r = await h.call('slicerx_design_open', { path: file, texture: { filaments: ['red'] } })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('filaments')
    },
    sxTimeout,
  )
})
