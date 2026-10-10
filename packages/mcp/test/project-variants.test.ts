// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio 2 project writes some settings once per hotend variant: filament values once per filament and
// variant (`filament_extruder_variant`), process values once per extruder and variant (`print_extruder_variant`).
// readProjectFile keeps the values that slice, each extruder's own variant, as the app's project open does.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importFlat, selectVariants } from '@slicerx/settings'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect } from './helpers'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

const variants = ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive E3D High Flow']
/** Four filaments, three variants each: filament f's standard variant value is `base + f`, the others far off. */
const perFilament = (base: number) => [0, 1, 2, 3].flatMap((f) => [String(base + f), String(base + 50 + f), String(base + 90 + f)])

/** The settings of an H2D project as Bambu Studio 2 writes them (the keychain project's shape). */
const SETTINGS = {
  printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
  printer_model: 'Bambu Lab H2D',
  print_settings_id: '0.20mm Standard @BBL H2D',
  filament_settings_id: ['Generic PLA @BBL H2D', 'Generic PLA @BBL H2D', 'Bambu PLA Basic @BBL H2D', 'Bambu PLA Basic @BBL H2D'],
  filament_colour: ['#FFFFFF', '#000000', '#8E9089', '#FF6A13'],
  filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
  extruder_type: ['Direct Drive', 'Direct Drive'],
  nozzle_volume_type: ['Standard', 'Standard'],
  filament_extruder_variant: [0, 1, 2, 3].flatMap(() => variants),
  print_extruder_id: ['1', '1', '1', '2', '2', '2', '2'],
  print_extruder_variant: [...variants, 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow', 'Direct Drive E3D High Flow'],
  filament_max_volumetric_speed: ['12', '12', '12', '12', '12', '12', '25', '40', '40', '25', '40', '40'],
  nozzle_temperature: perFilament(220),
  nozzle_temperature_initial_layer: perFilament(230),
  hot_plate_temp: ['55', '56', '57', '58'],
  hot_plate_temp_initial_layer: ['60', '61', '62', '63'],
  outer_wall_speed: ['200', '500', '500', '210', '500', '500', '500'],
}

function project(dir: string): string {
  const path = join(dir, 'h2d-variants.3mf')
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: MODEL }, { name: 'Metadata/project_settings.config', data: JSON.stringify(SETTINGS) }]))
  return path
}

describe('a Bambu Studio 2 project with per-variant values', () => {
  it('slices with each filament and extruder variant that applies', async () => {
    const h = await connect()
    const c = readProjectFile(project(h.dir)).config
    expect(c['filament_max_volumetric_speed']).toEqual([12, 12, 25, 25])
    expect(c['nozzle_temperature']).toEqual([220, 221, 222, 223])
    expect(c['nozzle_temperature_initial_layer']).toEqual([230, 231, 232, 233])
    expect(c['hot_plate_temp']).toEqual([55, 56, 57, 58])
    expect(c['hot_plate_temp_initial_layer']).toEqual([60, 61, 62, 63])
    expect(c['outer_wall_speed']).toEqual([200, 210])
  })

  it('reads them exactly as the app does', async () => {
    const h = await connect()
    const c = readProjectFile(project(h.dir)).config
    // the app's project open: importFlat(selectVariants(the project's settings))
    const app = importFlat(selectVariants(SETTINGS)).config as Record<string, unknown>
    for (const k of ['filament_max_volumetric_speed', 'nozzle_temperature', 'nozzle_temperature_initial_layer', 'hot_plate_temp', 'hot_plate_temp_initial_layer', 'outer_wall_speed']) {
      expect(c[k], k).toEqual(app[k])
    }
  })
})
