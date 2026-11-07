// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings that make no sense at 0 (a flow ratio, a layer height, a diameter, a clearance): a client that sets one
// to 0 is refused with the setting's usual range message, both when it slices with the value as an override and when
// it asks for the config to be checked. A project file that holds 0 opens with the value as the file has it.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, data, text } from './helpers'

/** Each setting, whether it holds one value per filament or extruder, and the message its 0 is refused with. */
const NO_ZERO: { key: string; list: boolean; message: string }[] = [
  { key: 'bridge_flow', list: false, message: 'Bridge flow ratio is 0, outside 0.01 to 2.' },
  { key: 'internal_bridge_flow', list: false, message: 'Internal bridge flow ratio is 0, outside 0.01 to 2.' },
  { key: 'layer_height', list: false, message: 'Layer height is 0; it must be at least 0.01 mm.' },
  { key: 'initial_layer_print_height', list: false, message: 'First layer height is 0; it must be at least 0.01 mm.' },
  { key: 'filament_diameter', list: true, message: 'Filament diameter is 0; it must be at least 0.01 mm.' },
  { key: 'filament_flow_ratio', list: true, message: 'Flow ratio is 0, outside 0.01 to 2.' },
  { key: 'nozzle_diameter', list: true, message: 'Nozzle diameter is 0, outside 0.01 to 100 mm.' },
  { key: 'nozzle_height', list: false, message: 'Nozzle height is 0; it must be at least 0.01 mm.' },
  { key: 'extruder_clearance_height_to_lid', list: false, message: 'Extruder clearance height to lid is 0; it must be at least 0.01 mm.' },
  { key: 'extruder_clearance_height_to_rod', list: false, message: 'Extruder clearance height to rod is 0; it must be at least 0.01 mm.' },
  { key: 'extruder_clearance_radius', list: false, message: 'Extruder clearance radius is 0; it must be at least 0.01 mm.' },
]

type Issue = { code: string; severity: string; keys: string[]; message: string }

describe('a setting that cannot be 0', () => {
  it.each(NO_ZERO)('$key at 0 is refused', async ({ key, list, message }) => {
    const h = await connect()
    try {
      const zero = list ? [0] : 0
      const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), overrides: { [key]: zero } })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('Invalid overrides')
      expect(text(r)).toContain(message)
      const v = data<{ valid: boolean; issues: Issue[] }>(await h.call('slicerx_validate_config', { config: { [key]: zero } }))
      expect(v.valid).toBe(false)
      expect(v.issues.filter((i) => i.code === 'out_of_range')).toEqual([expect.objectContaining({ severity: 'error', keys: [key], message })])
    } finally { await h.client.close() }
  })
})

describe('a project file that holds 0 for one of them', () => {
  it('opens with the value as the file has it', async () => {
    const h = await connect()
    try {
      const settings = Object.fromEntries(NO_ZERO.map(({ key, list }) => [key, list ? ['0'] : '0']))
      const path = join(h.dir, 'zeros.3mf')
      const MODEL = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="20"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
      writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: MODEL }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
      const config = readProjectFile(path).config
      for (const { key, list } of NO_ZERO) expect(config[key], key).toEqual(list ? [0] : 0)
    } finally { await h.client.close() }
  })
})
