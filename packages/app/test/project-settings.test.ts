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
