// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { scriptKeyValues, scriptNames } from './script-keys'
import { unmodeledValues } from './unmodeled'

describe('the names a G-code template reads', () => {
  it('reads every word of a block and each bracket placeholder, not quoted text or plain G-code', () => {
    const text = 'M104 S[nozzle_temperature] ; heat\n{if hold_probe_temp[initial_extruder] > 0 && curr_bed_type=="Cool Plate"}M106 S{fan_hold}{endif}\nG28 X ; home words'
    expect([...scriptNames(text)].sort()).toEqual(['curr_bed_type', 'endif', 'fan_hold', 'hold_probe_temp', 'if', 'initial_extruder', 'nozzle_temperature'])
  })

  it('reads nested blocks', () => {
    expect(scriptNames('G1 F{max(outer_speed, {inner_speed})}').has('inner_speed')).toBe(true)
  })
})

describe("a project's values for the keys a kept script names", () => {
  const unmodeled = { hold_probe_temp: ['187'], other_key: '5' }

  it('gives the keys a G-code text names and the config lacks', () => {
    expect(scriptKeyValues({ machine_start_gcode: 'M104 S{hold_probe_temp[0]}' }, unmodeled)).toEqual({ hold_probe_temp: ['187'] })
    expect(scriptKeyValues({ filament_start_gcode: ['', 'M104 S[hold_probe_temp]'] }, unmodeled)).toEqual({ hold_probe_temp: ['187'] })
  })

  it('gives nothing for a key no script names, or one the config holds', () => {
    expect(scriptKeyValues({ machine_start_gcode: 'G28 ; hold_probe_temp in a comment' }, unmodeled)).toEqual({})
    expect(scriptKeyValues({ machine_start_gcode: 'M104 S{hold_probe_temp[0]}', hold_probe_temp: ['200'] }, unmodeled)).toEqual({})
    expect(scriptKeyValues({ layer_height: '{hold_probe_temp}' }, unmodeled)).toEqual({})
  })

  it("gives the file's filament ids and fin temperatures over the printer layer's per-slot fill", () => {
    const script = { machine_start_gcode: 'M1002 set_next_filament_id:{filament_ids[0]} E{fins_extrude_safe_temp[0]}' }
    const file = { filament_ids: ['GFA00', 'GFU06'], fins_extrude_safe_temp: ['57', '0'] }
    expect(scriptKeyValues({ ...script, filament_ids: ['GFA00', 'GFU99'], fins_extrude_safe_temp: [57, 0] }, file)).toEqual(file)
  })

  it('keeps the values of keys no setting models, as plain values, and no secrets', () => {
    expect(unmodeledValues({ layer_height: '0.2', hold_probe_temp: ['187'], nested: [['1']], printhost_apikey: 'k', post_process: ['x'], my_token: 't' })).toEqual({ hold_probe_temp: ['187'] })
  })
})
