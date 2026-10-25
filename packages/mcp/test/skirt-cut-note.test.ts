// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A skirt that would run off the bed is cut to it, and the slice says so: a client slicing a plate whose part stands
// near the back edge gets the note naming it in the slice warnings, and the skirt in the G-code stays on the bed.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const A1 = ['machine:bambu-a1', 'process:standard']
const SKIRT = { skirt_loops: 1, skirt_distance: 2, skirt_height: 1, brim_type: 'no_brim' }

/** A project with one 20 mm box named `name`, centered at (`x`, `y`) on the A1's 256 mm bed. */
function project(path: string, name: string, x: number, y: number): string {
  const v: [number, number, number][] = []
  for (let i = 0; i < 8; i++) v.push([i & 1 ? 10 : -10, i & 2 ? 10 : -10, i & 4 ? 5 : 0])
  const faces = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  const mesh = `<mesh><vertices>${v.map(([a, b, c]) => `<vertex x="${a}" y="${b}" z="${c}"/>`).join('')}</vertices><triangles>${faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="${name}" type="model">${mesh}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} 0"/></build></model>`
  const config = `<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="${name}"/><metadata key="extruder" value="1"/></object></config>`
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: model },
    { name: 'Metadata/model_settings.config', data: config },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ printer_settings_id: 'Bambu Lab A1 0.4 nozzle' }) },
  ]))
  return path
}

/** The largest Y of the skirt's extruding moves in a G-code file. */
function skirtBack(gcode: string): number {
  let on = false
  let back = -Infinity
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; FEATURE: ')) on = line.slice(11).trim() === 'Skirt'
    else if (on && line.startsWith('G1 ') && / E[\d.]/.test(line)) {
      const y = / Y(-?[\d.]+)/.exec(line)
      if (y) back = Math.max(back, Number(y[1]))
    }
  }
  return back
}

describe.skipIf(noSx())('a skirt cut to the bed', () => {
  it('slices with the skirt on the bed and returns the note naming the part', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    // The box's back edge 2 mm from the bed's: its skirt, 2 mm out, would leave the bed.
    const r = await h.call('slicerx_slice_file', { model: project(join(h.dir, 'edge.3mf'), 'edge box', 128, 244), profiles: A1, overrides: SKIRT })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ warnings: string[]; gcode_path: string }>(r)
    // A model sliced on its own is named by its file.
    expect(out.warnings, JSON.stringify(out.warnings)).toContain('The skirt near "edge.3mf" was cut to fit on the bed')
    const back = skirtBack(readFileSync(out.gcode_path, 'utf8'))
    expect(back).toBeGreaterThan(255)
    expect(back).toBeLessThanOrEqual(256)
  })

  it('says nothing about a skirt that fits', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: project(join(h.dir, 'middle.3mf'), 'middle box', 128, 128), profiles: A1, overrides: SKIRT })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ warnings: string[] }>(r)
    expect(out.warnings.filter((w) => w.includes('skirt'))).toEqual([])
  })
})
