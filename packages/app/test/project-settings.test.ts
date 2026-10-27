// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { baseConfig } from '../src/adapters/settings'
import { modifierSettings, projectSettingChanges } from '../src/export/project-settings'

describe('project settings', () => {
  it('takes plain values that differ from the current settings', () => {
    const r = projectSettingChanges({ wall_loops: '5', layer_height: '0.12', sparse_infill_density: '25%' }, baseConfig())
    expect(r.values['wall_loops']).toBe(5)
    expect(r.values['layer_height']).toBe(0.12)
  })

  it('drops values that equal the current ones', () => {
    const cfg = baseConfig() as unknown as Record<string, unknown>
    const r = projectSettingChanges({ wall_loops: String(cfg['wall_loops']) }, baseConfig())
    expect(r.values).toEqual({})
  })

  it("reads Bambu Studio 2.8's reduce_infill_retraction_mode: Auto with PLA skips retraction inside infill", () => {
    const auto = projectSettingChanges({ reduce_infill_retraction_mode: 'Auto', filament_metal_stickiness: ['None', 'None'] }, baseConfig())
    expect(auto.values['reduce_infill_retraction']).toBe(true)
    // A high stickiness filament keeps the retraction; the old switch still reads as before.
    const petg = projectSettingChanges({ reduce_infill_retraction_mode: 'Auto', filament_metal_stickiness: ['None', 'High'] }, { ...baseConfig(), reduce_infill_retraction: true })
    expect(petg.values['reduce_infill_retraction']).toBe(false)
    expect(projectSettingChanges({ reduce_infill_retraction: '1' }, baseConfig()).values['reduce_infill_retraction']).toBe(true)
  })

  it("passes a Bambu Lab project's initial_layer_flow_ratio on as the engine reads the same file", () => {
    // sx slice <project.3mf> slices with the file's own keys, so the app's request carries the same flow keys: the first
    // layer ratio under its own name, and no bottom surface ratio the file does not set.
    for (const printer_model of ['Bambu Lab A1', 'Bambu Lab P1S']) {
      const file = { printer_model, initial_layer_flow_ratio: '0.9' }
      const r = projectSettingChanges(file, baseConfig())
      expect(r.values['initial_layer_flow_ratio']).toBe(0.9)
      expect(r.values['bottom_solid_infill_flow_ratio']).toBeUndefined()
      const own = projectSettingChanges({ ...file, bottom_solid_infill_flow_ratio: '0.95' }, baseConfig())
      expect(own.values['initial_layer_flow_ratio']).toBe(0.9)
      expect(own.values['bottom_solid_infill_flow_ratio']).toBe(0.95)
    }
  })

  it("reads another printer's initial_layer_flow_ratio as the bottom surface ratio", () => {
    const r = projectSettingChanges({ printer_model: 'Generic Klipper Printer', initial_layer_flow_ratio: '0.9' }, baseConfig())
    expect(r.values['bottom_solid_infill_flow_ratio']).toBe(0.9)
    expect(r.values['initial_layer_flow_ratio']).toBeUndefined()
  })

  it("reads Bambu Studio's prime_tower_rib_wall as the prime tower wall type", () => {
    const rib = projectSettingChanges({ prime_tower_rib_wall: '1' }, { ...baseConfig(), wipe_tower_wall_type: 'rectangle' })
    expect(rib.values['wipe_tower_wall_type']).toBe('rib')
    const plain = projectSettingChanges({ prime_tower_rib_wall: '0' }, { ...baseConfig(), wipe_tower_wall_type: 'rib' })
    expect(plain.values['wipe_tower_wall_type']).toBe('rectangle')
  })

  it("leaves a Bambu Studio project's own feature filaments unread", () => {
    // Studio prints a project's wall_filament, sparse_infill_filament and solid_infill_filament on nothing.
    for (const v of ['1', '2', '3']) {
      const r = projectSettingChanges({ wall_filament: v, sparse_infill_filament: v, solid_infill_filament: v }, baseConfig())
      expect(r.values).toEqual({})
    }
  })

  it("puts an object's wall_filament on both walls and reads its 1 as filament 1", () => {
    expect(modifierSettings({ wall_filament: '2' })).toMatchObject({ outer_wall_filament_id: 2, inner_wall_filament_id: 2 })
    expect(modifierSettings({ sparse_infill_filament: '1' })['sparse_infill_filament_id']).toBe(1)
  })

  it('leaves out G-code, scripts, credentials and printer settings', () => {
    const r = projectSettingChanges(
      { machine_start_gcode: 'M104 S300', post_process: ['rm -rf /'], printhost_apikey: 'secret', printable_height: '999', nozzle_temperature: ['215'] },
      baseConfig(),
    )
    expect(Object.keys(r.values)).toEqual(['nozzle_temperature'])
    expect(r.left).toEqual(expect.arrayContaining(['machine_start_gcode', 'printable_height']))
    expect(JSON.stringify(r.values)).not.toMatch(/rm -rf|secret|M104/)
  })
})


it('takes the explicit mapped filament variant when opening a project', () => {
  const result = projectSettingChanges({
    filament_settings_id: ['one', 'two'],
    filament_self_index: ['2', '1', '2', '1'],
    filament_extruder_variant: ['Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive Standard', 'Direct Drive High Flow'],
    filament_map: ['2', '1'],
    extruder_type: ['Direct Drive', 'Direct Drive'],
    nozzle_volume_type: ['Standard', 'High Flow'],
    filament_max_volumetric_speed: ['42', '11', '22', '31'],
  }, baseConfig())
  expect(result.values['filament_max_volumetric_speed']).toEqual([31, 22])
})
