// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project saved for a printer with two extruders keeps an object's own speeds as one value per extruder ("50,nil":
// 50 mm/s on the first, the second left to the profile). A client slicing the project's plate through
// slicerx_slice_file gets G-code with the object's inner walls at 50 mm/s and no warning about the values.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const PER_EXTRUDER = ['inner_wall_speed', 'top_surface_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'gap_infill_speed', 'support_speed']

// A 60 x 60 x 6 mm box, big enough that no layer slows down for cooling.
const VERTS = Array.from({ length: 8 }, (_, i) => [i & 1 ? 60 : 0, i & 2 ? 60 : 0, i & 4 ? 6 : 0])
const TRIS = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
const md = (k: string, v: string) => `<metadata key="${k}" value="${v}"/>`

/** A Bambu Studio project for the P1S: the box, with the six speeds as its own settings ("50,nil"). */
function project(path: string): void {
  const mesh = `<mesh><vertices>${VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${TRIS.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.04.61</metadata><resources><object id="1" type="model">${mesh}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 98 98 0"/></build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config><object id="1">${md('name', 'body')}${md('extruder', '1')}${PER_EXTRUDER.map((k) => md(k, '50,nil')).join('')}</object><plate>${md('plater_id', '1')}<model_instance>${md('object_id', '1')}</model_instance></plate></config>`
  const settings = { printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], layer_height: '0.2', initial_layer_print_height: '0.2', inner_wall_speed: ['300', '300'], brim_width: '0', skirt_loops: '0' }
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

/** The feed rates (mm/min) of the inner wall extrusions above the first layer. */
function innerWallFeeds(gcode: string): number[] {
  let here = false
  let layer = 0
  let feed = 0
  const out: number[] = []
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';LAYER_CHANGE') || l.startsWith('; CHANGE_LAYER')) layer++
    else if (l.startsWith('; FEATURE: ') || l.startsWith(';TYPE:')) here = l.replace(/^; FEATURE: |^;TYPE:/, '').trim() === 'Inner wall'
    else if (/^G[123] /.test(l)) {
      const f = /\bF([\d.]+)/.exec(l)
      if (f) feed = Number(f[1])
      if (here && layer > 1 && / E/.test(l) && /[XY]/.test(l)) out.push(feed)
    }
  }
  return out
}

describe.skipIf(noSx())('slicerx_slice_file: an object with per-extruder speeds', { timeout: sxTimeout }, () => {
  it("slices the project's plate with the first extruder's values", async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = join(h.dir, 'two-extruders.3mf')
      project(model)
      const r = await h.call('slicerx_slice_file', { model, plate: 1, project_settings: true })
      expect(r.isError, text(r)).toBeFalsy()
      const out = data<{ gcode_path: string; warnings: string[] }>(r)
      expect(out.warnings.join(' ')).not.toMatch(/inner_wall_speed|cannot use/)
      const feeds = innerWallFeeds(readFileSync(out.gcode_path, 'utf8'))
      expect(feeds.length).toBeGreaterThan(0)
      expect(Math.max(...feeds)).toBe(3000)
    } finally {
      await h.client.close()
    }
  })
})
