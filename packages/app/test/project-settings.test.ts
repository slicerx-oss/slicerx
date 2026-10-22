// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { baseConfig } from '../src/adapters/settings'
import { projectSettingChanges } from '../src/export/project-settings'

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

  it("reads Bambu Studio's prime_tower_rib_wall as the prime tower wall type", () => {
    const rib = projectSettingChanges({ prime_tower_rib_wall: '1' }, { ...baseConfig(), wipe_tower_wall_type: 'rectangle' })
    expect(rib.values['wipe_tower_wall_type']).toBe('rib')
    const plain = projectSettingChanges({ prime_tower_rib_wall: '0' }, { ...baseConfig(), wipe_tower_wall_type: 'rib' })
    expect(plain.values['wipe_tower_wall_type']).toBe('rectangle')
  })

  it("puts a Bambu Studio project's wall_filament on both walls", () => {
    const r = projectSettingChanges({ wall_filament: '2' }, baseConfig())
    expect(r.values['outer_wall_filament_id']).toBe(2)
    expect(r.values['inner_wall_filament_id']).toBe(2)
  })

  it("reads a Bambu Studio project's filament 1 as filament 1, not the object's own", () => {
    // Studio 2.8 prints the infill of a cube on filament 2 with filament 1 here.
    expect(projectSettingChanges({ sparse_infill_filament: '1' }, baseConfig()).values['sparse_infill_filament_id']).toBe(1)
    expect(projectSettingChanges({ sparse_infill_filament: '2' }, baseConfig()).values['sparse_infill_filament_id']).toBe(2)
    expect(projectSettingChanges({ sparse_infill_filament: '0' }, baseConfig()).values).toEqual({})
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
