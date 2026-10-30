// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a project paints or marks on its own, the brim ears, the pause and the tool change at a height, comes through a
// slice of the file.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

const TOOL = (mode: string) => `<?xml version="1.0"?><custom_gcodes_per_layer><plate><plate_info id="1"/><layer top_z="5.0" type="2" extruder="2" color="" extra="" gcode="tool_change"/><mode value="${mode}"/></plate></custom_gcodes_per_layer>`

describe('a project with a tool change at a height', () => {
  it.skipIf(noSx())('changes filament on that layer, or notes why it does not', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const slice = async (name: string, mode: string) => {
      const path = join(h.dir, name)
      writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: BOX }, { name: 'Metadata/custom_gcode_per_layer.xml', data: TOOL(mode) }]))
      const r = await h.call('slicerx_slice_file', { model: path, profiles: ['filament:pla'], overrides: { layer_height: 0.2, initial_layer_print_height: 0.2, skirt_loops: 0 } })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      const d = data<{ gcode_path: string; warning_details?: { code: string; message: string }[] }>(r)
      // The tool commands after the first layer's own selection, by layer (1-based).
      const lines = readFileSync(d.gcode_path, 'utf8').split('\n')
      let layer = 0
      const tools: string[] = []
      for (const l of lines) {
        if (/^;\s?(LAYER_CHANGE|CHANGE_LAYER)/.test(l)) layer++
        else if (layer > 1 && /^T\d+\s*$/.test(l)) tools.push(`${layer}:${l.trim()}`)
      }
      return { tools, notes: (d.warning_details ?? []).filter((w) => w.code === 'tool_change_skipped').map((w) => w.message) }
    }
    expect(await slice('change.3mf', 'MultiAsSingle')).toEqual({ tools: ['25:T1'], notes: [] })
    expect(await slice('several.3mf', 'MultiExtruder')).toEqual({
      tools: [],
      notes: ['Tool change at 5 mm to filament 2 skipped: the project saved it for a plate that prints several filaments.'],
    })
  })
})

describe('a Bambu Lab project with a tool change to a filament its parts do not use', () => {
  it.skipIf(noSx())('slices with that filament\'s settings, as the app opens it', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    // The box prints on filament 2 and the change at 5 mm goes to filament 4 (packages/core/cli/tests/fixtures).
    const model = join(h.dir, 'a1-cc.3mf')
    writeFileSync(model, readFileSync(resolve(__dirname, '../../core/cli/tests/fixtures/layer-tool-change/a1-cc.3mf')))
    const r = await h.call('slicerx_slice_file', { model, plate: 1, profiles: ['machine:bambu-a1'], project_settings: true })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const out = data<{ gcode_path: string }>(r).gcode_path
    const request = JSON.parse(readFileSync(join(dirname(out), 'request.json'), 'utf8')) as { config: Record<string, unknown> }
    expect((request.config['filament_colour'] as unknown[]).length).toBe(4)
  })
})

describe('a Bambu Lab project with a color change at a height', () => {
  it.skipIf(noSx())('pauses the print there for a filament swap by hand, with no M600', { timeout: sxTimeout }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    // One box on filament 4 of five on an A1, with and without a color change at 5 mm (packages/core/cli/tests/fixtures).
    const slice = async (dir: string, name: string) => {
      const model = join(h.dir, `${name}.3mf`)
      writeFileSync(model, readFileSync(resolve(__dirname, `../../core/cli/tests/fixtures/${dir}/${name}.3mf`)))
      const r = await h.call('slicerx_slice_file', { model, plate: 1, profiles: ['machine:bambu-a1'], project_settings: true })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      return readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8').split('\n')
    }
    const marked = await slice('color-change', 'a1-f5cc')
    const plain = await slice('layer-tools', 'a1-s4')
    let layer = 0
    const pauses: number[] = []
    for (const l of marked) {
      if (l.startsWith('; CHANGE_LAYER')) layer++
      else if (l.trim() === 'M400 U1') pauses.push(layer)
    }
    expect(pauses).toEqual([25])
    expect(marked.filter((l) => /^M600\b/.test(l))).toEqual([])
    const fans = (lines: string[]) => lines.filter((l) => l.startsWith('M106')).length
    expect(fans(marked)).toBe(fans(plain))
  })
})
