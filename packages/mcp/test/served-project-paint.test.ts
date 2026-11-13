// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A 3MF project with paint, opened through the MCP server on a served sx-geom (one process for the server, `sx-geom
// serve`) and read back with slicerx_paint_regions: the paint the file holds is the paint the design has, as it is on
// one process per call. Runs on the real binary named by SLICERX_SX_GEOM_BIN when it has a serve mode, else skips.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { geomEngine } from '../src/geom'
import { servedGeomEngine } from '../src/geom-served'
import { writeZip } from '../src/zip'
import { built, connect, data, GEOM_BUILD, text } from './helpers'

const bin = process.env['SLICERX_SX_GEOM_BIN']

const v = (x: number, y: number, z: number): string => `<vertex x="${x}" y="${y}" z="${z}"/>`
const TRIS = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
/** A closed 20 mm box; its top (triangles 2 and 3) painted filament 2 (`8`). */
const box = `<mesh><vertices>${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => v(i & 1 ? 20 : 0, i & 2 ? 20 : 0, i & 4 ? 20 : 0)).join('')}</vertices><triangles>${TRIS.map(([a, b, c], k) => `<triangle v1="${a}" v2="${b}" v3="${c}"${k === 2 || k === 3 ? ' paint_color="8"' : ''}/>`).join('')}</triangles></mesh>`
const MODEL = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="Box">${box}</object></resources><build><item objectid="1"/></build></model>`

describe.skipIf(!built(bin, GEOM_BUILD))('a painted project on a served sx-geom', () => {
  let serves = false
  beforeAll(async () => {
    serves = await servedGeomEngine(bin!, { perCall: geomEngine(bin!) }).keepsBodies()
  })

  it('opens with its paint, and paint_regions reads it back', async (ctx) => {
    if (!serves) ctx.skip()
    const h = await connect({ engine: 'stub', sxGeomBin: bin })
    const file = join(h.dir, 'painted.3mf')
    writeFileSync(file, writeZip([{ name: '3D/3dmodel.model', data: MODEL }]))
    const opened = await h.call('slicerx_design_open', { path: file })
    expect(opened.isError, text(opened)).toBeFalsy()
    const [design] = data<{ output: { designs: { design: string; parts: { paintedTriangles?: Record<string, number> }[] }[] } }>(opened).output.designs
    expect(design?.parts[0]?.paintedTriangles).toEqual({ color: 2 })
    const read = await h.call('slicerx_paint_regions', { design: design!.design, layer: 'color' })
    expect(read.isError, text(read)).toBeFalsy()
    // the box's top, 20 by 20 mm, in filament 2
    expect(data<{ output: { totalsMm2: Record<string, number> } }>(read).output.totalsMm2).toEqual({ 2: 400 })
  }, 60_000)
})
