// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a project paints or marks on its own, the brim ears and the pause at a height, comes through a slice of the file.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

const BOX = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>`

const EARS = 'brim_points_format_version=0\nobject_id=1|0 0 0 5 20 20 0 5\n'
const MARKS = '<?xml version="1.0"?><custom_gcodes_per_layer><plate><plate_info id="1"/><layer top_z="4.0" type="1" extruder="1" color="" extra="" gcode="M601"/></plate></custom_gcodes_per_layer>'

describe('a project with painted brim ears and a layer mark', () => {
  it.skipIf(noSx())('prints the ears and writes the pause when the file is sliced', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const slice = async (name: string, extra: { name: string; data: string }[]) => {
      const path = join(h.dir, name)
      writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: BOX }, ...extra]))
      const r = await h.call('slicerx_slice_file', { model: path, profiles: ['filament:pla'], overrides: { layer_height: 0.2, brim_type: 'painted', brim_width: 6, skirt_loops: 0 } })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      return readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8')
    }
    const bare = await slice('bare.3mf', [])
    expect(bare).not.toContain(';TYPE:Brim')
    expect(bare).not.toContain('M601')
    const marked = await slice('marked.3mf', [
      { name: 'Metadata/brim_ear_points.txt', data: EARS },
      { name: 'Metadata/custom_gcode_per_layer.xml', data: MARKS },
    ])
    expect(marked).toContain(';TYPE:Brim')
    expect(marked.match(/M601/g)).toHaveLength(1)
  })
})
